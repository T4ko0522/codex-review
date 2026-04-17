# codex-review

GitHub の push / pull_request / issues を契機に **OpenAI Codex CLI** でコードレビューを実行し、**GitHub** (PR コメント / Issue 自動作成) と **Discord** (スレッド投稿 + 対話) の両方にフィードバックする Bot です。

GitHub への投稿は **GitHub App** (`codex-review[bot]`) の専用アカウントで行います。

## 特徴

- push / PR / Issue の 3 イベントに対応 (個別 ON/OFF 可)
- PR には `codex-review[bot]` 名義でレビューコメントを投稿
- push で Critical / High の指摘があれば Issue を自動起票
- Discord スレッド内でレビューに対する追加質問が可能 (Codex が実ファイルを参照して回答)
- fork PR に対応 (`pull_request_target` + fork remote fetch)
- diff フィルタ (拡張子指定 / パス除外) で不要なファイルを除外
- HMAC-SHA256 による webhook 署名検証

## 全体フロー

```
GitHub (push / PR / Issue)
      |  GitHub Actions (.github/workflows/codex-review.yml)
      |  HMAC-SHA256 署名付き POST
      v
+------------------------------------------+
|  codex-review サーバー (Docker)           |
|                                          |
|  Fastify /webhook                        |
|    -> 署名検証 -> フィルタ -> enqueue     |
|                                          |
|  p-queue (concurrency=1)                 |
|    -> git clone + diff                   |
|    -> codex exec (子プロセス)             |
|    -> GitHub API (PR comment / Issue)    |
|    -> Discord Bot (スレッド投稿)          |
|                                          |
|  Discord messageCreate                   |
|    -> スレッド内 follow-up -> codex       |
+------------------------------------------+
```

## 前提条件

| 項目 | 要件 |
|------|------|
| Node.js | >= 20.11 |
| pnpm | 9.x (corepack 経由) |
| Vite+ (`vp`) | ホスト側にインストール (ビルド用) |
| Docker | compose v2 |
| Git | >= 2.31 |
| OpenAI Codex CLI | `~/.codex` に認証情報、または `OPENAI_API_KEY` |

## セットアップ

### 1. GitHub App の作成

<https://github.com/settings/apps/new> で App を作成します。

| 設定項目 | 値 |
|---------|---|
| App name | 任意 (例: `codex-review`) |
| Homepage URL | 任意 |
| Webhook | **Active のチェックを外す** (不要) |
| Repository permissions | `Contents: Read`, `Issues: Read & Write`, `Pull requests: Read & Write` |
| Where can this app be installed? | **Only on this account** |

作成後:

1. **App ID** を控える (App 設定ページ上部の `App ID`)
2. **秘密鍵を生成**: Private keys > Generate a private key → PEM ファイルをダウンロード
3. **App をインストール**: Install App > 対象リポジトリを選択
4. **Installation ID** を控える: インストール後の URL `https://github.com/settings/installations/<この数字>`

### 2. Discord Bot の作成

<https://discord.com/developers/applications> で Bot を作成します。

1. `Bot` タブで **MESSAGE CONTENT INTENT** を ON
2. `OAuth2 URL Generator` で以下の権限を付けてサーバーに招待:
   - Scopes: `bot`
   - Permissions: `View Channels`, `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Read Message History`
3. Bot Token を控える
4. 投稿先のテキストチャンネル ID を控える

### 3. Codex CLI の認証

ホストで `codex login` を済ませ、`~/.codex` に認証情報を用意します。
API キーを使う場合は `.env` に `OPENAI_API_KEY=...` を追加してください (compose が自動注入)。

### 4. 設定ファイルの準備

```bash
cp .env.example .env
cp config.example.yml config.yml
```

`.env` を編集:

```env
# webhook 署名検証用 (GitHub Secrets の CODEX_REVIEW_SECRET と同じ値)
WEBHOOK_SECRET=<長いランダム文字列>

# GitHub App 認証 (必須)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./github-app-key.pem
GITHUB_APP_INSTALLATION_ID=78901234

# Discord Bot
DISCORD_BOT_TOKEN=<Bot Token>
DISCORD_CHANNEL_ID=<チャンネル ID>
```

### 5. ビルドと起動

```bash
# Vite+ のインストール (初回のみ)
curl -fsSL https://vite.plus | bash    # Linux / macOS
# irm https://vite.plus/ps1 | iex     # Windows (PowerShell)

# ビルドと起動
pnpm install
pnpm build
docker compose up -d --build
docker compose logs -f
```

`https://your-domain/webhook` が外部からアクセスできることを確認してください。

### 6. レビュー対象リポジトリへの Actions 追加

[`actions/codex-review.yml`](./actions/codex-review.yml) を対象リポの `.github/workflows/codex-review.yml` にコピーし、以下の Secrets を設定:

| Secret | 値 |
|--------|---|
| `CODEX_REVIEW_URL` | Bot の公開 URL (例: `https://review.example.com`) |
| `CODEX_REVIEW_SECRET` | `.env` の `WEBHOOK_SECRET` と同じ値 |

## 環境変数リファレンス (.env)

| 変数 | 必須 | デフォルト | 説明 |
|------|:----:|-----------|------|
| `WEBHOOK_SECRET` | **必須** | - | HMAC-SHA256 署名検証用 (8 文字以上) |
| `GITHUB_APP_ID` | **必須** | - | GitHub App の App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | **必須** | - | PEM 秘密鍵のファイルパス |
| `GITHUB_APP_INSTALLATION_ID` | **必須** | - | GitHub App の Installation ID |
| `DISCORD_BOT_TOKEN` | **必須** | - | Discord Bot Token |
| `DISCORD_CHANNEL_ID` | **必須** | - | レビュー投稿先チャンネル ID |
| `HTTP_HOST` | | `127.0.0.1` | リスンアドレス |
| `HTTP_PORT` | | `3000` | リスンポート |
| `CODEX_BIN` | | `codex` | Codex CLI のパス |
| `CODEX_EXTRA_ARGS` | | - | Codex 追加引数 (例: `--model gpt-5-codex --full-auto`) |
| `CODEX_TIMEOUT_MS` | | `900000` | Codex 実行タイムアウト (ms) |
| `WORKSPACES_DIR` | | `/app/workspaces` | clone 先ディレクトリ |
| `DATA_DIR` | | `/app/data` | SQLite 保存先 |
| `LOG_LEVEL` | | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `CONFIG_FILE` | | `/app/config.yml` | config ファイルパス |

## 設定リファレンス (config.yml)

### events

| キー | デフォルト | 説明 |
|------|-----------|------|
| `push` | `true` | push イベントのレビュー |
| `pull_request` | `true` | PR イベントのレビュー |
| `issues` | `true` | Issue イベントの分析 |

### filters

| キー | デフォルト | 説明 |
|------|-----------|------|
| `repositories` | `[]` | 許可リポ (`owner/repo` or `owner/*`)。空なら全許可 |
| `branches` | `[]` | push 対象ブランチ。空なら全許可 |
| `skipDraftPullRequests` | `true` | Draft PR をスキップ |
| `skipBotSenders` | `true` | `*[bot]` sender をスキップ |

### review

| キー | デフォルト | 説明 |
|------|-----------|------|
| `maxDiffChars` | `200000` | diff の最大文字数 (超過分は切り詰め) |
| `cloneDepth` | `50` | shallow clone の depth (0 で full clone) |
| `includeExtensions` | `[]` | レビュー対象の拡張子 (例: `["ts", "js"]`)。空なら全て |
| `excludePaths` | `[]` | 除外パス (glob 風: `node_modules/**`, `*.lock` 等) |

### github

| キー | デフォルト | 説明 |
|------|-----------|------|
| `prReviewComment` | `true` | PR にレビューコメントを投稿 |
| `pushIssueOnSevere` | `true` | push で Critical/High 検出時に Issue を自動作成 |

### discord

| キー | デフォルト | 説明 |
|------|-----------|------|
| `chunkSize` | `1900` | 1 メッセージの最大文字数 (上限 2000) |
| `threadAutoArchiveMinutes` | `1440` | `60` / `1440` / `4320` / `10080` |
| `enableThreadChat` | `true` | スレッド内での対話応答 |

## GitHub フィードバック

`codex-review[bot]` の名義で GitHub に直接フィードバックします。

- **PR レビューコメント**: `pulls.createReview` で PR にレビュー本文を投稿。`config.github.prReviewComment` で制御
- **push Issue 自動作成**: レビューに `重大度: Critical` または `重大度: High` が含まれる場合、`codex-review` ラベル付きの Issue を自動起票。`config.github.pushIssueOnSevere` で制御

いずれも best-effort で動作し、GitHub API エラーは Discord 投稿やキュー処理をブロックしません。

## スレッド内での対話

レビュー投稿後、Discord にスレッドが自動作成されます。スレッド内にメッセージを書くと、Bot が会話履歴と clone 済みリポジトリを Codex に渡して応答します。

### workspace のライフサイクル

| 状態 | 挙動 |
|------|------|
| **通常運用** | 最後の活動から `threadAutoArchiveMinutes` 経過で自動削除 (10 分間隔スイープ)。会話中は TTL リセット |
| **プロセス再起動** | 全 workspace 消失。会話履歴は SQLite に残るが、実ファイル参照なしの応答になる |
| **異常終了** | `WORKSPACES_DIR` にディレクトリが残る。手動削除が必要 |

## 開発

```bash
pnpm install
pnpm dev          # tsx watch (Node 直起動)
pnpm build        # vp build (dist/index.js を生成)
pnpm test         # vp test
pnpm test:watch   # vp test watch
pnpm coverage     # vp test run --coverage
pnpm check        # vp check (Oxlint + Oxfmt + tsc)
pnpm typecheck    # tsc --noEmit
```

テストは `vite-plus/test` から import し、`src/**/*.test.ts` に配置。現在 100 テスト / カバレッジ約 61%。

## セキュリティ

- 全 webhook は HMAC-SHA256 (`X-Codex-Review-Signature: sha256=<hex>`) で検証
- GitHub トークンは `GIT_CONFIG_*` 環境変数経由で git に渡し、URL やコマンドラインに露出しない
- GitHub App は **Private** (自分のアカウントのみインストール可能) に設定
- Docker コンテナは非 root 化を行っていません。必要に応じて `USER node` を追加してください
