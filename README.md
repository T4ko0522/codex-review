# Codex Rabbit

GitHub の push / pull_request / issues / issue_comment を契機に **Codex CLI** でコードレビューを実行し、**GitHub** (PR コメント / コミットコメント / Issue 自動作成) と **Discord** (スレッド投稿 + 対話) の両方にフィードバックする Bot です。

## デプロイ

導入・本番公開・運用の詳細手順は **[DEPLOY.md](./DEPLOY.md)** にまとめています。GitHub App / Discord Bot / Codex CLI の準備から、Docker でのサーバー起動、レビュー対象リポジトリへの GitHub Actions 追加、リバースプロキシ設定、トラブルシューティングまでカバーしています。

## 環境変数リファレンス (.env)

| 変数                          |   必須   | デフォルト        | 説明                                                   |
| ----------------------------- | :------: | ----------------- | ------------------------------------------------------ |
| `WEBHOOK_SECRET`              | **必須** | -                 | HMAC-SHA256 署名検証用 (8 文字以上)                    |
| `GITHUB_APP_ID`               | **必須** | -                 | GitHub App の App ID                                   |
| `GITHUB_APP_PRIVATE_KEY_PATH` | **必須** | -                 | PEM 秘密鍵のファイルパス                               |
| `GITHUB_APP_INSTALLATION_ID`  | **必須** | -                 | GitHub App の Installation ID                          |
| `DISCORD_BOT_TOKEN`           |          | -                 | Discord Bot Token                                      |
| `DISCORD_CHANNEL_ID`          |          | -                 | レビュー投稿先チャンネル ID                            |
| `HTTP_HOST`                   |          | `127.0.0.1`       | リスンアドレス                                         |
| `HTTP_PORT`                   |          | `3000`            | リスンポート                                           |
| `CODEX_BIN`                   |          | `codex`           | Codex CLI のパス                                       |
| `CODEX_EXTRA_ARGS`            |          | -                 | Codex 追加引数 (例: `--model gpt-5-codex --full-auto`) |
| `CODEX_TIMEOUT_MS`            |          | `900000`          | Codex 実行タイムアウト (ms)                            |
| `SHUTDOWN_TIMEOUT_MS`         |          | `30000`           | shutdown 時に `queue.drain` を待つ最大時間 (ms)        |
| `WORKSPACES_DIR`              |          | `/app/workspaces` | clone 先ディレクトリ                                   |
| `DATA_DIR`                    |          | `/app/data`       | SQLite 保存先                                          |
| `LOG_LEVEL`                   |          | `info`            | `trace` / `debug` / `info` / `warn` / `error`          |
| `CONFIG_FILE`                 |          | `/app/config.yml` | config ファイルパス                                    |

## 設定リファレンス (config.yml)

### events

3 つのサブキーそれぞれに `enabled` と発火制御オプションを持ちます。

| キー                               | デフォルト     | 説明                                                                     |
| ---------------------------------- | -------------- | ------------------------------------------------------------------------ |
| `events.push.enabled`              | `true`         | push イベントを処理する                                                  |
| `events.push.mode`                 | `default-only` | `all` = 全 push を自動レビュー / `default-only` = デフォルトブランチのみ |
| `events.pull_request.enabled`      | `true`         | PR イベントを処理する                                                    |
| `events.pull_request.autoReviewOn` | `["opened"]`   | 自動レビューする action 一覧。含まれない action は mention 待ち          |
| `events.issues.enabled`            | `true`         | Issue イベントを処理する                                                 |
| `events.issues.autoReviewOn`       | `[]`           | 空なら全て mention 待ち。`opened` などを入れると自動起動                 |

### mention

| キー               | デフォルト              | 説明                                                                                     |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| `mention.triggers` | `["@CodexRabbit[bot]"]` | PR/Issue コメント本文にこれらの文字列が含まれるとレビュー実行。空配列で mention 機能 OFF |

### filters

| キー                    | デフォルト | 説明                                               |
| ----------------------- | ---------- | -------------------------------------------------- |
| `repositories`          | `[]`       | 許可リポ (`owner/repo` or `owner/*`)。空なら全許可 |
| `branches`              | `[]`       | push 対象ブランチ。空なら全許可                    |
| `skipDraftPullRequests` | `true`     | Draft PR をスキップ                                |
| `skipBotSenders`        | `true`     | `*[bot]` sender をスキップ                         |

### review

| キー                | デフォルト | 説明                                                  |
| ------------------- | ---------- | ----------------------------------------------------- |
| `maxDiffChars`      | `200000`   | diff の最大文字数 (超過分は切り詰め)                  |
| `cloneDepth`        | `50`       | shallow clone の depth (0 で full clone)              |
| `includeExtensions` | `[]`       | レビュー対象の拡張子 (例: `["ts", "js"]`)。空なら全て |
| `excludePaths`      | `[]`       | 除外パス (glob 風: `node_modules/**`, `*.lock` 等)    |

### github

| キー                | デフォルト | 説明                                            |
| ------------------- | ---------- | ----------------------------------------------- |
| `prReviewComment`   | `true`     | PR にレビューコメントを投稿                     |
| `pushCommitComment` | `true`     | push レビュー時に head コミットへコメントを投稿 |
| `pushIssueOnSevere` | `true`     | push で Critical/High 検出時に Issue を自動作成 |

### discord

| キー                       | デフォルト | 説明                                                            |
| -------------------------- | ---------- | --------------------------------------------------------------- |
| `enabled`                  | `true`     | `false` で Discord 連携を無効化 (環境変数 `DISCORD_*` も不要に) |
| `chunkSize`                | `1900`     | 1 メッセージの最大文字数 (上限 2000)                            |
| `threadAutoArchiveMinutes` | `1440`     | `60` / `1440` / `4320` / `10080`                                |
| `enableThreadChat`         | `true`     | スレッド内での対話応答                                          |

### workspace

| キー         | デフォルト | 説明                                                                                  |
| ------------ | ---------- | ------------------------------------------------------------------------------------- |
| `ttlMinutes` | `1440`     | 非活性スレッドに紐づく clone ディレクトリを自動回収するまでの分数 (10 分間隔で sweep) |

## GitHub フィードバック

`CodexRabbit[bot]` の名義で GitHub に直接フィードバックします。

- **PR レビューコメント**: `pulls.createReview` で PR にレビュー本文を投稿。`config.github.prReviewComment` で制御
- **コミットコメント**: push レビューでは head コミットに `repos.createCommitComment` でレビューを残す。`config.github.pushCommitComment` で制御
- **push Issue 自動作成**: レビューに `重大度: Critical` または `重大度: High` が含まれる場合、`codex-review` ラベル付きの Issue を自動起票。`config.github.pushIssueOnSevere` で制御
- **mention 経由レビュー**: PR/Issue コメント本文に `mention.triggers` の文字列が含まれると、その PR/Issue に対するレビューが追加で走る。`synchronize` 後に再レビューを依頼したり、既存 Issue の棚卸しに使用

いずれも best-effort で動作し、GitHub API エラーは Discord 投稿やキュー処理をブロックしません。

## スレッド内での対話

レビュー投稿後、Discord にスレッドが自動作成されます。スレッド内にメッセージを書くと、Bot が会話履歴と clone 済みリポジトリを Codex に渡して応答します。

### workspace のライフサイクル

| 状態               | 挙動                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| **通常運用**       | 最後の活動から `workspace.ttlMinutes` 経過で自動削除 (10 分間隔スイープ)。会話中は TTL リセット |
| **プロセス再起動** | 全 workspace 消失。会話履歴は SQLite に残るが、実ファイル参照なしの応答になる                   |
| **異常終了**       | `WORKSPACES_DIR` にディレクトリが残る。手動削除が必要                                           |

## 開発・コントリビュート

[CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## セキュリティ

- 全 webhook は HMAC-SHA256 (`X-Codex-Review-Signature: sha256=<hex>`) で検証
- GitHub トークンは `GIT_CONFIG_*` 環境変数経由で git に渡し、URL やコマンドラインに露出しない
- GitHub App は **Private** (自分のアカウントのみインストール可能) に設定
- Docker コンテナは非 root 化を行っていません。必要に応じて `USER node` を追加してください
- Codex CLI 子プロセスへは `PATH` や `OPENAI_*` など最小限の環境変数のみを引き渡し、`DISCORD_BOT_TOKEN` など他の secrets は渡しません

## ライセンス

Apache License 2.0 の下で配布されています。全文は [LICENSE](./LICENSE) を参照してください。
