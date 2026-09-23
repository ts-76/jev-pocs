# Gmail + Jev Triage

このREADMEの `pnpm` コマンドは、特記がない限り monorepo のルートで実行します。ファイルパスはmonorepoルート基準です。Cloudflare/Gmailの設定値は [`.dev.vars.example`](.dev.vars.example) と [`.secrets.production.example`](.secrets.production.example) を基準にし、値の種類と登録先を後半の一覧にまとめています。

Gmailを正本として、認証付きPub/Sub通知を入口に、Cloudflare WorkerからGmail APIとtypesafe/jevを呼び出してラベルを付けるPoCです。通知の受付とメール評価を分け、メールボックス専用Durable Objectへ処理要求を保存してから応答します。5分ごとの回収と毎日のwatch更新も同じ実行経路を使います。

~~~text
Gmail watch
  -> Google Cloud Pub/Sub
  -> POST /pubsub でJWTと対象メールアドレスを検証
  -> Durable Objectへ要求を保存して204応答
  -> alarmでhistory.listをページ単位で取得しメール単位の仕事を保存
  -> メール本文を最大 6000 文字取得
  -> 既知の定型パターンをルールで判定し、判断が残る場合だけ Jev を呼ぶ
  -> Jev応答を検証・評価結果を保存
  -> Gmail messages.modifyでラベルを追加して完了（既存ラベルを保持）

5分ごとの Cron は通知の遅延・欠落時のフォールバックです。
~~~

この PoC はメールを削除、転送、送信しません。成功したメールに AI/Triaged を付けるため、途中で失敗しても次回に再試行できます。

Jevの実測応答は `{state:"Completed",result:{model,answers,usage}}` です。`result.answers` を検証して読み取ります。回答の欠落・型違い・範囲外は0点に変換せず失敗とします。ラベル適用だけが失敗した場合は保存した評価結果を再利用します。

## 判定とラベル

分類ルール・表示ラベル・しきい値は `config/rules.json` で管理します。これはメールボックスごとの個人設定としてignore対象です。
共有する初期設定は `config/rules.default.json` に置き、`config/rules.json` が存在しない環境では初期設定を使います。
`config/rules.schema.json` がエディタ補完と構造検証を提供し、ルールIDの重複、
未知のラベルID、不正な正規表現などは `src/rule-engine.ts` が検証します。
不正な設定ではメール処理を開始しません。設定はデプロイ時に取り込みます。

### ルールの編集と確認

```bash
pnpm --filter gmail-triage rules:validate
pnpm --filter gmail-triage rules:dry-run examples/email.json
pnpm --filter gmail-triage rules:dry-run /path/to/email.json /path/to/custom-rules.json
pnpm --filter gmail-triage test
pnpm --filter gmail-triage typecheck
pnpm --filter gmail-triage build
```

ドライランの入力は EmailState 形式のJSON、またはその配列です。
from / subject / snippet は必須、body / receivedAt / evaluatedAt / timezone は任意です。
出力は一致したルールID、付与予定ラベル、AI省略可否・理由のみです。
Gmail API・AIを呼ばず、メールを書き換えません。AI判定の予測は行いません。

- `all` はAND、`any` はOR。空の条件配列はエラーです。
- 文字列条件: `equals` / `startsWith` / `contains` / `matches`。
  `ignoreCase: true` で大文字小文字を無視できます。
- `from.address` は表示名を除いた小文字のメールアドレスです。
  ヘッダー条件は送信者の暗号学的な認証を保証するものではありません。
- `body` は抽出本文、本文未指定時だけsnippetを使います。
- `ageDays` は受信日時と評価日時の差。日時が無効なら一致しません。
- 一致した全ルールを設定順に評価し、ラベルを合算・重複排除します。
  `ai: "skip"` はAIのみ省略し、後続ルールの評価を止めません。
- AI省略は、対応要否まで確定できる定型メールだけに指定してください。
- 正規表現は信頼できる設定作成者が管理します。過度なバックトラッキングを起こす式や
  未検証の第三者ルールを取り込まないでください。
- `labels` の固定IDと表示名を分離しています。既存環境での表示名変更には
  Gmail側のラベル移行とDurable ObjectのラベルIDキャッシュ更新が別途必要です。
  処理済みマーカーの `AI/Triaged` は変更できません。
- 各評価には `matchedRuleIds` / `aiReason` を保存し、ラベル適用ログにも記録します。
  本文や件名はこのログへ出力しません。

Cloudflare Workersで実行時のコード生成を避けるため、JSON Schemaの検証関数は
Ajvのstandalone機能で事前生成しています。スキーマを変更したら
`pnpm --filter gmail-triage rules:generate` を実行し、生成ファイルも変更に含めてください。
`rules:validate` は生成物がスキーマと一致することも確認します。
ビルドとテストは設定検証を先に実行します。通常更新はrootの `pnpm deploy:gmail` を使ってください。

同梱ルールは個人情報を含まない最小限の初期設定です。自分のメールボックス用ルールは
`config/rules.json` に作成してください。YAML入力、設定ファイルの重ね合わせ、
同一設定からのGmailフィルタ生成は未実装です。Gmailフィルタは引き続き別管理です。

- 内容: 請求・支払い / 売上・入金 / 開発通知 / 仕事・問い合わせ / お知らせ・購読 / 認証・セキュリティ
- category の confidence >= 0.8 の場合に内容ラベルを追加。other / 低確信度は内容ラベルを強制しない。
- requires_reply >= 0.75 または priority >= 2.0 -> 要対応（広告の誘い・認証コード・支払い済みは除く）
- unsolicited_sales >= 0.85 -> お知らせ・購読
- 7日以上経過した既知のCloudflare認証コードを評価した場合 -> 削除候補（削除はしない）
- 成功 -> AI/Triaged

Cloudflare認証コード、npm公開成功、Chatwork/リベシティ未読通知、Zenn新着記事は、正確な送信元と件名を確認してAIを省略する。それ以外は既知送信元でも対応要否をAIで評価する。Gmailの6つの新着用フィルタは別途設定済みで、Workerはフィルタやユーザーが付けたラベルを消さない。

既存のAI/Triaged付きメールは再課金を避けて自動再評価しない。旧AIラベルも一括削除しない。必要なメールのみreprocessする。既に処理済みの認証コードに、時間経過だけで削除候補を付け直す定期処理は未実装。

ラベルは初回実行時に存在しなければ自動作成します。

## Google Cloud と OAuth の準備

Google Cloud のコマンドは `gcloud auth login` 済みで、対象Projectを操作できるアカウントで実行します。`PROJECT_ID` はCloud ConsoleのProject ID、`TOPIC_ID` は任意のTopic名です。

~~~bash
PROJECT_ID="your-project-id"
TOPIC_ID="gmail-triage"

gcloud config set project "$PROJECT_ID"
gcloud services enable gmail.googleapis.com pubsub.googleapis.com iam.googleapis.com --project="$PROJECT_ID"
gcloud pubsub topics create "$TOPIC_ID" --project="$PROJECT_ID"
gcloud pubsub topics add-iam-policy-binding "$TOPIC_ID" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
PUSH_SERVICE_ACCOUNT_ID="gmail-triage-push"
PUSH_SERVICE_ACCOUNT_EMAIL="$PUSH_SERVICE_ACCOUNT_ID@$PROJECT_ID.iam.gserviceaccount.com"
PUBSUB_SERVICE_AGENT="service-$PROJECT_NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com"
DEPLOYER_EMAIL="your-google-account@example.com"

gcloud iam service-accounts create "$PUSH_SERVICE_ACCOUNT_ID" \
  --project="$PROJECT_ID" \
  --display-name="Gmail triage authenticated push"

gcloud iam service-accounts add-iam-policy-binding "$PUSH_SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:$PUBSUB_SERVICE_AGENT" \
  --role="roles/iam.serviceAccountTokenCreator"

# Subscription作成者にService Account User権限を付ける
gcloud iam service-accounts add-iam-policy-binding "$PUSH_SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --member="user:$DEPLOYER_EMAIL" \
  --role="roles/iam.serviceAccountUser"
~~~

次に Google Auth Platform で OAuth consent screen を設定し、利用する Gmail アカウントを test user に追加します。OAuth Client は **Web application** として作成します。最初はローカル callback `http://localhost:8787/oauth/callback` を Authorized redirect URI に登録します。本番 callback は後述のCloudflare Worker URLが決まったら追加します。

要求するscopeは `https://www.googleapis.com/auth/gmail.modify` です。ローカルでOAuthを一度完了してrefresh tokenを取得します。OAuth consent screenがTestingの場合、Gmailのような基本プロフィール以外のscopeでは認可とrefresh tokenが7日で期限切れになります。[GoogleのOAuth testingの説明](https://support.google.com/cloud/answer/15549945)

Gmail APIがPub/Sub Topicへ通知を送れるよう、Topicには `gmail-api-push@system.gserviceaccount.com` の `roles/pubsub.publisher` を付けます。`GMAIL_PUBSUB_TOPIC` に設定する値は、次の完全修飾名です。

~~~text
projects/your-project-id/topics/gmail-triage
~~~

この段階ではPush Subscriptionをまだ作りません。SubscriptionのHTTPS endpointはWorkerを最初にデプロイしてから設定します。[Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)

## ローカル起動

`.dev.vars` では、Googleから取得したGMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET、作成したTopicの完全修飾名、Gmailアカウント、push用Service Accountメールを設定します。OAUTH_STATE_SECRETとRUN_TOKENには別々に `openssl rand -hex 32` の出力を使います。GMAIL_REFRESH_TOKENは最初は空のままにし、次のOAuth callback後に入力します。

~~~bash
cp apps/gmail-triage/.dev.vars.example apps/gmail-triage/.dev.vars
# apps/gmail-triage/.dev.vars の空欄とローカル値を編集する
pnpm install
pnpm --filter gmail-triage typecheck
pnpm --filter gmail-triage test
pnpm dev:gmail
~~~

`secrets.required` があるWrangler設定では `.dev.vars` のうち必須Secret名だけが自動読込されます。このアプリの `scripts/dev.mjs` は残りの非Secret設定3項目と任意のtimezoneを `wrangler dev --var` として渡します。ローカル起動は上記の `pnpm dev:gmail` を使ってください。

ローカルポートは8787に固定しています。別プロセスが使用中なら、空いているポートを指定し、OAuth Clientのcallbackと `.dev.vars` の `GMAIL_REDIRECT_URI`、`PUBSUB_AUDIENCE`、`WORKER_URL` を同じポートへ変更してから起動します。

~~~bash
WRANGLER_DEV_PORT=8788 pnpm dev:gmail
~~~

OAuth URL を表示します。

~~~bash
curl http://localhost:8787/oauth/start
~~~

ブラウザで authorization_url を開いて認証し、callbackに表示されたrefresh tokenを apps/gmail-triage/.dev.vars の GMAIL_REFRESH_TOKEN に保存します。ローカル開発では OAuth Client 側に http://localhost:8787/oauth/callback を許可 redirect URI として登録してください。callback画面に表示されたtokenはパスワード同様に扱い、チャットやログへ貼らないでください。

ローカルWorkerの手動実行はRUN_TOKENを .dev.vars に設定してから行います。管理スクリプトがその値を読み込むため、tokenをコマンド行に直接書く必要はありません。POSTの202は受付完了で、処理完了ではありません。

~~~bash
node apps/gmail-triage/scripts/admin.mjs run
~~~

Gmail の watch を開始・更新するには、Worker起動後に実行します。これは `RUN_TOKEN` で保護されています。

~~~bash
node apps/gmail-triage/scripts/admin.mjs watch
~~~

### 初回デプロイ後にPush Subscriptionを設定

以下は初回デプロイ後に、Google CloudのProject IDとCloudflareのWorker URLを指定して実行します。Pub/Sub push用Service AccountとIAM権限は前のGoogle Cloud setupで作成済みの前提です。

~~~bash
PROJECT_ID="your-project-id"
TOPIC_ID="gmail-triage"
WORKER_URL="https://jev-gmail-triage.your-workers-dev-subdomain.workers.dev"
PUSH_SERVICE_ACCOUNT_ID="gmail-triage-push"
PUSH_SERVICE_ACCOUNT_EMAIL="$PUSH_SERVICE_ACCOUNT_ID@$PROJECT_ID.iam.gserviceaccount.com"
SUBSCRIPTION_ID="gmail-triage-push"

gcloud pubsub subscriptions create "$SUBSCRIPTION_ID" \
  --project="$PROJECT_ID" \
  --topic="projects/$PROJECT_ID/topics/$TOPIC_ID" \
  --push-endpoint="$WORKER_URL/pubsub" \
  --push-auth-service-account="$PUSH_SERVICE_ACCOUNT_EMAIL" \
  --push-auth-token-audience="$WORKER_URL/pubsub"
~~~

Pub/Sub APIを有効化した直後はservice agentの反映まで時間がかかる場合があります。権限付与でservice agentが見つからない場合は、数分待ってから再実行してください。既存Subscriptionのendpointやaudienceを変更する場合は gcloud pubsub subscriptions modify-push-config を使います。[Authenticated push subscriptions](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions)

Workerの通常変数には、ここで作った PUSH_SERVICE_ACCOUNT_EMAIL と https://jev-gmail-triage.<workers.dev-subdomain>.workers.dev/pubsub のaudienceを同じ文字列で設定します。コードはJWTの署名、issuer、audience、有効期限、サービスアカウントメールを照合します。

履歴の取得位置とメール単位の処理状態はDurable Objectに保存します。watch更新で処理位置を上書きしません。初回は受信箱を回収し、旧AI/Triaged付きメールは通常スキップします。

## 状態確認と再評価

`GET /status` と `POST /run`・`/watch`・`/reprocess`・`/resume` はRUN_TOKENのBearer認証が必要です。`/reprocess` は `{ "messageIds": ["GmailメッセージID"] }` 形式で最大20件を受け付けます。旧バージョンで誤って完了扱いになったメールも、指定したものだけ再評価できます。

トークンをコマンド引数へ出さずに操作する補助スクリプト（Node.jsのutil.parseEnv対応版が必要）：

```bash
node apps/gmail-triage/scripts/admin.mjs status
node apps/gmail-triage/scripts/admin.mjs run
node apps/gmail-triage/scripts/admin.mjs reprocess 0123abcdef
node apps/gmail-triage/scripts/admin.mjs resume
node apps/gmail-triage/scripts/check-message.mjs 0123abcdef
```

ローカルの `.dev.vars` からRUN_TOKENを読みます。別パスは `--vars /absolute/path/.dev.vars` を指定します。クレジット不足は保留し、復旧後にresumeします。レート制限は待ち時間を設けます。評価結果を保存してからラベルを適用するため、ラベルの再試行に再推論は不要です。外部操作と記録の間でクラッシュした場合、同じラベル操作が再実行される可能性はあります。

本文はplain textを優先し、なければHTMLをテキスト化します。本文やOAuthトークンを診断ログへ記録しません。`scripts/probe-jev.mjs` は合成文で実AIを呼び出す診断用で、通常のテストには含めません。実行するとAI利用料が発生します。

不正なAI応答はメール単位で隔離します。通常の回収で同じメールを繰り返し推論せず、原因の修正後に対象IDを指定してreprocessします。`status`の`quarantined`が現在の隔離状態、`failed`が失敗したジョブの記録です。Gmail認証エラーでも評価を一時停止するため、認証を直してからresumeしてください。

## 検証

`pnpm --filter gmail-triage test`は合成データによる単体テストです。`node apps/gmail-triage/scripts/runtime-smoke.mjs`は実際のworkerdとSQLite Durable Objectを起動し、外部通信を合成データへ置き換えて受付・alarm・ラベル付与・重複防止・watch・再評価・ラベル付与失敗の再試行を検証します。Gmail本文の取得や有料AI呼び出しは行いません。

## デプロイ

### 設定値と登録先

`.dev.vars.example` はローカル用です。Wranglerの `secrets.required` に列挙した7項目はlocal Secretとして読み込まれます。残りの非Secret設定は `scripts/dev.mjs` が `wrangler dev --var` として渡します。`.dev.vars` の全項目が本番へ自動アップロードされることはありません。

| 名前 | ローカル | Cloudflare本番 | 値の取得元・形式 |
| --- | --- | --- | --- |
| `GMAIL_CLIENT_ID` | `.dev.vars` | Secret | Google Auth PlatformのOAuth Client |
| `GMAIL_CLIENT_SECRET` | `.dev.vars` | Secret | 同じOAuth Client |
| `GMAIL_REFRESH_TOKEN` | `.dev.vars` | Secret | ローカルOAuth callbackで取得 |
| `GMAIL_REDIRECT_URI` | `.dev.vars` | Secret | ローカルは `http://localhost:8787/oauth/callback`、本番はWorkerの `/oauth/callback` |
| `GMAIL_PUBSUB_TOPIC` | `.dev.vars` | Secret | `projects/PROJECT_ID/topics/TOPIC_ID` |
| `OAUTH_STATE_SECRET` | `.dev.vars` | Secret | `openssl rand -hex 32` で生成 |
| `RUN_TOKEN` | `.dev.vars` | Secret | `openssl rand -hex 32` で生成。OAUTH_STATE_SECRETとは別の値 |
| `GMAIL_ACCOUNT_EMAIL` | `.dev.vars` | Dashboard Text variable | Gmail APIを操作するアカウント |
| `PUBSUB_AUDIENCE` | `.dev.vars` | Dashboard Text variable | `https://WORKER_HOST/pubsub`。Subscriptionのaudienceと完全一致 |
| `PUBSUB_SERVICE_ACCOUNT_EMAIL` | `.dev.vars` | Dashboard Text variable | 作成したPub/Sub push用Service Accountのメールアドレス |
| `MAILBOX_TIMEZONE` | `.dev.vars` | Dashboard Text variable | IANA timezone。例: `Asia/Tokyo`。省略時はUTC |
| `WORKER_URL` | `.dev.vars`のみ | なし | admin/check補助スクリプト用のWorker base URL。末尾に `/` を付けない |
| `AI`, `MAILBOX` | Wrangler binding | Wrangler binding | `wrangler.jsonc` で宣言済み。値の手入力不要 |

Cloudflare DashboardのAccount IDはWorkers & Pagesのアカウント情報で確認できます。CLIは `pnpm --filter gmail-triage exec wrangler login` で認証します。複数Accountを使う場合は `CLOUDFLARE_ACCOUNT_ID` を環境変数に設定して対象を明示してください。

### 初回デプロイ

`secrets.required` により、7つのSecretがない状態ではデプロイを拒否します。新規WorkerはSecretを先に `secret put` できないため、初回は `--secrets-file` でコードとSecretをまとめてデプロイします。

1. Cloudflare Dashboardでworkers.devのsubdomainを確認します。このWorker URLは `https://jev-gmail-triage.<workers-dev-subdomain>.workers.dev` です。
2. OAuth ClientのAuthorized redirect URIへ、本番URL `https://jev-gmail-triage.<workers-dev-subdomain>.workers.dev/oauth/callback` を追加します。ローカル用URIも残します。
3. ローカルOAuthを完了し、refresh tokenを `.dev.vars` に保存します。
4. production用Secretファイルを作成して値を設定します。

~~~bash
cp apps/gmail-triage/.secrets.production.example apps/gmail-triage/.secrets.production
chmod 600 apps/gmail-triage/.secrets.production
~~~

`.secrets.production` の7項目には対応するOAuth/Google Cloudの値とローカルOAuthで取得したrefresh tokenを設定します。`GMAIL_REDIRECT_URI` は本番callback URL、`GMAIL_PUBSUB_TOPIC` はGoogle Cloudで作成したTopicの完全修飾名にします。`OAUTH_STATE_SECRET` と `RUN_TOKEN` には異なるランダム値を入れてください。ファイルは `.gitignore` 対象です。サンプルの `your-` / `replace-with-` 値のままでは初回デプロイを止めます。

5. Wranglerを認証してからrootの初回デプロイスクリプトを実行します。

~~~bash
pnpm --filter gmail-triage exec wrangler login
pnpm deploy:gmail:first
~~~

初回スクリプトはproduction Secretファイルのキーが `wrangler.jsonc` の `secrets.required` と一致し、値が空やテンプレートではないことを確認してからデプロイします。Cloudflareの `--secrets-file` 機能を使います。[Wrangler secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

### 初回デプロイ後の設定

Cloudflare Dashboardの **Workers & Pages > jev-gmail-triage > Settings > Variables and Secrets** で、次の4つを通常のText variableとして登録します。

~~~text
GMAIL_ACCOUNT_EMAIL=<操作対象のGmailアドレス>
PUBSUB_AUDIENCE=https://jev-gmail-triage.<workers-dev-subdomain>.workers.dev/pubsub
PUBSUB_SERVICE_ACCOUNT_EMAIL=<作成したpush用Service Accountのメールアドレス>
MAILBOX_TIMEZONE=Asia/Tokyo
~~~

その後、[初回デプロイ後にPush Subscriptionを設定](#初回デプロイ後にpush-subscriptionを設定)を実行してPub/Sub subscriptionを作成し、`.dev.vars` の `WORKER_URL` を本番Worker URLにして設定を確認します。

~~~text
WORKER_URL=https://jev-gmail-triage.<workers-dev-subdomain>.workers.dev
~~~

~~~bash
pnpm deploy:gmail:check
# またはURLを一度だけ指定
node apps/gmail-triage/scripts/check-deploy.mjs --url https://jev-gmail-triage.<workers-dev-subdomain>.workers.dev
~~~

health checkで全項目がtrueなら、watchを開始して受信箱の初回回収を行います。

~~~bash
node apps/gmail-triage/scripts/admin.mjs watch
node apps/gmail-triage/scripts/admin.mjs run
~~~

### 通常の更新とSecret変更

既存Workerへのコード更新はrootから `pnpm deploy:gmail` を実行します。`--keep-vars` により既存Dashboardの通常変数を保持します。ローカルの `.dev.vars` はアップロードされず、Secretもデプロイでは削除されません。

Secretを個別に変更する場合は `pnpm --filter gmail-triage exec wrangler secret put SECRET_NAME` を使います。`secret put` はSecretを反映したWorker versionをその場でデプロイします。`.secrets.production` は初回デプロイ用で、日常のコード更新には使用しません。

## 注意

- gmail.modify は Gmail の制限付きスコープです。個人用 PoC の OAuth Testing として運用し、取り扱う本文を最小限にしてください。
- Jev の判定は誤る可能性があるため、最初は 50〜100 通ほど結果を確認して閾値を調整してください。
- 添付ファイルは意図的に無視しています。
