import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub 標準の `sha256=<hex>` 形式に合わせたい場合は `format: 'prefixed'`。
 * 単純な hex のみを許容する場合は 'hex'。両方許容する。
 */
export function verifySignature(
  secret: string,
  rawBody: string | Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}
