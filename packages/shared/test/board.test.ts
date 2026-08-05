import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { WORKABLE_STATUSES, isBoardEnvelope } from "../src/board";

describe("board contracts", () => {
  test("only approved and in_progress are workable", () => {
    assert.deepEqual([...WORKABLE_STATUSES].sort(), ["approved", "in_progress"]);
  });

  test("isBoardEnvelope accepts board-channel events and nothing else", () => {
    assert.equal(isBoardEnvelope({ channel: "board", type: "item.created" }), true);
    assert.equal(isBoardEnvelope({ channel: "chat" }), false);
    assert.equal(isBoardEnvelope({ type: "message" }), false);
    assert.equal(isBoardEnvelope(null), false);
    assert.equal(isBoardEnvelope("board"), false);
  });
});
