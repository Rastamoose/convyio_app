import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { modelForProvider } from "../src/config";

describe("modelForProvider", () => {
  test("does not pass a root Gemini model override to Claude", () => {
    assert.equal(modelForProvider("claude", "gemini-2.5-flash"), undefined);
  });

  test("uses the Claude harness default when no Claude model is configured", () => {
    assert.equal(modelForProvider("claude", undefined), undefined);
  });

  test("preserves an explicit Claude model", () => {
    assert.equal(modelForProvider("claude", "claude-opus-4-1"), "claude-opus-4-1");
  });

  test("keeps Gemini on its provider default instead of inheriting a Claude model", () => {
    assert.equal(modelForProvider("gemini", "claude-opus-4-1"), "gemini-2.5-flash");
    assert.equal(modelForProvider("gemini", undefined), "gemini-2.5-flash");
  });
});
