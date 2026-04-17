import { describe, expect, it } from "vite-plus/test";
import { buildJobFromPayload } from "./events.ts";

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
