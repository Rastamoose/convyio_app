import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardItem, InteractionRequest } from "@workspace/shared";
import { AppBar } from "./AppBar";

// AppBar reads the pending-approval counts from the workspace context;
// per-test state via module-level lets.
let board: BoardItem[] = [];
let pendingInteractions: InteractionRequest[] = [];
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    board,
    pendingInteractions,
    demoChannels: [],
    startDemo: vi.fn(),
  }),
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

function renderAppBar() {
  const handlers = {
    onSetView: vi.fn(),
    onToggleQueue: vi.fn(),
  };
  render(
    <AppBar view="chat" channel="general" {...handlers} />,
  );
  return handlers;
}

describe("AppBar", () => {
  beforeEach(() => {
    board = [];
    pendingInteractions = [];
  });

  it("uses the yellow brand mark", () => {
    renderAppBar();
    expect(screen.getByAltText("convyio")).toHaveAttribute("src", "/mark-yellow.svg");
  });

  it("shows the combined pending count and opens the queue from the chip", async () => {
    const user = userEvent.setup();
    board = [proposal("p1", 1_000), proposal("p2", 2_000)];
    pendingInteractions = [interaction("i1")];
    const { onToggleQueue } = renderAppBar();

    await user.click(screen.getByRole("button", { name: "Review 3 pending approvals" }));
    expect(onToggleQueue).toHaveBeenCalled();
  });

  it("shows no approval chip when nothing is waiting", () => {
    renderAppBar();
    expect(screen.queryByRole("button", { name: /pending approvals/ })).toBeNull();
  });

  it("switches the workspace view from the tabs", async () => {
    const user = userEvent.setup();
    const { onSetView } = renderAppBar();

    await user.click(screen.getByRole("tab", { name: "Board" }));
    expect(onSetView).toHaveBeenCalledWith("board");
  });
});
