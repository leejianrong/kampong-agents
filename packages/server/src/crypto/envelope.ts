import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// KAN-1229 (ADR-0016): application-level AES-256-GCM encryption of a BYOK
// provider key under the deployment's single root key, using only Node's
// built-in `node:crypto` (no new dependency, per ADR-0016). "Envelope
// encryption" in ADR-0016's sense is direct encryption of each key value
// under the root key -- not a two-layer per-value data key -- so that is what
// this implements, with a fresh random IV per encryption.
//
// The stored token is self-framed as base64(iv || authTag || ciphertext), so
// a single `byok_keys.ciphertext` column carries everything `decryptSecret`
// needs and there are no separate iv/tag columns to keep in sync. GCM's
// authentication tag makes any tampering with the stored ciphertext (or a
// wrong root key) a loud, detectable failure at decrypt time -- ADR-0016's
// explicit reason for choosing GCM: a corrupted-but-undetected key would
// otherwise surface as a confusing downstream provider-auth error rather than
// an obvious integrity error.
//
// Pure functions over an explicit `rootKey: Buffer` -- no `process.env`, no
// I/O -- so they are unit-testable with no infrastructure (test/unit/crypto/
// envelope.test.ts). The root key itself is read from the environment by
// `getByokRootKey` (../auth/env.ts), matching this deployment's
// read-env-or-throw-clearly pattern.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard 96-bit nonce.
const AUTH_TAG_BYTES = 16; // GCM's 128-bit authentication tag.
export const ROOT_KEY_BYTES = 32; // AES-256 needs a 256-bit key.

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/**
 * Encrypts `plaintext` under `rootKey` with AES-256-GCM and a fresh random
 * IV, returning the self-framed base64 token `base64(iv || authTag ||
 * ciphertext)` to store in `byok_keys.ciphertext`.
 */
export function encryptSecret(plaintext: string, rootKey: Buffer): string {
  assertRootKey(rootKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, rootKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Reverses {@link encryptSecret}. Throws {@link DecryptionError} if `token`
 * is malformed, or if GCM's authentication tag does not verify -- i.e. the
 * ciphertext was tampered with, or `rootKey` is not the key it was encrypted
 * under. Never returns a wrong-but-plausible plaintext.
 */
export function decryptSecret(token: string, rootKey: Buffer): string {
  assertRootKey(rootKey);
  let raw: Buffer;
  try {
    raw = Buffer.from(token, "base64");
  } catch {
    throw new DecryptionError("BYOK ciphertext is not valid base64.");
  }
  if (raw.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new DecryptionError("BYOK ciphertext is too short to contain an IV and auth tag.");
  }
  const iv = raw.subarray(0, IV_BYTES);
  const authTag = raw.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, rootKey, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // GCM final() throws when the auth tag doesn't verify -- tampered
    // ciphertext or a wrong root key. Surfaced as our own typed, message-safe
    // error (never echoing key material).
    throw new DecryptionError(
      "BYOK ciphertext failed authentication -- it was tampered with, or the root key is wrong.",
    );
  }
}

/**
 * The display-only masking hint stored alongside the ciphertext: the last 4
 * characters of the raw key (so a UI can show `sk-...ab12` to prove a key is
 * configured without ever decrypting it). Short keys are masked entirely.
 */
export function maskLastFour(rawKey: string): string {
  return rawKey.length <= 4 ? "" : rawKey.slice(-4);
}

function assertRootKey(rootKey: Buffer): void {
  // A clear guard turns a misconfigured root key into an obvious error rather
  // than a cryptic OpenSSL "Invalid key length" throw from deep inside
  // createCipheriv.
  if (rootKey.length !== ROOT_KEY_BYTES) {
    throw new DecryptionError(
      `BYOK root key must be ${ROOT_KEY_BYTES} bytes; got ${rootKey.length}.`,
    );
  }
}
