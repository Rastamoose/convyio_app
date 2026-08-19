import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  Actor,
  GitBranch,
  GitCheck,
  GitCommit,
  GitIssue,
  GitPullFile,
  GitPullRequest,
  GitRepository,
  GitSyncStatus,
  GitTreeEntry,
  ProjectAction,
} from "@workspace/shared";
import { ApiError } from "../board/BoardService";
import type { ToolmanResult } from "../board/Toolman";
import type { Channels } from "../chat/Channels";
import type { ThreadEventStore } from "../chat/ThreadEventStore";
import type { WorkspaceDb } from "../db";
import type { ProjectStore } from "./ProjectStore";
import type { GitHub } from "./GitHub";
import {
  deleteManagedFile,
  editManagedFile,
  listManagedFiles,
  moveManagedFile,
  readManagedFile,
  resolveManagedPath,
  writeManagedFile,
} from "./ManagedProjectFiles";

const PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_MAX_BYTES = 10_485_760;
const OUTPUT_CLIP = 16_000;

interface RepositoryRow {
  project_id: string;
  workspace_id: string;
  connection_id: string;
  provider: "github";
  provider_repository_id: string;
  owner_name: string;
  repository_name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  default_branch: string;
  html_url: string;
  clone_url: string;
  state: "cloning" | "ready" | "error";
  last_synced_at: number | null;
  last_error: string | null;
  linked_by: string;
  linked_at: number;
  unlinked_at: number | null;
}

interface GitHubBranchResponse {
  name: string;
  commit: { sha: string };
}

interface GitHubCommitResponse {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name: string; date: string } | null };
  author: { login: string; avatar_url: string | null } | null;
}

interface GitHubPullResponse {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  html_url: string;
  updated_at: string;
  user: { login: string };
  head: { ref: string; sha: string };
  base: { ref: string };
}

interface GitHubPullFileResponse {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface GitHubCheckResponse {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

interface GitHubIssueResponse {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  updated_at: string;
  user: { login: string };
  labels: ({ name: string } | string)[];
  pull_request?: unknown;
}

interface ProcessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export class GitRepositories {
  private locks = new Map<string, Promise<void>>();

  constructor(
    private store: WorkspaceDb,
    private events: ThreadEventStore,
    private projects: ProjectStore,
    private github: GitHub,
    private channels: Channels,
    private root: string,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async list(): Promise<GitRepository[]> {
    const rows = await this.store.sql<RepositoryRow[]>`
      SELECT * FROM git_repositories
      WHERE workspace_id = ${this.store.workspaceId} AND unlinked_at IS NULL
      ORDER BY linked_at DESC
    `;
    return Promise.all(rows.map((row) => this.toRepository(row)));
  }

  async find(projectId: string): Promise<GitRepository | null> {
    const row = await this.findRow(projectId);
    return row ? this.toRepository(row) : null;
  }

  async isManaged(projectId: string): Promise<boolean> {
    return (await this.findRow(projectId)) !== null;
  }

  async link(actor: Actor, fullName: string): Promise<GitRepository> {
    this.assertHuman(actor);
    const remote = await this.github.repository(actor.id, fullName);
    const existing = await this.store.sql<RepositoryRow[]>`
      SELECT * FROM git_repositories
      WHERE workspace_id = ${this.store.workspaceId}
        AND provider = 'github'
        AND provider_repository_id = ${remote.providerId}
    `;
    const account = await this.github.account(actor.id);
    if (!account) throw new ApiError(409, "GITHUB_AUTH_REQUIRED", "connect GitHub first");
    if (existing[0] && !existing[0].unlinked_at) return this.toRepository(existing[0]);
    if (existing[0]) {
      if (existing[0].linked_by !== actor.id) throw new ApiError(403, "OWNER_ONLY", "only the original repository owner can relink it");
      const now = Date.now();
      await this.store.transaction(async (sql) => {
        await sql`UPDATE projects SET archived_at = NULL WHERE id = ${existing[0].project_id} AND workspace_id = ${this.store.workspaceId}`;
        await sql`
          UPDATE git_repositories SET
            connection_id = ${account.id}, owner_name = ${remote.owner}, repository_name = ${remote.name},
            full_name = ${remote.fullName}, description = ${remote.description}, private = ${remote.private},
            default_branch = ${remote.defaultBranch}, html_url = ${remote.htmlUrl}, clone_url = ${remote.cloneUrl},
            state = 'cloning', last_error = NULL, linked_at = ${now}, unlinked_at = NULL
          WHERE project_id = ${existing[0].project_id} AND workspace_id = ${this.store.workspaceId}
        `;
        await this.events.append(sql, {
          workspaceId: this.store.workspaceId,
          actorId: actor.id,
          kind: "git.repository.linked",
          subjectId: existing[0].project_id,
          payload: { projectId: existing[0].project_id, provider: "github", fullName: remote.fullName, state: "cloning" },
          createdAt: now,
        });
      });
      await this.clone(existing[0].project_id).catch(async (error: unknown) => {
        await this.setState(existing[0].project_id, "error", error instanceof Error ? error.message : String(error));
      });
      return (await this.find(existing[0].project_id))!;
    }
    const project = await this.projects.create(actor, {
      name: await this.availableProjectName(remote.name, remote.owner),
      kind: "git",
      remoteUrl: remote.cloneUrl,
      defaultBranch: remote.defaultBranch,
    });
    const now = Date.now();
    await this.store.transaction(async (sql) => {
      await sql`
        INSERT INTO git_repositories (
          project_id, workspace_id, connection_id, provider, provider_repository_id,
          owner_name, repository_name, full_name, description, private, default_branch,
          html_url, clone_url, state, linked_by, linked_at
        ) VALUES (
          ${project.id}, ${this.store.workspaceId}, ${account.id}, 'github', ${remote.providerId},
          ${remote.owner}, ${remote.name}, ${remote.fullName}, ${remote.description}, ${remote.private},
          ${remote.defaultBranch}, ${remote.htmlUrl}, ${remote.cloneUrl}, 'cloning', ${actor.id}, ${now}
        )
      `;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "git.repository.linked",
        subjectId: project.id,
        payload: { projectId: project.id, provider: "github", fullName: remote.fullName, state: "cloning" },
        createdAt: now,
      });
    });
    await this.clone(project.id).catch(async (error: unknown) => {
      await this.setState(project.id, "error", error instanceof Error ? error.message : String(error));
    });
    return (await this.find(project.id))!;
  }

  async retry(actor: Actor, projectId: string): Promise<GitRepository> {
    const row = await this.requireOwned(actor, projectId);
    if (row.state === "ready") return this.toRepository(row);
    await this.setState(projectId, "cloning", null);
    await this.clone(projectId).catch(async (error: unknown) => {
      await this.setState(projectId, "error", error instanceof Error ? error.message : String(error));
    });
    return (await this.find(projectId))!;
  }

  async unlink(actor: Actor, projectId: string): Promise<void> {
    const row = await this.requireOwned(actor, projectId);
    const rooms = await this.store.sql<{ name: string }[]>`
      SELECT c.name FROM git_branch_channels b
      JOIN channels c ON c.id = b.channel_id
      WHERE b.project_id = ${projectId} AND b.archived_at IS NULL
    `;
    for (const room of rooms) await this.channels.setArchived(actor, room.name, true);
    const now = Date.now();
    await this.store.transaction(async (sql) => {
      await sql`DELETE FROM project_assignments WHERE project_id = ${projectId}`;
      await sql`UPDATE projects SET archived_at = ${now} WHERE id = ${projectId} AND workspace_id = ${this.store.workspaceId}`;
      await sql`UPDATE git_repositories SET unlinked_at = ${now} WHERE project_id = ${projectId} AND workspace_id = ${this.store.workspaceId}`;
      await sql`UPDATE git_branch_channels SET archived_at = ${now} WHERE project_id = ${projectId} AND archived_at IS NULL`;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "project.archived",
        subjectId: projectId,
        payload: { projectId },
        createdAt: now,
      });
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "git.repository.unlinked",
        subjectId: projectId,
        payload: { projectId, fullName: row.full_name },
        createdAt: now,
      });
    });
    await fs.rm(this.checkoutPath(projectId), { recursive: true, force: true }).catch((error: unknown) => {
      console.warn("[git] repository unlinked but its checkout could not be removed:", error instanceof Error ? error.message : error);
    });
  }

  async sync(actor: Actor, projectId: string, operation: "fetch" | "pull" | "push"): Promise<GitRepository> {
    await this.requireOwned(actor, projectId);
    await this.locked(projectId, async () => {
      await this.syncOperation(actor.id, projectId, operation);
    });
    return (await this.find(projectId))!;
  }

  async createBranch(actor: Actor, projectId: string, name: string, startPoint?: string): Promise<GitRepository> {
    await this.requireOwned(actor, projectId);
    await this.locked(projectId, async () => {
      await this.branch(actor, projectId, name, startPoint);
    });
    return (await this.find(projectId))!;
  }

  async deleteBranch(actor: Actor, projectId: string, name: string): Promise<GitRepository> {
    const row = await this.requireOwned(actor, projectId);
    const branchName = validRef(name);
    if (branchName === row.default_branch) throw new ApiError(409, "DEFAULT_BRANCH", "the default branch cannot be deleted");
    const openPulls = await this.pulls(projectId, "open");
    if (openPulls.some((pull) => pull.head === branchName)) {
      throw new ApiError(409, "BRANCH_HAS_PULL", "close or merge the branch's pull request before deleting it");
    }
    await this.locked(projectId, async () => {
      const root = this.checkoutPath(projectId);
      if (await this.currentBranch(root) === branchName) {
        await this.git(root, ["-c", "core.hooksPath=/dev/null", "switch", row.default_branch]);
      }
      await this.deleteRemoteBranch(row, root, branchName);
      await runProcess("git", ["branch", "-D", branchName], root, minimalEnv(root));
      let channelArchived = true;
      try {
        await this.archiveBranchChannel(row, branchName);
      } catch (error) {
        channelArchived = false;
        console.warn("[git] branch deleted but its channel could not be archived:", error instanceof Error ? error.message : error);
      }
      await this.record(actor.id, "git.branch.deleted", projectId, { projectId, branch: branchName, channelArchived });
    });
    return (await this.find(projectId))!;
  }

  async branches(projectId: string): Promise<GitBranch[]> {
    const row = await this.requireRow(projectId);
    const [rows, bindings] = await Promise.all([
      this.github.requestForConnection<GitHubBranchResponse[]>(
        row.connection_id,
        `/repos/${encodeRepo(row.full_name)}/branches?per_page=100`,
      ),
      this.store.sql<{ branch: string; name: string }[]>`
        SELECT b.branch, c.name FROM git_branch_channels b
        JOIN channels c ON c.id = b.channel_id
        WHERE b.project_id = ${projectId} AND b.archived_at IS NULL
      `,
    ]);
    const channelByBranch = new Map(bindings.map((binding) => [binding.branch, binding.name]));
    return rows.map((branch) => ({
      name: branch.name,
      sha: branch.commit.sha,
      isDefault: branch.name === row.default_branch,
      channelName: channelByBranch.get(branch.name) ?? null,
    }));
  }

  async commits(projectId: string, ref?: string): Promise<GitCommit[]> {
    const row = await this.requireRow(projectId);
    const query = ref ? `?sha=${encodeURIComponent(validRef(ref))}&per_page=100` : "?per_page=100";
    const rows = await this.github.requestForConnection<GitHubCommitResponse[]>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/commits${query}`,
    );
    return rows.map((commit) => ({
      sha: commit.sha,
      shortSha: commit.sha.slice(0, 7),
      message: commit.commit.message.split("\n")[0] ?? commit.commit.message,
      authorName: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
      authorAvatarUrl: commit.author?.avatar_url ?? null,
      committedAt: Date.parse(commit.commit.author?.date ?? ""),
      htmlUrl: commit.html_url,
    }));
  }

  async tree(
    projectId: string,
    ref?: string,
    directory?: string,
    source: "remote" | "local" = "remote",
  ): Promise<GitTreeEntry[]> {
    const row = await this.requireReadyRow(projectId);
    const selectedPath = directory ? validGitPath(directory) : "";
    if (source === "local") return this.workingTree(projectId, selectedPath);
    const selectedRef = validRef(ref ?? row.default_branch);
    const treeish = selectedPath ? `${selectedRef}:${selectedPath}` : selectedRef;
    const result = await this.git(this.checkoutPath(projectId), ["ls-tree", "-l", treeish]);
    return result.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const metadata = line.slice(0, tab).trim().split(/\s+/);
        const name = line.slice(tab + 1);
        const kind = metadata[1] === "tree" ? "directory" : "file";
        return {
          path: selectedPath ? `${selectedPath}/${name}` : name,
          name,
          kind,
          sha: metadata[2] ?? "",
          size: kind === "file" && metadata[3] !== "-" ? Number(metadata[3]) : null,
        } as GitTreeEntry;
      });
  }

  async file(
    projectId: string,
    filePath: string,
    ref?: string,
    source: "remote" | "local" = "remote",
  ): Promise<string> {
    const row = await this.requireReadyRow(projectId);
    if (source === "local") return readManagedFile(this.checkoutPath(projectId), validGitPath(filePath));
    const result = await this.git(this.checkoutPath(projectId), ["show", `${validRef(ref ?? row.default_branch)}:${validGitPath(filePath)}`]);
    if (Buffer.byteLength(result.stdout, "utf8") > 1_048_576) throw new ApiError(413, "FILE_TOO_LARGE", "file exceeds 1 MiB");
    return result.stdout;
  }

  async pulls(projectId: string, state: "open" | "closed" | "all" = "open"): Promise<GitPullRequest[]> {
    const row = await this.requireRow(projectId);
    const rows = await this.github.requestForConnection<GitHubPullResponse[]>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls?state=${state}&per_page=100`,
    );
    return rows.map(toPullRequest);
  }

  async pullFiles(projectId: string, number: number): Promise<GitPullFile[]> {
    const row = await this.requireRow(projectId);
    const files = await this.github.requestForConnection<GitHubPullFileResponse[]>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls/${number}/files?per_page=100`,
    );
    return files.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
    }));
  }

  async pullChecks(projectId: string, number: number): Promise<GitCheck[]> {
    const row = await this.requireRow(projectId);
    const pull = await this.github.requestForConnection<GitHubPullResponse>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls/${number}`,
    );
    const checks = await this.github.requestForConnection<{ check_runs: GitHubCheckResponse[] }>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/commits/${encodeURIComponent(pull.head.sha)}/check-runs`,
    );
    return checks.check_runs.map((check) => ({
      id: String(check.id),
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      htmlUrl: check.html_url,
    }));
  }

  async createPull(
    actor: Actor,
    projectId: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitPullRequest> {
    await this.requireOwned(actor, projectId);
    const row = await this.requireRow(projectId);
    const created = await this.github.requestForConnection<GitHubPullResponse>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls`,
      {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: validRef(input.head),
          base: validRef(input.base),
        }),
      },
    );
    await this.record(actor.id, "git.pull.created", projectId, {
      projectId,
      number: created.number,
      title: created.title,
      head: created.head.ref,
      base: created.base.ref,
    });
    return toPullRequest(created);
  }

  async approvePull(actor: Actor, projectId: string, number: number): Promise<void> {
    await this.requireOwned(actor, projectId);
    const row = await this.requireRow(projectId);
    await this.github.requestForConnection(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls/${number}/reviews`,
      { method: "POST", body: JSON.stringify({ event: "APPROVE" }) },
    );
    await this.record(actor.id, "git.pull.approved", projectId, { projectId, number });
  }

  async mergePull(actor: Actor, projectId: string, number: number): Promise<void> {
    await this.requireOwned(actor, projectId);
    const row = await this.requireRow(projectId);
    const pull = await this.github.requestForConnection<GitHubPullResponse>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls/${number}`,
    );
    await this.github.requestForConnection(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/pulls/${number}/merge`,
      { method: "PUT", body: JSON.stringify({ merge_method: "merge" }) },
    );
    let channelArchived = true;
    try {
      await this.archiveBranchChannel(row, pull.head.ref);
    } catch (error) {
      channelArchived = false;
      console.warn("[git] pull request merged but its channel could not be archived:", error instanceof Error ? error.message : error);
    }
    await this.record(actor.id, "git.pull.merged", projectId, {
      projectId,
      number,
      branch: pull.head.ref,
      channelArchived,
    });
  }

  async issues(projectId: string, state: "open" | "closed" | "all" = "open"): Promise<GitIssue[]> {
    const row = await this.requireRow(projectId);
    const rows = await this.github.requestForConnection<GitHubIssueResponse[]>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/issues?state=${state}&per_page=100`,
    );
    return rows.filter((issue) => !issue.pull_request).map(toIssue);
  }

  async createIssue(actor: Actor, projectId: string, title: string, body: string): Promise<GitIssue> {
    await this.requireOwned(actor, projectId);
    const row = await this.requireRow(projectId);
    const created = await this.github.requestForConnection<GitHubIssueResponse>(
      row.connection_id,
      `/repos/${encodeRepo(row.full_name)}/issues`,
      { method: "POST", body: JSON.stringify({ title, body }) },
    );
    await this.record(actor.id, "git.issue.created", projectId, {
      projectId,
      number: created.number,
      title: created.title,
    });
    return toIssue(created);
  }

  async execute(actor: Actor, action: ProjectAction): Promise<ToolmanResult> {
    try {
      const row = await this.requireReadyRow(action.projectId);
      const root = this.checkoutPath(row.project_id);
      switch (action.kind) {
        case "project_read_file":
          return { ok: true, output: await readManagedFile(root, action.path) };
        case "project_list_files":
          return { ok: true, output: (await listManagedFiles(root, action.path ?? ".")).join("\n") || "(empty)" };
        case "project_search_files": {
          const target = action.path ? await this.safeSearchPath(root, action.path) : root;
          const result = await runProcess("grep", ["-rIn", "--exclude-dir=node_modules", "--exclude-dir=.git", "-m", "100", "-e", action.query, "--", target], root, minimalEnv(root));
          return { ok: true, output: clip(result.stdout || result.stderr || "(no matches)") };
        }
        case "project_write_file":
          await writeManagedFile(root, action.path, action.content);
          return { ok: true, output: `wrote ${action.content.length} bytes to ${action.path}` };
        case "project_edit_file":
          await editManagedFile(root, action.path, action.oldString, action.newString);
          return { ok: true, output: `edited ${action.path}` };
        case "project_delete_file":
          await deleteManagedFile(root, action.path);
          return { ok: true, output: `deleted ${action.path}` };
        case "project_move_file":
          await moveManagedFile(root, action.from, action.to);
          return { ok: true, output: `moved ${action.from} → ${action.to}` };
        case "project_run_command":
          return {
            ok: false,
            code: "CHECKOUT_UNAVAILABLE",
            error: "commands on managed repositories require a paired local Toolman checkout",
          };
        case "project_git_commit": {
          await this.git(root, ["-c", "core.hooksPath=/dev/null", "add", "-A"]);
          const committed = await runProcess(
            "git",
            ["-c", "core.hooksPath=/dev/null", "commit", "-m", action.message],
            root,
            actorEnv(root, actor),
          );
          if (!committed.ok) return { ok: false, error: committed.stderr || committed.stdout || committed.error };
          const revision = await this.revision(root, "HEAD");
          await this.record(actor.id, "git.commit.created", action.projectId, {
            projectId: action.projectId,
            revision,
            message: action.message,
          });
          return { ok: true, output: revision ?? "committed" };
        }
        case "project_git_status":
          return { ok: true, output: JSON.stringify(await this.status(row), null, 2) };
        case "project_git_fetch":
          await this.locked(action.projectId, () => this.syncOperation(actor.id, action.projectId, "fetch"));
          return { ok: true, output: JSON.stringify(await this.status(await this.requireReadyRow(action.projectId)), null, 2) };
        case "project_git_pull":
          await this.locked(action.projectId, () => this.syncOperation(actor.id, action.projectId, "pull"));
          return { ok: true, output: JSON.stringify(await this.status(await this.requireReadyRow(action.projectId)), null, 2) };
        case "project_git_push":
          await this.locked(action.projectId, () => this.syncOperation(actor.id, action.projectId, "push"));
          return { ok: true, output: JSON.stringify(await this.status(await this.requireReadyRow(action.projectId)), null, 2) };
        case "project_git_branch":
          await this.locked(action.projectId, () => this.branch(actor, action.projectId, action.name, action.startPoint));
          return { ok: true, output: `created and pushed ${action.name}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async clone(projectId: string): Promise<void> {
    await this.locked(projectId, async () => {
      const row = await this.requireRow(projectId);
      const target = this.checkoutPath(projectId);
      await fs.rm(target, { recursive: true, force: true });
      await fs.mkdir(path.dirname(target), { recursive: true });
      await this.withCredential(row, async (env) => {
        const result = await runProcess(
          "git",
          [...credentialGitOptions(row.clone_url), "clone", "--origin", "origin", "--no-tags", "--filter=blob:none", row.clone_url, target],
          this.root,
          env,
        );
        if (!result.ok) throw new Error(result.stderr || result.stdout || result.error || "git clone failed");
      });
      await this.setState(projectId, "ready", null);
    });
  }

  private async syncOperation(actorId: string, projectId: string, operation: "fetch" | "pull" | "push"): Promise<void> {
    const row = await this.requireReadyRow(projectId);
    const root = this.checkoutPath(projectId);
    const branch = await this.currentBranch(root);
    if (!branch) throw new ApiError(409, "DETACHED_HEAD", "select a branch before syncing");
    if (operation === "fetch" || operation === "pull") {
      await this.withCredential(row, async (env) => {
        const result = await runProcess(
          "git",
          [...credentialGitOptions(row.clone_url), "fetch", "--prune", row.clone_url, "+refs/heads/*:refs/remotes/origin/*"],
          root,
          env,
        );
        if (!result.ok) throw new ApiError(409, "GIT_SYNC_FAILED", result.stderr || result.stdout || result.error || "fetch failed");
      });
      if (operation === "pull") await this.git(root, ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", `refs/remotes/origin/${branch}`]);
    } else {
      await this.withCredential(row, async (env) => {
        const result = await runProcess(
          "git",
          [...credentialGitOptions(row.clone_url), "push", row.clone_url, `${branch}:refs/heads/${branch}`],
          root,
          env,
        );
        if (!result.ok) throw new ApiError(409, "GIT_SYNC_FAILED", result.stderr || result.stdout || result.error || "push failed");
      });
      await this.git(root, ["remote", "set-url", "origin", row.clone_url]);
      await this.git(root, ["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
    }
    const now = Date.now();
    await this.store.transaction(async (sql) => {
      await sql`
        UPDATE git_repositories SET last_synced_at = ${now}, last_error = NULL
        WHERE project_id = ${projectId} AND workspace_id = ${this.store.workspaceId}
      `;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId,
        kind: operation === "push" ? "git.push.completed" : "git.repository.synced",
        subjectId: projectId,
        payload: { projectId, operation, branch, revision: await this.revision(root, "HEAD") },
        createdAt: now,
      });
    });
  }

  private async branch(actor: Actor, projectId: string, name: string, startPoint?: string): Promise<void> {
    const row = await this.requireReadyRow(projectId);
    const root = this.checkoutPath(projectId);
    const checked = await runProcess("git", ["check-ref-format", "--branch", name], root, minimalEnv(root));
    if (!checked.ok) throw new ApiError(400, "BAD_BRANCH", "branch name is invalid");
    const previous = await this.currentBranch(root);
    const args = ["-c", "core.hooksPath=/dev/null", "switch", "-c", name, ...(startPoint ? [validRef(startPoint)] : [])];
    await this.git(root, args);
    try {
      await this.withCredential(row, async (env) => {
        const pushed = await runProcess(
          "git",
          [...credentialGitOptions(row.clone_url), "push", row.clone_url, `${name}:refs/heads/${name}`],
          root,
          env,
        );
        if (!pushed.ok) throw new ApiError(409, "GIT_SYNC_FAILED", pushed.stderr || pushed.stdout || "could not push branch");
      });
    } catch (error) {
      if (previous) {
        await this.git(root, ["-c", "core.hooksPath=/dev/null", "switch", previous]);
        await this.git(root, ["branch", "-D", name]);
      }
      throw error;
    }
    await this.git(root, ["remote", "set-url", "origin", row.clone_url]);
    await this.git(root, ["update-ref", `refs/remotes/origin/${name}`, "HEAD"]);
    let channelName: string;
    try {
      channelName = await this.bindBranchChannel(row, name, actor);
    } catch (error) {
      await this.deleteRemoteBranch(row, root, name);
      if (previous) {
        await this.git(root, ["-c", "core.hooksPath=/dev/null", "switch", previous]);
        await this.git(root, ["branch", "-D", name]);
      }
      throw error;
    }
    const now = Date.now();
    await this.store.transaction(async (sql) => {
      await sql`UPDATE git_repositories SET last_synced_at = ${now}, last_error = NULL WHERE project_id = ${projectId}`;
      await this.events.append(sql, {
        workspaceId: this.store.workspaceId,
        actorId: actor.id,
        kind: "git.branch.created",
        subjectId: projectId,
        payload: { projectId, branch: name, startPoint: startPoint ?? null, channelName },
        createdAt: now,
      });
    });
  }

  private async bindBranchChannel(row: RepositoryRow, branch: string, actor: Actor): Promise<string> {
    const owner = actor.kind === "human" ? actor : await this.store.getActor(row.linked_by);
    if (!owner || owner.kind !== "human") throw new ApiError(409, "REPOSITORY_OWNER_MISSING", "repository owner is unavailable");
    const [bound] = await this.store.sql<{ name: string; archived_at: number | null }[]>`
      SELECT c.name, b.archived_at FROM git_branch_channels b
      JOIN channels c ON c.id = b.channel_id
      WHERE b.project_id = ${row.project_id} AND b.branch = ${branch}
    `;
    if (bound) {
      if (bound.archived_at) {
        await this.channels.setArchived(owner, bound.name, false);
        await this.store.sql`UPDATE git_branch_channels SET archived_at = NULL WHERE project_id = ${row.project_id} AND branch = ${branch}`;
      }
      return bound.name;
    }
    const channelName = branchChannelName(row.repository_name, row.project_id, branch);
    const [existing] = await this.store.sql<{ id: string; name: string; created_by: string | null }[]>`
      SELECT id, name, created_by FROM channels
      WHERE workspace_id = ${this.store.workspaceId} AND name = ${channelName}
    `;
    const channel = existing?.created_by === owner.id ? existing : await this.channels.create(owner, channelName);
    try {
      await this.store.sql`
        INSERT INTO git_branch_channels (project_id, branch, channel_id, created_at)
        VALUES (${row.project_id}, ${branch}, ${channel.id}, ${Date.now()})
      `;
    } catch (error) {
      if (!existing) await this.channels.setArchived(owner, channel.name, true);
      throw error;
    }
    return channel.name;
  }

  private async deleteRemoteBranch(row: RepositoryRow, root: string, branch: string): Promise<void> {
    await this.withCredential(row, async (env) => {
      const deleted = await runProcess(
        "git",
        [...credentialGitOptions(row.clone_url), "push", row.clone_url, `:refs/heads/${branch}`],
        root,
        env,
      );
      if (!deleted.ok) throw new ApiError(409, "GIT_SYNC_FAILED", deleted.stderr || deleted.stdout || "could not delete branch");
    });
    await runProcess("git", ["update-ref", "-d", `refs/remotes/origin/${branch}`], root, minimalEnv(root));
  }

  private async archiveBranchChannel(row: RepositoryRow, branch: string): Promise<void> {
    const [binding] = await this.store.sql<{ name: string }[]>`
      SELECT c.name FROM git_branch_channels b
      JOIN channels c ON c.id = b.channel_id
      WHERE b.project_id = ${row.project_id} AND b.branch = ${branch} AND b.archived_at IS NULL
    `;
    if (!binding) return;
    const owner = await this.store.getActor(row.linked_by);
    if (!owner || owner.kind !== "human") throw new ApiError(409, "REPOSITORY_OWNER_MISSING", "repository owner is unavailable");
    await this.channels.setArchived(owner, binding.name, true);
    await this.store.sql`
      UPDATE git_branch_channels SET archived_at = ${Date.now()}
      WHERE project_id = ${row.project_id} AND branch = ${branch}
    `;
  }

  private async workingTree(projectId: string, directory: string): Promise<GitTreeEntry[]> {
    const root = this.checkoutPath(projectId);
    const target = directory ? await resolveManagedPath(root, directory) : root;
    const entries = await fs.readdir(target, { withFileTypes: true });
    return Promise.all(
      entries
        .filter((entry) => !entry.isSymbolicLink() && entry.name !== ".git")
        .sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))
        .map(async (entry) => {
          const entryPath = directory ? `${directory}/${entry.name}` : entry.name;
          const stat = entry.isFile() ? await fs.stat(path.join(target, entry.name)) : null;
          return {
            path: entryPath,
            name: entry.name,
            kind: entry.isDirectory() ? "directory" as const : "file" as const,
            size: stat?.size ?? null,
            sha: "",
          };
        }),
    );
  }

  private async status(row: RepositoryRow): Promise<GitSyncStatus> {
    if (row.state !== "ready") return emptyStatus(row.last_error ?? "checkout is not ready");
    const root = this.checkoutPath(row.project_id);
    try {
      const branch = await this.currentBranch(root);
      const localHead = await this.revision(root, "HEAD");
      const remoteHead = branch ? await this.revision(root, `refs/remotes/origin/${branch}`, true) : null;
      const porcelain = (await this.git(root, ["status", "--porcelain"])).stdout;
      const lines = porcelain.split("\n").filter(Boolean);
      const hasUntrackedFiles = lines.some((line) => line.startsWith("??"));
      const hasUncommittedChanges = lines.some((line) => !line.startsWith("??"));
      let aheadCount = 0;
      let behindCount = 0;
      if (branch && remoteHead) {
        const counts = (await this.git(root, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${branch}`])).stdout.trim().split(/\s+/);
        aheadCount = Number(counts[0] ?? 0);
        behindCount = Number(counts[1] ?? 0);
      }
      const pushBlockReason = !branch
        ? "Detached HEAD"
        : behindCount > 0
          ? "Pull remote changes first"
          : aheadCount === 0
            ? "Nothing to push"
            : null;
      const pullBlockReason = !branch
        ? "Detached HEAD"
        : hasUncommittedChanges || hasUntrackedFiles
          ? "Commit or discard local changes first"
          : aheadCount > 0
            ? "Push or reconcile local commits first"
            : behindCount === 0
              ? "Already up to date"
              : null;
      return {
        branch,
        localHead,
        remoteHead,
        aheadCount,
        behindCount,
        hasUncommittedChanges,
        hasUntrackedFiles,
        canPush: pushBlockReason === null,
        pushBlockReason,
        canPull: pullBlockReason === null,
        pullBlockReason,
      };
    } catch (error) {
      return emptyStatus(error instanceof Error ? error.message : String(error));
    }
  }

  private async toRepository(row: RepositoryRow): Promise<GitRepository> {
    return {
      projectId: row.project_id,
      workspaceId: row.workspace_id,
      connectionId: row.connection_id,
      provider: row.provider,
      providerRepositoryId: row.provider_repository_id,
      owner: row.owner_name,
      name: row.repository_name,
      fullName: row.full_name,
      description: row.description,
      private: row.private,
      defaultBranch: row.default_branch,
      htmlUrl: row.html_url,
      state: row.state,
      lastSyncedAt: row.last_synced_at,
      lastError: row.last_error,
      linkedBy: row.linked_by,
      linkedAt: row.linked_at,
      sync: row.state === "ready" ? await this.status(row) : null,
    };
  }

  private async record(
    actorId: string,
    kind: import("@workspace/shared").ThreadEventKind,
    projectId: string,
    payload: import("@workspace/shared").JsonObject,
  ): Promise<void> {
    await this.events.append(this.store.sql, {
      workspaceId: this.store.workspaceId,
      actorId,
      kind,
      subjectId: projectId,
      payload,
    });
  }

  private async setState(projectId: string, state: RepositoryRow["state"], error: string | null): Promise<void> {
    await this.store.sql`
      UPDATE git_repositories
      SET state = ${state}, last_error = ${error}, last_synced_at = ${state === "ready" ? Date.now() : null}
      WHERE project_id = ${projectId} AND workspace_id = ${this.store.workspaceId}
    `;
  }

  private async findRow(projectId: string): Promise<RepositoryRow | null> {
    const [row] = await this.store.sql<RepositoryRow[]>`
      SELECT * FROM git_repositories
      WHERE project_id = ${projectId} AND workspace_id = ${this.store.workspaceId} AND unlinked_at IS NULL
    `;
    return row ?? null;
  }

  private async requireRow(projectId: string): Promise<RepositoryRow> {
    const row = await this.findRow(projectId);
    if (!row) throw new ApiError(404, "NOT_FOUND", "no such linked repository");
    return row;
  }

  private async requireReadyRow(projectId: string): Promise<RepositoryRow> {
    const row = await this.requireRow(projectId);
    if (row.state !== "ready") throw new ApiError(409, "CHECKOUT_UNAVAILABLE", row.last_error ?? "repository checkout is not ready");
    return row;
  }

  private async requireOwned(actor: Actor, projectId: string): Promise<RepositoryRow> {
    this.assertHuman(actor);
    const row = await this.requireRow(projectId);
    if (row.linked_by !== actor.id) throw new ApiError(403, "OWNER_ONLY", "only the repository owner can change its Git state");
    return row;
  }

  private assertHuman(actor: Actor): void {
    if (actor.kind !== "human") throw new ApiError(403, "HUMAN_ONLY", "only humans can manage linked repositories");
  }

  private async availableProjectName(name: string, owner: string): Promise<string> {
    const used = new Set((await this.projects.list()).map((project) => project.name.toLowerCase()));
    if (!used.has(name.toLowerCase())) return name;
    const ownerName = `${owner}.${name}`.slice(0, 80);
    if (!used.has(ownerName.toLowerCase())) return ownerName;
    return `${ownerName.slice(0, 71)}-${createHash("sha256").update(`${owner}/${name}`).digest("hex").slice(0, 8)}`;
  }

  private checkoutPath(projectId: string): string {
    return path.join(this.root, createHash("sha256").update(projectId).digest("hex"));
  }

  private async withCredential<T>(row: RepositoryRow, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const token = await this.github.tokenForConnection(row.connection_id);
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "convyio-git-"));
    const askpass = path.join(temporary, "askpass.sh");
    await fs.writeFile(path.join(temporary, "token"), token, { mode: 0o600 });
    await fs.writeFile(
      askpass,
      "#!/bin/sh\ncase \"$1\" in *Username*) printf '%s\\n' x-access-token ;; *Password*) cat \"$(dirname \"$0\")/token\" ;; esac\n",
      { mode: 0o700 },
    );
    try {
      return await action({
        ...minimalEnv(temporary),
        GIT_ASKPASS: askpass,
        GIT_TERMINAL_PROMPT: "0",
      });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  private async git(cwd: string, args: string[]): Promise<ProcessResult> {
    const result = await runProcess("git", args, cwd, minimalEnv(cwd));
    if (!result.ok) throw new ApiError(409, "GIT_COMMAND_FAILED", result.stderr || result.stdout || result.error || "git command failed");
    return result;
  }

  private async currentBranch(root: string): Promise<string | null> {
    const result = await runProcess("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], root, minimalEnv(root));
    return result.ok ? result.stdout.trim() || null : null;
  }

  private async revision(root: string, ref: string, optional = false): Promise<string | null> {
    const result = await runProcess("git", ["rev-parse", "--verify", ref], root, minimalEnv(root));
    if (!result.ok) {
      if (optional) return null;
      throw new ApiError(409, "GIT_COMMAND_FAILED", result.stderr || result.error || `no revision ${ref}`);
    }
    return result.stdout.trim();
  }

  private safeSearchPath(root: string, relative: string): Promise<string> {
    return resolveManagedPath(root, relative);
  }

  private async locked<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(projectId, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(projectId) === current) this.locks.delete(projectId);
    }
  }
}

function runProcess(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env, timeout: PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_MAX_BYTES, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout,
          stderr,
          error: error ? (("killed" in error && error.killed) ? `command timed out after ${PROCESS_TIMEOUT_MS}ms` : error.message) : undefined,
        });
      },
    );
  });
}

function branchChannelName(repository: string, projectId: string, branch: string): string {
  const readable = `${repository}-${branch}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "branch";
  const suffix = createHash("sha256").update(`${projectId}:${branch}`).digest("hex").slice(0, 6);
  return `${readable.slice(0, 25).replace(/-+$/g, "")}-${suffix}`;
}

function credentialGitOptions(remoteUrl: string): string[] {
  return [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "credential.helper=",
    "-c", "http.sslVerify=true",
    "-c", `url.${remoteUrl}.insteadOf=${remoteUrl}`,
  ];
}

function minimalEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function actorEnv(home: string, actor: Actor): NodeJS.ProcessEnv {
  const email = `${actor.id.replace(/[^A-Za-z0-9._-]/g, "-")}@actors.convyio.local`;
  return {
    ...minimalEnv(home),
    GIT_AUTHOR_NAME: actor.displayName,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: actor.displayName,
    GIT_COMMITTER_EMAIL: email,
  };
}

function emptyStatus(reason: string): GitSyncStatus {
  return {
    branch: null,
    localHead: null,
    remoteHead: null,
    aheadCount: 0,
    behindCount: 0,
    hasUncommittedChanges: false,
    hasUntrackedFiles: false,
    canPush: false,
    pushBlockReason: reason,
    canPull: false,
    pullBlockReason: reason,
  };
}

function validRef(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) || value.includes("..") || value.includes("@{") || value.endsWith("/")) {
    throw new ApiError(400, "BAD_REF", "Git ref is invalid");
  }
  return value;
}

function validGitPath(value: string): string {
  const normalized = path.posix.normalize(value);
  if (!value || value.startsWith("/") || value.includes("\0") || normalized === ".." || normalized.startsWith("../")) {
    throw new ApiError(400, "BAD_PATH", "path must stay inside the repository");
  }
  return normalized;
}

function encodeRepo(fullName: string): string {
  return fullName.split("/").map(encodeURIComponent).join("/");
}

function clip(value: string): string {
  return value.length <= OUTPUT_CLIP ? value : `${value.slice(0, OUTPUT_CLIP)}\n…[${value.length - OUTPUT_CLIP} more characters truncated]`;
}

function toPullRequest(pull: GitHubPullResponse): GitPullRequest {
  return {
    id: String(pull.id),
    number: pull.number,
    title: pull.title,
    state: pull.state,
    draft: pull.draft,
    author: pull.user.login,
    head: pull.head.ref,
    base: pull.base.ref,
    updatedAt: Date.parse(pull.updated_at),
    htmlUrl: pull.html_url,
  };
}

function toIssue(issue: GitHubIssueResponse): GitIssue {
  return {
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user.login,
    updatedAt: Date.parse(issue.updated_at),
    htmlUrl: issue.html_url,
    labels: issue.labels.map((label) => typeof label === "string" ? label : label.name),
  };
}
