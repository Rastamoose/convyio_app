import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentInvite } from "@workspace/shared";
import { AddAgentModal } from "./AddAgentModal";

// AddAgentModal reads/writes agent invites through the workspace context;
// swap in a controllable stub whose createAgent/revokeAgent actually mutate
// the shared `agentInvites` list, the way the real hook does.
let agentInvites: AgentInvite[] = [];
const createAgent = vi.fn();
const revokeAgent = vi.fn();
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    agentInvites,
    createAgent,
    revokeAgent,
  }),
}));

const invite = (id: string, name: string): AgentInvite => ({
  id,
  actorId: id,
  name,
  provider: "claude",
  createdBy: "h1",
  createdAt: 1_000,
  revokedAt: null,
});

describe("AddAgentModal", () => {
  it("clears the just-created banner once that agent is removed", async () => {
    const user = userEvent.setup();
    agentInvites = [];
    createAgent.mockImplementation(async (name: string) => {
      const created = invite("inv-1", name);
      agentInvites = [created];
      return { ...created, token: "secret-token", command: "run-command" };
    });
    revokeAgent.mockImplementation(async (id: string) => {
      agentInvites = agentInvites.filter((a) => a.id !== id);
      return true;
    });

    const { rerender } = render(
      <AddAgentModal open={true} onClose={() => {}} />,
    );

    await user.type(screen.getByLabelText("Agent name"), "helper");
    await user.click(screen.getByText("Create agent"));

    expect(await screen.findByText("secret-token")).toBeInTheDocument();

    await user.click(screen.getByText("Remove"));
    rerender(<AddAgentModal open={true} onClose={() => {}} />);

    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();
  });

  it("does not carry the created banner across a close/reopen", async () => {
    const user = userEvent.setup();
    agentInvites = [];
    createAgent.mockImplementation(async (name: string) => {
      const created = invite("inv-2", name);
      agentInvites = [created];
      return { ...created, token: "secret-token-2", command: "run-command-2" };
    });

    const { rerender } = render(
      <AddAgentModal open={true} onClose={() => {}} />,
    );

    await user.type(screen.getByLabelText("Agent name"), "helper2");
    await user.click(screen.getByText("Create agent"));
    expect(await screen.findByText("secret-token-2")).toBeInTheDocument();

    rerender(<AddAgentModal open={false} onClose={() => {}} />);
    rerender(<AddAgentModal open={true} onClose={() => {}} />);

    expect(screen.queryByText("secret-token-2")).not.toBeInTheDocument();
  });
});
