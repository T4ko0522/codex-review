import { createHmac } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { verifySignature } from "./verify.ts";

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("verifySignature", () => {
  const secret = "test-secret-0123456789";
  const body = JSON.stringify({ hello: "world" });

  it("accepts a valid signature in raw hex", () => {
    const sig = sign(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it("accepts a valid signature with sha256= prefix", () => {
    const sig = `sha256=${sign(secret, body)}`;
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it("rejects tampered body", () => {
    const sig = sign(secret, body);
    expect(verifySignature(secret, `${body}x`, sig)).toBe(false);
  });

  it("rejects wrong secret", () => {
    const sig = sign("other-secret", body);
    expect(verifySignature(secret, body, sig)).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
  });

  it("rejects malformed signature length", () => {
    expect(verifySignature(secret, body, "deadbeef")).toBe(false);
  });

  it("works with Buffer body", () => {
    const buf = Buffer.from(body, "utf8");
    const sig = sign(secret, body);
    expect(verifySignature(secret, buf, sig)).toBe(true);
  });
});
