import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GitRepository } from "@workspace/shared";
import { GitProjectsView } from "./GitProjectsView";

const apiFetch = vi.fn();
const notify = vi.fn();
const fetchActors = vi.fn().mockResolvedValue([]);

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({ apiFetch, fetchActors, notify }),
}));

const repository: GitRepository = {
  projectId: "project-1",
  workspaceId: "workspace-1",
  connectionId: "connection-1",
  provider: "github",
  providerRepositoryId: "42",
  owner: "acme",
  name: "app",
  fullName: "acme/app",
  description: "The app",
  private: true,
  defaultBranch: "main",
  htmlUrl: "https://github.com/acme/app",
  state: "ready",
  lastSyncedAt: 1,
  lastError: null,
  linkedBy: "human-1",
  linkedAt: 1,
  sync: {
    branch: "main",
    localHead: "abc",
    remoteHead: "abc",
    aheadCount: 0,
    behindCount: 0,
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    canPush: false,
    pushBlockReason: "Nothing to push",
    canPull: false,
    pullBlockReason: "Already up to date",
  },
};

const response = (body: unknown): Response => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
}) as Response;

describe("GitProjectsView", () => {
  afterEach(() => {
    cleanup();
    apiFetch.mockReset();
    notify.mockReset();
  });

  it("offers GitHub connection when no account is linked", async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === "/api/git/account") return Promise.resolve(response({ available: true, account: null }));
      if (path === "/api/git/repositories") return Promise.resolve(response({ repositories: [] }));
      throw new Error(`unexpected request ${path}`);
    });

    render(<GitProjectsView />);

    expect(await screen.findByText("Bring your repositories into the workspace")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeInTheDocument();
  });

  it("opens a linked repository with Buzz-style source and sync controls", async () => {
    const user = userEvent.setup();
    apiFetch.mockImplementation((path: string) => {
      if (path === "/api/git/account") return Promise.resolve(response({
        available: true,
        account: {
          id: "connection-1",
          provider: "github",
          login: "octocat",
          displayName: "Octo Cat",
          avatarUrl: null,
          scopes: ["repo"],
          connectedAt: 1,
        },
      }));
      if (path === "/api/git/repositories") return Promise.resolve(response({ repositories: [repository] }));
      if (path === "/api/git/repositories/project-1/branches") return Promise.resolve(response({ branches: [{ name: "main", sha: "abc", isDefault: true }] }));
      if (path === "/api/projects/project-1") return Promise.resolve(response({ project: {}, assignments: [], mounts: [] }));
      if (path.startsWith("/api/git/repositories/project-1/tree?")) return Promise.resolve(response({ entries: [] }));
      if (path === "/api/git/repositories/project-1/pulls?state=open") return Promise.resolve(response({ pulls: [{ id: "pull-7", number: 7, title: "Agent change", state: "open", draft: false, author: "octocat", head: "feature", base: "main", updatedAt: 1, htmlUrl: "https://github.com/acme/app/pull/7" }] }));
      if (path === "/api/git/repositories/project-1/pulls/7/files") return Promise.resolve(response({ files: [{ filename: "src/app.ts", status: "modified", additions: 2, deletions: 1, patch: "@@ -1 +1 @@" }] }));
      throw new Error(`unexpected request ${path}`);
    });

    render(<GitProjectsView />);
    await user.click(await screen.findByText("acme/app"));

    expect(await screen.findByRole("heading", { name: "acme/app" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "remote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "local" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Push" })).toBeDisabled();
    expect(screen.getByText("Add an agent to the workspace first.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "local" }));
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining("source=local"));

    await user.click(screen.getByRole("tab", { name: "Pull requests" }));
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.click(screen.getByRole("tab", { name: /Files changed/ }));
    expect(await screen.findByText("src/app.ts")).toBeInTheDocument();
    expect(screen.getByText("@@ -1 +1 @@")).toBeInTheDocument();
  });
});
