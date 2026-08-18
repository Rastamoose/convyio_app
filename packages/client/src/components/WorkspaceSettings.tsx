import { useEffect, useState } from "react";
import {
  DEFAULT_WORKSPACE_INVITE_OPTIONS,
  WORKSPACE_INVITE_MAX_AGE_SECONDS,
  WORKSPACE_INVITE_MAX_USES,
  type WorkspaceAccessRequest,
  type WorkspaceInvite,
  type WorkspaceInviteMaxAgeSeconds,
  type WorkspaceInviteMaxUses,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { responseMessage } from "../lib/accountApi";
import { formatFullDateTime } from "../lib/format";

const INVITE_EXPIRY_LABELS: Record<WorkspaceInviteMaxAgeSeconds, string> = {
  1_800: "30 minutes",
  3_600: "1 hour",
  21_600: "6 hours",
  43_200: "12 hours",
  86_400: "1 day",
  604_800: "7 days",
};

export function WorkspaceSettings({
  summary,
  onClose,
  onAccountRefresh,
  onLeft,
}: {
  summary: WorkspaceSummary;
  onClose: () => void;
  onAccountRefresh: () => void;
  onLeft: () => void;
}) {
  const { apiFetch, self, connected, restoreNoodle, participants } = useWorkspace();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [requests, setRequests] = useState<WorkspaceAccessRequest[]>([]);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [inviteMaxAge, setInviteMaxAge] = useState<WorkspaceInviteMaxAgeSeconds>(DEFAULT_WORKSPACE_INVITE_OPTIONS.maxAgeSeconds);
  const [inviteMaxUses, setInviteMaxUses] = useState<WorkspaceInviteMaxUses>(DEFAULT_WORKSPACE_INVITE_OPTIONS.maxUses);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const memberResponse = await apiFetch("/api/workspace/members");
      if (!memberResponse) return;
      if (!memberResponse.ok) {
        setError(await responseMessage(memberResponse));
        return;
      }
      const memberBody = (await memberResponse.json()) as { members: WorkspaceMember[] };
      setMembers(memberBody.members);
      if (summary.role === "owner") {
        const [inviteResponse, requestResponse] = await Promise.all([
          apiFetch("/api/workspace/invites"),
          apiFetch("/api/workspace/access-requests"),
        ]);
        if (!inviteResponse || !requestResponse) return;
        const failed = [inviteResponse, requestResponse].find((response) => !response.ok);
        if (failed) {
          setError(await responseMessage(failed));
          return;
        }
        const inviteBody = (await inviteResponse.json()) as { invites: WorkspaceInvite[] };
        const requestBody = (await requestResponse.json()) as { requests: WorkspaceAccessRequest[] };
        setInvites(inviteBody.invites);
        setRequests(requestBody.requests);
      }
    } catch {
      setError("Could not load workspace settings.");
    }
  };

  useEffect(() => {
    if (connected) void load();
  }, [connected]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("Clipboard access was refused.");
    }
  };

  const createInvite = async () => {
    setBusy("create-invite");
    setError(null);
    try {
      const response = await apiFetch("/api/workspace/invites", {
        method: "POST",
        body: JSON.stringify({ maxAgeSeconds: inviteMaxAge, maxUses: inviteMaxUses }),
      });
      if (!response) return;
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      const body = (await response.json()) as { invite: WorkspaceInvite; token: string };
      setInvites((current) => [body.invite, ...current]);
      setCreatedLink(`${window.location.origin}/invite/${encodeURIComponent(body.token)}`);
    } catch {
      setError("Could not create an invite link.");
    } finally {
      setBusy(null);
    }
  };

  const revokeInvite = async (inviteId: string) => {
    setBusy(inviteId);
    setError(null);
    try {
      const response = await apiFetch(`/api/workspace/invites/${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
      });
      if (!response) return;
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      setInvites((current) => current.filter((invite) => invite.id !== inviteId));
    } catch {
      setError("Could not revoke the invite.");
    } finally {
      setBusy(null);
    }
  };

  const resolveRequest = async (requestId: string, decision: "approved" | "denied") => {
    setBusy(requestId);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/workspace/access-requests/${encodeURIComponent(requestId)}/resolve`,
        { method: "POST", body: JSON.stringify({ decision }) },
      );
      if (!response) return;
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      const body = (await response.json()) as { request: WorkspaceAccessRequest };
      setRequests((current) => current.map((request) => request.id === requestId ? body.request : request));
      if (decision === "approved") await load();
    } catch {
      setError("Could not resolve the access request.");
    } finally {
      setBusy(null);
    }
  };

  const updateRole = async (member: WorkspaceMember, role: WorkspaceRole) => {
    if (member.role === role) return;
    setBusy(member.actorId);
    setError(null);
    try {
      const response = await apiFetch(`/api/workspace/members/${encodeURIComponent(member.actorId)}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      if (!response) return;
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      setMembers((current) => current.map((item) => item.actorId === member.actorId ? { ...item, role } : item));
      if (member.actorId === self?.id) onAccountRefresh();
    } catch {
      setError("Could not update the member role.");
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (member: WorkspaceMember) => {
    if (!window.confirm(`Remove ${member.displayName} from ${summary.name}?`)) return;
    setBusy(member.actorId);
    setError(null);
    try {
      const response = await apiFetch(`/api/workspace/members/${encodeURIComponent(member.actorId)}`, {
        method: "DELETE",
      });
      if (!response) return;
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      setMembers((current) => current.filter((item) => item.actorId !== member.actorId));
    } catch {
      setError("Could not remove the member.");
    } finally {
      setBusy(null);
    }
  };

  const leaveWorkspace = async () => {
    if (!self || !window.confirm(`Leave ${summary.name}?`)) return;
    setBusy(self.id);
    setError(null);
    try {
      const response = await apiFetch(`/api/workspace/members/${encodeURIComponent(self.id)}`, {
        method: "DELETE",
      });
      if (!response) return;
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      onClose();
      onLeft();
      onAccountRefresh();
    } catch {
      setError("Could not leave the workspace.");
    } finally {
      setBusy(null);
    }
  };

  const activeInvites = invites.filter(
    (invite) => !invite.revokedAt && invite.expiresAt > Date.now()
      && (invite.maxUses === 0 || invite.uses < invite.maxUses),
  );
  const pendingRequests = requests.filter((request) => request.status === "pending");

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-backdrop/55 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title" className="elevated flex max-h-[88vh] w-full max-w-2xl animate-pop-in flex-col rounded-2xl">
        <header className="flex items-start gap-4 border-b border-divider px-6 py-5">
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Workspace settings</p>
            <h1 id="workspace-settings-title" className="truncate text-xl font-semibold text-body">{summary.name}</h1>
          </div>
          <button onClick={onClose} aria-label="Close workspace settings" className="rounded-md p-1.5 text-muted hover:bg-subtle hover:text-body">×</button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {error && <p role="alert" className="mb-5 rounded-md bg-dead/10 px-3 py-2 text-sm text-dead">{error}</p>}

          <section className="mb-8">
            <h2 className="mb-3 text-lg font-semibold text-body">Workspace code</h2>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border border-divider bg-input px-3 py-2 font-mono text-sm text-body">{summary.publicCode}</code>
              <button onClick={() => void copy("code", summary.publicCode)} className="rounded-md bg-subtle px-3 py-2 text-sm font-medium text-body hover:bg-subtle-hover">
                {copied === "code" ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-sm text-muted">People can look up this workspace and ask its owners for access.</p>
          </section>

          {summary.role === "owner" && (
            <>
          <section className="mb-8 border-t border-divider pt-6">
            <h2 className="mb-2 text-lg font-semibold text-body">noodle</h2>
            <p className="mb-3 text-sm text-muted">
              Convyio’s built-in guide. Removing him from the sidebar does not delete his messages. Turning this back on restores the same noodle, without repeating the welcome.
            </p>
            {participants.some((participant) => participant.managedAgent === "noodle") ? (
              <p className="text-sm text-muted">Enabled. Owners can right-click noodle in the sidebar to remove him.</p>
            ) : (
              <button
                onClick={async () => {
                  setBusy("restore-noodle");
                  setError(null);
                  const ok = await restoreNoodle();
                  if (!ok) setError("Could not restore noodle.");
                  setBusy(null);
                }}
                disabled={busy === "restore-noodle"}
                className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
              >
                Enable noodle
              </button>
            )}
          </section>
          <section className="mb-8 border-t border-divider pt-6">
            <div className="mb-4">
              <h2 className="text-lg font-semibold text-body">Invite links</h2>
              <p className="mt-1 text-sm text-muted">Create a reusable link, then revoke it whenever you want to stop new joins.</p>
            </div>
            <div className="mb-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="text-sm font-medium text-body">
                <span className="mb-1 block">Expires after</span>
                <select aria-label="Invite expiry" value={inviteMaxAge} onChange={(event) => setInviteMaxAge(Number(event.target.value) as WorkspaceInviteMaxAgeSeconds)} className="w-full rounded-md border border-divider bg-input px-2 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent">
                  {WORKSPACE_INVITE_MAX_AGE_SECONDS.map((seconds) => <option key={seconds} value={seconds}>{INVITE_EXPIRY_LABELS[seconds]}</option>)}
                </select>
              </label>
              <label className="text-sm font-medium text-body">
                <span className="mb-1 block">Max uses</span>
                <select aria-label="Invite max uses" value={inviteMaxUses} onChange={(event) => setInviteMaxUses(Number(event.target.value) as WorkspaceInviteMaxUses)} className="w-full rounded-md border border-divider bg-input px-2 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent">
                  {WORKSPACE_INVITE_MAX_USES.map((uses) => <option key={uses} value={uses}>{uses === 0 ? "No limit" : `${uses} ${uses === 1 ? "use" : "uses"}`}</option>)}
                </select>
              </label>
              <button onClick={() => void createInvite()} disabled={busy === "create-invite"} className="shrink-0 rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">
                Create link
              </button>
            </div>
            {createdLink && (
              <div className="mb-3 flex items-center gap-2 rounded-md bg-subtle p-2">
                <input readOnly aria-label="New invite link" value={createdLink} className="min-w-0 flex-1 bg-transparent px-1 font-mono text-xs text-body outline-none" />
                <button onClick={() => void copy("invite", createdLink)} className="rounded-md bg-input px-2 py-1.5 text-xs font-medium text-body hover:bg-subtle-hover">
                  {copied === "invite" ? "Copied" : "Copy link"}
                </button>
              </div>
            )}
            {activeInvites.length === 0 ? (
              <p className="text-sm text-muted">No active invite links.</p>
            ) : (
              <ul className="divide-y divide-divider border-y border-divider">
                {activeInvites.map((invite) => (
                  <li key={invite.id} className="flex items-center gap-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="text-body">{invite.maxUses === 0 ? `${invite.uses} ${invite.uses === 1 ? "use" : "uses"}` : `${invite.uses} of ${invite.maxUses} uses`}</div>
                      <div className="mt-0.5 text-xs text-muted">Expires {formatFullDateTime(invite.expiresAt)}</div>
                    </div>
                    <button onClick={() => void revokeInvite(invite.id)} disabled={busy === invite.id} className="rounded-md px-2 py-1 text-dead hover:bg-dead/10 disabled:opacity-50">Revoke</button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mb-8 border-t border-divider pt-6">
            <h2 className="mb-3 text-lg font-semibold text-body">Pending requests</h2>
            {pendingRequests.length === 0 ? (
              <p className="text-sm text-muted">Nothing waiting on you.</p>
            ) : (
              <ul className="divide-y divide-divider border-y border-divider">
                {pendingRequests.map((request) => (
                  <li key={request.id} className="flex items-start gap-4 py-4">
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-body">{request.requesterName}</div>
                      {request.message && <p className="mt-1 text-sm text-muted">{request.message}</p>}
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => void resolveRequest(request.id, "denied")} disabled={busy === request.id} className="rounded-md px-2 py-1.5 text-sm text-muted hover:bg-subtle-hover hover:text-body disabled:opacity-50">Deny</button>
                      <button onClick={() => void resolveRequest(request.id, "approved")} disabled={busy === request.id} className="rounded-md bg-accent px-2 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">Approve</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
            </>
          )}

          <section className="border-t border-divider pt-6">
            <h2 className="mb-3 text-lg font-semibold text-body">Members</h2>
            <ul className="divide-y divide-divider border-y border-divider">
              {members.map((member) => (
                <li key={member.actorId} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-body">{member.displayName}{member.actorId === self?.id ? " · you" : ""}</div>
                    <div className="mt-0.5 text-[10px] tracking-wider text-muted uppercase">{member.kind}</div>
                  </div>
                  {summary.role === "owner" && member.kind === "human" ? (
                    <select aria-label={`Role for ${member.displayName}`} value={member.role} disabled={busy === member.actorId} onChange={(event) => void updateRole(member, event.target.value as WorkspaceRole)} className="rounded-md border border-divider bg-input px-2 py-1.5 text-sm text-body outline-none focus:ring-2 focus:ring-accent disabled:opacity-50">
                      <option value="member">Member</option>
                      <option value="owner">Owner</option>
                    </select>
                  ) : (
                    <span className="text-[10px] tracking-wider text-muted uppercase">{member.role}</span>
                  )}
                  {summary.role === "owner" && member.actorId !== self?.id && member.kind === "human" && (
                    <button onClick={() => void removeMember(member)} disabled={busy === member.actorId} className="rounded-md px-2 py-1.5 text-sm text-dead hover:bg-dead/10 disabled:opacity-50">Remove</button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-8 border-t border-divider pt-6">
            <button
              onClick={() => void leaveWorkspace()}
              disabled={!self || busy === self?.id}
              className="rounded-md px-3 py-2 text-sm font-medium text-dead hover:bg-dead/10 disabled:opacity-50"
            >
              Leave workspace
            </button>
            {summary.role === "owner" && (
              <p className="mt-2 text-sm text-muted">Another owner is required before the last owner can leave.</p>
            )}
          </section>
        </div>
      </section>
    </div>
  );
}
