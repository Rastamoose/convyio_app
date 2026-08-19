import { useEffect, useMemo, useState } from "react";
import type {
  Actor,
  FolderAccessMode,
  Project,
  ProjectAccessRequest,
  ProjectAssignment,
  ProjectMount,
  ToolmanNodeSummary,
  ToolmanPairingResponse,
} from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { PairingCopyRow, SetupPromptCard } from "./PairingCopy";

interface ProjectDetail {
  project: Project;
  assignments: ProjectAssignment[];
  mounts: ProjectMount[];
}

type ApiFetch = ReturnType<typeof useWorkspace>["apiFetch"];

const ACCESS_MODES: { mode: FolderAccessMode; label: string; hint: string }[] = [
  { mode: "ask", label: "Ask", hint: "Ask you once per agent conversation; you must be online" },
  { mode: "always", label: "Always", hint: "Durable access while Toolman is connected, even when you are away" },
  { mode: "deny", label: "Deny", hint: "Refuse every local operation" },
];

const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export function toolmanPairCommand(apiUrl: string, pairingCode: string): string {
  return `convyio-toolman pair --server ${apiUrl} --code ${pairingCode}`;
}

export function toolmanCliCommands(apiUrl: string, pairingCode: string): string {
  return [
    toolmanPairCommand(apiUrl, pairingCode),
    "convyio-toolman project add .",
    "convyio-toolman run",
  ].join("\n");
}

/** Prompt a local coding agent can follow to pair Toolman and attach this folder. */
export function toolmanSetupPrompt(apiUrl: string, pairingCode: string, nodeName: string): string {
  return [
    `Set up Convyio Toolman on this computer as machine "${nodeName}", and attach the folder already open here.`,
    "",
    "Toolman is a small local process. It streams one folder from this machine into the workspace. Agents never see the rest of the disk. It does not host an LLM and does not need an API key. A dirty or uncommitted tree is fine — do not ask the human to commit or stash.",
    "",
    "Pairing command (one-time, expires in about 10 minutes — run it immediately):",
    toolmanPairCommand(apiUrl, pairingCode),
    "",
    "Do this without asking for confirmation unless a command fails:",
    "1. Confirm Node.js 22+ with `node -v`.",
    "2. Put `convyio-toolman` on PATH. It is not a published npm package.",
    "   - If `convyio-toolman` already runs, continue.",
    "   - Else if this workspace or a parent contains packages/toolman/package.json named @workspace/toolman, from that folder run:",
    "     npm install && npm run build -w @workspace/toolman && npm link -w @workspace/toolman",
    "   - Else stop and tell the human they need the Convyio app repo to build the CLI.",
    "3. From the folder already open here, run the pairing command above.",
    "4. Attach this same folder, dirty or not:",
    "     convyio-toolman project add .",
    "5. Start Toolman in this terminal and keep it running: `convyio-toolman run`",
    "6. Tell the human to return to the Convyio Resources tab. The machine and folder appear when Toolman joins.",
    "",
    "Do not background Toolman and exit. Do not invent an installer. Do not put the pairing code in git, chat, or logs.",
  ].join("\n");
}

export function ResourcesView() {
  const { fetchActors, apiFetch, apiUrl, self, participants } = useWorkspace();
  const [nodes, setNodes] = useState<ToolmanNodeSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [requests, setRequests] = useState<ProjectAccessRequest[]>([]);
  const [agents, setAgents] = useState<Actor[]>([]);
  const [details, setDetails] = useState<Record<string, ProjectDetail>>({});
  const [requestMounts, setRequestMounts] = useState<Record<string, string>>({});
  const [pairing, setPairing] = useState<ToolmanPairingResponse | null>(null);
  const [nodeName, setNodeName] = useState("desk");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [nodeRes, projectRes, requestRes, actorList] = await Promise.all([
      apiFetch("/api/toolman/nodes"),
      apiFetch("/api/projects"),
      apiFetch("/api/project-access-requests"),
      fetchActors(),
    ]);
    if (nodeRes?.ok) setNodes(((await nodeRes.json()) as { nodes: ToolmanNodeSummary[] }).nodes);
    if (requestRes?.ok) setRequests(((await requestRes.json()) as { requests: ProjectAccessRequest[] }).requests);
    setAgents(actorList.filter((actor) => actor.kind === "agent"));
    if (!projectRes?.ok) return;
    const nextProjects = ((await projectRes.json()) as { projects: Project[] }).projects;
    setProjects(nextProjects);
    const loadedDetails = await Promise.all(nextProjects.map(async (project) => {
      const response = await apiFetch(`/api/projects/${project.id}`);
      return response?.ok ? await response.json() as ProjectDetail : null;
    }));
    setDetails(Object.fromEntries(loadedDetails.filter((detail): detail is ProjectDetail => Boolean(detail)).map((detail) => [detail.project.id, detail])));
  };

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    const id = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  const trimmedName = nodeName.trim();
  const nameValid = NODE_NAME.test(trimmedName);

  const createPairing = async () => {
    if (!nameValid || creating) return;
    setCreating(true);
    setError(null);
    const res = await apiFetch("/api/toolman/pairings", {
      method: "POST",
      body: JSON.stringify({ name: trimmedName }),
    });
    setCreating(false);
    if (!res?.ok) {
      setError("Could not create a pairing code");
      return;
    }
    setPairing((await res.json()) as ToolmanPairingResponse);
    await load();
  };

  const setAccessMode = async (project: Project, accessMode: FolderAccessMode) => {
    const res = await apiFetch(`/api/projects/${project.id}/access-mode`, {
      method: "POST",
      body: JSON.stringify({ accessMode }),
    });
    if (!res?.ok) {
      setError("Could not change folder access");
      return;
    }
    const body = (await res.json()) as { project: Project };
    setProjects((prev) => prev.map((item) => (item.id === project.id ? body.project : item)));
  };

  const assign = async (project: Project, agentId: string, mountId?: string) => {
    if (!mountId && project.kind !== "git") {
      setError("Share the folder from the machine first");
      return;
    }
    const response = await apiFetch(`/api/projects/${project.id}/assignments`, {
      method: "POST",
      body: JSON.stringify({ agentId, ...(mountId ? { mountId } : {}) }),
    });
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not assign agent") : "Not connected");
      return;
    }
    setError(null);
    await load();
  };

  const revokeAssignment = async (project: Project, agentId: string) => {
    const response = await apiFetch(`/api/projects/${project.id}/assignments/${agentId}`, { method: "DELETE" });
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not revoke access") : "Not connected");
      return;
    }
    setError(null);
    await load();
  };

  const revokeNode = async (node: ToolmanNodeSummary) => {
    if (!window.confirm(`Remove ${node.name}? Its shared folders become unavailable from this device.`)) return;
    const response = await apiFetch(`/api/toolman/nodes/${node.id}`, { method: "DELETE" });
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not remove device") : "Not connected");
      return;
    }
    await load();
  };

  const resolveRequest = async (
    request: ProjectAccessRequest,
    decision: "approved" | "denied",
    mountId?: string,
  ) => {
    const res = await apiFetch(`/api/project-access-requests/${request.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, ...(mountId ? { mountId } : {}) }),
    });
    if (!res?.ok) {
      setError("Could not resolve access request");
      return;
    }
    await load();
  };

  const mine = useMemo(() => nodes.filter((node) => node.createdBy === self?.id), [nodes, self]);
  const others = useMemo(() => nodes.filter((node) => node.createdBy !== self?.id), [nodes, self]);
  const foldersByNode = (nodeId: string) =>
    projects.flatMap((project) => {
      const mount = details[project.id]?.mounts.find((candidate) => candidate.nodeId === nodeId);
      return mount ? [{ project, mount }] : [];
    });
  const unmounted = projects.filter((project) => (details[project.id]?.mounts ?? []).length === 0);
  const ownerOnline = (ownerId: string) =>
    participants.some((participant) => participant.id === ownerId && participant.online);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <section>
          <h1 className="mb-2 text-lg font-semibold text-body">Share a folder</h1>
          <p className="mb-4 text-sm text-muted">
            Toolman is a small process on this computer — it streams one local folder into the
            workspace. Paste a prompt into Claude Code, Cursor, Codex, or any coding agent
            here; it pairs the machine and attaches the folder already open there. Agents never
            see the rest of the disk.
          </p>
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="min-w-0 flex-1 text-sm font-medium text-body">
              <span className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase">
                Machine name
              </span>
              <input
                value={nodeName}
                onChange={(e) => setNodeName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void createPairing()}
                maxLength={80}
                aria-label="Machine name"
                className="w-full rounded-md border border-divider bg-input px-3 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
              />
            </label>
            <button
              onClick={() => void createPairing()}
              disabled={!nameValid || creating}
              className={`cursor-pointer rounded-md px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                pairing
                  ? "bg-subtle text-body hover:bg-subtle-hover"
                  : "bg-accent text-on-accent hover:bg-accent-hover"
              }`}
            >
              {creating ? "Creating…" : pairing ? "New pairing" : "Share this folder"}
            </button>
          </div>
          {!nameValid && trimmedName.length > 0 && (
            <p className="mb-3 text-xs text-muted">
              1–80 characters: start with a letter or digit; then letters, digits, dots, - or _.
            </p>
          )}

          {pairing && (
            <div className="mb-6 space-y-3">
              <p className="text-sm text-muted">
                Paste this into a coding agent on this computer. The pairing code is shown only
                once and expires in about 10 minutes.
              </p>
              <SetupPromptCard
                value={toolmanSetupPrompt(apiUrl, pairing.pairingCode, pairing.pairing.nodeName)}
              />
              <div>
                <p className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
                  Or run it yourself
                </p>
                <div className="space-y-2">
                  <PairingCopyRow
                    label="CLI"
                    value={toolmanCliCommands(apiUrl, pairing.pairingCode)}
                    multiline
                  />
                  <PairingCopyRow label="Pairing code" value={pairing.pairingCode} />
                </div>
              </div>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold text-body">Your devices</h2>
          {mine.length === 0 && !pairing ? (
            <p className="text-sm text-muted">
              No machines paired yet. Share a folder and paste the prompt into your coding agent.
            </p>
          ) : mine.length === 0 ? (
            <p className="text-sm text-muted">Waiting for Toolman to connect…</p>
          ) : (
            <div className="space-y-3">
              {mine.map((node) => (
                <DeviceTree
                  key={node.id}
                  node={node}
                  folders={foldersByNode(node.id)}
                  details={details}
                  ownerOnline={ownerOnline(node.createdBy)}
                  agents={agents}
                  canManage
                  onMode={setAccessMode}
                  onAssign={assign}
                  onRevokeAssignment={revokeAssignment}
                  onRevokeNode={revokeNode}
                  apiFetch={apiFetch}
                />
              ))}
            </div>
          )}
        </section>

        {(others.length > 0 || unmounted.length > 0) && (
          <section>
            <h2 className="mb-3 text-lg font-semibold text-body">Other shared folders</h2>
            <div className="space-y-3">
              {others.map((node) => (
                <DeviceTree
                  key={node.id}
                  node={node}
                  folders={foldersByNode(node.id)}
                  details={details}
                  ownerOnline={ownerOnline(node.createdBy)}
                  agents={agents}
                  apiFetch={apiFetch}
                />
              ))}
              {unmounted.map((project) => (
                <FolderRow
                  key={project.id}
                  project={project}
                  detail={details[project.id]}
                  ownerOnline={ownerOnline(project.createdBy)}
                  agents={agents}
                  canManage={project.createdBy === self?.id}
                  onMode={setAccessMode}
                  onAssign={assign}
                  onRevokeAssignment={revokeAssignment}
                  apiFetch={apiFetch}
                />
              ))}
            </div>
          </section>
        )}

        {requests.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold text-body">Standing access requests</h2>
            <ul className="space-y-2 text-sm">
              {requests.map((request) => {
                const project = projects.find((candidate) => candidate.id === request.projectId);
                const mounts = details[request.projectId]?.mounts ?? [];
                const selectedMount = mounts.some((mount) => mount.id === requestMounts[request.id])
                  ? requestMounts[request.id]
                  : mounts[0]?.id;
                return (
                  <li key={request.id} className="flex items-start justify-between gap-3 rounded-md border border-divider px-3 py-2">
                    <div>
                      <p>{request.agentName ?? request.agentId} wants {request.projectName ?? project?.name ?? request.projectId}: {request.reason}</p>
                      {mounts.length > 1 && (
                        <select
                          value={selectedMount}
                          onChange={(event) => setRequestMounts((current) => ({ ...current, [request.id]: event.target.value }))}
                          aria-label={`Device for ${request.agentName ?? request.agentId}`}
                          className="mt-2 rounded-md border border-divider bg-input px-2 py-1 text-xs text-body outline-none focus:ring-2 focus:ring-accent"
                        >
                          {mounts.map((mount) => {
                            const node = nodes.find((candidate) => candidate.id === mount.nodeId);
                            return <option key={mount.id} value={mount.id}>{node?.name ?? mount.nodeId}</option>;
                          })}
                        </select>
                      )}
                    </div>
                    <span className="flex shrink-0 gap-2">
                      <button
                        className="cursor-pointer text-xs font-semibold text-accent disabled:cursor-not-allowed disabled:opacity-50"
                        disabled={project?.kind === "directory" && !selectedMount}
                        onClick={() => void resolveRequest(request, "approved", selectedMount)}
                      >
                        Approve
                      </button>
                      <button
                        className="cursor-pointer text-xs font-semibold text-muted"
                        onClick={() => void resolveRequest(request, "denied")}
                      >
                        Deny
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {error && <p className="text-sm text-dead">{error}</p>}
      </div>
    </div>
  );
}

function DeviceTree({
  node,
  folders,
  details,
  ownerOnline,
  agents,
  apiFetch,
  canManage,
  onMode,
  onAssign,
  onRevokeAssignment,
  onRevokeNode,
}: {
  node: ToolmanNodeSummary;
  folders: Array<{ project: Project; mount: ProjectMount }>;
  details: Record<string, ProjectDetail>;
  ownerOnline: boolean;
  agents: Actor[];
  apiFetch: ApiFetch;
  canManage?: boolean;
  onMode?: (project: Project, mode: FolderAccessMode) => Promise<void>;
  onAssign?: (project: Project, agentId: string, mountId?: string) => Promise<void>;
  onRevokeAssignment?: (project: Project, agentId: string) => Promise<void>;
  onRevokeNode?: (node: ToolmanNodeSummary) => Promise<void>;
}) {
  const nodeOnline = !node.revokedAt && node.health === "ready";
  return (
    <div className="rounded-md border border-divider">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div>
          <span className="text-sm font-medium text-body">{node.name}</span>
          <span className="ml-2 text-xs text-muted">{node.createdByName ?? node.createdBy}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
            {node.revokedAt ? "revoked" : nodeOnline ? "online" : "offline"}
          </span>
          {canManage && onRevokeNode && !node.revokedAt && (
            <button
              onClick={() => void onRevokeNode(node)}
              className="cursor-pointer text-xs font-medium text-muted hover:text-dead"
              aria-label={`Remove device ${node.name}`}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {folders.length === 0 ? (
        <p className="border-t border-divider px-3 py-2 text-xs text-muted">
          No folders yet. The setup prompt attaches the folder open in your editor.
        </p>
      ) : (
        <div className="space-y-2 border-t border-divider p-2">
          {folders.map(({ project, mount }) => (
            <FolderRow
              key={`${project.id}:${mount.id}`}
              project={project}
              mount={mount}
              detail={details[project.id]}
              ownerOnline={ownerOnline}
              nodeOnline={nodeOnline}
              agents={agents}
              apiFetch={apiFetch}
              canManage={canManage}
              onMode={onMode}
              onAssign={onAssign}
              onRevokeAssignment={onRevokeAssignment}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderRow({
  project,
  mount,
  detail,
  ownerOnline,
  nodeOnline = false,
  agents,
  apiFetch,
  canManage,
  onMode,
  onAssign,
  onRevokeAssignment,
}: {
  project: Project;
  mount?: ProjectMount;
  detail?: ProjectDetail;
  ownerOnline: boolean;
  nodeOnline?: boolean;
  agents: Actor[];
  apiFetch: ApiFetch;
  canManage?: boolean;
  onMode?: (project: Project, mode: FolderAccessMode) => Promise<void>;
  onAssign?: (project: Project, agentId: string, mountId?: string) => Promise<void>;
  onRevokeAssignment?: (project: Project, agentId: string) => Promise<void>;
}) {
  const [filesOpen, setFilesOpen] = useState(false);
  const assignments = detail?.assignments ?? [];
  const assignedIds = new Set(assignments.map((assignment) => assignment.agentId));
  const availableAgents = agents.filter((agent) => !assignedIds.has(agent.id));
  const availability = project.kind === "git" && !mount
    ? "managed checkout"
    : !mount
      ? "not mounted"
      : !nodeOnline
      ? "device offline"
      : project.accessMode === "ask" && !ownerOnline
        ? "waiting for owner"
        : "available";
  return (
    <div className="rounded-md bg-subtle px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-medium text-body">{project.name}</span>
          <span className="ml-2 text-xs text-muted">{project.kind}</span>
        </div>
        <span className="text-[10px] text-muted">{availability}</span>
      </div>
      {canManage && onMode && (
        <div className="mt-2 flex flex-wrap items-center gap-1" aria-label={`Access policy for ${project.name}`}>
          <span className="mr-1 text-[10px] font-bold tracking-wider text-muted uppercase">Agent access</span>
          {ACCESS_MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              title={hint}
              aria-label={`${label} access for ${project.name}`}
              aria-pressed={project.accessMode === mode}
              onClick={() => void onMode(project, mode)}
              className={`cursor-pointer rounded-md px-1.5 py-1 text-[11px] select-none ${
                project.accessMode === mode ? "bg-popup text-body" : "text-muted hover:bg-subtle-hover hover:text-body"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 space-y-2">
        {assignments.length === 0 ? (
          <p className="text-xs text-muted">No agents assigned.</p>
        ) : (
          <ul className="space-y-1">
            {assignments.map((assignment) => (
              <li key={assignment.agentId} className="flex items-center justify-between gap-2 text-xs text-muted">
                <span>{assignment.agentName ?? assignment.agentId} · {assignment.status}</span>
                {canManage && onRevokeAssignment && (
                  <button
                    onClick={() => void onRevokeAssignment(project, assignment.agentId)}
                    className="cursor-pointer font-medium hover:text-dead"
                    aria-label={`Revoke ${assignment.agentName ?? assignment.agentId} from ${project.name}`}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && onAssign && (
          availableAgents.length === 0 ? (
            <p className="text-xs text-faint">{agents.length === 0 ? "Add an agent before assigning this folder." : "Every agent already has access."}</p>
          ) : (
            <select
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) void onAssign(project, event.target.value, mount?.id);
              }}
              aria-label={`Agent to assign to ${project.name}`}
              className="min-w-0 rounded-md border border-divider bg-input px-2 py-1 text-xs text-body outline-none focus:ring-2 focus:ring-accent"
            >
              <option value="" disabled>Assign an agent…</option>
              {availableAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.displayName}</option>)}
            </select>
          )
        )}
        {canManage && mount && (
          <button
            onClick={() => setFilesOpen((open) => !open)}
            disabled={!nodeOnline}
            className="cursor-pointer text-xs font-semibold text-accent disabled:cursor-not-allowed disabled:text-muted"
            aria-expanded={filesOpen}
          >
            {filesOpen ? "Close files" : "Open files"}
          </button>
        )}
      </div>
      {filesOpen && mount && (
        <ProjectFiles project={project} mount={mount} apiFetch={apiFetch} />
      )}
    </div>
  );
}

function ProjectFiles({ project, mount, apiFetch }: { project: Project; mount: ProjectMount; apiFetch: ApiFetch }) {
  const [directory, setDirectory] = useState(".");
  const [entries, setEntries] = useState<string[]>([]);
  const [draftPath, setDraftPath] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [existingFile, setExistingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = async (target = directory) => {
    const response = await apiFetch(`/api/projects/${project.id}/files?mountId=${encodeURIComponent(mount.id)}&path=${encodeURIComponent(target)}`);
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not load files") : "Not connected");
      return;
    }
    setEntries(((await response.json()) as { entries: string[] }).entries);
    setError(null);
  };

  useEffect(() => {
    void loadEntries();
  }, [directory, mount.id, project.id]);

  const openEntry = async (entry: string) => {
    const target = joinProjectPath(directory, entry.replace(/\/$/, ""));
    if (entry.endsWith("/")) {
      setDirectory(target);
      setDraftPath(null);
      return;
    }
    const response = await apiFetch(`/api/projects/${project.id}/file?mountId=${encodeURIComponent(mount.id)}&path=${encodeURIComponent(target)}`);
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not open file") : "Not connected");
      return;
    }
    setDraftPath(target);
    setDraftContent(((await response.json()) as { content: string }).content);
    setExistingFile(true);
    setError(null);
  };

  const newFile = () => {
    setDraftPath(directory === "." ? "" : `${directory}/`);
    setDraftContent("");
    setExistingFile(false);
    setError(null);
  };

  const save = async () => {
    const target = draftPath?.trim();
    if (!target || busy) return;
    setBusy(true);
    const response = await apiFetch(`/api/projects/${project.id}/file`, {
      method: "PUT",
      body: JSON.stringify({ mountId: mount.id, path: target, content: draftContent }),
    });
    setBusy(false);
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not save file") : "Not connected");
      return;
    }
    setExistingFile(true);
    setError(null);
    await loadEntries();
  };

  const remove = async () => {
    if (!draftPath || !existingFile || busy || !window.confirm(`Delete ${draftPath}?`)) return;
    setBusy(true);
    const response = await apiFetch(`/api/projects/${project.id}/file`, {
      method: "DELETE",
      body: JSON.stringify({ mountId: mount.id, path: draftPath }),
    });
    setBusy(false);
    if (!response?.ok) {
      setError(response ? await responseError(response, "Could not delete file") : "Not connected");
      return;
    }
    setDraftPath(null);
    setDraftContent("");
    setExistingFile(false);
    setError(null);
    await loadEntries();
  };

  return (
    <div className="mt-3 border-t border-divider pt-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setDirectory(parentProjectPath(directory))}
            disabled={directory === "."}
            className="cursor-pointer text-xs font-medium text-muted hover:text-body disabled:cursor-default disabled:opacity-40"
          >
            Up
          </button>
          <span className="font-mono text-xs text-muted">/{directory === "." ? "" : directory}</span>
        </div>
        <button onClick={newFile} className="cursor-pointer text-xs font-semibold text-accent">Add file</button>
      </div>
      <div className="divide-y divide-divider border-y border-divider">
        {entries.map((entry) => (
          <button
            key={entry}
            onClick={() => void openEntry(entry)}
            className="block w-full cursor-pointer px-1 py-1.5 text-left font-mono text-xs text-body hover:bg-subtle-hover"
          >
            {entry}
          </button>
        ))}
        {entries.length === 0 && <p className="py-2 text-xs text-muted">This folder is empty.</p>}
      </div>
      {draftPath !== null && (
        <div className="mt-3 space-y-2">
          <input
            value={draftPath}
            onChange={(event) => setDraftPath(event.target.value)}
            readOnly={existingFile}
            aria-label="File path"
            placeholder="notes/new-file.txt"
            className="w-full rounded-md border border-divider bg-input px-2 py-1.5 font-mono text-xs text-body outline-none focus:ring-2 focus:ring-accent read-only:text-muted"
          />
          <textarea
            value={draftContent}
            onChange={(event) => setDraftContent(event.target.value)}
            aria-label="File contents"
            rows={10}
            className="w-full resize-y rounded-md border border-divider bg-input px-2 py-2 font-mono text-xs text-body outline-none focus:ring-2 focus:ring-accent"
          />
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => void remove()}
              disabled={!existingFile || busy}
              className="cursor-pointer text-xs font-medium text-dead disabled:cursor-default disabled:opacity-40"
            >
              Delete
            </button>
            <div className="flex gap-2">
              <button onClick={() => setDraftPath(null)} className="cursor-pointer text-xs font-medium text-muted">Cancel</button>
              <button
                onClick={() => void save()}
                disabled={!draftPath.trim() || busy}
                className="cursor-pointer rounded-md bg-accent px-2 py-1 text-xs font-semibold text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-dead">{error}</p>}
    </div>
  );
}

function joinProjectPath(directory: string, name: string): string {
  return directory === "." ? name : `${directory}/${name}`;
}

function parentProjectPath(directory: string): string {
  if (directory === "." || !directory.includes("/")) return ".";
  return directory.slice(0, directory.lastIndexOf("/"));
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}
