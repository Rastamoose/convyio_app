import { useState } from "react";
import type { WorkspaceAccessRequest, WorkspaceSummary } from "@workspace/shared";
import { accountFetch, responseMessage, type WorkspaceAccount } from "../lib/accountApi";
import { relativeTime } from "../lib/format";
import { ThemeToggle } from "./ThemeToggle";

interface LookupWorkspace {
  id: string;
  name: string;
  publicCode: string;
}

export function WorkspaceLobby({
  account,
  accessToken,
  onOpen,
  onWorkspaceCreated,
  onRequestCreated,
  onSignOut,
}: {
  account: WorkspaceAccount;
  accessToken: string;
  onOpen: (workspaceId: string) => void;
  onWorkspaceCreated: (workspace: WorkspaceSummary) => void;
  onRequestCreated: (request: WorkspaceAccessRequest) => void;
  onSignOut: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [lookup, setLookup] = useState<LookupWorkspace | null>(null);
  const [creating, setCreating] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const requests = account.accessRequests.filter(
    (request) => request.status === "pending" || request.status === "denied",
  );

  const createWorkspace = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await accountFetch(accessToken, "/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        setCreateError(await responseMessage(response));
        return;
      }
      const body = (await response.json()) as { workspace: WorkspaceSummary };
      onWorkspaceCreated(body.workspace);
    } catch {
      setCreateError("Could not reach the server.");
    } finally {
      setCreating(false);
    }
  };

  const lookupWorkspace = async () => {
    const trimmed = code.trim();
    if (!trimmed || lookingUp) return;
    setLookingUp(true);
    setLookup(null);
    setLookupError(null);
    try {
      const response = await accountFetch(
        accessToken,
        `/api/workspaces/lookup/${encodeURIComponent(trimmed)}`,
      );
      if (!response.ok) {
        setLookupError(await responseMessage(response));
        return;
      }
      const body = (await response.json()) as { workspace: LookupWorkspace };
      setLookup(body.workspace);
      setCode(body.workspace.publicCode);
    } catch {
      setLookupError("Could not reach the server.");
    } finally {
      setLookingUp(false);
    }
  };

  const requestAccess = async () => {
    if (!lookup || requesting) return;
    setRequesting(true);
    setLookupError(null);
    try {
      const response = await accountFetch(
        accessToken,
        `/api/workspaces/${encodeURIComponent(lookup.publicCode)}/access-requests`,
        {
          method: "POST",
          body: JSON.stringify({ message: message.trim() || undefined }),
        },
      );
      if (!response.ok) {
        setLookupError(await responseMessage(response));
        return;
      }
      const body = (await response.json()) as { request: WorkspaceAccessRequest };
      onRequestCreated(body.request);
      setLookup(null);
      setCode("");
      setMessage("");
    } catch {
      setLookupError("Could not reach the server.");
    } finally {
      setRequesting(false);
    }
  };

  return (
    <div className="app-frame min-h-full overflow-y-auto text-body">
      <header className="flex h-14 items-center gap-3 border-b border-divider px-5">
        <img src="/mark-yellow.svg" alt="convyio" className="h-6 w-6" />
        <span className="text-sm font-bold tracking-wider uppercase">Workspaces</span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-muted">{account.username}</span>
          <button onClick={onSignOut} className="rounded-md px-2 py-1 text-sm text-muted hover:bg-subtle hover:text-body">
            Sign out
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-12">
        <div className="mb-10 max-w-2xl">
          <p className="mb-2 text-[11px] font-bold tracking-wider text-muted uppercase">
            Your desk
          </p>
          <h1 className="mb-2 text-2xl font-semibold">Choose a workspace</h1>
          <p className="text-muted">Pick up where you left off, or make room for something new.</p>
        </div>

        <section className="mb-12">
          <h2 className="mb-3 text-lg font-semibold">Memberships</h2>
          {account.workspaces.length === 0 ? (
            <div className="border-y border-divider py-8 text-sm text-muted">
              No workspace memberships yet. Create one or ask for access below.
            </div>
          ) : (
            <ul className="divide-y divide-divider border-y border-divider">
              {account.workspaces.map((workspace) => (
                <li key={workspace.id} className="flex items-center gap-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold">{workspace.name}</div>
                    <div className="mt-1 text-[11px] tracking-wide text-muted uppercase">
                      {workspace.role} · joined {relativeTime(workspace.joinedAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => onOpen(workspace.id)}
                    className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {requests.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-3 text-lg font-semibold">Access requests</h2>
            <ul className="divide-y divide-divider border-y border-divider">
              {requests.map((request) => (
                <li key={request.id} className="flex items-start justify-between gap-4 py-4">
                  <div>
                    <div className="font-medium">{request.workspaceName}</div>
                    {request.message && <p className="mt-1 text-sm text-muted">{request.message}</p>}
                  </div>
                  <span className={`text-[11px] font-bold tracking-wide uppercase ${request.status === "pending" ? "text-accent" : "text-muted"}`}>
                    {request.status}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="grid gap-10 border-t border-divider pt-10 md:grid-cols-2">
          <section>
            <p className="mb-2 text-[11px] font-bold tracking-wider text-muted uppercase">Create</p>
            <h2 className="mb-2 text-lg font-semibold">Start a workspace</h2>
            <p className="mb-5 text-sm text-muted">You will be its first owner.</p>
            <label htmlFor="workspace-name" className="mb-2 block text-sm font-medium">Workspace name</label>
            <input
              id="workspace-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setCreateError(null);
              }}
              onKeyDown={(event) => event.key === "Enter" && void createWorkspace()}
              maxLength={80}
              placeholder="Quiet launch"
              className="w-full rounded-md border border-divider bg-input px-3 py-2 text-body outline-none focus:ring-2 focus:ring-accent"
            />
            {createError && <p role="alert" className="mt-2 text-sm text-dead">{createError}</p>}
            <button
              onClick={() => void createWorkspace()}
              disabled={!name.trim() || creating}
              className="mt-4 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              Create workspace
            </button>
          </section>

          <section>
            <p className="mb-2 text-[11px] font-bold tracking-wider text-muted uppercase">Join</p>
            <h2 className="mb-2 text-lg font-semibold">Find by code</h2>
            <p className="mb-5 text-sm text-muted">Ask an owner for the workspace code.</p>
            <label htmlFor="workspace-code" className="mb-2 block text-sm font-medium">Workspace code</label>
            <div className="flex gap-2">
              <input
                id="workspace-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setLookup(null);
                  setLookupError(null);
                }}
                onKeyDown={(event) => event.key === "Enter" && void lookupWorkspace()}
                placeholder="ABCD-1234"
                className="min-w-0 flex-1 rounded-md border border-divider bg-input px-3 py-2 font-mono text-sm text-body outline-none focus:ring-2 focus:ring-accent"
              />
              <button
                onClick={() => void lookupWorkspace()}
                disabled={!code.trim() || lookingUp}
                className="rounded-md bg-subtle px-3 py-2 text-sm font-medium text-body hover:bg-subtle-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                Look up
              </button>
            </div>
            {lookupError && <p role="alert" className="mt-2 text-sm text-dead">{lookupError}</p>}
            {lookup && (
              <div className="mt-5 border-t border-divider pt-5">
                <div className="font-semibold">{lookup.name}</div>
                <p className="mt-1 text-sm text-muted">Send a short note to its owners.</p>
                <textarea
                  aria-label="Access request message"
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  maxLength={500}
                  rows={3}
                  placeholder="What are you working on?"
                  className="mt-3 w-full resize-none rounded-md border border-divider bg-input px-3 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
                />
                <button
                  onClick={() => void requestAccess()}
                  disabled={requesting}
                  className="mt-3 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Request access
                </button>
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
