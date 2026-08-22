import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { randomBytes } from "node:crypto";

process.env.AGENT_SECRET_KEY = randomBytes(32).toString("base64");
const { encrypt, decrypt } = await import("../src/crypto/secretBox");

describe("secretBox", () => {
  test("round-trips a plaintext string", () => {
    const ciphertext = encrypt("sk-abc123");
    assert.notEqual(ciphertext, "sk-abc123");
    assert.equal(decrypt(ciphertext), "sk-abc123");
  });

  test("different ciphertexts for the same plaintext (random IV)", () => {
    assert.notEqual(encrypt("same-key"), encrypt("same-key"));
  });

  test("a tampered ciphertext fails to decrypt", () => {
    const ciphertext = encrypt("sk-abc123");
    const [iv, tag, body] = ciphertext.split(":");
    const tampered = `${iv}:${tag}:${body.slice(0, -2)}00`;
    assert.throws(() => decrypt(tampered));
  });

  test("throws clearly when AGENT_SECRET_KEY is not configured", () => {
    const original = process.env.AGENT_SECRET_KEY;
    delete process.env.AGENT_SECRET_KEY;
    try {
      assert.throws(() => encrypt("x"), /AGENT_SECRET_KEY is not set/);
    } finally {
      process.env.AGENT_SECRET_KEY = original;
    }
  });
});
