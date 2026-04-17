import type { ReviewJob } from "../types.ts";

const SYSTEM_PREFIX = `あなたは熟練のシニアソフトウェアエンジニアとしてコードレビューを行います。
- 出力は **日本語の GitHub-Flavored Markdown** で返してください。
- 不必要な前置きや謝辞は書かない。事実に基づき具体的に指摘する。
- 推測に頼らず、diff や周辺コードを根拠として示す。
- セキュリティ(OWASP Top10 相当), ロジックの正しさ, パフォーマンス, 可読性/保守性, テスト観点の順で重要なものから述べる。
- 指摘ごとに \`file:line\` を付与し、コピペで直せるパッチ例を短く添える。
- 問題が見当たらない観点は触れない (埋め草を書かない)。`;

export function buildReviewPrompt(job: ReviewJob, diff: string): string {
  if (job.kind === "issues") return buildIssueReviewPrompt(job);

  const head = job.sha ? `HEAD: \`${job.sha}\`` : "";
  const base = job.baseSha ? `BASE: \`${job.baseSha}\`` : "";
  const ref = job.ref ? `ref: \`${job.ref}\`` : "";
  const summary = job.summary ? `\n### コミット一覧\n${job.summary}` : "";
  const body = job.body ? `\n### 本文\n${job.body}` : "";

  return `${SYSTEM_PREFIX}

# レビュー対象
- リポジトリ: \`${job.repo}\`
- イベント: \`${job.kind}${job.action ? `/${job.action}` : ""}\`
- 送信者: \`${job.sender}\`
- URL: ${job.htmlUrl}
${[ref, base, head].filter(Boolean).join(" / ")}
${summary}${body}

## diff
以下の unified diff が今回の変更点です。作業ディレクトリには実ファイルが展開されているため、必要に応じて読み取って判断してください。

\`\`\`diff
${diff || "(diff 取得失敗 — ファイルを直接読んで判断してください)"}
\`\`\`

## 期待する出力フォーマット
\`\`\`
## 概要
<今回の変更を 2〜4 行で要約>

## 主要な指摘
### <file:line> 重大度: Critical|High|Medium|Low|Nit
<何が問題か。根拠。修正案 (必要ならコードブロックで差分)>

### ...

## 良かった点
- <箇条書きで任意>

## リスク評価
- デプロイ影響:
- 回帰リスク:
- テスト不足:
\`\`\`

指摘が無ければ「## 主要な指摘」に「特になし」と記載して構いません。`;
}

function buildIssueReviewPrompt(job: ReviewJob): string {
  return `${SYSTEM_PREFIX}

# Issue レビュー対象
- リポジトリ: \`${job.repo}\`
- Issue: #${job.number} ${job.title}
- URL: ${job.htmlUrl}
- 送信者: \`${job.sender}\`

## 本文
${job.body || "(本文なし)"}

## 期待する出力
\`\`\`
## 概要
<Issue の意図を 2〜3 行で要約>

## 不足情報
- <再現手順 / 期待結果 / 環境 など足りない要素を指摘>

## 優先度の目安
- <Low/Medium/High と根拠>

## 解決アプローチ案
1. <調査 / 実装方針を箇条書きで>
\`\`\`
`;
}

/**
 * スレッドでの追加質問用プロンプト。履歴は最新 N 件のみ渡す。
 */
export function buildFollowUpPrompt(
  job: ReviewJob,
  history: Array<{ role: string; content: string }>,
  userMessage: string,
): string {
  const transcript = history
    .map((m) => {
      const label =
        m.role === "user" ? "ユーザー" : m.role === "review" ? "レビュー初回" : "アシスタント";
      return `### ${label}\n${m.content}`;
    })
    .join("\n\n");

  return `${SYSTEM_PREFIX}

# コンテキスト
- リポジトリ: \`${job.repo}\`
- 元イベント: \`${job.kind}${job.action ? `/${job.action}` : ""}\`
- 対象 URL: ${job.htmlUrl}
${job.sha ? `- SHA: \`${job.sha}\`` : ""}

# これまでのやり取り
${transcript}

# 新しい質問
${userMessage}

上記のやり取りとリポジトリの内容を踏まえ、**日本語 Markdown** で簡潔に回答してください。
必要であれば \`rg\` や \`cat\` でファイルを確認して根拠を示してください。`;
}
