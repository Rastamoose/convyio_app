import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyImpactMap, isCompleteImpactMap, mergeLiveItems } from "../src/context";

describe("context contracts", () => {
  test("empty impact map is complete when every surface is N/A", () => {
    assert.equal(isCompleteImpactMap(emptyImpactMap()), true);
  });

  test("affected surface without a note is incomplete", () => {
    const map = emptyImpactMap();
    map.server = "affected";
    assert.equal(isCompleteImpactMap(map), false);
    map.notes.server = "Hub dispatch changes";
    assert.equal(isCompleteImpactMap(map), true);
  });

  test("mergeLiveItems keeps live updates that arrived during the snapshot fetch", () => {
    const snapshot = [
      { id: "a", title: "old", deletedAt: null },
      { id: "b", title: "keep", deletedAt: null },
    ];
    const live = [
      { id: "a", title: "newer", deletedAt: null },
      { id: "c", title: "created live", deletedAt: null },
      { id: "b", title: "keep", deletedAt: 1 },
    ];
    const merged = mergeLiveItems(snapshot, live);
    assert.deepEqual(
      merged.map((item) => item.id).sort(),
      ["a", "c"],
    );
    assert.equal(merged.find((item) => item.id === "a")?.title, "newer");
  });
});
