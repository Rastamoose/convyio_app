import { describe, expect, it } from "vitest";
import { projectDemoProgress } from "./demoProgress";

describe("projectDemoProgress", () => {
  it("preserves the semantic spotlight target", () => {
    expect(projectDemoProgress({
      type: "demo_progress",
      channel: "demo",
      stage: "spotlight_1",
      message: "Both founders can see Noodle's findings.",
      paused: false,
      focus: { kind: "message", id: "message-1", label: "Shared evidence" },
    })).toEqual({
      channel: "demo",
      stage: "spotlight_1",
      message: "Both founders can see Noodle's findings.",
      paused: false,
      focus: { kind: "message", id: "message-1", label: "Shared evidence" },
    });
  });
});
