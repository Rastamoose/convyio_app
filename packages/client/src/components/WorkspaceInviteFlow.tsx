import { useEffect, useState } from "react";
import type { WorkspaceInvitePreview, WorkspaceSummary } from "@workspace/shared";
import { accountFetch, responseMessage } from "../lib/accountApi";
import { apiBaseUrl } from "../lib/serverUrl";
import { LoginScreen } from "./LoginScreen";

export function WorkspaceInviteFlow({
  token,
  accessToken,
  googleAuthEnabled,
  emailAuthEnabled,
  onAccepted,
  onLeave,
}: {
  token: string;
  accessToken: string | null;
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
  onAccepted: (workspace: WorkspaceSummary) => void;
  onLeave: () => void;
}) {
  const [preview, setPreview] = useState<WorkspaceInvitePreview | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setError(null);
    fetch(`${apiBaseUrl()}/api/invites/${encodeURIComponent(token)}`)
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setPreview(null);
          setError(await responseMessage(response));
          return;
        }
        setPreview((await response.json()) as WorkspaceInvitePreview);
      })
      .catch(() => {
        if (!cancelled) {
          setPreview(null);
          setError("Could not reach the server.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    if (!accessToken || accepting) return;
    setAccepting(true);
    setError(null);
    try {
      const response = await accountFetch(
        accessToken,
        `/api/invites/${encodeURIComponent(token)}/accept`,
        { method: "POST" },
      );
      if (!response.ok) {
        setError(await responseMessage(response));
        return;
      }
      const body = (await response.json()) as { workspace: WorkspaceSummary };
      onAccepted(body.workspace);
    } catch {
      setError("Could not accept the invitation.");
    } finally {
      setAccepting(false);
    }
  };

  if (preview === undefined) {
    return <div className="app-frame flex h-full items-center justify-center"><p role="status" className="text-muted">Opening invitation…</p></div>;
  }

  if (!preview) {
    return (
      <div className="app-frame flex h-full items-center justify-center p-4">
        <div className="elevated w-full max-w-md rounded-2xl p-8 text-center">
          <p className="mb-2 text-[11px] font-bold tracking-wider text-muted uppercase">Workspace invite</p>
          <h1 className="mb-2 text-2xl font-semibold text-body">Invite unavailable</h1>
          <p role="alert" className="mb-6 text-sm text-muted">{error ?? "This invite is invalid, expired, or already used."}</p>
          <button onClick={onLeave} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover">Go to workspaces</button>
        </div>
      </div>
    );
  }

  if (!accessToken) {
    return (
      <LoginScreen
        googleAuthEnabled={googleAuthEnabled}
        emailAuthEnabled={emailAuthEnabled}
        invitePreview={preview}
        inviteToken={token}
      />
    );
  }

  return (
    <div className="app-frame flex h-full items-center justify-center p-4">
      <div className="elevated w-full max-w-md animate-fade-in rounded-2xl p-8">
        <p className="mb-2 text-[11px] font-bold tracking-wider text-muted uppercase">Workspace invite</p>
        <h1 className="mb-2 text-2xl font-semibold text-body">Join {preview.workspace.name}</h1>
        <p className="mb-6 text-muted">{preview.inviterName} invited you to work alongside their team.</p>
        {error && <p role="alert" className="mb-4 text-sm text-dead">{error}</p>}
        <div className="flex gap-3">
          <button onClick={onLeave} className="flex-1 rounded-md bg-subtle px-3 py-2.5 font-medium text-body hover:bg-subtle-hover">Not now</button>
          <button onClick={() => void accept()} disabled={accepting} className="flex-1 rounded-md bg-accent px-3 py-2.5 font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50">Accept invitation</button>
        </div>
      </div>
    </div>
  );
}
