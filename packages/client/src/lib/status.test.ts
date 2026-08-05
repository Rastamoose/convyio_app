import { describe, expect, it } from "vitest";
import type { ItemStatus, Participant, RunState } from "@workspace/shared";
import { ITEM_STATUS_BADGE, ITEM_STATUS_LABEL, presenceDot } from "./status";

// Explicit list (not derived from the maps under test) so a status silently
// missing a label/badge fails here; tsc flags this array when the union grows.
const ALL_STATUSES: readonly ItemStatus[] = [
  "proposed",
  "denied",
  "approved",
  "in_progress",
  "blocked",
  "done",
];

describe("item status maps", () => {
  it.each(ALL_STATUSES)("has a label and a badge for %s", (status) => {
    expect(ITEM_STATUS_LABEL[status]).toBeTruthy();
    expect(ITEM_STATUS_BADGE[status]).toBeTruthy();
  });

  it("labels the kanban columns as the UI shows them", () => {
    expect(ITEM_STATUS_LABEL.proposed).toBe("Proposed");
    expect(ITEM_STATUS_LABEL.approved).toBe("To do");
    expect(ITEM_STATUS_LABEL.in_progress).toBe("In progress");
    expect(ITEM_STATUS_LABEL.done).toBe("Done");
  });
});

describe("presenceDot", () => {
  const agent = (runState: RunState, online = true): Participant => ({
    id: "a1",
    name: "agent-1",
    kind: "agent",
    status: "",
    runState,
    online,
  });
  const human = (online: boolean): Participant => ({
    id: "h1",
    name: "harris",
    kind: "human",
    status: "",
    runState: "idle",
    online,
  });

  it("shows a working agent as pulsing green", () => {
    expect(presenceDot(agent("working"))).toEqual({
      color: "bg-online",
      pulse: true,
    });
  });

  it("shows a blocked agent as pulsing red", () => {
    expect(presenceDot(agent("blocked"))).toEqual({
      color: "bg-dead",
      pulse: true,
    });
  });

  it("shows a dead agent as steady red", () => {
    expect(presenceDot(agent("dead"))).toEqual({
      color: "bg-dead",
      pulse: false,
    });
  });

  it("shows idle and done agents as orange while online, grey offline", () => {
    expect(presenceDot(agent("idle"))).toEqual({
      color: "bg-away",
      pulse: false,
    });
    expect(presenceDot(agent("done"))).toEqual({
      color: "bg-away",
      pulse: false,
    });
    expect(presenceDot(agent("idle", false))).toEqual({
      color: "bg-offline",
      pulse: false,
    });
  });

  it("shows humans simply online/offline, never pulsing", () => {
    expect(presenceDot(human(true))).toEqual({
      color: "bg-online",
      pulse: false,
    });
    expect(presenceDot(human(false))).toEqual({
      color: "bg-offline",
      pulse: false,
    });
  });
});
