import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

// Only the network boundary is mocked; the boot decision itself runs for real.
const fetchMock = vi.fn<typeof fetch>();

// The websocket boundary is replaced by a fake that greets with a welcome
// frame and records what the UI sends, so the real Workspace can boot.
// `historySeed` lets individual tests plant chat history before boot (e.g. an
// own message to edit); tests reset it in beforeEach.
const { sent, historySeed, channelsSeed, authState, connectedWorkspaces, closedWorkspaces } = vi.hoisted(() => ({
  sent: [] as Array<{ type: string; content?: string; replyToId?: string }>,
  historySeed: [] as unknown[],
  channelsSeed: ["general"] as string[],
  connectedWorkspaces: [] as string[],
  closedWorkspaces: [] as string[],
  // The Supabase auth boundary: null = signed out. Tests set this directly
  // instead of seeding localStorage, since App.tsx now sources its session
  // from supabase.auth.getSession()/onAuthStateChange, not stored tokens.
  authState: { session: null as null | { access_token: string } },
}));

vi.mock("./lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: authState.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: () => Promise.resolve({ error: null }),
    },
  },
  getRememberMe: () => true,
  setRememberMe: vi.fn(),
}));

vi.mock("./ws", () => {
  class WorkspaceSocket {
    private listeners = new Set<(event: unknown) => void>();
    private workspaceId = "";
    connect(credentials: { workspaceId: string }) {
      this.workspaceId = credentials.workspaceId;
      connectedWorkspaces.push(credentials.workspaceId);
      const self = {
        id: "u-1",
        name: "hana",
        kind: "human",
        status: "",
        runState: "idle",
        online: true,
      };
      for (const listener of this.listeners) {
        listener({
          type: "welcome",
          workspace: { id: this.workspaceId, name: this.workspaceId === "ws-1" ? "test_space" : "second_space" },
          self,
          history: historySeed,
          participants: [self],
          channels: channelsSeed,
          archivedChannels: [],
          pinnedChannels: [],
          demoChannels: [],
          token: "tok-1",
          apiUrl: "http://api.test",
          snapshotSeq: 0,
        });
      }
    }
    send(event: { type: string }) {
      sent.push(event);
    }
    onEvent(listener: (event: unknown) => void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    onDisconnect() {
      return () => {};
    }
    close() {
      closedWorkspaces.push(this.workspaceId);
    }
  }
  return { WorkspaceSocket };
});

// MessageList is owned by a parallel change and isn't under test here; stub
// it so App's reply/edit wiring (the thing this file covers) is observable
// without depending on MessageList's own reply-button UI.
vi.mock("./components/MessageList", () => ({
  MessageList: ({
    editingId,
    onReply,
  }: {
    editingId: string | null;
    onReply: (message: {
      id: string;
      authorId: string;
      authorName: string;
      authorKind: string;
      content: string;
      timestamp: number;
    }) => void;
  }) => (
    <>
      <div data-testid="editing-id">{editingId ?? ""}</div>
      <button
        onClick={() =>
          onReply({
            id: "m-1",
            authorId: "u-2",
            authorName: "bob",
            authorKind: "human",
            content: "hello world",
            timestamp: Date.now(),
          })
        }
      >
        trigger-reply
      </button>
    </>
  ),
}));

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

// jsdom's localStorage is shadowed by Node's experimental global in this
// test process, and WorkspaceProvider/MessageInput still read/write it.
const makeStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

describe("App boot decision", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("sessionStorage", makeStorage());
    window.history.replaceState({}, "", "/");
    authState.session = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("no auth method configured shows the contact-support dead end", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: false }),
    );

    render(<App />);

    expect(await screen.findByText("Sign-in unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "hello@convyio.com" })).toHaveAttribute(
      "href",
      "mailto:hello@convyio.com",
    );
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/config"));
  });

  it("auth mode shows the Google login screen instead", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleAuthEnabled: true, emailAuthEnabled: false }),
    );

    render(<App />);

    expect(await screen.findByText("Sign in")).toBeInTheDocument();
    expect(screen.queryByText("Join the workspace")).not.toBeInTheDocument();
  });

  it("a signed-in Supabase user without a username sees the username step", async () => {
    authState.session = { access_token: "tok-1" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleAuthEnabled: true, emailAuthEnabled: false }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { status: "needs_username" }),
    );

    render(<App />);

    expect(await screen.findByText("Pick a username")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/account"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer tok-1",
        }),
      }),
    );
  });

  it("a user without memberships sees the workspace lobby", async () => {
    authState.session = { access_token: "tok-1" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleAuthEnabled: true, emailAuthEnabled: false }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {
      status: "ok",
      username: "hana",
      workspaces: [],
      accessRequests: [],
    }));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose a workspace" })).toBeInTheDocument();
    expect(screen.getByText("No workspace memberships yet. Create one or ask for access below.")).toBeInTheDocument();
  });
});

describe("Workspace switching", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("sessionStorage", makeStorage());
    window.history.replaceState({}, "", "/");
    window.localStorage.setItem("convyio:last-workspace", "ws-1");
    authState.session = { access_token: "tok-1" };
    connectedWorkspaces.length = 0;
    closedWorkspaces.length = 0;
    Element.prototype.scrollIntoView = vi.fn();
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return Promise.resolve(jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: true }));
      }
      if (url.includes("/api/account")) {
        return Promise.resolve(jsonResponse(200, {
          status: "ok",
          username: "hana",
          workspaces: [
            { id: "ws-1", name: "First Space", publicCode: "FIRST", role: "owner", joinedAt: 1_000 },
            { id: "ws-2", name: "Second Space", publicCode: "SECOND", role: "member", joinedAt: 2_000 },
          ],
          accessRequests: [],
        }));
      }
      return new Promise<Response>(() => {});
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("closes the old workspace session and opens a keyed provider for the new workspace", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByRole("button", { name: "First Space" });
    await user.click(screen.getByRole("button", { name: "First Space" }));
    await user.click(screen.getByRole("menuitem", { name: /Second Space/ }));

    await waitFor(() => expect(connectedWorkspaces).toEqual(["ws-1", "ws-2"]));
    expect(closedWorkspaces).toContain("ws-1");
    expect(window.location.pathname).toBe("/w/ws-2");
    expect(window.localStorage.getItem("convyio:last-workspace")).toBe("ws-2");
  });
});

describe("Workspace composer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("sessionStorage", makeStorage());
    window.history.replaceState({}, "", "/");
    sent.length = 0;
    historySeed.length = 0;
    channelsSeed.length = 0;
    channelsSeed.push("general");
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  /** Boot straight into the chat view and hand back the composer textarea. */
  const bootWorkspace = async (): Promise<HTMLElement> => {
    authState.session = { access_token: "tok-1" };
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return Promise.resolve(jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: true }));
      }
      if (url.includes("/api/account")) {
        return Promise.resolve(jsonResponse(200, {
          status: "ok",
          username: "hana",
          workspaces: [{ id: "ws-1", name: "test_space", publicCode: "TEST-SPACE", role: "owner", joinedAt: 1_000 }],
          accessRequests: [],
        }));
      }
      // Board snapshot etc.: stay pending, irrelevant to these tests.
      return new Promise<Response>(() => {});
    });
    render(<App />);
    return await screen.findByLabelText("Message general");
  };

  it("an unknown slash command toasts and keeps the draft", async () => {
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.type(composer, "/foo{Enter}");

    expect(await screen.findByText("Unknown command: /foo")).toBeInTheDocument();
    expect(composer).toHaveValue("/foo");
    expect(sent.filter((e) => e.type === "message")).toHaveLength(0);
  });

  it("Shift+Enter inserts a newline instead of sending", async () => {
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.type(composer, "line1{Shift>}{Enter}{/Shift}line2");

    expect(composer).toHaveValue("line1\nline2");
    expect(sent.filter((e) => e.type === "message")).toHaveLength(0);

    await user.keyboard("{Enter}");
    expect(sent.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ content: "line1\nline2" }),
    ]);
    expect(composer).toHaveValue("");
  });

  it("reply pill appears and the × clears it", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.click(screen.getByRole("button", { name: "trigger-reply" }));
    expect(await screen.findByText("Replying to bob")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel reply" }));
    expect(screen.queryByText("Replying to bob")).not.toBeInTheDocument();
  });

  it("sending with a reply passes replyToId and clears the pill", async () => {
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.click(screen.getByRole("button", { name: "trigger-reply" }));
    await screen.findByText("Replying to bob");

    await user.type(composer, "thanks{Enter}");

    expect(sent.filter((e) => e.type === "message")).toEqual([
      expect.objectContaining({ content: "thanks", replyToId: "m-1" }),
    ]);
    expect(screen.queryByText("Replying to bob")).not.toBeInTheDocument();
  });

  it("Escape clears reply state", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.click(screen.getByRole("button", { name: "trigger-reply" }));
    await screen.findByText("Replying to bob");

    // The reply pill focuses the composer, so Escape lands on it.
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Replying to bob")).not.toBeInTheDocument();
  });

  it("ArrowUp in an empty composer sets editingId to the user's own last message", async () => {
    historySeed.push({
      id: "own-msg-1",
      authorId: "u-1",
      authorName: "hana",
      authorKind: "human",
      content: "my earlier message",
      timestamp: Date.now(),
      channel: "general",
    });
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.click(composer);
    await user.keyboard("{ArrowUp}");

    expect(await screen.findByTestId("editing-id")).toHaveTextContent("own-msg-1");
  });

  it("ArrowUp with text in the composer does not request an edit", async () => {
    historySeed.push({
      id: "own-msg-1",
      authorId: "u-1",
      authorName: "hana",
      authorKind: "human",
      content: "my earlier message",
      timestamp: Date.now(),
      channel: "general",
    });
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    await user.type(composer, "still typing");
    await user.keyboard("{ArrowUp}");

    expect(screen.getByTestId("editing-id")).toHaveTextContent("");
  });
});

describe("Workspace keyboard navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", makeStorage());
    vi.stubGlobal("sessionStorage", makeStorage());
    window.history.replaceState({}, "", "/");
    sent.length = 0;
    historySeed.length = 0;
    channelsSeed.length = 0;
    channelsSeed.push("general", "random", "bugs");
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  /** Boot straight into the chat view and hand back the composer textarea. */
  const bootWorkspace = async (): Promise<HTMLElement> => {
    authState.session = { access_token: "tok-1" };
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/auth/config")) {
        return Promise.resolve(jsonResponse(200, { googleAuthEnabled: false, emailAuthEnabled: true }));
      }
      if (url.includes("/api/account")) {
        return Promise.resolve(jsonResponse(200, {
          status: "ok",
          username: "hana",
          workspaces: [{ id: "ws-1", name: "test_space", publicCode: "TEST-SPACE", role: "owner", joinedAt: 1_000 }],
          accessRequests: [],
        }));
      }
      return new Promise<Response>(() => {});
    });
    render(<App />);
    return await screen.findByLabelText("Message general");
  };

  it("Alt+ArrowDown advances the open page and wraps at the end", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    // Rooms become pages when opened from the sidebar; cycling walks pages.
    const rooms = screen.getByRole("tablist", { name: "Rooms" });
    await user.click(within(rooms).getByRole("tab", { name: /random/ }));
    await user.click(within(rooms).getByRole("tab", { name: /bugs/ }));

    // Active page is the last one opened; advancing wraps to the first page.
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByLabelText("Message general")).toBeInTheDocument();

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByLabelText("Message random")).toBeInTheDocument();

    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(await screen.findByLabelText("Message bugs")).toBeInTheDocument();
  });

  it("Alt+ArrowUp cycles pages while the composer is focused, without also triggering its own edit-last shortcut", async () => {
    historySeed.push({
      id: "own-msg-1",
      authorId: "u-1",
      authorName: "hana",
      authorKind: "human",
      content: "my earlier message",
      timestamp: Date.now(),
      channel: "general",
    });
    const user = userEvent.setup();
    const composer = await bootWorkspace();

    // Open bugs as a second page, return to general, then wrap backward.
    const rooms = screen.getByRole("tablist", { name: "Rooms" });
    await user.click(within(rooms).getByRole("tab", { name: /bugs/ }));
    await user.click(within(rooms).getByRole("tab", { name: /general/ }));
    await user.click(composer);

    // Backward from "general" (first page) wraps to the last page, "bugs".
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");

    expect(await screen.findByLabelText("Message bugs")).toBeInTheDocument();
    expect(screen.getByTestId("editing-id")).toHaveTextContent("");
  });

  it("Ctrl+K opens the quick switcher", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    expect(await screen.findByLabelText("Jump to channel")).toBeInTheDocument();
  });

  it("typing filters the channel list", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("Jump to channel");
    await user.type(input, "bug");

    const list = screen.getByRole("list");
    expect(within(list).getByText("bugs")).toBeInTheDocument();
    expect(within(list).queryByText("random")).not.toBeInTheDocument();
  });

  it("Enter selects the highlighted channel and closes the switcher", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByLabelText("Jump to channel");
    await user.type(input, "bug{Enter}");

    expect(await screen.findByLabelText("Message bugs")).toBeInTheDocument();
    expect(screen.queryByLabelText("Jump to channel")).not.toBeInTheDocument();
  });

  it("Escape closes the switcher", async () => {
    const user = userEvent.setup();
    await bootWorkspace();

    await user.keyboard("{Control>}k{/Control}");
    await screen.findByLabelText("Jump to channel");
    await user.keyboard("{Escape}");

    expect(screen.queryByLabelText("Jump to channel")).not.toBeInTheDocument();
  });
});
