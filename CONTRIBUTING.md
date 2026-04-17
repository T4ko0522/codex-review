# Contributing

CodexRabbit への貢献に興味を持っていただきありがとうございます。

## 開発環境のセットアップ

```bash
pnpm install
```

## 開発コマンド

```bash
pnpm dev          # tsx watch (Node 直起動)
pnpm build        # vp build (dist/index.js を生成)
pnpm test         # vp test
pnpm test:watch   # vp test watch
pnpm coverage     # vp test run --coverage
pnpm check        # vp check (Oxlint + Oxfmt + tsc)
pnpm typecheck    # tsc --noEmit
```
