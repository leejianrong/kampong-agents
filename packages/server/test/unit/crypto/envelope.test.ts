import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  DecryptionError,
  encryptSecret,
  maskLastFour,
  ROOT_KEY_BYTES,
} from "../../../src/crypto/envelope.js";

// KAN-1229 (ADR-0016): the AES-256-GCM envelope crypto, unit-tested with no
// infrastructure -- pure functions over an explicit root key. The DB-backed
// route behavior (storage, masking, RLS isolation) is at the integration
// layer (test/integration/routes/byok.test.ts).

const rootKey = (): Buffer => randomBytes(ROOT_KEY_BYTES);

describe("encryptSecret / decryptSecret", () => {
  it("round-trips a secret back to its exact plaintext", () => {
    const key = rootKey();
    const secret = "sk-proj-abcdef0123456789";
    expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
  });

  it("round-trips unicode and empty-ish values", () => {
    const key = rootKey();
    for (const secret of ["", "a", "künstliche-intelligenz-🔑", "x".repeat(4096)]) {
      expect(decryptSecret(encryptSecret(secret, key), key)).toBe(secret);
    }
  });

  it("produces a different ciphertext each time (fresh IV), even for the same input", () => {
    const key = rootKey();
    const a = encryptSecret("same-secret", key);
    const b = encryptSecret("same-secret", key);
    expect(a).not.toBe(b);
    // ...but both still decrypt to the same plaintext.
    expect(decryptSecret(a, key)).toBe("same-secret");
    expect(decryptSecret(b, key)).toBe("same-secret");
  });

  it("does not leak the plaintext into the stored token", () => {
    const key = rootKey();
    const token = encryptSecret("sk-super-secret-value", key);
    expect(token).not.toContain("super-secret");
  });

  it("fails to decrypt under a different root key (confidentiality), rather than returning garbage", () => {
    const token = encryptSecret("sk-secret", rootKey());
    expect(() => decryptSecret(token, rootKey())).toThrow(DecryptionError);
  });

  it("detects a tampered ciphertext via the GCM auth tag (integrity), not a silent wrong value", () => {
    const key = rootKey();
    const token = encryptSecret("sk-secret", key);
    // Flip a byte in the ciphertext body (past the 12-byte IV + 16-byte tag).
    const raw = Buffer.from(token, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");
    expect(() => decryptSecret(tampered, key)).toThrow(DecryptionError);
  });

  it("rejects a token too short to hold an IV and auth tag", () => {
    expect(() => decryptSecret(Buffer.from("short").toString("base64"), rootKey())).toThrow(
      DecryptionError,
    );
  });

  it("rejects a wrong-sized root key with a clear error, not a cryptic OpenSSL throw", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});

describe("maskLastFour", () => {
  it("returns the last four characters for a normal key", () => {
    expect(maskLastFour("sk-proj-abcd1234")).toBe("1234");
  });

  it("masks short values entirely rather than revealing most of them", () => {
    expect(maskLastFour("abcd")).toBe("");
    expect(maskLastFour("ab")).toBe("");
  });
});
