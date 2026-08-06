import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

// Only the network boundary is mocked; the boot decision itself runs for real.
const fetchMock = vi.fn<typeof fetch>();

// The websocket boundary is replaced by a fake that greets with a welcome
// frame and records what the UI sends, so the real Workspace can boot.
const { sent } = vi.hoisted(() => ({
  sent: [] as Array<{ type: string; content?: string }>,
}));
vi.mock("./ws", () => {
  class WorkspaceSocket {
    private listeners = new Set<(event: unknown) => void>();
    connect() {
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
          self,
          history: [],
          participants: [self],
          channels: ["general"],
          demoChannels: [],
          token: "tok-1",
          apiUrl: "http://api.test",
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
    close() {}
  }
  return { WorkspaceSocket };
});

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

// node's experimental localStorage global (undefined without a flag) shadows
// jsdom's in this test process, so back it with a real in-memory Storage.
const storageStub = (): Storage => {
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
    vi.stubGlobal("localStorage", storageStub());
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("guest mode (no Google client id) keeps the guest name modal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { googleClientId: null }));

    render(<App />);

    expect(await screen.findByText("Join the workspace")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/config"));
  });

  it("auth mode shows the Google login screen instead", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleClientId: "client-1.apps.googleusercontent.com" }),
    );

    render(<App />);

    expect(await screen.findByText("Sign in")).toBeInTheDocument();
    expect(screen.queryByText("Join the workspace")).not.toBeInTheDocument();
  });
});

describe("Workspace composer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", storageStub());
    window.sessionStorage.clear();
    sent.length = 0;
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  /** Boot straight into the chat view and hand back the composer textarea. */
  const bootWorkspace = async (): Promise<HTMLElement> => {
    window.sessionStorage.setItem("displayName", "hana");
    fetchMock.mockImplementation((input) => {
      if (String(input).includes("/api/auth/config")) {
        return Promise.resolve(jsonResponse(200, { googleClientId: null }));
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
});
