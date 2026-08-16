import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { BoardItem, InteractionRequest } from "@workspace/shared";
import { ApprovalQueue } from "./ApprovalQueue";

// The cards are their own units; capture the order the queue renders them in.
const rendered: string[] = [];
vi.mock("./ProposalCard", () => ({
  ProposalCard: ({ item }: { item: BoardItem }) => {
    rendered.push(item.id);
    return null;
  },
}));
vi.mock("./PermissionCard", () => ({
  PermissionCard: ({ request }: { request: InteractionRequest }) => {
    rendered.push(request.id);
    return null;
  },
}));

const proposal = (id: string, createdAt: number): BoardItem => ({
  id,
  workspaceId: "srv-1",
  ref: id,
  title: id,
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
  proposalWhy: null,
  proposalEffect: null,
  projectId: null,
  scopePaths: ["x/"],
  capabilities: null,
  createdAt,
  approvedAt: null,
  startedAt: null,
  completedAt: null,
  deletedAt: null,
});

const interaction = (id: string): InteractionRequest => ({
  id,
  workspaceId: "srv-1",
  channelId: "general",
  agentId: "agent-1",
  conversationId: null,
  summary: "write_file src/a.ts",
  capability: "file_write",
  boardItemRef: null,
  targetActorId: null,
  status: "pending",
  resolvedBy: null,
  createdAt: 1_000,
  resolvedAt: null,
});

describe("ApprovalQueue", () => {
  beforeEach(() => {
    rendered.length = 0;
  });

  it("renders paused runs first, then proposals newest-first", () => {
    render(
      <ApprovalQueue
        items={[proposal("older", 1_000), proposal("newer", 2_000)]}
        interactions={[interaction("i1")]}
        onResolveInteraction={vi.fn()}
        onDiscuss={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(rendered).toEqual(["i1", "newer", "older"]);
  });

  it("says so when nothing is waiting", () => {
    render(
      <ApprovalQueue
        items={[]}
        interactions={[]}
        onResolveInteraction={vi.fn()}
        onDiscuss={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Nothing waiting on you")).toBeInTheDocument();
  });
});
