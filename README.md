# codex-review

GitHub リポジトリの push / pull_request / issues を契機に **OpenAI Codex CLI** でレビューを実行し、Discord のチャンネルへ Markdown で投稿するボットです。投稿されたレビューのスレッド内でメッセージを書くと Codex がそのまま追加応答します。

- 言語: TypeScript (ESM, Node.js 20)
- HTTP: Fastify + HMAC-SHA256 署名検証
- レビュー: `@openai/codex` を子プロセスで起動 (`codex exec`)
- 通知先: Discord Bot (discord.js v14)
- 永続化: better-sqlite3
- ツールチェーン: **Vite+ (`vp`)** で build / test / check を統合
- デプロイ: Docker + docker compose (事前に `vp build` した `dist/` を取り込む)

## 全体フロー

```
GitHub (push/PR/issue)
      │  GitHub Actions
      ▼
  ┌─────────────────────┐     HMAC 署名付 POST
  │ actions/codex-review│ ─────────────────────┐
  └─────────────────────┘                      ▼
                                    ┌──────────────────────┐
                                    │  Linux Host (Docker) │
                                    │                      │
                                    │  Fastify /webhook    │
                                    │     │                │
                                    │     ▼                │
                                    │  p-queue (serial)    │
                                    │     │                │
                                    │     ▼                │
                                    │  git clone → diff    │
                                    │     │                │
                                    │     ▼                │
                                    │  codex exec (CLI)    │
                                    │     │                │
                                    │     ▼                │
                                    │  Discord Bot         │
                                    │   ├─ 親メッセージ    │
                                    │   └─ スレッド投稿    │
                                    │       ↑              │
                                    │       └─ 返信を監視  │
                                    │           → codex    │
                                    └──────────────────────┘
```

## セットアップ

### 1. Discord Bot の用意

1. <https://discord.com/developers/applications> で Bot を作成
2. `Bot` タブで **MESSAGE CONTENT INTENT** を ON
3. `OAuth2 URL Generator` → scopes=`bot`、permissions=`View Channels`, `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Read Message History` を付けてサーバーに招待
4. Bot Token を控える → `.env` の `DISCORD_BOT_TOKEN`
5. 投稿先のテキストチャンネル ID を控える → `.env` の `DISCORD_CHANNEL_ID`

### 2. ホスト側 codex CLI 認証の用意

ホストで一度 `codex login` などを済ませ、`~/.codex` に認証情報が入っている状態にします。コンテナはこのディレクトリを read-write で bind mount して使用します。API キー派の場合は `.env` に `OPENAI_API_KEY=...` を書いても構いません (`docker compose` が自動で注入します)。

### 3. 設定ファイル

```bash
cp .env.example .env
cp config.example.yml config.yml
# 値を編集
```

`WEBHOOK_SECRET` は十分に長いランダム文字列にしてください (同じ値を GitHub Secrets にも登録します)。

### 4. ホストに Vite+ (vp) をインストール

ビルドはホスト側で行います (Docker イメージには同梱しません)。

```bash
# Linux / macOS
curl -fsSL https://vite.plus | bash

# Windows (PowerShell)
irm https://vite.plus/ps1 | iex
```

動作確認:

```bash
vp help
```

### 5. 起動

```bash
pnpm install
pnpm build              # = vp build (dist/ を生成)
docker compose up -d --build
docker compose logs -f
```

公開 URL (`https://your-domain/webhook`) が到達できることを確認します。

### 6. レビュー対象リポジトリに GitHub Actions を追加

[`actions/codex-review.yml`](./actions/codex-review.yml) を対象リポジトリの `.github/workflows/codex-review.yml` にコピーし、以下の Secrets を設定します。

| Secret                | 内容                                             |
| --------------------- | ------------------------------------------------ |
| `CODEX_REVIEW_URL`    | Bot の公開 URL (例 `https://review.example.com`) |
| `CODEX_REVIEW_SECRET` | Bot の `.env` の `WEBHOOK_SECRET` と同じ値       |

## 設定リファレンス (config.yml)

- `events.push` / `events.pull_request` / `events.issues`: イベント毎の ON/OFF
- `filters.repositories`: `owner/repo` もしくは `owner/*` のホワイトリスト。空なら全許可
- `filters.branches`: push 時のブランチフィルタ。空なら全許可
- `filters.skipDraftPullRequests`: Draft PR をスキップ
- `filters.skipBotSenders`: sender が `*[bot]` ならスキップ
- `review.maxDiffChars`: diff の文字数上限 (超えた分は切り詰め)
- `review.cloneDepth`: `git clone --depth`。0 以下で full clone
- `review.includeExtensions`: レビュー対象の拡張子 (空なら全て)
- `review.excludePaths`: 除外パス (glob 風。lockfile や dist 等)
- `github.prReviewComment`: PR にレビューコメントを投稿 (`GITHUB_TOKEN` 必須)
- `github.pushIssueOnSevere`: push レビューで Critical/High 検出時に Issue を自動作成
- `discord.chunkSize`: 1 メッセージ最大文字数 (≤ 2000)
- `discord.threadAutoArchiveMinutes`: 60 / 1440 / 4320 / 10080
- `discord.enableThreadChat`: スレッド内での対話応答を有効化

## GitHub フィードバック

`GITHUB_TOKEN` (repo スコープの PAT) を設定すると、レビュー結果を Discord だけでなく GitHub にも直接反映します。

- **PR レビューコメント**: `pull_request` イベント時、`pulls.createReview` で PR にレビュー本文を投稿します (`config.github.prReviewComment`)。
- **push Issue 自動作成**: `push` イベント時、レビューに Critical / High の指摘が含まれていれば Issue を自動起票します (`config.github.pushIssueOnSevere`)。ラベル `codex-review` が付与されます。

いずれも best-effort で動作し、GitHub API エラーは Discord 投稿やキュー処理をブロックしません。

## スレッド内での対話

レビュー投稿直後、Bot がスレッドを自動作成してレビュー本文を流し込みます。同じスレッドへメッセージを書くと、Bot が履歴と併せて Codex に渡して応答します。作業ディレクトリ (clone 済みリポジトリ) はそのスレッドのコンテキストに紐付いて保持されるため、Codex は実ファイルを参照しながら回答できます。

### workspace のライフサイクル

- **TTL**: 最後の活動 (投稿 or follow-up 応答) から `threadAutoArchiveMinutes` が経過すると、10 分間隔のスイープで workspace を自動削除します。会話を続けている間は TTL がリセットされるため、active なスレッドの workspace は維持されます。
- **再起動**: プロセス再起動時は全 workspace が失われます。SQLite のスレッド情報は残るため会話履歴と SHA は参照可能ですが、実ファイル参照なしの応答になります。
- **異常終了**: SIGKILL 等でスイープや shutdown cleanup が走らなかった場合、永続 volume にディレクトリが残ります。手動で `WORKSPACES_DIR` 内の古いディレクトリを削除してください。

## 開発

```bash
pnpm install
pnpm dev          # tsx watch (Vite+ 管轄外。Node 直起動)
pnpm build        # vp build (Rolldown SSR で dist/index.js を生成)
pnpm test         # vp test (CI 向けに単発実行)
pnpm test:watch   # vp test watch
pnpm coverage     # vp test run --coverage
pnpm check        # vp check (Oxlint + Oxfmt + tsc)
pnpm typecheck    # tsc --noEmit
```

### テスト

Vite+ の `vp test` (内部は Vitest) を使用。設定は `vite.config.ts` の `test` ブロックに統合しています。テストコードは `'vite-plus/test'` から `describe / it / expect / vi` を import します。

```ts
import { describe, it, expect } from "vite-plus/test";
```

対象は `src/**/*.test.ts`。ロジック層 (HMAC 検証 / GitHub payload 変換 / 設定フィルタ / Markdown チャンク分割 / 引数分割) を中心にカバーしています。

### Vite+ の前提

- Vite+ は 2026-03 に Alpha 公開された統合ツールチェーン。CLI 名 `vp`、npm パッケージ `vite-plus`
- このリポジトリでは build / test / check を `vp` に集約し、`tsdown` / `vitest` / `eslint` は devDep から除去
- Docker イメージには `vp` を入れず、ホストでビルド済みの `dist/` を COPY するだけの構成

## セキュリティ

- 全ての受信は HMAC-SHA256 でチェックします (`X-Codex-Review-Signature: sha256=<hex>`)
- `GITHUB_TOKEN` は `GIT_CONFIG_*` 環境変数経由で git に渡し、URL やコマンドラインには露出しません
- Docker コンテナは非 root 化を行っていません (codex の挙動によっては後述の改修が必要)。必要に応じて `USER node` を追加してください
