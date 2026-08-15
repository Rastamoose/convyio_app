import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Participant } from "@workspace/shared";
import { StatusBar } from "./StatusBar";

// StatusBar reads workspace identity, presence and connection from context;
// per-test state via module-level lets.
let participants: Participant[] = [];
let connected = true;
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    workspace: { id: "ws-1", name: "test_space" },
    participants,
    connected,
  }),
}));

const human = (id: string, name: string, online: boolean): Participant => ({
  id,
  name,
  kind: "human",
  status: "",
  runState: "idle",
  online,
});

const workingAgent = (id: string, name: string): Participant => ({
  id,
  name,
  kind: "agent",
  status: "",
  runState: "working",
  online: true,
});

describe("StatusBar", () => {
  beforeEach(() => {
    participants = [];
    connected = true;
  });

  it("shows the workspace name and the current channel", () => {
    render(<StatusBar channel="general" view="chat" />);

    expect(screen.getByText("test_space")).toBeInTheDocument();
    expect(screen.getByText("# general")).toBeInTheDocument();
  });

  it("omits the channel readout on the board view", () => {
    render(<StatusBar channel="general" view="board" />);

    expect(screen.queryByText("# general")).toBeNull();
  });

  it("surfaces working agents instead of the plain online count", () => {
    participants = [human("h1", "bea", true), workingAgent("a1", "noodle")];
    render(<StatusBar channel="general" view="chat" />);

    expect(screen.getByText("1 agent working")).toBeInTheDocument();
    expect(screen.queryByText(/online$/)).toBeNull();
  });
});
