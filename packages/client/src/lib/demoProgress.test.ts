import { describe, expect, it } from "vitest";
import { projectDemoProgress } from "./demoProgress";

describe("projectDemoProgress", () => {
  it("preserves the walkthrough label", () => {
    expect(projectDemoProgress({
      type: "demo_progress",
      channel: "demo",
      stage: "step_1",
      message: "Noodle knows the backend, but not every consumer.",
      paused: false,
      label: "Backend finding",
    })).toEqual({
      channel: "demo",
      stage: "step_1",
      message: "Noodle knows the backend, but not every consumer.",
      paused: false,
      label: "Backend finding",
    });
  });
});
