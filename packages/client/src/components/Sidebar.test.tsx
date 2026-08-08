import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BoardItem, Participant } from "@workspace/shared";
import { Sidebar } from "./Sidebar";

// Sidebar (and the MemberCard it opens) read from the workspace context;
// swap in a controllable stub, per-test state via module-level lets.
let participants: Participant[] = [];
let board: BoardItem[] = [];
let unreadsByChannel: Record<string, number> = {};
let channels = ["general", "design"];
let archivedChannels: string[] = [];
let pinnedChannels: string[] = [];
const createChannel = vi.fn();
const renameChannel = vi.fn();
const archiveChannel = vi.fn();
const pinChannel = vi.fn();
const deleteChannel = vi.fn();
const markRead = vi.fn();
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    participants,
    self: participants[0] ?? null,
    channels,
    archivedChannels,
    pinnedChannels,
    board,
    activeRuns: [],
    messages: [],
    setStatus: vi.fn(),
    signOut: null,
    createChannel,
    renameChannel,
    archiveChannel,
    pinChannel,
    deleteChannel,
    unreadCount: (channel: string) => unreadsByChannel[channel] ?? 0,
    markRead,
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
    unreadsByChannel = {};
    channels = ["general", "design"];
    archivedChannels = [];
    pinnedChannels = [];
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

  it("renders a channel with unreads in bold white with a count badge", () => {
    unreadsByChannel = { design: 5 };
    renderSidebar();

    const designButton = screen.getByRole("tab", { name: /design/ });
    // Should have white/bold text
    expect(designButton).toHaveClass("text-body", "font-medium");
    // Should show the badge with count inside the button
    expect(designButton.textContent).toContain("5");
  });

  it("renders a channel with zero unreads without a badge", () => {
    unreadsByChannel = { design: 0 };
    renderSidebar();

    const designButton = screen.getByRole("tab", { name: /design/ });
    // Should have muted text since it's not active and has no unreads
    expect(designButton).toHaveClass("text-muted");
    // Should not show any number badge
    expect(designButton.textContent).not.toContain(/\d/);
  });

  it("renders a count over 99 as 99+", () => {
    unreadsByChannel = { design: 150 };
    renderSidebar();

    const designButton = screen.getByRole("tab", { name: /design/ });
    // Should show the 99+ badge inside the button
    expect(designButton.textContent).toContain("99+");
  });

  it("right-clicking a room opens its context menu; general omits rename/archive/delete", () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /general/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Mark as read")).toBeInTheDocument();
    expect(within(menu).getByText("Pin channel")).toBeInTheDocument();
    expect(within(menu).queryByText("Rename")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Archive")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Delete")).not.toBeInTheDocument();
  });

  it("right-clicking a non-default room offers rename, archive, and delete", () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /design/ }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Rename")).toBeInTheDocument();
    expect(within(menu).getByText("Archive")).toBeInTheDocument();
    expect(within(menu).getByText("Delete")).toBeInTheDocument();
  });

  it("Mark as read calls markRead for that channel and closes the menu", async () => {
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /design/ }));
    await user.click(screen.getByText("Mark as read"));

    expect(markRead).toHaveBeenCalledWith("design");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("Pin channel calls pinChannel(name, true); already-pinned rooms offer Unpin", async () => {
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /design/ }));
    await user.click(screen.getByText("Pin channel"));
    expect(pinChannel).toHaveBeenCalledWith("design", true);

    pinnedChannels = ["design"];
    renderSidebar();
    fireEvent.contextMenu(screen.getAllByRole("tab", { name: /design/ })[1]);
    expect(screen.getByText("Unpin")).toBeInTheDocument();
  });

  it("Delete requires a second confirming click before calling deleteChannel", async () => {
    const user = userEvent.setup();
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /design/ }));
    await user.click(screen.getByText("Delete"));
    expect(deleteChannel).not.toHaveBeenCalled();
    expect(screen.getByText("Confirm delete?")).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /design/ }));
    await user.click(screen.getByText("Confirm delete?"));
    expect(deleteChannel).toHaveBeenCalledWith("design");
  });

  it("Rename opens an inline input pre-filled with the current name, submits on Enter", async () => {
    const user = userEvent.setup();
    renameChannel.mockResolvedValue("renamed-room");
    renderSidebar();

    fireEvent.contextMenu(screen.getByRole("tab", { name: /design/ }));
    await user.click(screen.getByText("Rename"));

    const input = screen.getByLabelText("Rename design");
    expect(input).toHaveValue("design");
    await user.clear(input);
    await user.type(input, "renamed-room{Enter}");

    expect(renameChannel).toHaveBeenCalledWith("design", "renamed-room");
  });

  it("collapsing Rooms hides the room list", async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(screen.getByRole("tab", { name: /design/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Rooms/ }));
    expect(screen.queryByRole("tab", { name: /design/ })).not.toBeInTheDocument();
  });

  it("shows a collapsed Archived section only when archived rooms exist", async () => {
    const user = userEvent.setup();
    archivedChannels = ["old-room"];
    renderSidebar();

    expect(screen.getByText("Archived — 1")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /old-room/ })).not.toBeInTheDocument();

    await user.click(screen.getByText("Archived — 1"));
    expect(screen.getByRole("tab", { name: /old-room/ })).toBeInTheDocument();
  });
});
