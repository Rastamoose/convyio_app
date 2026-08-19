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
    fetchActors.mockReset().mockResolvedValue([]);
    vi.restoreAllMocks();
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

  it("assigns the selected agent, revokes access, and manages files", async () => {
    const user = userEvent.setup();
    let assigned = false;
    const writes: Array<{ path: string; content: string }> = [];
    const deleted: string[] = [];
    const project = {
      id: "project-1",
      workspaceId: "workspace-1",
      name: "notes",
      kind: "directory",
      remoteUrl: null,
      defaultBranch: null,
      createdBy: "human-1",
      createdByName: "Harris",
      createdAt: 1,
      archivedAt: null,
      accessMode: "always",
    } as const;
    const mount = {
      id: "mount-1",
      projectId: project.id,
      nodeId: "node-1",
      mountKey: "opaque",
      headRevision: null,
      branch: null,
      cleanliness: "unknown",
      createdAt: 1,
      updatedAt: 1,
    } as const;
    fetchActors.mockResolvedValue([
      { id: "alpha", workspaceId: "workspace-1", kind: "agent", displayName: "Alpha" },
      { id: "beta", workspaceId: "workspace-1", kind: "agent", displayName: "Beta" },
    ]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/toolman/nodes") return response({ nodes: [{
        id: "node-1",
        workspaceId: "workspace-1",
        name: "desk",
        createdBy: "human-1",
        createdByName: "Harris",
        createdAt: 1,
        lastConnectedAt: 1,
        revokedAt: null,
        health: "ready",
      }] });
      if (path === "/api/projects") return response({ projects: [project] });
      if (path === "/api/project-access-requests") return response({ requests: [] });
      if (path === "/api/projects/project-1") return response({
        project,
        mounts: [mount],
        assignments: assigned ? [{
          projectId: project.id,
          agentId: "beta",
          agentName: "Beta",
          mountId: mount.id,
          assignedBy: "human-1",
          assignedAt: 1,
          checkoutKey: "checkout",
          branch: null,
          baseRevision: null,
          status: "ready",
          lastError: null,
          updatedAt: 1,
        }] : [],
      });
      if (path === "/api/projects/project-1/assignments" && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ agentId: "beta", mountId: "mount-1" });
        assigned = true;
        return response({ assignment: {} });
      }
      if (path === "/api/projects/project-1/assignments/beta" && init?.method === "DELETE") {
        assigned = false;
        return response({ ok: true });
      }
      if (path.startsWith("/api/projects/project-1/files?")) return response({ entries: ["a.txt"] });
      if (path.startsWith("/api/projects/project-1/file?") && !init?.method) return response({ content: "old" });
      if (path === "/api/projects/project-1/file" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { path: string; content: string };
        writes.push({ path: body.path, content: body.content });
        return response({ ok: true });
      }
      if (path === "/api/projects/project-1/file" && init?.method === "DELETE") {
        deleted.push((JSON.parse(String(init.body)) as { path: string }).path);
        return response({ ok: true });
      }
      throw new Error(`unexpected request: ${path}`);
    });

    render(<ResourcesView />);
    await screen.findByLabelText("Agent to assign to notes");
    await new Promise((resolve) => window.setTimeout(resolve, 25));
    await user.selectOptions(screen.getByLabelText("Agent to assign to notes"), "beta");
    expect(await screen.findByText("Beta · ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Revoke Beta from notes" }));
    expect(await screen.findByText("No agents assigned.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open files" }));
    expect(await screen.findByText("a.txt")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add file" }));
    await user.type(screen.getByLabelText("File path"), "new.txt");
    await user.type(screen.getByLabelText("File contents"), "new content");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(writes).toContainEqual({ path: "new.txt", content: "new content" });

    await user.click(screen.getByText("a.txt"));
    const contents = screen.getByLabelText("File contents");
    await user.clear(contents);
    await user.type(contents, "edited");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(writes).toContainEqual({ path: "a.txt", content: "edited" });
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleted).toEqual(["a.txt"]);
  });
});
