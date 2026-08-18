import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ResourcesView,
  toolmanCliCommands,
  toolmanPairCommand,
  toolmanSetupPrompt,
} from "./ResourcesView";

const apiFetch = vi.fn();
const fetchActors = vi.fn().mockResolvedValue([]);

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    apiFetch,
    apiUrl: "http://localhost:3001",
    fetchActors,
    self: { id: "human-1" },
    participants: [],
  }),
}));

const response = (body: unknown): Response =>
  ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  }) as Response;

describe("ResourcesView", () => {
  afterEach(() => {
    cleanup();
    apiFetch.mockReset();
  });

  it("makes the setup prompt the primary way to share a folder", async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/toolman/nodes") return response({ nodes: [] });
      if (path === "/api/projects") return response({ projects: [] });
      if (path === "/api/project-access-requests") return response({ requests: [] });
      if (path === "/api/toolman/pairings" && init?.method === "POST") {
        expect(JSON.parse(init.body as string)).toEqual({ name: "desk" });
        return {
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              pairing: {
                id: "pair-1",
                workspaceId: "w1",
                nodeName: "desk",
                createdBy: "human-1",
                createdAt: 1,
                expiresAt: 2,
                consumedAt: null,
                revokedAt: null,
              },
              pairingCode: "pair-code-xyz",
            }),
        } as Response;
      }
      throw new Error(`unexpected request: ${path}`);
    });

    render(<ResourcesView />);

    expect(
      await screen.findByText(/Paste a prompt into Claude Code, Cursor, Codex/),
    ).toBeInTheDocument();
    expect(screen.getByText(/streams one local folder into the/)).toBeInTheDocument();

    await user.click(screen.getByText("Share this folder"));

    const expectedPrompt = toolmanSetupPrompt("http://localhost:3001", "pair-code-xyz", "desk");
    expect((await screen.findByLabelText("Setup prompt")).textContent).toBe(expectedPrompt);
    expect(screen.getByRole("button", { name: (n) => n === "CLI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: (n) => n === "Pairing code" })).toBeInTheDocument();
    expect(screen.queryByText("pair-code-xyz")).not.toBeInTheDocument();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByLabelText("Copy setup prompt"));
    expect(writeText).toHaveBeenCalledWith(expectedPrompt);

    await user.click(screen.getByLabelText("Copy CLI"));
    expect(writeText).toHaveBeenCalledWith(
      toolmanCliCommands("http://localhost:3001", "pair-code-xyz"),
    );
  });

  it("writes a local-only setup prompt that includes pair, attach, and run", () => {
    const prompt = toolmanSetupPrompt("https://app.convyio.com", "secret-code", "laptop");
    expect(prompt).toContain(toolmanPairCommand("https://app.convyio.com", "secret-code"));
    expect(prompt).toContain("convyio-toolman project add .");
    expect(prompt).toContain("convyio-toolman run");
    expect(prompt).toContain('machine "laptop"');
    expect(prompt).toContain("does not need an API key");
    expect(prompt).toContain("A dirty or uncommitted tree is fine");
    expect(prompt).not.toContain("commit or stash first");
    expect(prompt).toContain("Do not put the pairing code in git, chat, or logs");
  });
});
