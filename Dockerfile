# syntax=docker/dockerfile:1.7
#
# Vite+ (vp) はホスト側でのみ走らせる方針。
# このイメージは事前に `vp build` 済みの dist/ を取り込むだけ。
#
# ビルド手順:
#   pnpm build              # = vp build (host で実行)
#   docker compose up -d --build

FROM node:20-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex

WORKDIR /app

# production 依存のみインストール (better-sqlite3 のビルドのため python3/make/g++ が必要)
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --prod --no-frozen-lockfile

# ホストでビルドした成果物を取り込む
COPY dist ./dist

RUN mkdir -p /app/data /app/workspaces
EXPOSE 3000
CMD ["node", "dist/index.js"]
