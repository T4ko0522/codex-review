import { describe, expect, it } from "vite-plus/test";
import { buildJobFromPayload, stripNonMentionContent } from "./events.ts";

describe("stripNonMentionContent", () => {
  it("removes fenced code blocks", () => {
    expect(stripNonMentionContent("before\n```\n@bot\n```\nafter")).toBe("before\n\nafter");
  });

  it("removes inline code", () => {
    expect(stripNonMentionContent("see `@bot` here")).toBe("see  here");
  });

  it("removes blockquote lines", () => {
    expect(stripNonMentionContent("> quoted @bot\nreal text")).toBe("\nreal text");
  });

  it("preserves normal text", () => {
    expect(stripNonMentionContent("hello @bot")).toBe("hello @bot");
  });
});

describe("buildJobFromPayload - push", () => {
  it("maps push event with head_commit", () => {
    const job = buildJobFromPayload({
      event: "push",
      repository: "acme/widget",
      sender: "alice",
      payload: {
        ref: "refs/heads/main",
        before: "aaaa000",
        after: "bbbb111",
        compare: "https://github.com/acme/widget/compare/aaaa...bbbb",
        head_commit: { id: "bbbb111", message: "feat: add thing\n\nbody" },
        commits: [
          { id: "cccc222", message: "chore: first\nextra" },
          { id: "bbbb111", message: "feat: add thing" },
        ],
        pusher: { name: "alice" },
      },
    });
    expect(job).not.toBeNull();
    expect(job!.kind).toBe("push");
    expect(job!.sha).toBe("bbbb111");
    expect(job!.baseSha).toBe("aaaa000");
    expect(job!.ref).toBe("refs/heads/main");
    expect(job!.summary).toContain("chore: first");
    expect(job!.summary).not.toContain("\nextra"); // first line only
    expect(job!.htmlUrl).toMatch(/compare/);
  });

  it("returns null when no commits", () => {
    const job = buildJobFromPayload({
      event: "push",
      repository: "acme/widget",
      sender: "",
      payload: { ref: "refs/heads/main", commits: [] },
    });
    expect(job).toBeNull();
  });
});

describe("buildJobFromPayload - pull_request", () => {
  const basePayload = {
    action: "opened",
    pull_request: {
      number: 42,
      title: "Refactor auth",
      body: "desc",
      draft: false,
      html_url: "https://github.com/acme/widget/pull/42",
      user: { login: "bob" },
      head: { ref: "feature/auth", sha: "hhhh111" },
      base: { ref: "main", sha: "bbbb000" },
    },
  };

  it("maps opened PR", () => {
    const job = buildJobFromPayload({
      event: "pull_request",
      repository: "acme/widget",
      sender: "bob",
      payload: basePayload,
    });
    expect(job?.kind).toBe("pull_request");
    expect(job?.number).toBe(42);
    expect(job?.sha).toBe("hhhh111");
    expect(job?.baseSha).toBe("bbbb000");
    expect(job?.ref).toBe("feature/auth");
    expect(job?.baseRef).toBe("main");
    expect(job?.isDraft).toBe(false);
    expect(job?.action).toBe("opened");
    expect(job?.triggeredBy).toBe("auto");
  });

  it("flags draft PR", () => {
    const job = buildJobFromPayload({
      event: "pull_request",
      repository: "acme/widget",
      sender: "bob",
      payload: { ...basePayload, pull_request: { ...basePayload.pull_request, draft: true } },
    });
    expect(job?.isDraft).toBe(true);
  });

  it("skips closed PR", () => {
    const job = buildJobFromPayload({
      event: "pull_request",
      repository: "acme/widget",
      sender: "bob",
      payload: { ...basePayload, action: "closed" },
    });
    expect(job).toBeNull();
  });
});

describe("buildJobFromPayload - issues", () => {
  it("maps opened issue", () => {
    const job = buildJobFromPayload({
      event: "issues",
      repository: "acme/widget",
      sender: "carol",
      payload: {
        action: "opened",
        issue: {
          number: 7,
          title: "Bug",
          body: "steps",
          html_url: "https://github.com/acme/widget/issues/7",
          user: { login: "carol" },
        },
      },
    });
    expect(job?.kind).toBe("issues");
    expect(job?.number).toBe(7);
    expect(job?.body).toBe("steps");
  });

  it("skips PR-originated issue events", () => {
    const job = buildJobFromPayload({
      event: "issues",
      repository: "acme/widget",
      sender: "carol",
      payload: {
        action: "opened",
        issue: { number: 7, title: "Bug", pull_request: { url: "x" } },
      },
    });
    expect(job).toBeNull();
  });

  it("skips unsupported actions", () => {
    const job = buildJobFromPayload({
      event: "issues",
      repository: "acme/widget",
      sender: "",
      payload: { action: "labeled", issue: { number: 1, title: "x" } },
    });
    expect(job).toBeNull();
  });
});

describe("buildJobFromPayload - issue_comment", () => {
  const prCommentPayload = {
    action: "created",
    comment: {
      id: 9999,
      body: "re-review please @CodexRabbit[bot]",
      html_url: "https://github.com/acme/widget/pull/42#issuecomment-9999",
      user: { login: "bob" },
    },
    issue: {
      number: 42,
      title: "Refactor auth",
      body: "desc",
      html_url: "https://github.com/acme/widget/pull/42",
      pull_request: { url: "https://api.github.com/acme/widget/pulls/42" },
    },
  };

  const issueCommentPayload = {
    action: "created",
    comment: {
      id: 7777,
      body: "please triage @CodexRabbit[bot]",
      html_url: "https://github.com/acme/widget/issues/7#issuecomment-7777",
      user: { login: "carol" },
    },
    issue: {
      number: 7,
      title: "Bug",
      body: "steps",
      html_url: "https://github.com/acme/widget/issues/7",
    },
  };

  it("returns null when triggers are empty", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: prCommentPayload,
      },
      { mentionTriggers: [] },
    );
    expect(job).toBeNull();
  });

  it("returns null when comment body does not contain any trigger", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: {
          ...prCommentPayload,
          comment: { ...prCommentPayload.comment, body: "just a note" },
        },
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job).toBeNull();
  });

  it("skips unsupported comment actions", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: { ...prCommentPayload, action: "deleted" },
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job).toBeNull();
  });

  it("builds a pull_request job from PR comment mention", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: prCommentPayload,
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job?.kind).toBe("pull_request");
    expect(job?.number).toBe(42);
    expect(job?.triggeredBy).toBe("mention");
    expect(job?.commentId).toBe(9999);
    expect(job?.action).toBe("mention");
    // sha/baseSha は payload に無いため server 側で補完される
    expect(job?.sha).toBeUndefined();
  });

  it("builds an issues job from Issue comment mention", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "carol",
        payload: issueCommentPayload,
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job?.kind).toBe("issues");
    expect(job?.number).toBe(7);
    expect(job?.triggeredBy).toBe("mention");
    expect(job?.commentId).toBe(7777);
  });

  it("ignores trigger inside blockquote", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: {
          ...prCommentPayload,
          comment: {
            ...prCommentPayload.comment,
            body: "> @CodexRabbit[bot] said something\nI agree",
          },
        },
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job).toBeNull();
  });

  it("ignores trigger inside fenced code block", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: {
          ...prCommentPayload,
          comment: {
            ...prCommentPayload.comment,
            body: "check this:\n```\n@CodexRabbit[bot]\n```\n",
          },
        },
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job).toBeNull();
  });

  it("ignores trigger inside inline code", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: {
          ...prCommentPayload,
          comment: {
            ...prCommentPayload.comment,
            body: "use `@CodexRabbit[bot]` to trigger",
          },
        },
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job).toBeNull();
  });

  it("detects trigger outside of quoted/code content", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "bob",
        payload: {
          ...prCommentPayload,
          comment: {
            ...prCommentPayload.comment,
            body: "> previous comment\n@CodexRabbit[bot] please review",
          },
        },
      },
      { mentionTriggers: ["@CodexRabbit[bot]"] },
    );
    expect(job?.kind).toBe("pull_request");
    expect(job?.triggeredBy).toBe("mention");
  });

  it("matches any of multiple triggers", () => {
    const job = buildJobFromPayload(
      {
        event: "issue_comment",
        repository: "acme/widget",
        sender: "carol",
        payload: {
          ...issueCommentPayload,
          comment: { ...issueCommentPayload.comment, body: "hey /review please" },
        },
      },
      { mentionTriggers: ["@CodexRabbit[bot]", "/review"] },
    );
    expect(job?.kind).toBe("issues");
    expect(job?.triggeredBy).toBe("mention");
  });
});
