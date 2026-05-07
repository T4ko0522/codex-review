# syntax=docker/dockerfile:1.7

# ── build stage ──────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml vite.config.ts tsconfig.json ./
COPY src ./src

RUN --mount=type=cache,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build

# ── runtime stage ────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@latest

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,target=/pnpm/store pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data /app/workspaces
EXPOSE 3000
CMD ["node", "dist/index.js"]
