import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentResourceAccessRequest, BoardItem, BoardPlan, ChatMessage, InteractionRequest, Participant } from "@workspace/shared";
import type { LocalMessage } from "../hooks/useChatMessages";
import { MessageList } from "./MessageList";

// MessageList reads everything from the workspace context; swap in a
// controllable stub, per-test state via module-level lets (same pattern as
// Sidebar.test.tsx / ProposalCard.test.tsx).
let messages: LocalMessage[] = [];
let participants: Participant[] = [];
let self: Participant | null = null;
let board: BoardItem[] = [];
let plans: BoardPlan[] = [];
let pendingInteractions: InteractionRequest[] = [];
let pendingResourceAccessRequests: AgentResourceAccessRequest[] = [];
let channelInfos: { id: string; name: string; sectionId: string | null }[] = [
  { id: "ch-general", name: "general", sectionId: null },
];

const pinMessage = vi.fn();
const editMessage = vi.fn();
const deleteMessage = vi.fn();
const reactToMessage = vi.fn();
const retryMessage = vi.fn();
const discardMessage = vi.fn();
const markRead = vi.fn();
const loadOlder = vi.fn(async () => false);

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    messages,
    boardLines: [],
    activeRuns: [],
    runDurations: new Map(),
    board,
    plans,
    context: [],
    pendingInteractions,
    pendingResourceAccessRequests,
    resolveResourceAccessRequest: vi.fn(),
    channelInfos,
    executions: [],
    acceptPlan: vi.fn(),
    addPlanConstraint: vi.fn(),
    createBoardItem: vi.fn(),
    resolveInteraction: vi.fn(),
    // ProposalCard (rendered for proposed items) fetches the owner list.
    fetchActors: vi.fn().mockResolvedValue([]),
    participants,
    self,
    pinMessage,
    editMessage,
    deleteMessage,
    reactToMessage,
    retryMessage,
    discardMessage,
    typistsIn: () => [],
    firstUnreadId: () => null,
    markRead,
    loadOlder,
    attachmentUrl: (a: { url: string }) => `http://api.test${a.url}`,
    apiFetch: vi.fn().mockResolvedValue({ ok: true, text: async () => "" }),
  }),
}));

const proposal = (overrides: Partial<BoardItem> = {}): BoardItem => ({
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
  scopePaths: ["billing/"],
  capabilities: null,
  createdAt: Date.now(),
  approvedAt: null,
  startedAt: null,
  completedAt: null,
  deletedAt: null,
  createdByName: "agent-1",
  ...overrides,
});

const interaction = (overrides: Partial<InteractionRequest> = {}): InteractionRequest => ({
  id: "req-1",
  workspaceId: "srv-1",
  channelId: "general",
  agentId: "agent-1",
  conversationId: null,
  summary: "write_file billing/round.ts",
  capability: "file_write",
  boardItemRef: "task-1",
  targetActorId: null,
  status: "pending",
  resolvedBy: null,
  createdAt: Date.now(),
  resolvedAt: null,
  ...overrides,
});

const human = (id: string, name: string): Participant => ({
  id,
  name,
  kind: "human",
  status: "",
  runState: "idle",
  online: true,
});

const msg = (overrides: Partial<LocalMessage> & { id: string }): LocalMessage => ({
  authorId: "u1",
  authorName: "bea",
  authorKind: "human",
  content: "hello",
  timestamp: Date.now(),
  channel: "general",
  ...overrides,
});

/** jsdom does no layout: define the three scroll geometry props as plain
 * writable values so the component's own `el.scrollTop = ...` assignments
 * actually stick and can be asserted on. */
function mockGeometry(
  el: HTMLElement,
  geo: { scrollTop: number; scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollTop", { value: geo.scrollTop, writable: true, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: geo.scrollHeight, writable: true, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: geo.clientHeight, writable: true, configurable: true });
}

/** Controlled editingId, mirroring how App owns it. */
function Harness({
  initialEditingId = null,
  onReply = vi.fn(),
}: {
  initialEditingId?: string | null;
  onReply?: (m: ChatMessage) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(initialEditingId);
  return (
    <MessageList
      channel="general"
      onRefClick={vi.fn()}
      onReply={onReply}
      editingId={editingId}
      onEditingIdChange={setEditingId}
      onDiscuss={vi.fn()}
      onPrefill={vi.fn()}
      onOpenBoard={vi.fn()}
    />
  );
}

describe("MessageList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messages = [];
    board = [];
    plans = [];
    pendingInteractions = [];
    pendingResourceAccessRequests = [];
    channelInfos = [{ id: "ch-general", name: "general", sectionId: null }];
    participants = [human("self-1", "me")];
    self = participants[0];
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("stays put with a new-messages pill when not at the bottom, and jumps to bottom on click", () => {
    messages = [msg({ id: "m1" })];
    const { rerender } = render(<Harness />);
    const el = screen.getByTestId("message-scroll");

    mockGeometry(el, { scrollTop: 200, scrollHeight: 1000, clientHeight: 500 });
    fireEvent.scroll(el);
    expect(el.scrollTop).toBe(200);

    messages = [...messages, msg({ id: "m2", content: "new one" })];
    mockGeometry(el, { scrollTop: 200, scrollHeight: 1100, clientHeight: 500 });
    rerender(<Harness />);

    // Scroll position untouched by the new message; a pill offers the jump instead.
    expect(el.scrollTop).toBe(200);
    const pill = screen.getByRole("button", { name: /1 new message/ });
    expect(pill).toBeInTheDocument();

    fireEvent.click(pill);
    expect(el.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: /new message/ })).not.toBeInTheDocument();
  });

  it("auto-scrolls to the bottom when you publish a message even if scrolled up", () => {
    messages = [msg({ id: "m1" })];
    const { rerender } = render(<Harness />);
    const el = screen.getByTestId("message-scroll");

    mockGeometry(el, { scrollTop: 200, scrollHeight: 1000, clientHeight: 500 });
    fireEvent.scroll(el);

    messages = [...messages, msg({ id: "m2", authorId: "self-1", content: "mine" })];
    mockGeometry(el, { scrollTop: 200, scrollHeight: 1100, clientHeight: 500 });
    rerender(<Harness />);

    expect(el.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: /new message/ })).not.toBeInTheDocument();
  });

  it("auto-scrolls to the bottom when a new message arrives while already there", () => {
    messages = [msg({ id: "m1" })];
    const { rerender } = render(<Harness />);
    const el = screen.getByTestId("message-scroll");

    mockGeometry(el, { scrollTop: 500, scrollHeight: 1000, clientHeight: 500 });
    fireEvent.scroll(el); // 1000 - 500 - 500 = 0, at the bottom

    messages = [...messages, msg({ id: "m2", content: "new one" })];
    mockGeometry(el, { scrollTop: 500, scrollHeight: 1100, clientHeight: 500 });
    rerender(<Harness />);

    expect(el.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: /new message/ })).not.toBeInTheDocument();
  });

  it("keeps the channel intro above messages instead of replacing it", () => {
    messages = [];
    const { rerender } = render(<Harness />);
    const heading = screen.getByRole("heading", { name: /general/i });
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();

    messages = [msg({ id: "m1", content: "first" })];
    rerender(<Harness />);

    expect(heading).toBeInTheDocument();
    expect(screen.getByText("This is the start of #general.")).toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(heading.compareDocumentPosition(screen.getByText("first")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not group noodle's chat after his join notice", () => {
    const now = Date.now();
    participants = [
      human("self-1", "me"),
      { id: "n1", name: "noodle", kind: "agent", status: "", runState: "idle", online: true, managedAgent: "noodle" },
    ];
    messages = [
      msg({
        id: "member-joined:ws:n1",
        authorId: "n1",
        authorName: "noodle",
        authorKind: "system",
        content: "noodle joined the workspace",
        timestamp: now,
      }),
      msg({
        id: "managed-welcome:ws:1",
        authorId: "n1",
        authorName: "noodle",
        authorKind: "agent",
        content: "Hey — I’m noodle",
        timestamp: now + 1,
      }),
    ];
    render(<Harness />);
    expect(screen.getByText("joined the workspace")).toBeInTheDocument();
    expect(screen.getByText("Hey — I’m noodle")).toBeInTheDocument();
    expect(screen.getByText("noodle", { selector: "button" })).toBeInTheDocument();
  });

  it("a loadOlder that resolves true without prepending anything leaves the next new message on the normal path", async () => {
    messages = [msg({ id: "m1" })];
    // Resolves true (a page came back) but never touches `messages` — the
    // real-world equivalent of every returned message already being loaded,
    // so the de-duplicating prepend is a no-op.
    loadOlder.mockImplementation(async () => true);
    const { rerender } = render(<Harness />);
    const el = screen.getByTestId("message-scroll");

    // Near the top and not at the bottom: triggers maybeLoadOlder on scroll.
    mockGeometry(el, { scrollTop: 50, scrollHeight: 1000, clientHeight: 500 });
    fireEvent.scroll(el);

    expect(loadOlder).toHaveBeenCalledWith("general");
    // Wait for loadOlder's promise to settle (loadingOlder flips back to false).
    await waitFor(() => expect(screen.queryByText("Loading messages…")).not.toBeInTheDocument());

    // A genuinely new tail message arrives afterward.
    messages = [...messages, msg({ id: "m2", content: "new one" })];
    mockGeometry(el, { scrollTop: 50, scrollHeight: 1100, clientHeight: 500 });
    rerender(<Harness />);

    // Must take the normal new-tail path (pill increments), not get yanked
    // to the stale pre-load offset via a leftover prependingRef.
    expect(el.scrollTop).toBe(50);
    expect(screen.getByRole("button", { name: /1 new message/ })).toBeInTheDocument();
  });

  it("renders a reply preview and jumps to the original on click", () => {
    messages = [
      msg({ id: "m1", authorName: "al", content: "original text" }),
      msg({ id: "m2", authorId: "u2", authorName: "zed", content: "a reply", replyToId: "m1" }),
    ];
    render(<Harness />);

    // "original text" appears twice: the original message body, and the
    // truncated preview span inside the reply button — find the latter.
    const preview = screen
      .getAllByText("original text")
      .map((el) => el.closest("button"))
      .find((el): el is HTMLButtonElement => el != null);
    expect(preview).toBeTruthy();
    expect(preview).toHaveTextContent("al");

    fireEvent.click(preview!);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("shows 'Original message not loaded' when the replied-to message isn't in the loaded set", () => {
    messages = [msg({ id: "m2", replyToId: "missing" })];
    render(<Harness />);

    expect(screen.getByText("Original message not loaded")).toBeInTheDocument();
  });

  it("inline edit saves on Enter", async () => {
    const user = userEvent.setup();
    messages = [msg({ id: "m1", authorId: "self-1", content: "hello" })];
    render(<Harness initialEditingId="m1" />);

    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("hello");

    await user.type(textarea, " world");
    await user.keyboard("{Enter}");

    expect(editMessage).toHaveBeenCalledWith("m1", "hello world");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("inline edit cancels on Escape without saving", async () => {
    const user = userEvent.setup();
    messages = [msg({ id: "m1", authorId: "self-1", content: "hello" })];
    render(<Harness initialEditingId="m1" />);

    const textarea = screen.getByRole("textbox");
    await user.type(textarea, "!!!");
    await user.keyboard("{Escape}");

    expect(editMessage).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("delete requires a second confirming click before calling deleteMessage", () => {
    messages = [msg({ id: "m1", authorId: "self-1" })];
    render(<Harness />);

    const del = screen.getByTitle("Delete");
    fireEvent.click(del);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(screen.getByTitle("Confirm delete?")).toBeInTheDocument();

    fireEvent.click(screen.getByTitle("Confirm delete?"));
    expect(deleteMessage).toHaveBeenCalledWith("m1");
  });

  it("toggles a reaction: removes when self already reacted, adds otherwise", () => {
    messages = [
      msg({
        id: "m1",
        reactions: [{ emoji: "👍", actors: [{ id: "self-1", name: "me" }] }],
      }),
      msg({
        id: "m2",
        reactions: [{ emoji: "🎉", actors: [{ id: "u2", name: "zed" }] }],
      }),
    ];
    render(<Harness />);

    fireEvent.click(screen.getByTitle("me")); // mine -> toggling removes
    expect(reactToMessage).toHaveBeenCalledWith("m1", "👍", "remove");

    fireEvent.click(screen.getByTitle("zed")); // not mine -> toggling adds
    expect(reactToMessage).toHaveBeenCalledWith("m2", "🎉", "add");
  });

  it("shows Retry/Delete on a failed message and calls the right actions", () => {
    messages = [msg({ id: "m1", failed: true, nonce: "n1" })];
    render(<Harness />);

    fireEvent.click(screen.getByText("Retry"));
    expect(retryMessage).toHaveBeenCalledWith("n1");

    fireEvent.click(screen.getByText("Delete"));
    expect(discardMessage).toHaveBeenCalledWith("n1");
  });

  it("renders a proposed item as an approval card in the conversation", () => {
    board = [proposal()];
    render(<Harness />);

    expect(screen.getByText("task-1")).toBeInTheDocument();
    expect(screen.getByText("Fix ICP rounding")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(document.getElementById("proposal-item-1")).toBeTruthy();
  });

  it("renders an orphan permission prompt in the conversation", () => {
    pendingInteractions = [interaction()];
    render(<Harness />);

    expect(screen.getByText("write_file billing/round.ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(document.getElementById("interaction-req-1")).toBeTruthy();
  });

  it("places a resource access card in the origin channel, not the requested channel", () => {
    pendingResourceAccessRequests = [
      {
        id: "rar-1",
        workspaceId: "srv-1",
        agentId: "agent-1",
        agentName: "noodle",
        resourceKind: "channel",
        resourceId: "ch-anoher",
        resourceName: "anoher",
        reason: "Read the other room",
        status: "pending",
        originChannelId: "ch-general",
        createdAt: Date.now(),
        resolvedBy: null,
        resolvedAt: null,
      },
    ];
    messages = [
      msg({ id: "m1", authorId: "agent-1", authorName: "noodle", authorKind: "agent", content: "I'll request access." }),
    ];
    render(<Harness />);
    expect(screen.getByText("anoher")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("copies message text from the hover rail", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    messages = [msg({ id: "m1", content: "copy me" })];
    render(<Harness />);

    fireEvent.click(screen.getByTitle("Copy message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"));
  });

  it("pins an unpinned message and unpins a pinned message", () => {
    messages = [
      msg({ id: "m1", content: "one" }),
      msg({ id: "m2", content: "two", pinnedAt: 100, pinnedBy: "bea" }),
    ];
    render(<Harness />);

    fireEvent.click(screen.getByTitle("Pin message"));
    expect(pinMessage).toHaveBeenCalledWith("m1", true);

    fireEvent.click(screen.getByTitle("Unpin message"));
    expect(pinMessage).toHaveBeenCalledWith("m2", false);
  });
});
