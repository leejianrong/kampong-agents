import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies a real GitHub webhook's X-Hub-Signature-256 against the raw request body. */
export function verifyGithubSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
