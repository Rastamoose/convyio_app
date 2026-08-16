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

export function ResourcesView() {
  const { fetchActors, apiFetch, apiUrl, self, participants } = useWorkspace();
  const [nodes, setNodes] = useState<ToolmanNodeSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [requests, setRequests] = useState<ProjectAccessRequest[]>([]);
  const [details, setDetails] = useState<Record<string, ProjectDetail>>({});
  const [pairing, setPairing] = useState<ToolmanPairingResponse | null>(null);
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

  const createPairing = async () => {
    const name = window.prompt("Name this machine", "desk");
    if (!name) return;
    const res = await apiFetch("/api/toolman/pairings", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
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
          <div className="mb-3 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-body">Your devices</h1>
            <button
              onClick={() => void createPairing()}
              className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent"
            >
              Share a folder
            </button>
          </div>
          <p className="mb-3 text-sm text-muted">
            A device is only the pipe to a local folder. Pair it, then attach a clean checkout:
          </p>
          {pairing && (
            <pre className="mb-3 overflow-x-auto rounded-md bg-subtle p-3 font-mono text-xs text-body">
              {`convyio-toolman pair --server ${apiUrl} --code ${pairing.pairingCode}\nconvyio-toolman project add <path>\nconvyio-toolman run`}
            </pre>
          )}
          {mine.length === 0 && !pairing ? (
            <p className="text-sm text-muted">No machines paired yet. Share a folder to register this computer.</p>
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
        {error && <p className="text-sm text-danger">{error}</p>}
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
          No folders yet. Attach one with <code className="font-mono">convyio-toolman project add</code>.
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
