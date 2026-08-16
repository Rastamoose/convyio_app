import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentSummary, Participant, RunnerConfigOption } from "@workspace/shared";
import { AddAgentModal, pairCommand, setupPrompt } from "./AddAgentModal";

// AddAgentModal reads/writes agent invites through the workspace context;
// swap in a controllable stub, per-test state via module-level lets, the
// same shape the real WorkspaceContext exposes.
let agentInvites: AgentSummary[] = [];
let participants: Participant[] = [];
const createAgent = vi.fn();
const updateAgent = vi.fn();
const repairAgent = vi.fn();
const revokeAgent = vi.fn();
const refreshAgents = vi.fn().mockResolvedValue(undefined);
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    agentInvites,
    apiUrl: "http://localhost:3001",
    participants,
    createAgent,
    updateAgent,
    repairAgent,
    revokeAgent,
    refreshAgents,
  }),
}));

const summary = (
  id: string,
  name: string,
  overrides: Partial<AgentSummary["runtime"]> = {},
): AgentSummary => ({
  id,
  actorId: id,
  name,
  provider: "claude",
  workspaceId: "w1",
  instructions: "",
  requestedModel: null,
  access: { mode: "workspace", selectedActorIds: [] },
  configRevision: 1,
  updatedAt: 0,
  createdBy: "h1",
  createdAt: 1_000,
  revokedAt: null,
  runtime: { connected: true, health: "ready", configRevision: 1, options: [], ...overrides },
});

const human = (id: string, name: string): Participant => ({
  id,
  name,
  kind: "human",
  status: "",
  runState: "idle",
  online: true,
});

const modelOption: RunnerConfigOption = {
  id: "model",
  label: "Model",
  category: "model",
  kind: "select",
  choices: [{ value: "claude-opus", label: "Opus" }],
};

describe("AddAgentModal", () => {
  it("makes the setup prompt the primary pairing action after creating an agent", async () => {
    const user = userEvent.setup();
    agentInvites = [];
    createAgent.mockImplementation(async (fields: { name: string }) => {
      agentInvites = [summary("inv-1", fields.name)];
      return { id: "inv-1", pairingCode: "pair-code-xyz" };
    });

    render(<AddAgentModal open={true} onClose={() => {}} />);

    await user.type(screen.getByLabelText("Agent name"), "helper");
    await user.click(screen.getByText("Create agent"));

    expect(
      await screen.findByText(/Paste this into Claude Code, Cursor, Codex/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your subscription stays on this machine/)).toBeInTheDocument();
    const expectedPrompt = setupPrompt("http://localhost:3001", "pair-code-xyz", "helper");
    expect(screen.getByLabelText("Setup prompt").textContent).toBe(expectedPrompt);
    expect(screen.getByRole("button", { name: (n) => n === "CLI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: (n) => n === "Pairing code" })).toBeInTheDocument();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByLabelText("Copy setup prompt"));
    expect(writeText).toHaveBeenCalledWith(expectedPrompt);

    await user.click(screen.getByRole("button", { name: (n) => n === "CLI" }));
    expect(
      screen.getByText(pairCommand("http://localhost:3001", "pair-code-xyz")),
    ).toBeInTheDocument();
  });

  it("writes a local-only setup prompt that includes the pairing command", () => {
    const prompt = setupPrompt("https://app.convyio.com", "secret-code", "reader");
    expect(prompt).toContain(pairCommand("https://app.convyio.com", "secret-code"));
    expect(prompt).toContain("keep using the subscription already signed in here");
    expect(prompt).toContain("Do not send that login, an API key, or the pairing code to any remote service");
    expect(prompt).toContain("claude login");
    expect(prompt).toContain("convyio-agent run");
  });

  it("disables the model select until the runner reports a model option", async () => {
    const user = userEvent.setup();
    agentInvites = [summary("inv-2", "helper2", { options: [] })];

    const { rerender } = render(<AddAgentModal open={true} onClose={() => {}} />);
    await user.click(screen.getByText("helper2"));

    expect(screen.getByLabelText("Model")).toBeDisabled();

    agentInvites = [summary("inv-2", "helper2", { options: [modelOption] })];
    rerender(<AddAgentModal open={true} onClose={() => {}} />);

    expect(screen.getByLabelText("Model")).not.toBeDisabled();
  });

  it("PATCHes the expected access body when 'selected' access is saved", async () => {
    const user = userEvent.setup();
    agentInvites = [summary("inv-3", "helper3")];
    participants = [human("human-1", "alice")];
    updateAgent.mockResolvedValue(true);

    render(<AddAgentModal open={true} onClose={() => {}} />);
    await user.click(screen.getByText("helper3"));

    fireEvent.change(screen.getByLabelText("Who can direct this agent"), {
      target: { value: "selected" },
    });
    await user.click(screen.getByLabelText("alice"));
    await user.click(screen.getByText("Save changes"));

    expect(updateAgent).toHaveBeenCalledWith(
      "inv-3",
      expect.objectContaining({
        access: { mode: "selected", selectedActorIds: ["human-1"] },
      }),
    );
  });
});
