import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardItem, Participant } from "@workspace/shared";
import { Sidebar } from "./Sidebar";

// Sidebar (and the MemberCard it opens) read from the workspace context;
// swap in a controllable stub, per-test state via module-level lets.
let participants: Participant[] = [];
let board: BoardItem[] = [];
const createChannel = vi.fn();
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    participants,
    self: participants[0] ?? null,
    channels: ["general", "design"],
    board,
    activeRuns: [],
    messages: [],
    setStatus: vi.fn(),
    signOut: null,
    createChannel,
  }),
}));

// ApprovalQueue is its own unit; capture the item order it receives.
const queueItems = vi.fn();
vi.mock("./ApprovalQueue", () => ({
  ApprovalQueue: ({ items }: { items: BoardItem[] }) => {
    queueItems(items.map((i) => i.id));
    return null;
  },
}));

const human = (id: string, name: string, online: boolean): Participant => ({
  id,
  name,
  kind: "human",
  status: "",
  runState: "idle",
  online,
});

const proposal = (id: string, createdAt: number): BoardItem => ({
  id,
  serverId: "srv-1",
  ref: id,
  title: id,
  description: null,
  status: "proposed",
  origin: "agent",
  createdBy: "agent-1",
  approvedBy: null,
  owner: null,
  proposalWhy: null,
  proposalEffect: null,
  scopePaths: ["x/"],
  createdAt,
  approvedAt: null,
  startedAt: null,
  completedAt: null,
  deletedAt: null,
});

function renderSidebar(onSelectChannel = vi.fn()) {
  return render(
    <Sidebar
      channel="general"
      onSelectChannel={onSelectChannel}
      onDiscuss={vi.fn()}
      onPrefill={vi.fn()}
    />,
  );
}

describe("Sidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    participants = [];
    board = [];
  });

  it("groups members into Online/Offline sections with counts", () => {
    participants = [
      human("h1", "bea", true),
      human("h2", "al", true),
      human("h3", "zed", false),
    ];
    renderSidebar();

    expect(screen.getByText("Online — 2")).toBeInTheDocument();
    expect(screen.getByText("Offline — 1")).toBeInTheDocument();
    // Presence dots carry the label as a tooltip.
    expect(screen.getAllByTitle("Online").length).toBeGreaterThan(0);
  });

  it("hides the Offline section when everyone is online", () => {
    participants = [human("h1", "bea", true)];
    renderSidebar();

    expect(screen.getByText("Online — 1")).toBeInTheDocument();
    expect(screen.queryByText(/^Offline —/)).not.toBeInTheDocument();
  });

  it("keeps the room draft across blur but clears it on Escape", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole("button", { name: "Create a room" }));
    await user.type(screen.getByLabelText("New room name"), "war-room");
    fireEvent.blur(screen.getByLabelText("New room name"));
    expect(screen.queryByLabelText("New room name")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create a room" }));
    expect(screen.getByLabelText("New room name")).toHaveValue("war-room");

    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("New room name")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create a room" }));
    expect(screen.getByLabelText("New room name")).toHaveValue("");
  });

  it("submits the room draft with Enter", async () => {
    const user = userEvent.setup();
    const onSelectChannel = vi.fn();
    createChannel.mockResolvedValue("war-room");
    renderSidebar(onSelectChannel);

    await user.click(screen.getByRole("button", { name: "Create a room" }));
    await user.type(screen.getByLabelText("New room name"), "war-room{Enter}");

    expect(createChannel).toHaveBeenCalledWith("war-room");
    await waitFor(() => expect(onSelectChannel).toHaveBeenCalledWith("war-room"));
  });

  it("opens the approval queue with proposals newest-first", async () => {
    const user = userEvent.setup();
    board = [proposal("older", 1_000), proposal("newer", 2_000)];
    renderSidebar();

    await user.click(screen.getByRole("button", { name: /Awaiting approval \(2\)/ }));
    expect(queueItems).toHaveBeenCalledWith(["newer", "older"]);
  });

  it("anchors the member card beside the clicked row, clamped into view", async () => {
    const user = userEvent.setup();
    participants = [human("h1", "al", true)];
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 120,
      right: 232,
      bottom: 160,
      left: 8,
      width: 224,
      height: 40,
      x: 8,
      y: 120,
      toJSON: () => ({}),
    } as DOMRect);
    const { container } = renderSidebar();

    await user.click(screen.getAllByText("al")[0]);
    const card = container.parentElement?.querySelector<HTMLElement>(".animate-pop-in");
    expect(card).toBeTruthy();
    // jsdom reports 0 height, so top stays at the row and left sits past it.
    expect(card?.style.top).toBe("120px");
    expect(card?.style.left).toBe("240px");

    await user.keyboard("{Escape}");
    expect(
      container.parentElement?.querySelector(".animate-pop-in"),
    ).toBeNull();
  });
});
