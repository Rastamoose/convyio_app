import { useEffect, useState } from "react";
import type { Project, ProjectAssignment, ProjectAccessRequest, ToolmanNodeSummary, ToolmanPairingResponse } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";

interface ProjectDetail {
  project: Project;
  assignments: ProjectAssignment[];
}

export function ResourcesView() {
  const { fetchActors, apiFetch, apiUrl } = useWorkspace();
  const [nodes, setNodes] = useState<ToolmanNodeSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [requests, setRequests] = useState<ProjectAccessRequest[]>([]);
  const [pairing, setPairing] = useState<ToolmanPairingResponse | null>(null);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
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

  const openProject = async (project: Project) => {
    const res = await apiFetch(`/api/projects/${project.id}`);
    if (!res?.ok) return;
    setSelected((await res.json()) as ProjectDetail);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h1 className="text-lg font-semibold text-body">Toolman nodes</h1>
            <button
              onClick={() => void createPairing()}
              className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent"
            >
              Pair a machine
            </button>
          </div>
          {pairing && (
            <pre className="mb-3 overflow-x-auto rounded-md bg-subtle p-3 font-mono text-xs text-body">
              {`convyio-toolman pair --server ${apiUrl} --code ${pairing.pairingCode}`}
            </pre>
          )}
          {nodes.length === 0 ? (
            <p className="text-sm text-muted">No machines paired yet.</p>
          ) : (
            <ul className="space-y-2">
              {nodes.map((node) => (
                <li key={node.id} className="rounded-md border border-divider px-3 py-2 text-sm">
                  <span className="font-medium text-body">{node.name}</span>
                  <span className="ml-2 font-mono text-xs text-muted">{node.health}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h2 className="mb-3 text-lg font-semibold text-body">Projects</h2>
          {projects.length === 0 ? (
            <p className="text-sm text-muted">
              Attach a checkout from a paired machine with <code className="font-mono">convyio-toolman project add</code>.
            </p>
          ) : (
            <ul className="space-y-2">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    onClick={() => void openProject(project)}
                    className="w-full cursor-pointer rounded-md border border-divider px-3 py-2 text-left text-sm hover:bg-subtle"
                  >
                    <span className="font-medium text-body">{project.name}</span>
                    <span className="ml-2 font-mono text-xs text-muted">{project.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected && (
            <ProjectAssignments
              detail={selected}
              onAssigned={async () => {
                await openProject(selected.project);
                await load();
              }}
              fetchActors={fetchActors}
              apiFetch={apiFetch}
            />
          )}
        </section>
        {requests.length > 0 && (
          <section>
            <h2 className="mb-3 text-lg font-semibold text-body">Access requests</h2>
            <ul className="space-y-2 text-sm">
              {requests.map((request) => (
                <li key={request.id} className="rounded-md border border-divider px-3 py-2">
                  {request.agentName ?? request.agentId} wants {request.projectId}: {request.reason}
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

function ProjectAssignments({
  detail,
  onAssigned,
  fetchActors,
  apiFetch,
}: {
  detail: ProjectDetail;
  onAssigned: () => Promise<void>;
  fetchActors: () => Promise<{ id: string; kind: string; displayName: string }[]>;
  apiFetch: (path: string, init?: RequestInit) => Promise<Response> | null;
}) {
  const assign = async () => {
    const actors = (await fetchActors()).filter((actor) => actor.kind === "agent");
    if (actors.length === 0) return;
    const chosen = actors[0];
    const mountRes = await apiFetch(`/api/projects/${detail.project.id}`);
    if (!mountRes?.ok) return;
    const body = (await mountRes.json()) as { mounts?: { id: string }[] };
    const mountId = body.mounts?.[0]?.id;
    if (!mountId) return;
    await apiFetch(`/api/projects/${detail.project.id}/assignments`, {
      method: "POST",
      body: JSON.stringify({ agentId: chosen.id, mountId }),
    });
    await onAssigned();
  };

  return (
    <div className="mt-4 rounded-md border border-divider p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-body">{detail.project.name} assignments</h3>
        <button onClick={() => void assign()} className="cursor-pointer text-xs font-semibold text-accent">
          Assign first agent
        </button>
      </div>
      {detail.assignments.length === 0 ? (
        <p className="text-xs text-muted">No agents assigned.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {detail.assignments.map((assignment) => (
            <li key={`${assignment.projectId}:${assignment.agentId}`}>
              {assignment.agentName ?? assignment.agentId} · {assignment.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
