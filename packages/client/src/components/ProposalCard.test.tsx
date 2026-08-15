import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardItem } from "@workspace/shared";
import { ProposalCard } from "./ProposalCard";

// ProposalCard reads approve/deny from the workspace context; the card is the
// unit under test, so only that collaborator is replaced.
const approveItem = vi.fn();
const denyItem = vi.fn();
const fetchActors = vi.fn().mockResolvedValue([
  { id: "agent-1", kind: "agent", displayName: "noodle", workspaceId: "srv-1" },
]);
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({ approveItem, denyItem, fetchActors }),
}));

const item: BoardItem = {
  id: "item-1",
  workspaceId: "srv-1",
  ref: "task-1",
  title: "Fix ICP rounding",
  description: null,
  status: "proposed",
  origin: "agent",
  createdBy: "agent-1",
  approvedBy: null,
  owner: null,
  planId: null,
  acceptanceCriteria: [],
  verificationEvidence: null,
  impactMap: null,
  proposalWhy: "Invoices round the wrong way",
  proposalEffect: "Totals match the ledger",
  projectId: null,
  scopePaths: ["billing/", "docs/README.md"],
  capabilities: null,
  createdAt: Date.now() - 60_000,
  approvedAt: null,
  startedAt: null,
  completedAt: null,
  deletedAt: null,
  createdByName: "agent-1",
};

describe("ProposalCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders ref, author, title, why, effect and scope", () => {
    render(<ProposalCard item={item} onDiscuss={vi.fn()} />);

    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(screen.getByText("agent-1")).toBeInTheDocument();
    expect(screen.getByText("Fix ICP rounding")).toBeInTheDocument();
    expect(
      screen.getByText("Invoices round the wrong way"),
    ).toBeInTheDocument();
    expect(screen.getByText("Totals match the ledger")).toBeInTheDocument();
    expect(screen.getByText("billing/, docs/README.md")).toBeInTheDocument();
  });

  it("omits why/effect/scope sections the item does not have", () => {
    render(
      <ProposalCard
        item={{ ...item, proposalWhy: null, proposalEffect: null, scopePaths: null }}
        onDiscuss={vi.fn()}
      />,
    );

    expect(screen.queryByText("Why")).not.toBeInTheDocument();
    expect(screen.queryByText("Expected effect")).not.toBeInTheDocument();
    expect(screen.queryByText("Scope")).not.toBeInTheDocument();
  });

  it("fires approve, deny and discuss callbacks on click", async () => {
    const user = userEvent.setup();
    const onDiscuss = vi.fn();
    render(<ProposalCard item={item} onDiscuss={onDiscuss} />);

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(approveItem).toHaveBeenCalledWith("item-1", undefined);

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(denyItem).toHaveBeenCalledWith("item-1");

    await user.click(screen.getByRole("button", { name: "Discuss" }));
    expect(onDiscuss).toHaveBeenCalledWith(item);
  });

  it("swallows the second press of a rapid double-click on Approve", async () => {
    const user = userEvent.setup();
    render(<ProposalCard item={item} onDiscuss={vi.fn()} />);

    await user.dblClick(screen.getByRole("button", { name: "Approve" }));
    expect(approveItem).toHaveBeenCalledTimes(1);
  });
});
