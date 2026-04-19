# Codex Rabbit

GitHub の push / pull_request / issues / issue_comment を契機に **Codex CLI** でコードレビューを実行し、**GitHub** (PR コメント / コミットコメント / Issue 自動作成) と **Discord** (スレッド投稿 + 対話) の両方にフィードバックする AI Review Assistant です。

## デプロイ

導入・本番公開・運用の詳細手順は **[DEPLOY.md](./DEPLOY.md)** にまとめています。GitHub App / Discord Bot / Codex CLI の準備から、Docker でのサーバー起動、レビュー対象リポジトリへの GitHub Actions 追加、リバースプロキシ設定、トラブルシューティングまでカバーしています。

## リファレンス

環境変数 (.env) と設定ファイル (config.yml) の詳細は **[REFERENCE.md](./REFERENCE.md)** を参照してください。

## GitHub フィードバック

登録した GitHub App の名義で GitHub に直接フィードバックします。

- **PR レビューコメント**: `pulls.createReview` で PR にレビュー本文を投稿。`config.github.prReviewComment` で制御
- **コミットコメント**: push レビューでは head コミットに `repos.createCommitComment` でレビューを残す。`config.github.pushCommitComment` で制御
- **push Issue 自動作成**: レビューに `重大度: Critical` または `重大度: High` が含まれる場合、`codex-review` ラベル付きの Issue を自動起票。`config.github.pushIssueOnSevere` で制御
- **mention 経由レビュー**: PR/Issue コメント本文に `mention.triggers` の文字列が含まれると、その PR/Issue に対するレビューが追加で走る。`synchronize` 後に再レビューを依頼したり、既存 Issue の棚卸しに使用

いずれも best-effort で動作し、GitHub API エラーは Discord 投稿やキュー処理をブロックしません。

## Discordでの対話

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
