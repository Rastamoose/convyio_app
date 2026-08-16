import { useEffect, useMemo, useState } from "react";
import type {
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

const ACCESS_MODES: { mode: FolderAccessMode; label: string; hint: string }[] = [
  { mode: "ask", label: "Ask", hint: "Ask you before each new run" },
  { mode: "always", label: "While online", hint: "Allow while you are online; no prompts" },
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
    "Toolman is a small local process. It is the pipe from this workspace to one checkout on this machine. Agents never see the rest of the disk. It does not host an LLM and does not need an API key.",
    "",
    "Pairing command (one-time, expires in about 10 minutes — run it immediately):",
    toolmanPairCommand(apiUrl, pairingCode),
    "",
    "Do this without asking for confirmation unless a command fails:",
    "1. Confirm Node.js 22+ with `node -v`.",
    "2. Put `convyio-toolman` on PATH. It is not a published npm package.",
    "   - If `convyio-toolman` already runs, continue.",
    "   - Else if this workspace or a parent contains packages/toolman/package.json named @workspace/toolman, from that checkout run:",
    "     npm install && npm run build -w @workspace/toolman && npm link -w @workspace/toolman",
    "   - Else stop and tell the human they need a Convyio checkout to build the CLI.",
    "3. From the project directory already open here, run the pairing command above.",
    "4. Attach this same directory. It must be a clean git checkout or a plain folder:",
    "     convyio-toolman project add .",
    "     If git reports a dirty tree, stop and tell the human to commit or stash first.",
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
  const [details, setDetails] = useState<Record<string, ProjectDetail>>({});
  const [pairing, setPairing] = useState<ToolmanPairingResponse | null>(null);
  const [nodeName, setNodeName] = useState("desk");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [nodeRes, projectRes, requestRes] = await Promise.all([
      apiFetch("/api/toolman/nodes"),
      apiFetch("/api/projects"),
      apiFetch("/api/project-access-requests"),
    ]);
    if (nodeRes?.ok) setNodes(((await nodeRes.json()) as { nodes: ToolmanNodeSummary[] }).nodes);
    if (projectRes?.ok) setProjects(((await projectRes.json()) as { projects: Project[] }).projects);
    if (requestRes?.ok) setRequests(((await requestRes.json()) as { requests: ProjectAccessRequest[] }).requests);
  };

  useEffect(() => {
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    const id = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    void Promise.all(
      projects.map(async (project) => {
        const res = await apiFetch(`/api/projects/${project.id}`);
        if (!res?.ok) return;
        const detail = (await res.json()) as ProjectDetail;
        setDetails((prev) => ({ ...prev, [project.id]: detail }));
      }),
    );
  }, [projects]);

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

  const assign = async (project: Project) => {
    const actors = (await fetchActors()).filter((actor) => actor.kind === "agent");
    if (actors.length === 0) return;
    const mountId = details[project.id]?.mounts[0]?.id;
    if (!mountId) {
      setError("Share the folder from the machine first");
      return;
    }
    await apiFetch(`/api/projects/${project.id}/assignments`, {
      method: "POST",
      body: JSON.stringify({ agentId: actors[0].id, mountId }),
    });
    await load();
  };

  const resolveRequest = async (request: ProjectAccessRequest, decision: "approved" | "denied") => {
    const detail = details[request.projectId];
    const res = await apiFetch(`/api/project-access-requests/${request.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, mountId: detail?.mounts[0]?.id }),
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
    projects.filter((project) => (details[project.id]?.mounts ?? []).some((mount) => mount.nodeId === nodeId));
  const unmounted = projects.filter((project) => (details[project.id]?.mounts ?? []).length === 0);
  const ownerOnline = (ownerId: string) =>
    participants.some((participant) => participant.id === ownerId && participant.online);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <section>
          <h1 className="mb-2 text-lg font-semibold text-body">Share a folder</h1>
          <p className="mb-4 text-sm text-muted">
            Toolman is a small process on this computer — the pipe from the workspace to one
            local checkout. Paste a prompt into Claude Code, Cursor, Codex, or any coding agent
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
                  canManage
                  onMode={setAccessMode}
                  onAssign={assign}
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
                />
              ))}
              {unmounted.map((project) => (
                <FolderRow
                  key={project.id}
                  project={project}
                  detail={details[project.id]}
                  ownerOnline={ownerOnline(project.createdBy)}
                />
              ))}
            </div>
          </section>
        )}

        {requests.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold text-body">Standing access requests</h2>
            <ul className="space-y-2 text-sm">
              {requests.map((request) => (
                <li key={request.id} className="flex items-start justify-between gap-3 rounded-md border border-divider px-3 py-2">
                  <span>
                    {request.agentName ?? request.agentId} wants {request.projectId}: {request.reason}
                  </span>
                  <span className="flex shrink-0 gap-2">
                    <button
                      className="cursor-pointer text-xs font-semibold text-accent"
                      onClick={() => void resolveRequest(request, "approved")}
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
              ))}
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
  canManage,
  onMode,
  onAssign,
}: {
  node: ToolmanNodeSummary;
  folders: Project[];
  details: Record<string, ProjectDetail>;
  ownerOnline: boolean;
  canManage?: boolean;
  onMode?: (project: Project, mode: FolderAccessMode) => Promise<void>;
  onAssign?: (project: Project) => Promise<void>;
}) {
  return (
    <div className="rounded-md border border-divider">
      <div className="flex items-center justify-between px-3 py-2">
        <div>
          <span className="text-sm font-medium text-body">{node.name}</span>
          <span className="ml-2 text-xs text-muted">{node.createdByName ?? node.createdBy}</span>
        </div>
        <span className="text-[10px] font-bold tracking-wider text-muted uppercase">
          {node.revokedAt ? "revoked" : ownerOnline && node.health === "ready" ? "online" : node.health}
        </span>
      </div>
      {folders.length === 0 ? (
        <p className="border-t border-divider px-3 py-2 text-xs text-muted">
          No folders yet. The setup prompt attaches the checkout open in your editor.
        </p>
      ) : (
        <div className="space-y-2 border-t border-divider p-2">
          {folders.map((project) => (
            <FolderRow
              key={project.id}
              project={project}
              detail={details[project.id]}
              ownerOnline={ownerOnline}
              canManage={canManage}
              onMode={onMode}
              onAssign={onAssign}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderRow({
  project,
  detail,
  ownerOnline,
  canManage,
  onMode,
  onAssign,
}: {
  project: Project;
  detail?: ProjectDetail;
  ownerOnline: boolean;
  canManage?: boolean;
  onMode?: (project: Project, mode: FolderAccessMode) => Promise<void>;
  onAssign?: (project: Project) => Promise<void>;
}) {
  return (
    <div className="rounded-md bg-subtle px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-medium text-body">{project.name}</span>
          <span className="ml-2 text-xs text-muted">{project.kind}</span>
        </div>
        <span className="text-[10px] text-muted">
          {ownerOnline ? "available" : "owner offline"}
        </span>
      </div>
      {canManage && onMode && (
        <div className="mt-2 flex gap-1">
          {ACCESS_MODES.map(({ mode, label, hint }) => (
            <button
              key={mode}
              title={hint}
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
      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-muted">
          {(detail?.assignments ?? []).length === 0
            ? "No agents assigned."
            : detail!.assignments.map((assignment) => `${assignment.agentName ?? assignment.agentId} · ${assignment.status}`).join(", ")}
        </p>
        {canManage && onAssign && (
          <button onClick={() => void onAssign(project)} className="cursor-pointer text-xs font-semibold text-accent">
            Assign first agent
          </button>
        )}
      </div>
    </div>
  );
}
