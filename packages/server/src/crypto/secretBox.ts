import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  const raw = process.env.AGENT_SECRET_KEY;
  if (!raw) {
    throw new Error("AGENT_SECRET_KEY is not set — required to store or read an agent's API key");
  }
  const buffer = Buffer.from(raw, "base64");
  if (buffer.length !== 32) {
    throw new Error("AGENT_SECRET_KEY must decode to exactly 32 bytes (base64)");
  }
  return buffer;
}

/** "iv:authTag:ciphertext", each hex-encoded. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decrypt(stored: string): string {
  const [ivHex, tagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !tagHex || !ciphertextHex) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
