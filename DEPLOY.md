# デプロイ手順

codex-review サーバーを本番環境へ導入するための詳細手順です。セルフホスト (Docker) を前提に、事前準備 → サーバー起動 → GitHub Actions 連携 → 公開 → 運用 の順で進めます。

## 目次

1. [前提条件](#前提条件)
2. [事前準備](#事前準備)
   - [GitHub App の作成](#1-github-app-の作成)
   - [Discord Bot の作成](#2-discord-bot-の作成)
   - [Codex CLI の認証](#3-codex-cli-の認証)
3. [サーバーのセットアップ](#サーバーのセットアップ)
4. [レビュー対象リポジトリの設定](#レビュー対象リポジトリの設定)
5. [本番公開](#本番公開)
6. [運用](#運用)
7. [トラブルシューティング](#トラブルシューティング)

## 前提条件

| 項目             | 要件                                           |
| ---------------- | ---------------------------------------------- |
| Node.js          | >= 20.11                                       |
| pnpm             | 9.x (corepack 経由)                            |
| Vite+ (`vp`)     | ホスト側にインストール (ビルド用)              |
| Docker           | compose v2                                     |
| Git              | >= 2.31                                        |
| OpenAI Codex CLI | `~/.codex` に認証情報、または `OPENAI_API_KEY` |
| 公開 URL         | GitHub Actions から到達可能な HTTPS エンドポイント |

Vite+ は次のコマンドでインストールできます (初回のみ)。

```bash
curl -fsSL https://vite.plus | bash    # Linux / macOS

irm https://vite.plus/ps1 | iex      # Windows (PowerShell)
```

## 事前準備

### 1. GitHub App の作成

<https://github.com/settings/apps/new> で App を作成します。

| 設定項目                         | 値                                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| App name                         | 任意 (mention 既定値に合わせるなら `CodexRabbit`)                                                                           |
| Homepage URL                     | 任意                                                                                                                        |
| Webhook                          | **Active のチェックを外す** (不要)                                                                                          |
| Repository permissions           | `Administration: Read`, `Contents: Read & Write`, `Issues: Read & Write`, `Pull requests: Read & Write` |
| Where can this app be installed? | **Only on this account**                                                                                                    |

> **App 名と `mention.triggers` の整合性**: `config.yml` の `mention.triggers` の既定値は `@CodexRabbit[bot]` です。別の App 名にした場合は `mention.triggers` をその名前に合わせて書き換えてください。
>
> **permissions 追加の反映**: 既存の App に Permissions を追加した場合、GitHub 側の Installation 画面で「Accept new permissions」を押さないと新権限が有効になりません。

各 permission の用途:

- `Administration: Read` — `events.push.mode: protected-only` で `getBranchProtection` を呼ぶのに必須
- `Contents: Read & Write` — レビュー対象コード取得 (Read) + `repos.createCommitComment` (Write)
- `Issues: Read & Write` — Issue レビュー取得 + `pushIssueOnSevere` で Issue 起票
- `Pull requests: Read & Write` — PR レビューコメント投稿 + mention 経由で `pulls.get` 呼び出し

作成後:

1. **App ID** を控える (App 設定ページ上部の `App ID`)
2. **秘密鍵を生成**: Private keys > Generate a private key → PEM ファイルをダウンロード
3. **App をインストール**: Install App > 対象リポジトリを選択
4. **Installation ID** を控える: インストール後の URL `https://github.com/settings/installations/<この数字>`

PEM ファイルはサーバー上で `GITHUB_APP_PRIVATE_KEY_PATH` が指すパスに配置します。Docker コンテナからは `/app/github-app-key.pem` として読み込まれます。

### 2. Discord Bot の作成

<https://discord.com/developers/applications> で Bot を作成します。

1. `Bot` タブで **MESSAGE CONTENT INTENT** を ON
2. `OAuth2 URL Generator` で以下の権限を付けてサーバーに招待
   - Scopes: `bot`
   - Permissions: `View Channels`, `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Read Message History`
3. Bot Token を控える
4. 投稿先のテキストチャンネル ID を控える

### 3. Codex CLI の認証

ホストで `codex login` を済ませ、`~/.codex` に認証情報を用意します。compose ファイルはホストの `${CODEX_AUTH_DIR:-$HOME/.codex}` をコンテナ内 `/root/.codex` に **rw** でマウントするため、トークンリフレッシュが透過的に行われます。

API キー方式を使う場合は `.env` に `OPENAI_API_KEY=...` を追加してください (compose が自動注入)。

## サーバーのセットアップ

### 1. 設定ファイルの準備

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

環境変数の全リストは README の「環境変数リファレンス」を参照してください。

`config.yml` ではイベントの ON/OFF、レビュー対象リポジトリのホワイトリスト、Discord 投稿フォーマットなどを調整できます。詳細は README の「設定リファレンス」を参照してください。

### 2. ビルドと起動

Vite+ はホスト側でのみ走らせる方針です。Docker イメージはビルド済みの `dist/` を取り込むだけなので、先にホストでビルドしてください。

```bash
pnpm install
pnpm build                      # = vp build (dist/index.js を生成)
docker compose up -d --build
docker compose logs -f codex-review
```

### 3. 動作確認

```bash
curl -fsS http://127.0.0.1:3000/health
```

`{"status":"ok"}` 相当が返れば起動成功です。compose の healthcheck も同じエンドポイントを叩いているため、`docker compose ps` で `healthy` になることを確認してください。

外部からは `https://your-domain/webhook` が到達可能である必要があります。公開手順は [本番公開](#本番公開) を参照してください。

## レビュー対象リポジトリの設定

[`actions/codex-review.yml`](./actions/codex-review.yml) を対象リポの `.github/workflows/codex-review.yml` にコピーし、リポジトリの Secrets を設定します。

| Secret                | 値                                                |
| --------------------- | ------------------------------------------------- |
| `CODEX_REVIEW_URL`    | Bot の公開 URL (例: `https://review.example.com`) |
| `CODEX_REVIEW_SECRET` | `.env` の `WEBHOOK_SECRET` と同じ値               |

ワークフローは `push` / `pull_request_target` / `issues` / `issue_comment` の 4 イベントで発火し、HMAC-SHA256 署名付きで `/webhook` に POST します。fork PR は `pull_request_target` で secrets にアクセスできる設計ですが、チェックアウトは行わないためコード実行のリスクはありません。`issue_comment` は mention 経由レビューのトリガで、本文に `mention.triggers` の文字列を含むコメントだけがサーバー側で採用されます。

## 本番公開

GitHub Actions から到達可能にするには、リバースプロキシ + TLS 終端を前段に置くのが一般的です。代表的な構成例:

### Caddy (例)

```caddyfile
review.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

### Nginx (例)

```nginx
server {
  listen 443 ssl http2;
  server_name review.example.com;

  # TLS 設定は省略

  location /webhook {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 60s;
  }

  location /health {
    proxy_pass http://127.0.0.1:3000;
  }
}
```

補足:

- `HTTP_HOST=0.0.0.0` でリッスンする場合はファイアウォールで 3000 番ポートを絞ってください。コンテナのポートバインドは `compose.yml` の `ports:` で制御しています。
- GitHub Actions からの POST はリクエストボディがそこそこ大きくなることがあります。プロキシのリクエストボディサイズ上限 (Nginx なら `client_max_body_size`) は 10MB 程度を目安に緩めてください。
- `/webhook` 以外のエンドポイントは外部公開する必要がありません。`/health` 以外は閉じても構いません。

## 運用

### ログ確認

```bash
docker compose logs -f codex-review
```

`LOG_LEVEL=debug` に切り替えるとキューイング・Codex 実行・GitHub/Discord API 呼び出しの詳細が追えます。

### 更新手順

```bash
git pull
pnpm install
pnpm build
docker compose up -d --build
```

`dist/` はホストでビルドした成果物をそのままイメージに COPY する方式のため、ビルドを忘れるとコンテナ内のコードが古いままになります。

### ヘルスチェック

compose の healthcheck は 30 秒間隔で `/health` を叩きます。`docker compose ps` で `unhealthy` が続く場合は `docker compose logs codex-review` でエラー原因を確認してください。Codex CLI のログインが切れているケースが多いです。

### workspace / データの永続化

| ボリューム           | 用途                                              |
| -------------------- | ------------------------------------------------- |
| `codex-data`         | SQLite (会話履歴、ジョブ状態)                     |
| `codex-workspaces`   | clone 済みリポジトリ。TTL 経過で自動削除          |

`config.yml` の `workspace.ttlMinutes` (デフォルト 1440 分) を過ぎた非活性スレッドの workspace は 10 分間隔の sweep で削除されます。プロセス異常終了時は残骸が残ることがあり、その場合は `docker compose down` 後にボリューム内を手動掃除してください。

### バックアップ

会話履歴を保全したい場合は `codex-data` ボリュームをバックアップ対象にしてください。

```bash
docker run --rm -v codex-data:/data -v "$PWD":/backup busybox \
  tar czf /backup/codex-data-$(date +%Y%m%d).tgz -C /data .
```

## トラブルシューティング

| 症状                                              | 確認ポイント                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| webhook が 401 を返す                             | `.env` の `WEBHOOK_SECRET` と GitHub Secrets の `CODEX_REVIEW_SECRET` が一致しているか    |
| PR にコメントが付かない                           | GitHub App の権限 / Installation ID / PEM ファイルのパス。`docker compose logs` にエラー  |
| Discord にスレッドが立たない                      | Bot 招待時の権限、`DISCORD_CHANNEL_ID`、`MESSAGE CONTENT INTENT` の ON                    |
| Codex 実行がタイムアウトする                      | `CODEX_TIMEOUT_MS` の延長、`CODEX_EXTRA_ARGS` のモデル指定、ホストの `codex login` 状態   |
| clone が遅い / 失敗する                           | `review.cloneDepth` を増やす、プライベートリポジトリは GitHub App の `Contents: Read` 必須 |
| `healthcheck` が unhealthy のまま                 | `/health` を手動で叩いて 200 が返るか、コンテナ内 `node` の起動ログ                        |

追加の質問や再現手順は Issue で共有してください。
