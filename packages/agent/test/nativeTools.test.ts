import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSafeAcpKind, isSafeClaudeNativeTool } from "../src/nativeTools";

describe("native tool ceiling", () => {
  test("Claude may only run classified read/search/fetch tools natively", () => {
    assert.equal(isSafeClaudeNativeTool("Read"), true);
    assert.equal(isSafeClaudeNativeTool("Grep"), true);
    assert.equal(isSafeClaudeNativeTool("Write"), false);
    assert.equal(isSafeClaudeNativeTool("Bash"), false);
  });

  test("ACP may only allow search, think, fetch, or a later-checked read", () => {
    assert.equal(isSafeAcpKind("search"), true);
    assert.equal(isSafeAcpKind("think"), true);
    assert.equal(isSafeAcpKind("fetch"), true);
    assert.equal(isSafeAcpKind("read"), true);
    assert.equal(isSafeAcpKind("edit"), false);
    assert.equal(isSafeAcpKind("execute"), false);
    assert.equal(isSafeAcpKind(undefined), false);
  });
});
