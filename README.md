# Jev PoCs

TypeSafe AI の Jev を「一次判断層」として使う、2つの個人向け PoC です。

必要環境は Node.js 22系（最新patch推奨）と pnpm 11.22.0 です。この手順は Node.js 22.0.0 でも検証しています。Gmail-triageを構築する場合はGoogle Cloud CLIも使います。

- [Gmail Triage PoC の README](apps/gmail-triage/README.md): Gmail API を正本にして、認証付きPub/Sub通知と定期回収でメールを評価し、Gmail ラベルを付ける Cloudflare Worker
- [Issue Triage PoC の README](apps/issue-triage/README.md): GitHub Issue 作成・更新時に Jev で分類し、必要な Issue だけ Flue の調査エージェントへ渡す GitHub Actions 用 Node.js アプリ

どちらも、Jev に副作用を持たせず、Jev の判定結果を TypeScript のルールで処理する構成です。

今後の活用候補と実現性は[docs/jev-ideas.md](docs/jev-ideas.md)に記録しています。

## セットアップ

pnpmコマンドはすべてリポジトリのルートから実行します。

~~~bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
~~~

各アプリのセットアップ手順は、上記の [Gmail Triage README](apps/gmail-triage/README.md) または [Issue Triage README](apps/issue-triage/README.md) を参照してください。

## デプロイ

Gmail-triageの個人ルールは `apps/gmail-triage/config/rules.json` に置けますが、共有対象ではありません。`.gitignore` で除外され、ビルド時にローカルだけ生成されます。共有用の初期ルールは `apps/gmail-triage/config/rules.default.json` です。

Gmail-triageを初めて作るときは、Gmail-triage READMEの手順でGoogle CloudとCloudflareの値を設定し、production Secretファイルを用意してから初回デプロイします。初回デプロイ後にCloudflare Dashboardの通常変数と認証付きPub/Sub Push Subscriptionを設定してから、health checkを実行します。

~~~bash
pnpm deploy:gmail:first
# Dashboard variablesとPush Subscriptionを設定後に実行
pnpm deploy:gmail:check
~~~

初回セットアップ後のコード更新では `pnpm deploy:gmail` を使います。デプロイ後チェックは `/health` の設定状態だけを確認し、値やメール本文を表示しません。

## 設計

~~~text
入力（メール / Issue）
        |
        v
       Jev  --- Choice / Score / Noul
        |
        v
 TypeScript の決定ルール
        |
   +----+----------------+
   |                     |
軽い副作用             深い調査
Gmailラベル             Flue Issue agent
~~~

PoC では、Jev の結果だけでメール削除、Issue の close、コード変更、commit、PR 作成は行いません。曖昧な判定はラベル・コメントに残し、人間が確認できる状態にします。

## Cloudflare / GitHub の準備

Gmail 側は Gmail API、Pub/Sub API、OAuth Client と認証付きPush用のService Accountを使います。Cloudflare側はWorkers AIと、メールボックス単位の処理状態を管理するDurable Objectを使います。旧KVの履歴値は新しい処理の進捗として使用しません。詳細は各アプリのREADMEを参照してください。

Jevの応答は実行結果の形式を検証してからラベル判定へ渡します。回答の欠落・型違い・範囲外の値を0点として扱いません。Workers AIバインディングで実測した `{ state: 'Completed', result: { model, answers, usage } }` の形式にも対応します。

Issue 側は Cloudflare Workers AI REST API を GitHub Actions から呼びます。必要な GitHub Actions secrets は次のとおりです。

- CLOUDFLARE_ACCOUNT_ID
- CLOUDFLARE_API_TOKEN
- FLUE_DISPATCH_URL（Flue を接続するときだけ）
- FLUE_DISPATCH_TOKEN（Flue webhook が認証を要求するときだけ）
