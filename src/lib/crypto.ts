import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM. A chave (32 bytes, base64) vem de CREDENTIALS_KEY e só existe no backend/worker. */
function key(b64: string): Buffer {
  const k = Buffer.from(b64, "base64");
  if (k.length !== 32) throw new Error("CREDENTIALS_KEY deve ter 32 bytes em base64 (use: npm run key:generate)");
  return k;
}

export type Sealed = { ciphertext: Buffer; iv: Buffer; tag: Buffer };

export function seal(plaintext: string, keyB64: string): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(keyB64), iv);
  const ciphertext = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return { ciphertext, iv, tag: c.getAuthTag() };
}

export function open(s: Sealed, keyB64: string): string {
  const d = createDecipheriv("aes-256-gcm", key(keyB64), s.iv);
  d.setAuthTag(s.tag);
  return Buffer.concat([d.update(s.ciphertext), d.final()]).toString("utf8");
}
