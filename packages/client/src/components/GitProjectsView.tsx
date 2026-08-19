import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  Actor,
  GitAccount,
  GitBranch,
  GitCheck,
  GitCommit,
  GitIssue,
  GitPullFile,
  GitPullRequest,
  GitRemoteRepository,
  GitRepository,
  GitTreeEntry,
  ProjectAssignment,
} from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { relativeTime } from "../lib/format";
import { renderMessageContent } from "../lib/markdown";

type ProjectSection = "overview" | "repositories" | "pulls" | "issues";
type RepositoryTab = "readme" | "files" | "commits" | "pulls" | "issues";
type GitSource = "remote" | "local";
type ApiFetch = ReturnType<typeof useWorkspace>["apiFetch"];

interface AggregatePull extends GitPullRequest {
  projectId: string;
  repository: string;
}

interface AggregateIssue extends GitIssue {
  projectId: string;
  repository: string;
}

export function GitProjectsView({ onOpenChannel }: { onOpenChannel?: (channel: string) => void }) {
  const { apiFetch, fetchActors, notify } = useWorkspace();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [account, setAccount] = useState<GitAccount | null>(null);
  const [repositories, setRepositories] = useState<GitRepository[]>([]);
  const [remoteRepositories, setRemoteRepositories] = useState<GitRemoteRepository[]>([]);
  const [section, setSection] = useState<ProjectSection>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const accountRequest = apiFetch("/api/git/account");
    const repositoriesRequest = apiFetch("/api/git/repositories");
    if (!accountRequest || !repositoriesRequest) return;
    try {
      const [accountResponse, repositoriesResponse] = await Promise.all([accountRequest, repositoriesRequest]);
      if (!accountResponse.ok) throw new Error(await responseError(accountResponse));
      if (!repositoriesResponse.ok) throw new Error(await responseError(repositoriesResponse));
      const accountBody = (await accountResponse.json()) as { available: boolean; account: GitAccount | null };
      const repositoriesBody = (await repositoriesResponse.json()) as { repositories: GitRepository[] };
      setAvailable(accountBody.available);
      setAccount(accountBody.account);
      setRepositories(repositoriesBody.repositories);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("git");
    if (result !== "connected" && result !== "error") return;
    params.delete("git");
    window.history.replaceState({}, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
    notify(result === "connected" ? "GitHub connected" : "GitHub connection was not completed");
  }, [notify]);

  const loadRemoteRepositories = useCallback(async () => {
    const request = apiFetch("/api/git/available-repositories");
    if (!request) {
      setError("GitHub session is unavailable");
      return;
    }
    setLoadingRemote(true);
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      setRemoteRepositories(((await response.json()) as { repositories: GitRemoteRepository[] }).repositories);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingRemote(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    if (!account || section !== "repositories" || remoteRepositories.length > 0) return;
    void loadRemoteRepositories();
  }, [account, section, remoteRepositories.length, loadRemoteRepositories]);

  const connect = async () => {
    const request = apiFetch("/api/git/github/authorize", { method: "POST" });
    if (!request) return;
    setBusy("connect");
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      window.location.assign(((await response.json()) as { url: string }).url);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : String(connectError));
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect this GitHub App installation? Linked repositories stay in the workspace but cannot sync until you reconnect.")) return;
    const request = apiFetch("/api/git/account", { method: "DELETE" });
    if (!request) return;
    setBusy("disconnect");
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      setAccount(null);
      setRemoteRepositories([]);
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : String(disconnectError));
    } finally {
      setBusy(null);
    }
  };

  const link = async (remote: GitRemoteRepository) => {
    const request = apiFetch("/api/git/repositories", {
      method: "POST",
      body: JSON.stringify({ fullName: remote.fullName }),
    });
    if (!request) return;
    setBusy(remote.providerId);
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      const linked = ((await response.json()) as { repository: GitRepository }).repository;
      await load();
      setSelectedId(linked.projectId);
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : String(linkError));
    } finally {
      setBusy(null);
    }
  };

  const selected = repositories.find((repository) => repository.projectId === selectedId) ?? null;
  if (loading) return <CenteredStatus>Loading projects…</CenteredStatus>;

  if (selected) {
    return (
      <RepositoryWorkspace
        repository={selected}
        apiFetch={apiFetch}
        fetchActors={fetchActors}
        onOpenChannel={onOpenChannel}
        onBack={() => setSelectedId(null)}
        onRemoved={async () => { setSelectedId(null); await load(); }}
        error={error}
        onRepositoryUpdated={load}
        onError={setError}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-divider px-6 pt-5">
        <div className="mx-auto flex max-w-6xl items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold text-body">Projects</h1>
            <p className="mt-1 text-sm text-muted">Code, changes, reviews, and agent work in one place.</p>
          </div>
          <AccountControl
            available={available === true}
            account={account}
            busy={busy}
            onConnect={connect}
            onDisconnect={disconnect}
          />
        </div>
        <nav role="tablist" className="mx-auto mt-5 flex max-w-6xl gap-5" aria-label="Project sections">
          {(["overview", "repositories", "pulls", "issues"] as ProjectSection[]).map((target) => (
            <button
              role="tab"
              aria-selected={section === target}
              key={target}
              onClick={() => setSection(target)}
              className={`cursor-pointer border-b-2 px-0.5 pb-3 text-sm font-medium capitalize ${
                section === target ? "border-accent text-body" : "border-transparent text-muted hover:text-body"
              }`}
            >
              {target === "pulls" ? "Pull requests" : target}
            </button>
          ))}
        </nav>
      </div>

      <main className="mx-auto max-w-6xl p-6">
        {available === false ? (
          <EmptyState
            title="GitHub App integration is not configured"
            body="The server needs a GitHub App id, slug, client credentials and private key before repositories can connect."
          />
        ) : !account ? (
          <EmptyState
            title="Bring your repositories into the workspace"
            body="Install the GitHub App on selected repositories to browse code, assign agents, sync branches, and review pull requests."
          />
        ) : section === "overview" ? (
          <Overview repositories={repositories} onOpen={setSelectedId} />
        ) : section === "repositories" ? (
          <RepositoryIndex
            linked={repositories}
            remote={remoteRepositories}
            account={account}
            loadingRemote={loadingRemote}
            busy={busy}
            onOpen={setSelectedId}
            onLink={link}
            onRefresh={() => void loadRemoteRepositories()}
          />
        ) : section === "pulls" ? (
          <AggregatePulls repositories={repositories} apiFetch={apiFetch} onOpen={setSelectedId} />
        ) : (
          <AggregateIssues repositories={repositories} apiFetch={apiFetch} onOpen={setSelectedId} />
        )}
        {error && <p role="alert" className="mt-5 text-sm text-dead">{error}</p>}
      </main>
    </div>
  );
}

function AccountControl({
  available,
  account,
  busy,
  onConnect,
  onDisconnect,
}: {
  available: boolean;
  account: GitAccount | null;
  busy: string | null;
  onConnect: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  if (!available) return null;
  if (!account) return <PrimaryButton onClick={() => void onConnect()} disabled={busy === "connect"}>Install GitHub App</PrimaryButton>;
  return (
    <div className="flex items-center gap-2">
      {account.avatarUrl && <img src={account.avatarUrl} alt="" className="h-7 w-7 rounded-md" />}
      <div className="text-right">
        <p className="text-sm font-medium text-body">{account.login}</p>
        <button onClick={() => void onDisconnect()} disabled={busy === "disconnect"} className="cursor-pointer text-xs text-muted hover:text-body">
          Disconnect
        </button>
      </div>
    </div>
  );
}

function Overview({ repositories, onOpen }: { repositories: GitRepository[]; onOpen: (id: string) => void }) {
  const ready = repositories.filter((repository) => repository.state === "ready").length;
  const dirty = repositories.filter((repository) => repository.sync?.hasUncommittedChanges || repository.sync?.hasUntrackedFiles).length;
  const ahead = repositories.reduce((count, repository) => count + (repository.sync?.aheadCount ?? 0), 0);
  return (
    <div className="space-y-8">
      <section className="grid grid-cols-1 border-y border-divider sm:grid-cols-3 sm:divide-x sm:divide-divider">
        <Metric label="Repositories" value={repositories.length} />
        <Metric label="Ready checkouts" value={ready} />
        <Metric label="Commits to push" value={ahead} hint={dirty ? `${dirty} with local changes` : "Working trees clean"} />
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold text-body">Recent repositories</h2>
        {repositories.length === 0 ? (
          <EmptyState title="No repositories yet" body="Open Repositories to choose one from your connected account." />
        ) : (
          <RepositoryRows repositories={repositories.slice(0, 8)} onOpen={onOpen} />
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="px-5 py-4 first:pl-0 last:pr-0">
      <p className="text-[10px] font-bold tracking-wider text-muted uppercase">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-body">{value}</p>
      {hint && <p className="mt-1 text-xs text-faint">{hint}</p>}
    </div>
  );
}

function RepositoryIndex({
  linked,
  remote,
  account,
  loadingRemote,
  busy,
  onOpen,
  onLink,
  onRefresh,
}: {
  linked: GitRepository[];
  remote: GitRemoteRepository[];
  account: GitAccount;
  loadingRemote: boolean;
  busy: string | null;
  onOpen: (id: string) => void;
  onLink: (repository: GitRemoteRepository) => Promise<void>;
  onRefresh: () => void;
}) {
  const [search, setSearch] = useState("");
  const linkedIds = new Set(linked.map((repository) => repository.providerRepositoryId));
  const filtered = remote.filter((repository) => repository.fullName.toLowerCase().includes(search.toLowerCase()));
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold text-body">Workspace repositories</h2>
        {linked.length ? <RepositoryRows repositories={linked} onOpen={onOpen} /> : <p className="text-sm text-muted">Nothing linked yet.</p>}
      </section>
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-body">Add from {account.login}</h2>
            <p className="mt-1 text-sm text-muted">Private repositories are visible only through the workspace server.</p>
          </div>
          <button onClick={onRefresh} className="cursor-pointer text-sm font-medium text-muted hover:text-body">Refresh</button>
        </div>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search repositories"
          aria-label="Search repositories"
          className="mb-3 w-full rounded-md border border-divider bg-input px-3 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
        />
        {loadingRemote ? (
          <p className="py-5 text-sm text-muted">Loading GitHub repositories…</p>
        ) : (
          <div className="divide-y divide-divider border-y border-divider">
            {filtered.map((repository) => {
              const isLinked = linkedIds.has(repository.providerId);
              return (
                <div key={repository.providerId} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-body">{repository.fullName}</p>
                    <p className="mt-0.5 truncate text-xs text-muted">{repository.description || (repository.private ? "Private repository" : "Public repository")}</p>
                  </div>
                  <button
                    disabled={isLinked || busy === repository.providerId}
                    onClick={() => void onLink(repository)}
                    className="shrink-0 cursor-pointer rounded-md bg-subtle px-2.5 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover disabled:cursor-default disabled:opacity-50"
                  >
                    {isLinked ? "Added" : busy === repository.providerId ? "Cloning…" : "Add"}
                  </button>
                </div>
              );
            })}
            {!filtered.length && <p className="py-5 text-sm text-muted">No repositories found.</p>}
          </div>
        )}
      </section>
    </div>
  );
}

function RepositoryRows({ repositories, onOpen }: { repositories: GitRepository[]; onOpen: (id: string) => void }) {
  return (
    <div className="divide-y divide-divider border-y border-divider">
      {repositories.map((repository) => (
        <button
          key={repository.projectId}
          onClick={() => onOpen(repository.projectId)}
          className="flex w-full cursor-pointer items-center justify-between gap-4 py-3 text-left hover:bg-subtle"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-body">{repository.fullName}</p>
            <p className="mt-0.5 truncate text-xs text-muted">{repository.description || "No description"}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs font-medium text-muted">{repository.sync?.branch ?? repository.state}</p>
            <p className="mt-0.5 text-[10px] text-faint">{syncLabel(repository)}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

function AggregatePulls({ repositories, apiFetch, onOpen }: { repositories: GitRepository[]; apiFetch: ApiFetch; onOpen: (id: string) => void }) {
  const [pulls, setPulls] = useState<AggregatePull[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(repositories.map(async (repository) => {
      const response = await apiFetch(`/api/git/repositories/${repository.projectId}/pulls?state=open`);
      if (!response) throw new Error("Git session is unavailable");
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as { pulls: GitPullRequest[] };
      return body.pulls.map((pull) => ({ ...pull, projectId: repository.projectId, repository: repository.fullName }));
    })).then((groups) => {
      if (!cancelled) setPulls(groups.flat().sort((left, right) => right.updatedAt - left.updatedAt));
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [repositories, apiFetch]);
  if (loading) return <CenteredStatus>Loading pull requests…</CenteredStatus>;
  if (error) return <p role="alert" className="text-sm text-dead">{error}</p>;
  return pulls.length ? <PullRows pulls={pulls} onOpen={onOpen} /> : <EmptyState title="No open pull requests" body="Branches and review requests will appear here across every linked repository." />;
}

function AggregateIssues({ repositories, apiFetch, onOpen }: { repositories: GitRepository[]; apiFetch: ApiFetch; onOpen: (id: string) => void }) {
  const [issues, setIssues] = useState<AggregateIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all(repositories.map(async (repository) => {
      const response = await apiFetch(`/api/git/repositories/${repository.projectId}/issues?state=open`);
      if (!response) throw new Error("Git session is unavailable");
      if (!response.ok) throw new Error(await responseError(response));
      const body = (await response.json()) as { issues: GitIssue[] };
      return body.issues.map((issue) => ({ ...issue, projectId: repository.projectId, repository: repository.fullName }));
    })).then((groups) => {
      if (!cancelled) setIssues(groups.flat().sort((left, right) => right.updatedAt - left.updatedAt));
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [repositories, apiFetch]);
  if (loading) return <CenteredStatus>Loading issues…</CenteredStatus>;
  if (error) return <p role="alert" className="text-sm text-dead">{error}</p>;
  return issues.length ? <IssueRows issues={issues} onOpen={onOpen} /> : <EmptyState title="No open issues" body="Repository issues will appear here with the code and work they belong to." />;
}

function RepositoryWorkspace({
  repository,
  apiFetch,
  fetchActors,
  onOpenChannel,
  onBack,
  onRemoved,
  error,
  onRepositoryUpdated,
  onError,
}: {
  repository: GitRepository;
  apiFetch: ApiFetch;
  fetchActors: () => Promise<Actor[]>;
  onOpenChannel?: (channel: string) => void;
  onBack: () => void;
  onRemoved: () => Promise<void>;
  error: string | null;
  onRepositoryUpdated: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  const [tab, setTab] = useState<RepositoryTab>("readme");
  const [source, setSource] = useState<GitSource>("remote");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [branch, setBranch] = useState(repository.sync?.branch ?? repository.defaultBranch);
  const [busy, setBusy] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [agents, setAgents] = useState<Actor[]>([]);
  const [assignments, setAssignments] = useState<ProjectAssignment[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");

  const loadAgentAccess = useCallback(async () => {
    const [actors, response] = await Promise.all([
      fetchActors(),
      apiFetch(`/api/projects/${repository.projectId}`),
    ]);
    const availableAgents = actors.filter((actor) => actor.kind === "agent");
    setAgents(availableAgents);
    if (response?.ok) {
      const current = ((await response.json()) as { assignments: ProjectAssignment[] }).assignments;
      setAssignments(current);
      setSelectedAgentId((selected) => selected && !current.some((item) => item.agentId === selected)
        ? selected
        : availableAgents.find((actor) => !current.some((item) => item.agentId === actor.id))?.id ?? "");
    }
  }, [apiFetch, fetchActors, repository.projectId]);

  const reloadBranches = useCallback(async () => {
    const response = await apiFetch(`/api/git/repositories/${repository.projectId}/branches`);
    if (!response?.ok) return;
    setBranches(((await response.json()) as { branches: GitBranch[] }).branches);
  }, [repository.projectId, apiFetch]);

  useEffect(() => void reloadBranches(), [reloadBranches]);
  useEffect(() => void loadAgentAccess(), [loadAgentAccess]);
  useEffect(() => {
    setBranch(repository.sync?.branch ?? repository.defaultBranch);
  }, [repository.projectId, repository.defaultBranch, repository.sync?.branch]);

  const mutate = async (label: string, path: string, body?: unknown) => {
    const request = apiFetch(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!request) return false;
    setBusy(label);
    onError(null);
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      await onRepositoryUpdated();
      await reloadBranches();
      return true;
    } catch (mutationError) {
      onError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const updateAgentAccess = async (agentId: string, revoke = false) => {
    const request = apiFetch(
      `/api/projects/${repository.projectId}/assignments${revoke ? `/${encodeURIComponent(agentId)}` : ""}`,
      revoke
        ? { method: "DELETE" }
        : { method: "POST", body: JSON.stringify({ agentId }) },
    );
    if (!request) return;
    setBusy(`agent-${agentId}`);
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      await loadAgentAccess();
    } catch (accessError) {
      onError(accessError instanceof Error ? accessError.message : String(accessError));
    } finally {
      setBusy(null);
    }
  };

  const createBranch = async () => {
    if (!newBranch.trim()) return;
    if (await mutate("branch", `/api/git/repositories/${repository.projectId}/branches`, { name: newBranch.trim(), startPoint: branch })) {
      setBranch(newBranch.trim());
      setNewBranch("");
    }
  };

  const deleteBranch = async () => {
    if (branch === repository.defaultBranch || !window.confirm(`Delete ${branch}? This removes the remote branch.`)) return;
    const request = apiFetch(`/api/git/repositories/${repository.projectId}/branches/${encodeURIComponent(branch)}`, { method: "DELETE" });
    if (!request) return;
    setBusy("delete-branch");
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      setBranch(repository.defaultBranch);
      await onRepositoryUpdated();
      await reloadBranches();
    } catch (deleteError) {
      onError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setBusy(null);
    }
  };

  const removeRepository = async () => {
    if (!window.confirm(`Remove ${repository.fullName} from this workspace? The managed checkout and agent assignments will be removed.`)) return;
    const request = apiFetch(`/api/git/repositories/${repository.projectId}`, { method: "DELETE" });
    if (!request) return;
    setBusy("remove");
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      await onRemoved();
    } catch (removeError) {
      onError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setBusy(null);
    }
  };

  const branchChannel = branches.find((item) => item.name === branch)?.channelName ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="border-b border-divider px-6 py-4">
        <div className="mx-auto max-w-6xl">
          <button onClick={onBack} className="mb-3 cursor-pointer text-xs font-medium text-muted hover:text-body">Projects / Repositories</button>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-body">{repository.fullName}</h1>
                {repository.private && <span className="rounded-md bg-subtle px-1.5 py-0.5 text-[10px] font-medium text-muted">Private</span>}
              </div>
              <p className="mt-1 text-sm text-muted">{repository.description || "No description"}</p>
            </div>
            <div className="flex items-center gap-3">
              <a href={repository.htmlUrl} target="_blank" rel="noreferrer" className="text-sm font-medium text-muted hover:text-body">Open on GitHub</a>
              <button disabled={busy !== null} onClick={() => void removeRepository()} className="cursor-pointer text-xs font-medium text-dead disabled:opacity-50">Remove</button>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <select
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              aria-label="Branch"
              className="rounded-md border border-divider bg-input px-2.5 py-1.5 text-xs text-body outline-none focus:ring-2 focus:ring-accent"
            >
              {branches.map((item) => <option key={item.name} value={item.name}>{item.name}{item.isDefault ? " (default)" : ""}{item.channelName ? ` · #${item.channelName}` : ""}</option>)}
            </select>
            <div className="flex rounded-md bg-subtle p-0.5" aria-label="Repository source">
              {(["remote", "local"] as GitSource[]).map((target) => (
                <button
                  key={target}
                  onClick={() => setSource(target)}
                  className={`cursor-pointer rounded-md px-2 py-1 text-xs capitalize ${source === target ? "bg-popup text-body" : "text-muted"}`}
                >
                  {target}
                </button>
              ))}
            </div>
            <SyncButton label="Fetch" busy={busy} onClick={() => mutate("fetch", `/api/git/repositories/${repository.projectId}/sync`, { operation: "fetch" })} />
            <SyncButton label="Pull" busy={busy} disabled={!repository.sync?.canPull} title={repository.sync?.pullBlockReason ?? undefined} onClick={() => mutate("pull", `/api/git/repositories/${repository.projectId}/sync`, { operation: "pull" })} />
            <SyncButton label="Push" busy={busy} disabled={!repository.sync?.canPush} title={repository.sync?.pushBlockReason ?? undefined} onClick={() => mutate("push", `/api/git/repositories/${repository.projectId}/sync`, { operation: "push" })} />
            <span aria-live="polite" className="text-xs text-muted">{syncLabel(repository)}</span>
            {branchChannel && onOpenChannel && (
              <button onClick={() => onOpenChannel(branchChannel)} className="cursor-pointer text-xs font-medium text-accent hover:underline">#{branchChannel}</button>
            )}
          </div>
          <div className="mt-2 flex max-w-sm gap-2">
            <input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder="New branch" aria-label="New branch" className="min-w-0 flex-1 rounded-md border border-divider bg-input px-2.5 py-1.5 text-xs text-body outline-none focus:ring-2 focus:ring-accent" />
            <button disabled={!newBranch.trim() || busy !== null} onClick={() => void createBranch()} className="cursor-pointer rounded-md bg-subtle px-2.5 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover disabled:opacity-50">Create</button>
            {branch !== repository.defaultBranch && (
              <button disabled={busy !== null} onClick={() => void deleteBranch()} className="cursor-pointer px-1 text-xs font-medium text-dead disabled:opacity-50">Delete branch</button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-divider pt-3">
            <span className="text-[10px] font-bold tracking-wider text-muted uppercase">Agent access</span>
            {assignments.map((assignment) => (
              <span key={assignment.agentId} className="flex items-center gap-1 rounded-md bg-subtle px-2 py-1 text-xs text-body">
                {assignment.agentName ?? assignment.agentId}
                <button aria-label={`Remove ${assignment.agentName ?? assignment.agentId}`} disabled={busy !== null} onClick={() => void updateAgentAccess(assignment.agentId, true)} className="cursor-pointer text-muted hover:text-body">×</button>
              </span>
            ))}
            {agents.some((agent) => !assignments.some((assignment) => assignment.agentId === agent.id)) && (
              <>
                <select value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)} aria-label="Agent to assign" className="rounded-md border border-divider bg-input px-2 py-1 text-xs text-body">
                  {agents.filter((agent) => !assignments.some((assignment) => assignment.agentId === agent.id)).map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
                </select>
                <button disabled={!selectedAgentId || busy !== null} onClick={() => void updateAgentAccess(selectedAgentId)} className="cursor-pointer rounded-md bg-subtle px-2 py-1 text-xs font-semibold text-body hover:bg-subtle-hover disabled:opacity-50">Assign</button>
              </>
            )}
            {!agents.length && <span className="text-xs text-faint">Add an agent to the workspace first.</span>}
          </div>
          <nav role="tablist" className="mt-5 flex gap-5" aria-label="Repository sections">
            {(["readme", "files", "commits", "pulls", "issues"] as RepositoryTab[]).map((target) => (
              <button role="tab" aria-selected={tab === target} key={target} onClick={() => setTab(target)} className={`cursor-pointer border-b-2 pb-2 text-sm font-medium capitalize ${tab === target ? "border-accent text-body" : "border-transparent text-muted hover:text-body"}`}>
                {target === "pulls" ? "Pull requests" : target.toUpperCase() === "README" ? "README" : target}
              </button>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-6">
        {repository.state === "error" ? (
          <EmptyState
            title="Checkout failed"
            body={repository.lastError ?? "The repository could not be cloned."}
            action={<PrimaryButton onClick={() => void mutate("retry", `/api/git/repositories/${repository.projectId}/retry`)}>Retry clone</PrimaryButton>}
          />
        ) : repository.state !== "ready" ? (
          <CenteredStatus>Cloning repository…</CenteredStatus>
        ) : (
          <RepositoryPanel
            tab={tab}
            repository={repository}
            branch={branch}
            branches={branches}
            source={source}
            apiFetch={apiFetch}
            onChanged={onRepositoryUpdated}
            onError={onError}
          />
        )}
        {error && <p role="alert" className="mt-5 text-sm text-dead">{error}</p>}
      </main>
    </div>
  );
}

function RepositoryPanel({
  tab,
  repository,
  branch,
  branches,
  source,
  apiFetch,
  onChanged,
  onError,
}: {
  tab: RepositoryTab;
  repository: GitRepository;
  branch: string;
  branches: GitBranch[];
  source: GitSource;
  apiFetch: ApiFetch;
  onChanged: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  if (tab === "commits") return <CommitPanel repository={repository} branch={branch} apiFetch={apiFetch} onError={onError} />;
  if (tab === "pulls") return <PullPanel repository={repository} branches={branches} apiFetch={apiFetch} onChanged={onChanged} onError={onError} />;
  if (tab === "issues") return <IssuePanel repository={repository} apiFetch={apiFetch} onError={onError} />;
  return <FilesPanel repository={repository} branch={branch} source={source} readmeOnly={tab === "readme"} apiFetch={apiFetch} onError={onError} />;
}

function FilesPanel({ repository, branch, source, readmeOnly, apiFetch, onError }: { repository: GitRepository; branch: string; source: GitSource; readmeOnly: boolean; apiFetch: ApiFetch; onError: (error: string | null) => void }) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<GitTreeEntry[]>([]);
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadTree = useCallback(async (target = directory) => {
    setLoading(true);
    setFile(null);
    onError(null);
    const query = new URLSearchParams({ ref: branch, source });
    if (target) query.set("path", target);
    try {
      const response = await apiFetch(`/api/git/repositories/${repository.projectId}/tree?${query}`);
      if (!response) throw new Error("Git session is unavailable");
      if (!response.ok) throw new Error(await responseError(response));
      setEntries(((await response.json()) as { entries: GitTreeEntry[] }).entries);
    } catch (loadError) {
      setEntries([]);
      onError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [repository.projectId, branch, source, directory, apiFetch, onError]);

  useEffect(() => {
    setDirectory("");
    void loadTree("");
  }, [repository.projectId, branch, source]);

  useEffect(() => {
    if (!readmeOnly || loading) return;
    const readme = entries.find((entry) => entry.kind === "file" && /^readme(?:\.|$)/i.test(entry.name));
    if (readme) void openFile(readme.path);
  }, [readmeOnly, entries, loading]);

  const openDirectory = (path: string) => {
    setDirectory(path);
    void loadTree(path);
  };

  const openFile = async (filePath: string) => {
    const query = new URLSearchParams({ ref: branch, source, path: filePath });
    try {
      const response = await apiFetch(`/api/git/repositories/${repository.projectId}/file?${query}`);
      if (!response) throw new Error("Git session is unavailable");
      if (!response.ok) throw new Error(await responseError(response));
      setFile({ path: filePath, content: ((await response.json()) as { content: string }).content });
    } catch (loadError) {
      onError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  };

  if (loading) return <CenteredStatus>Loading files…</CenteredStatus>;
  if (readmeOnly) {
    if (!file) return <EmptyState title="No README" body="This branch does not have a README at its root." />;
    return <article className="max-w-4xl text-sm leading-6 text-body">{renderMessageContent(file.content, null)}</article>;
  }
  if (file) {
    return (
      <div>
        <button onClick={() => setFile(null)} className="mb-3 cursor-pointer text-xs font-medium text-muted hover:text-body">{directory || "root"} / {file.path.split("/").at(-1)}</button>
        <pre className="overflow-x-auto rounded-lg bg-subtle p-4 font-mono text-xs leading-5 text-body"><code>{file.content}</code></pre>
      </div>
    );
  }
  const crumbs = directory.split("/").filter(Boolean);
  return (
    <div>
      <div className="mb-3 flex items-center gap-1 text-xs text-muted">
        <button onClick={() => openDirectory("")} className="cursor-pointer hover:text-body">root</button>
        {crumbs.map((crumb, index) => {
          const crumbPath = crumbs.slice(0, index + 1).join("/");
          return <span key={crumbPath}> / <button onClick={() => openDirectory(crumbPath)} className="cursor-pointer hover:text-body">{crumb}</button></span>;
        })}
      </div>
      <div className="divide-y divide-divider border-y border-divider">
        {entries.map((entry) => (
          <button key={entry.path} onClick={() => entry.kind === "directory" ? openDirectory(entry.path) : void openFile(entry.path)} className="flex w-full cursor-pointer items-center justify-between py-2.5 text-left hover:bg-subtle">
            <span className="font-mono text-xs text-body">{entry.kind === "directory" ? `${entry.name}/` : entry.name}</span>
            <span className="text-[10px] text-faint">{entry.size === null ? entry.kind : formatBytes(entry.size)}</span>
          </button>
        ))}
        {!entries.length && <p className="py-5 text-sm text-muted">Empty directory.</p>}
      </div>
    </div>
  );
}

function CommitPanel({ repository, branch, apiFetch, onError }: { repository: GitRepository; branch: string; apiFetch: ApiFetch; onError: (error: string | null) => void }) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({ ref: branch });
    void (async () => {
      try {
        const response = await apiFetch(`/api/git/repositories/${repository.projectId}/commits?${query}`);
        if (!response) throw new Error("Git session is unavailable");
        if (!response.ok) throw new Error(await responseError(response));
        const next = ((await response.json()) as { commits: GitCommit[] }).commits;
        if (!cancelled) setCommits(next);
      } catch (loadError) {
        if (!cancelled) onError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [repository.projectId, branch, apiFetch, onError]);
  if (loading) return <CenteredStatus>Loading commits…</CenteredStatus>;
  return (
    <div className="divide-y divide-divider border-y border-divider">
      {commits.map((commit) => (
        <a key={commit.sha} href={commit.htmlUrl} target="_blank" rel="noreferrer" className="flex items-start justify-between gap-4 py-3 hover:bg-subtle">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-body">{commit.message}</p>
            <p className="mt-1 text-xs text-muted">{commit.authorName} · {relativeTime(commit.committedAt)}</p>
          </div>
          <code className="shrink-0 font-mono text-xs text-muted">{commit.shortSha}</code>
        </a>
      ))}
    </div>
  );
}

function PullPanel({ repository, branches, apiFetch, onChanged, onError }: { repository: GitRepository; branches: GitBranch[]; apiFetch: ApiFetch; onChanged: () => Promise<void>; onError: (error: string | null) => void }) {
  const [pulls, setPulls] = useState<GitPullRequest[]>([]);
  const [title, setTitle] = useState("");
  const [head, setHead] = useState(repository.sync?.branch ?? repository.defaultBranch);
  const [base, setBase] = useState(repository.defaultBranch);
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedPullId, setSelectedPullId] = useState<string | null>(null);
  const [reviewTab, setReviewTab] = useState<"conversation" | "commits" | "checks" | "files">("conversation");
  const [pullFiles, setPullFiles] = useState<GitPullFile[]>([]);
  const [pullChecks, setPullChecks] = useState<GitCheck[]>([]);
  const [pullCommits, setPullCommits] = useState<GitCommit[]>([]);
  const load = useCallback(async () => {
    const response = await apiFetch(`/api/git/repositories/${repository.projectId}/pulls?state=open`);
    if (response?.ok) setPulls(((await response.json()) as { pulls: GitPullRequest[] }).pulls);
  }, [repository.projectId, apiFetch]);
  useEffect(() => void load(), [load]);
  const selectedPull = pulls.find((pull) => pull.id === selectedPullId) ?? null;
  useEffect(() => {
    if (!selectedPull || reviewTab === "conversation") return;
    let cancelled = false;
    void (async () => {
      try {
        const path = reviewTab === "commits"
          ? `/api/git/repositories/${repository.projectId}/commits?ref=${encodeURIComponent(selectedPull.head)}`
          : `/api/git/repositories/${repository.projectId}/pulls/${selectedPull.number}/${reviewTab}`;
        const response = await apiFetch(path);
        if (!response) throw new Error("Git session is unavailable");
        if (!response.ok) throw new Error(await responseError(response));
        const body = await response.json() as { files?: GitPullFile[]; checks?: GitCheck[]; commits?: GitCommit[] };
        if (cancelled) return;
        if (reviewTab === "files") setPullFiles(body.files ?? []);
        else if (reviewTab === "checks") setPullChecks(body.checks ?? []);
        else setPullCommits(body.commits ?? []);
      } catch (loadError) {
        if (!cancelled) onError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedPull, reviewTab, repository.projectId, apiFetch, onError]);

  const action = async (path: string, key: string, body?: unknown) => {
    const request = apiFetch(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!request) return;
    setBusy(key);
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      await load();
      await onChanged();
      setTitle("");
    } catch (actionError) {
      onError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <section className="border-y border-divider py-4">
        <h2 className="text-sm font-semibold text-body">Open a pull request</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_150px_150px_auto]">
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Title" aria-label="Pull request title" className="rounded-md border border-divider bg-input px-2.5 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent" />
          <select value={head} onChange={(event) => setHead(event.target.value)} aria-label="Compare branch" className="rounded-md border border-divider bg-input px-2 py-2 text-xs text-body">{branches.map((item) => <option key={item.name}>{item.name}</option>)}</select>
          <select value={base} onChange={(event) => setBase(event.target.value)} aria-label="Base branch" className="rounded-md border border-divider bg-input px-2 py-2 text-xs text-body">{branches.map((item) => <option key={item.name}>{item.name}</option>)}</select>
          <PrimaryButton disabled={!title.trim() || head === base || busy !== null} onClick={() => void action(`/api/git/repositories/${repository.projectId}/pulls`, "create", { title: title.trim(), body: "", head, base })}>Open</PrimaryButton>
        </div>
      </section>
      {pulls.length ? (
        <div className="divide-y divide-divider border-y border-divider">
          {pulls.map((pull) => (
            <div key={pull.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <a href={pull.htmlUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-body">#{pull.number} {pull.title}</p>
                <p className="mt-1 text-xs text-muted">{pull.head} → {pull.base} · {pull.author} · {relativeTime(pull.updatedAt)}</p>
              </a>
              <div className="flex gap-2">
                <button onClick={() => { setSelectedPullId(pull.id); setReviewTab("conversation"); }} className="cursor-pointer rounded-md bg-subtle px-2.5 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover">Review</button>
                <button disabled={busy !== null} onClick={() => void action(`/api/git/repositories/${repository.projectId}/pulls/${pull.number}/approve`, `approve-${pull.number}`)} className="cursor-pointer rounded-md bg-subtle px-2.5 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover disabled:opacity-50">Approve</button>
                <button disabled={busy !== null} onClick={() => void action(`/api/git/repositories/${repository.projectId}/pulls/${pull.number}/merge`, `merge-${pull.number}`)} className="cursor-pointer rounded-md bg-accent px-2.5 py-1.5 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50">Merge</button>
              </div>
            </div>
          ))}
        </div>
      ) : <EmptyState title="No open pull requests" body="Push a branch, then open its review here." />}
      {selectedPull && (
        <PullReview
          pull={selectedPull}
          tab={reviewTab}
          files={pullFiles}
          checks={pullChecks}
          commits={pullCommits}
          onTab={setReviewTab}
          onClose={() => setSelectedPullId(null)}
        />
      )}
    </div>
  );
}

function PullReview({
  pull,
  tab,
  files,
  checks,
  commits,
  onTab,
  onClose,
}: {
  pull: GitPullRequest;
  tab: "conversation" | "commits" | "checks" | "files";
  files: GitPullFile[];
  checks: GitCheck[];
  commits: GitCommit[];
  onTab: (tab: "conversation" | "commits" | "checks" | "files") => void;
  onClose: () => void;
}) {
  const tabs = ["conversation", "commits", "checks", "files"] as const;
  return (
    <section className="border-y border-divider py-4">
      <div className="flex items-start justify-between gap-3">
        <div><h3 className="text-sm font-semibold text-body">#{pull.number} {pull.title}</h3><p className="mt-1 text-xs text-muted">{pull.head} → {pull.base}</p></div>
        <button onClick={onClose} className="cursor-pointer text-xs text-muted hover:text-body">Close review</button>
      </div>
      <div role="tablist" aria-label={`Review ${pull.number}`} className="mt-4 flex gap-4 border-b border-divider">
        {tabs.map((target) => (
          <button key={target} role="tab" aria-selected={tab === target} onClick={() => onTab(target)} className={`cursor-pointer border-b-2 pb-2 text-xs font-medium ${tab === target ? "border-accent text-body" : "border-transparent text-muted"}`}>
            {target === "files" ? `Files changed (${files.length})` : target === "checks" ? `Checks (${checks.length})` : target === "commits" ? `Commits (${commits.length})` : "Conversation"}
          </button>
        ))}
      </div>
      {tab === "conversation" ? (
        <div className="py-5 text-sm text-muted">Review discussion and inline comments remain on <a href={pull.htmlUrl} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">GitHub</a>; approvals and merge decisions are available here.</div>
      ) : tab === "commits" ? (
        <div className="divide-y divide-divider">{commits.map((commit) => <a key={commit.sha} href={commit.htmlUrl} target="_blank" rel="noreferrer" className="flex justify-between gap-3 py-3 text-sm text-body hover:bg-subtle"><span className="truncate">{commit.message}</span><code className="font-mono text-xs text-muted">{commit.shortSha}</code></a>)}{!commits.length && <p className="py-5 text-sm text-muted">No commits returned.</p>}</div>
      ) : tab === "checks" ? (
        <div className="divide-y divide-divider">{checks.map((check) => <a key={check.id} href={check.htmlUrl ?? pull.htmlUrl} target="_blank" rel="noreferrer" className="flex justify-between gap-3 py-3 text-sm text-body hover:bg-subtle"><span>{check.name}</span><span className="text-xs text-muted">{check.conclusion ?? check.status}</span></a>)}{!checks.length && <p className="py-5 text-sm text-muted">No checks reported.</p>}</div>
      ) : (
        <div className="space-y-4 pt-4">{files.map((file) => <div key={file.filename}><div className="flex justify-between gap-3 text-xs"><code className="font-mono text-body">{file.filename}</code><span className="text-muted">+{file.additions} −{file.deletions}</span></div>{file.patch && <pre className="mt-2 overflow-x-auto rounded-lg bg-subtle p-3 font-mono text-xs leading-5 text-body"><code>{file.patch}</code></pre>}</div>)}{!files.length && <p className="py-5 text-sm text-muted">No changed files returned.</p>}</div>
      )}
    </section>
  );
}

function IssuePanel({ repository, apiFetch, onError }: { repository: GitRepository; apiFetch: ApiFetch; onError: (error: string | null) => void }) {
  const [issues, setIssues] = useState<GitIssue[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const response = await apiFetch(`/api/git/repositories/${repository.projectId}/issues?state=open`);
    if (response?.ok) setIssues(((await response.json()) as { issues: GitIssue[] }).issues);
  }, [repository.projectId, apiFetch]);
  useEffect(() => void load(), [load]);
  const create = async () => {
    const request = apiFetch(`/api/git/repositories/${repository.projectId}/issues`, { method: "POST", body: JSON.stringify({ title: title.trim(), body: "" }) });
    if (!request) return;
    setBusy(true);
    try {
      const response = await request;
      if (!response.ok) throw new Error(await responseError(response));
      setTitle("");
      await load();
    } catch (createError) {
      onError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <div className="flex gap-2 border-y border-divider py-4">
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="New issue" aria-label="Issue title" className="min-w-0 flex-1 rounded-md border border-divider bg-input px-3 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent" />
        <PrimaryButton disabled={!title.trim() || busy} onClick={() => void create()}>Create issue</PrimaryButton>
      </div>
      {issues.length ? <IssueRows issues={issues.map((issue) => ({ ...issue, projectId: repository.projectId, repository: repository.fullName }))} onOpen={() => undefined} external /> : <EmptyState title="No open issues" body="Nothing waiting here." />}
    </div>
  );
}

function PullRows({ pulls, onOpen }: { pulls: AggregatePull[]; onOpen: (id: string) => void }) {
  return <div className="divide-y divide-divider border-y border-divider">{pulls.map((pull) => <button key={`${pull.projectId}-${pull.id}`} onClick={() => onOpen(pull.projectId)} className="flex w-full cursor-pointer items-start justify-between gap-4 py-3 text-left hover:bg-subtle"><div className="min-w-0"><p className="truncate text-sm font-medium text-body">#{pull.number} {pull.title}</p><p className="mt-1 text-xs text-muted">{pull.repository} · {pull.head} → {pull.base}</p></div><span className="shrink-0 text-xs text-faint">{relativeTime(pull.updatedAt)}</span></button>)}</div>;
}

function IssueRows({ issues, onOpen, external = false }: { issues: AggregateIssue[]; onOpen: (id: string) => void; external?: boolean }) {
  return (
    <div className="divide-y divide-divider border-y border-divider">
      {issues.map((issue) => {
        const content = <><div className="min-w-0"><p className="truncate text-sm font-medium text-body">#{issue.number} {issue.title}</p><p className="mt-1 text-xs text-muted">{issue.repository} · {issue.author}{issue.labels.length ? ` · ${issue.labels.join(", ")}` : ""}</p></div><span className="shrink-0 text-xs text-faint">{relativeTime(issue.updatedAt)}</span></>;
        return external
          ? <a key={`${issue.projectId}-${issue.id}`} href={issue.htmlUrl} target="_blank" rel="noreferrer" className="flex w-full cursor-pointer items-start justify-between gap-4 py-3 text-left hover:bg-subtle">{content}</a>
          : <button key={`${issue.projectId}-${issue.id}`} onClick={() => onOpen(issue.projectId)} className="flex w-full cursor-pointer items-start justify-between gap-4 py-3 text-left hover:bg-subtle">{content}</button>;
      })}
    </div>
  );
}

function SyncButton({ label, busy, disabled, title, onClick }: { label: string; busy: string | null; disabled?: boolean; title?: string; onClick: () => Promise<unknown> }) {
  return <button title={title} disabled={disabled || busy !== null} onClick={() => void onClick()} className="cursor-pointer rounded-md bg-subtle px-2.5 py-1.5 text-xs font-semibold text-body hover:bg-subtle-hover disabled:cursor-not-allowed disabled:opacity-40">{busy === label.toLowerCase() ? `${label}…` : label}</button>;
}

function PrimaryButton({ children, onClick, disabled }: { children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="cursor-pointer rounded-md bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{children}</button>;
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="py-16 text-center"><h2 className="text-lg font-semibold text-body">{title}</h2><p className="mx-auto mt-2 max-w-lg text-sm text-muted">{body}</p>{action && <div className="mt-5">{action}</div>}</div>;
}

function CenteredStatus({ children }: { children: ReactNode }) {
  return <div role="status" className="flex min-h-48 items-center justify-center text-sm text-muted">{children}</div>;
}

function syncLabel(repository: GitRepository): string {
  if (repository.state !== "ready") return repository.state;
  if (!repository.sync) return "status unavailable";
  const parts: string[] = [];
  if (repository.sync.aheadCount) parts.push(`${repository.sync.aheadCount} ahead`);
  if (repository.sync.behindCount) parts.push(`${repository.sync.behindCount} behind`);
  if (repository.sync.hasUncommittedChanges || repository.sync.hasUntrackedFiles) parts.push("changes");
  return parts.join(" · ") || "up to date";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: string };
  return body.message ?? `Request failed (${response.status})`;
}
