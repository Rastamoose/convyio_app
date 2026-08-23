import { describe, expect, it } from "vitest";
import { projectDemoProgress } from "./demoProgress";

describe("projectDemoProgress", () => {
  it("preserves the stage and optional message/focus, no commentary label", () => {
    expect(projectDemoProgress({
      type: "demo_progress",
      channel: "demo",
      stage: "step_1",
      message: "Waiting for you to accept the plan.",
      paused: false,
      focus: { kind: "plan_accept", id: "plan-1" },
    })).toEqual({
      channel: "demo",
      stage: "step_1",
      message: "Waiting for you to accept the plan.",
      paused: false,
      focus: { kind: "plan_accept", id: "plan-1" },
    });
  });

  it("drops the message key entirely when absent", () => {
    expect(projectDemoProgress({
      type: "demo_progress",
      channel: "demo",
      stage: "intro",
      paused: false,
    })).toEqual({
      channel: "demo",
      stage: "intro",
      paused: false,
    });
  });
});
