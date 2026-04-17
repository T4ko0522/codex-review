import { describe, expect, it } from "vite-plus/test";
import { hasSevereFindings } from "./feedback.ts";

describe("hasSevereFindings", () => {
	it("detects Critical severity", () => {
		const md = `## 主要な指摘\n### src/index.ts:10 重大度: Critical\nSQLインジェクション`;
		expect(hasSevereFindings(md)).toBe(true);
	});

	it("detects High severity", () => {
		const md = `## 主要な指摘\n### src/auth.ts:5 重大度: High\nトークン漏えい`;
		expect(hasSevereFindings(md)).toBe(true);
	});

	it("returns false for Medium severity only", () => {
		const md = `## 主要な指摘\n### src/util.ts:3 重大度: Medium\nエラーハンドリング不足`;
		expect(hasSevereFindings(md)).toBe(false);
	});

	it("returns false for Low/Nit severity only", () => {
		const md = `## 主要な指摘\n### src/util.ts:3 重大度: Low\n命名の改善提案\n### src/index.ts:1 重大度: Nit\nインポート順`;
		expect(hasSevereFindings(md)).toBe(false);
	});

	it("returns false when findings section says 特になし", () => {
		const md = `## 主要な指摘\n特になし\n\n## 良かった点\n- 読みやすい`;
		expect(hasSevereFindings(md)).toBe(false);
	});

	it("returns false when 特になし even with severity keywords elsewhere", () => {
		const md = `## 概要\nCritical path のリファクタリング\n## 主要な指摘\n特になし`;
		expect(hasSevereFindings(md)).toBe(false);
	});

	it("returns false for empty string", () => {
		expect(hasSevereFindings("")).toBe(false);
	});
});
