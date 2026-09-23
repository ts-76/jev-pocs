# GitHub Issue Triage with Jev + Flue

GitHub Issue の入口で Jev に安価な一次判断をさせ、repository 調査が必要な Issue だけ Flue の webhook に渡す PoC です。

~~~text
Issue opened / edited / reopened
          |
          v
     Cloudflare Workers AI
       typesafe/jev
          |
          v
      TypeScript rules
       |          |
       |          +-- bug + investigation -> Flue webhook
       |
       +-- label + idempotent comment
~~~

Jev は分類・ルーティングだけを担当し、Flue はコード探索、再現確認、関連 Issue の確認などの深い調査を担当します。この PoC から commit、push、PR 作成、Issue close は行いません。

## Jev の判定

- issue_type: bug / feature / question / docs / other
- severity: low / medium / high / critical
- needs_repo_investigation: repository 内のコード調査が必要か
- has_enough_information: 調査を開始できる情報があるか

分類・しきい値・GitHubラベルの表示名と色は `config/triage.json` で管理します。設定は起動時に検証し、不正なバージョン、しきい値、カテゴリ、質問定義では処理を開始しません。

初期ルールは bug かつ needs_repo_investigation >= 0.65 のときだけ Flue に渡します。Flue URL が未設定でも、Jev のラベル・コメント処理は動作します。判定結果には一致したルーティングルールIDを含め、コメントにも記録します。

設定を個別に差し替える場合は、検証済みのJSONファイルを `ISSUE_TRIAGE_CONFIG` に指定できます。通常のGitHub Actionsでは共有設定を使います。

## GitHub Actions

このworkflowはmonorepo自体のIssueに使う設定です。monorepoのルートにある .github/workflows/jev-issue-triage.yml をそのまま利用してください。別repositoryにworkflowファイルだけをコピーしても動きません。別repositoryで使う場合は apps/issue-triage のpackageとconfig、ルートのpnpm workspace/lockfileを同じパスに用意し、workflowのbuild/runパスをその構成に合わせてください。

必要な secrets:

- CLOUDFLARE_ACCOUNT_ID
- CLOUDFLARE_API_TOKEN
- FLUE_DISPATCH_URL（任意。Flue の HTTP webhook / workflow endpoint）
- FLUE_DISPATCH_TOKEN（任意）

Cloudflare Account IDは対象AccountのDashboardから取得します。CLOUDFLARE_API_TOKENはWorkers AI REST API用に作成し、対象AccountでWorkers AI ReadとWorkers AI Editを付与してください。Account IDとtokenは同じAccountから取得します。[Workers AI REST API tokenの設定](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)

GITHUB_TOKEN は Actions が自動提供します。workflow には issues: write と contents: read の権限を付けています。

必要なsecretは対象repositoryの Settings > Secrets and variables > Actions > New repository secret で登録します。GitHub Actionsのworkflow permissionsをrepository側で制限している場合は、Issuesへの書き込みを許可してください。Flueを利用しない場合はFLUE_DISPATCH_URLとFLUE_DISPATCH_TOKENは不要です。

## ローカル確認

~~~bash
pnpm install
pnpm --filter issue-triage typecheck
pnpm --filter issue-triage test
pnpm --filter issue-triage build
pnpm --filter issue-triage triage:validate
pnpm --filter issue-triage triage:dry-run examples/jev-response.json
~~~

上記はすべてmonorepoルートから実行します。最後のdry-runは同梱したJev応答JSONを判定するだけで、Cloudflare、GitHub、Flueへ通信しません。

`.env.example` はローカル統合実行用の環境変数一覧です。Node.jsはこれを自動読込しないため、コピーして値を設定したうえで `--env-file` を明示します。GITHUB_EVENT_PATHのfixtureは `examples/issue-event.json` です。GITHUB_REPOSITORYとfixture内のrepository/issue番号を、検証用の実在するIssueに合わせてください。

ローカル統合実行はCloudflare Workers AIへリクエストし、指定したGitHub Issueのラベルとtriageコメントを書き換えます。Flue URLも設定している場合はFlueへも送信します。専用のテストrepositoryとIssueだけで実行してください。

~~~bash
cp apps/issue-triage/.env.example apps/issue-triage/.env
# .env内の値とfixtureを検証用repository/issueへ合わせる
pnpm --filter issue-triage build
cd apps/issue-triage
node --env-file=.env dist/index.js
~~~

GITHUB_TOKENには対象repositoryのIssues read/write権限が必要です。Cloudflare tokenには上記のWorkers AI権限を設定します。通常のルール確認ではこの統合実行を使わず、dry-runを使ってください。

## Flue webhook の payload

Flue には次の payload を POST します。HTTPヘッダーとpayloadに `idempotencyKey` を含め、Flue側でも同じキーの重複処理を抑止してください。

~~~json
{
  "event": "issue.triage.requested",
  "repository": "owner/repository",
  "issue": {
    "number": 123,
    "title": "Example",
    "body": "...",
    "url": "https://github.com/owner/repository/issues/123"
  },
  "triage": {
    "issueType": "bug",
    "severity": "high",
    "needsRepoInvestigation": true,
    "hasEnoughInformation": true
  },
  "ref": "main",
  "sha": "...",
  "idempotencyKey": "owner/repository:123:2026-09-23T10:00:00Z"
}
~~~

Flue 側では payload の issue URL / number を initialData として受け取り、checkout 済み repository を調査する workflow に接続してください。
