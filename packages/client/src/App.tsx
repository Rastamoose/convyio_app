import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { BoardItem, ChatMessage, WorkspaceAccessRequest, WorkspaceSummary } from "@workspace/shared";
import { WorkspaceProvider, useWorkspace } from "./hooks/WorkspaceContext";
import { LoginScreen, MIN_PASSWORD_LENGTH } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { AppBar, type WorkspaceView } from "./components/AppBar";
import { FileDropZone } from "./components/FileDropZone";
import { MessageList } from "./components/MessageList";
import { MessageInput, type Prefill } from "./components/MessageInput";
import { BoardView } from "./components/BoardView";
import { ResourcesView } from "./components/ResourcesView";
import { ApprovalQueue } from "./components/ApprovalQueue";
import { PanelHeader } from "./components/PanelHeader";
import { StatusBar } from "./components/StatusBar";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { Toasts } from "./components/Toasts";
import { apiBaseUrl } from "./lib/serverUrl";
import { supabase } from "./lib/supabase";
import { WorkspaceLobby } from "./components/WorkspaceLobby";
import { WorkspaceInviteFlow } from "./components/WorkspaceInviteFlow";
import { WorkspaceSettings } from "./components/WorkspaceSettings";
import { accountFetch, type WorkspaceAccount } from "./lib/accountApi";
import {
  chooseInitialWorkspace,
  invitePath,
  LAST_WORKSPACE_KEY,
  pendingInviteToken,
  PENDING_INVITE_KEY,
  workspaceIdFromPath,
  workspacePath,
} from "./lib/workspaceNavigation";

const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

/**
 * Boot: ask the server which mode it runs in, then gate accordingly. No auth
 * method configured is treated as a misconfigured deployment, not guest mode
 * — it shows a dead-end screen instead of letting anyone in unauthenticated.
 * Auth mode tracks the Supabase session directly (supabase-js persists and
 * refreshes it through lib/supabase's remember-me storage adapter, no
 * app-managed token storage needed); a brand-new Supabase user who has not
 * yet picked a username sees UsernameStep before the workspace, for either
 * sign-in provider alike.
 */
/** Retries before "Connecting…" stops being an honest description (~10s). */
const STARTUP_PATIENCE = 5;

/**
 * The pre-workspace screen. Startup retries forever by design — a dev server
 * restart should heal itself — but a loop that never succeeds has to say so
 * rather than spin indefinitely with no explanation.
 */
function StartupScreen({ error }: { error: string | null }) {
  return (
    <div className="app-frame flex h-full items-center justify-center">
      {error ? (
        <div className="elevated w-96 rounded-2xl p-8 text-center">
          <h1 className="mb-2 text-lg font-semibold text-body">Can't start</h1>
          <p className="mb-4 text-sm text-muted">{error}</p>
          <p className="mb-4 text-xs text-faint">
            Still retrying every 2 seconds. In local development this usually
            means the server process is not running or crashed on boot — check
            the server pane of <code className="font-mono">npm run dev</code>.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent transition hover:bg-accent-hover"
          >
            Reload
          </button>
        </div>
      ) : (
        <p role="status" className="text-muted">
          Connecting…
        </p>
      )}
    </div>
  );
}

type ResolvedAccount = { status: "ok" } & WorkspaceAccount;
type AccountState = ResolvedAccount | { status: "needs_username" };

export default function App() {
  const [authMode, setAuthMode] = useState<{
    googleAuthEnabled: boolean;
    emailAuthEnabled: boolean;
  } | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [account, setAccount] = useState<AccountState | undefined>(undefined);
  const [accountVersion, setAccountVersion] = useState(0);
  // Which session token the loaded account belongs to — refreshes for the
  // same token must not reset the UI to the loading screen.
  const accountTokenRef = useRef<string | null>(null);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null | undefined>(undefined);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(() => {
    try {
      const token = pendingInviteToken(window.location.pathname, window.sessionStorage);
      if (token && window.location.pathname === "/") {
        window.history.replaceState({}, "", `${invitePath(token)}${window.location.search}${window.location.hash}`);
      }
      return token;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    let attempts = 0;
    const load = async () => {
      attempts += 1;
      try {
        const response = await fetch(`${apiBaseUrl()}/api/auth/config`);
        if (!response.ok) throw new Error(`server returned ${response.status}`);
        const data = (await response.json()) as { googleAuthEnabled: boolean; emailAuthEnabled: boolean };
        if (!cancelled) {
          setAuthMode(data);
          setStartupError(null);
        }
        return;
      } catch (error) {
        if (cancelled) return;
        if (attempts >= STARTUP_PATIENCE) {
          setStartupError(
            error instanceof Error && error.message.startsWith("server returned")
              ? `The server is up but not answering correctly (${error.message}).`
              : "Cannot reach the server.",
          );
        }
      }
      if (!cancelled) retry = window.setTimeout(() => void load(), 2000);
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      accountTokenRef.current = null;
      setAccount(undefined);
      setActiveWorkspaceId(undefined);
      return;
    }
    // Only drop back to the loading screen when the signed-in identity
    // changes. accountVersion refreshes (the lobby's 10s poll) refetch in
    // place so the mounted UI keeps its local state.
    if (accountTokenRef.current !== session.access_token) {
      accountTokenRef.current = session.access_token;
      setAccount(undefined);
    }
    let cancelled = false;
    let retry: number | undefined;
    let attempts = 0;
    const load = async () => {
      attempts += 1;
      let failure = "Cannot reach the server.";
      try {
        const response = await accountFetch(session.access_token, "/api/account");
        if (cancelled) return;
        if (response.ok) {
          const data = (await response.json()) as
            | { status: "needs_username" }
            | ({ status: "ok"; accessRequests?: WorkspaceAccessRequest[] } & Omit<WorkspaceAccount, "accessRequests">);
          setAccount(
            data.status === "ok"
              ? { ...data, accessRequests: data.accessRequests ?? [] }
              : data,
          );
          setStartupError(null);
          return;
        }
        if (response.status === 401) {
          void supabase.auth.signOut();
          return;
        }
        failure = `The server could not resolve this session (HTTP ${response.status}).`;
      } catch {
        failure = "Cannot reach the server.";
      }
      if (cancelled) return;
      if (attempts >= STARTUP_PATIENCE) setStartupError(failure);
      retry = window.setTimeout(() => void load(), 2000);
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [session?.access_token, accountVersion]);

  useEffect(() => {
    if (!account || account.status !== "ok" || inviteToken) return;
    setActiveWorkspaceId((current) => {
      if (current !== undefined) {
        if (current === null || account.workspaces.some((workspace) => workspace.id === current)) {
          return current;
        }
      }
      const selected = chooseInitialWorkspace(
        account.workspaces,
        window.location.pathname,
        window.localStorage.getItem(LAST_WORKSPACE_KEY),
      );
      if (selected) {
        window.localStorage.setItem(LAST_WORKSPACE_KEY, selected);
        window.history.replaceState({}, "", workspacePath(selected));
      } else if (workspaceIdFromPath(window.location.pathname)) {
        window.history.replaceState({}, "", "/");
      }
      return selected;
    });
  }, [account, inviteToken]);

  useEffect(() => {
    const onPopState = () => {
      const routeInvite = window.location.pathname.match(/^\/invite\/([^/]+)\/?$/);
      if (routeInvite) {
        const token = decodeURIComponent(routeInvite[1]);
        window.sessionStorage.setItem(PENDING_INVITE_KEY, token);
        setInviteToken(token);
        setActiveWorkspaceId(null);
        return;
      }
      setInviteToken(null);
      if (!account || account.status !== "ok") return;
      const routeWorkspaceId = workspaceIdFromPath(window.location.pathname);
      setActiveWorkspaceId(
        routeWorkspaceId && account.workspaces.some((workspace) => workspace.id === routeWorkspaceId)
          ? routeWorkspaceId
          : null,
      );
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [account]);

  const openWorkspace = useCallback((workspaceId: string, replace = false) => {
    window.localStorage.setItem(LAST_WORKSPACE_KEY, workspaceId);
    const path = workspacePath(workspaceId);
    if (replace) window.history.replaceState({}, "", path);
    else window.history.pushState({}, "", path);
    setActiveWorkspaceId(workspaceId);
  }, []);

  const openLobby = useCallback(() => {
    window.localStorage.removeItem(LAST_WORKSPACE_KEY);
    window.history.pushState({}, "", "/");
    setActiveWorkspaceId(null);
  }, []);

  const refreshAccount = useCallback(() => setAccountVersion((version) => version + 1), []);

  useEffect(() => {
    if (!session || account?.status !== "ok" || activeWorkspaceId !== null || inviteToken) return;
    const interval = window.setInterval(refreshAccount, 10_000);
    return () => window.clearInterval(interval);
  }, [session?.access_token, account?.status, activeWorkspaceId, inviteToken, refreshAccount]);

  const addWorkspace = (workspace: WorkspaceSummary) => {
    setAccount((current) => current?.status === "ok"
      ? { ...current, workspaces: [...current.workspaces.filter((item) => item.id !== workspace.id), workspace] }
      : current);
    openWorkspace(workspace.id);
  };

  const updateRequest = (request: WorkspaceAccessRequest) => {
    setAccount((current) => current?.status === "ok"
      ? {
          ...current,
          accessRequests: [
            request,
            ...current.accessRequests.filter((item) => item.id !== request.id),
          ],
        }
      : current);
  };

  const leaveInvite = () => {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
    window.history.replaceState({}, "", "/");
    setInviteToken(null);
    setActiveWorkspaceId(null);
  };

  const acceptInvite = (workspace: WorkspaceSummary) => {
    window.sessionStorage.removeItem(PENDING_INVITE_KEY);
    setInviteToken(null);
    setAccount((current) => current?.status === "ok"
      ? { ...current, workspaces: [...current.workspaces.filter((item) => item.id !== workspace.id), workspace] }
      : current);
    openWorkspace(workspace.id, true);
  };

  const lastAuthRecovery = useRef(0);
  const handleAuthRejected = async () => {
    if (session) {
      const response = await accountFetch(session.access_token, "/api/account").catch(() => null);
      if (response?.ok) {
        const current = (await response.json()) as AccountState;
        if (current.status === "ok") {
          setAccount(current);
          if (!current.workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
            window.localStorage.removeItem(LAST_WORKSPACE_KEY);
            window.history.replaceState({}, "", "/");
            setActiveWorkspaceId(null);
          }
          return;
        }
      }
    }
    const now = Date.now();
    if (now - lastAuthRecovery.current > 30_000) {
      lastAuthRecovery.current = now;
      const { data, error } = await supabase.auth.refreshSession();
      if (!error && data.session) return;
    }
    void supabase.auth.signOut();
  };

  if (!authMode || session === undefined) return <StartupScreen error={startupError} />;

  const authEnabled = authMode.googleAuthEnabled || authMode.emailAuthEnabled;
  if (!authEnabled) {
    return (
      <div className="app-frame flex h-full items-center justify-center">
        <div className="elevated w-96 rounded-2xl p-8 text-center">
          <h1 className="mb-2 text-2xl font-semibold text-body">Sign-in unavailable</h1>
          <p className="text-muted">
            This workspace isn't configured for sign-in yet. Contact{" "}
            <a href="mailto:hello@convyio.com" className="font-medium text-accent hover:underline">hello@convyio.com</a>{" "}
            for access.
          </p>
        </div>
      </div>
    );
  }

  if (recovering && session) return <ResetPasswordScreen onDone={() => setRecovering(false)} />;

  if (inviteToken && (!session || account?.status === "ok")) {
    return (
      <WorkspaceInviteFlow
        token={inviteToken}
        accessToken={session?.access_token ?? null}
        googleAuthEnabled={authMode.googleAuthEnabled}
        emailAuthEnabled={authMode.emailAuthEnabled}
        onAccepted={acceptInvite}
        onLeave={leaveInvite}
      />
    );
  }

  if (!session) {
    return <LoginScreen googleAuthEnabled={authMode.googleAuthEnabled} emailAuthEnabled={authMode.emailAuthEnabled} />;
  }

  if (!account) return <StartupScreen error={startupError} />;

  if (account.status === "needs_username") {
    return (
      <UsernameStep
        accessToken={session.access_token}
        onDone={refreshAccount}
        onBack={() => void supabase.auth.signOut()}
      />
    );
  }

  if (activeWorkspaceId === undefined) return <StartupScreen error={startupError} />;

  const activeWorkspace = activeWorkspaceId
    ? account.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null
    : null;

  if (!activeWorkspace) {
    return (
      <WorkspaceLobby
        account={account}
        accessToken={session.access_token}
        onOpen={openWorkspace}
        onWorkspaceCreated={addWorkspace}
        onRequestCreated={updateRequest}
        onSignOut={() => void supabase.auth.signOut()}
      />
    );
  }

  return (
    <WorkspaceProvider
      key={activeWorkspace.id}
      credentials={{ workspaceId: activeWorkspace.id, authToken: session.access_token }}
      onAuthRejected={() => void handleAuthRejected()}
      onSignOut={() => void supabase.auth.signOut()}
    >
      <Workspace
        activeWorkspace={activeWorkspace}
        workspaces={account.workspaces}
        onSelectWorkspace={openWorkspace}
        onOpenLobby={openLobby}
        onAccountRefresh={refreshAccount}
      />
    </WorkspaceProvider>
  );
}

/** First sign-in only (either provider): bind the one permanent username to
 *  the new Supabase account. */
function UsernameStep({
  accessToken,
  onDone,
  onBack,
}: {
  accessToken: string;
  onDone: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = name.trim();
  const valid = USERNAME_PATTERN.test(trimmed);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl()}/api/auth/username`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ username: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(data.message ?? `Could not save the username (${res.status}).`);
        return;
      }
      onDone();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-frame relative flex h-full items-center justify-center">
      <button
        onClick={onBack}
        aria-label="Back to sign in"
        title="Back to sign in"
        className="absolute top-4 left-4 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition select-none hover:bg-input"
      >
        <img src="/mark-yellow.svg" alt="" className="h-6 w-6" />
      </button>
      <div className="elevated w-96 animate-fade-in rounded-2xl p-8">
        <img src="/mark-yellow.svg" alt="convyio" className="mb-6 h-8 w-8" />
        <h1 className="mb-1 text-2xl font-semibold text-body">Pick a username</h1>
        <p className="mb-6 text-muted">
          This is who you are here, permanently — choose well.
        </p>
        <label
          htmlFor="username"
          className="mb-2 block text-[11px] font-bold tracking-wider text-muted uppercase"
        >
          Username
        </label>
        <input
          id="username"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className="mb-2 w-full rounded-md border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-accent"
          placeholder="e.g. harris"
          maxLength={32}
        />
        <p role={error ? "alert" : undefined} className={`mb-4 text-sm ${error ? "text-dead" : "text-faint"}`}>
          {error ?? "1-32 characters: letters, digits, spaces, - and _"}
        </p>
        <button
          onClick={() => void submit()}
          disabled={!valid || submitting}
          className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Join Workspace
        </button>
      </div>
    </div>
  );
}

/** Shown when the user lands from a password-reset email (PASSWORD_RECOVERY):
 *  sets the new password on the live recovery session, then hands the user
 *  back to the normal signed-in flow. */
function ResetPasswordScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const valid = password.length >= MIN_PASSWORD_LENGTH && password === confirm;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setSubmitting(false);
      return;
    }
    onDone();
  };

  const fieldClass =
    "w-full rounded-md border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-accent";
  const labelClass = "mb-2 block text-[11px] font-bold tracking-wider text-muted uppercase";

  return (
    <div className="app-frame flex h-full items-center justify-center">
      <div className="elevated w-96 animate-fade-in rounded-2xl p-8">
        <h1 className="mb-1 text-2xl font-semibold text-body">Set a new password</h1>
        <p className="mb-6 text-muted">
          Choose a new password for your account ({MIN_PASSWORD_LENGTH}+ characters).
        </p>
        <div className="mb-4">
          <label htmlFor="new-password" className={labelClass}>
            New password
          </label>
          <input
            id="new-password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            className={fieldClass}
            placeholder="••••••••"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="confirm-password" className={labelClass}>
            Confirm password
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            className={fieldClass}
            placeholder="••••••••"
          />
        </div>
        {error && (
          <p role="alert" className="mb-4 text-sm text-dead">
            {error}
          </p>
        )}
        <button
          onClick={() => void submit()}
          disabled={!valid || submitting}
          className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Save new password
        </button>
      </div>
    </div>
  );
}

/** The workspace shell: view/channel navigation and cross-view jumps. */
function Workspace({
  activeWorkspace,
  workspaces,
  onSelectWorkspace,
  onOpenLobby,
  onAccountRefresh,
}: {
  activeWorkspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  onSelectWorkspace: (workspaceId: string) => void;
  onOpenLobby: () => void;
  onAccountRefresh: () => void;
}) {
  const workspace = useWorkspace();
  const [channel, setChannel] = useState("general");
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [view, setView] = useState<WorkspaceView>("chat");
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [highlightRef, setHighlightRef] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.localStorage.getItem("convyio:sidebar-open") !== "0",
  );

  // Switching channels leaves any in-flight reply behind and marks the
  // channel we're entering as read (also covers the initial mount).
  useEffect(() => {
    setReplyTo(null);
    workspace.markRead(channel);
  }, [channel]);

  // The active channel can vanish out from under the viewer (someone else
  // deletes it); archived channels stay viewable, so only a real delete
  // needs a fallback.
  useEffect(() => {
    if (
      !workspace.channels.includes(channel) &&
      !workspace.archivedChannels.includes(channel)
    ) {
      setChannel("general");
    }
  }, [workspace.channels, workspace.archivedChannels, channel]);

  const cycleChannel = (dir: -1 | 1) => {
    const rooms = workspace.channels;
    if (rooms.length === 0) return;
    const idx = rooms.indexOf(channel);
    const next = rooms[(Math.max(idx, 0) + dir + rooms.length) % rooms.length] ?? rooms[0];
    setChannel(next);
  };

  const selectFromSwitcher = (target: string) => {
    setChannel(target);
    setView("chat");
    setSwitcherOpen(false);
  };

  // Persist the sidebar collapse across sessions, same pattern as the theme.
  useEffect(() => {
    try {
      window.localStorage.setItem("convyio:sidebar-open", sidebarOpen ? "1" : "0");
    } catch {
      // Private-mode storage denial: the toggle still applies for this session.
    }
  }, [sidebarOpen]);

  // Single window-level listener for the global shortcuts, registered
  // with useCapture so it runs before MessageInput's own keydown handling —
  // that handler's ArrowUp-to-edit branch has no modifier check, so without
  // capture+stopPropagation an Alt+ArrowUp while composing would fire both.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); // keep the browser's own search bar from opening
        setSwitcherOpen(true);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
        e.preventDefault(); // the browser's bookmarks bar stays shut
        setSidebarOpen((o) => !o);
        return;
      }
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        cycleChannel(e.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [channel, workspace.channels]);

  const prefillText = (text: string) => setPrefill({ text, nonce: Date.now() });

  const handleRefClick = (ref: string) => {
    setView("board");
    const item = workspace.board.find((i) => i.ref === ref);
    setOpenItemId(item?.id ?? null);
    setHighlightRef(ref);
    if (highlightTimer.current != null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(
      () => setHighlightRef(null),
      2000,
    );
  };

  const discussItem = (item: BoardItem) => {
    workspace.sendMessage(`discuss ${item.ref} — "${item.title}"`, channel);
    setView("chat");
  };

  const jumpToTrace = (runId: string) => {
    setView("chat");
    window.setTimeout(() => {
      document
        .getElementById(`trace-${runId}`)
        ?.scrollIntoView({ behavior: "smooth" });
    }, 50);
  };

  const handleSend = (content: string, attachmentIds: string[]): boolean => {
    // Attachment-carrying sends are always messages, never slash commands.
    if (attachmentIds.length === 0 && content.startsWith("/")) {
      const command = content.slice(1).split(/\s+/)[0].toLowerCase();
      switch (command) {
        case "clear":
          workspace.clearMessages();
          return true;
        case "interrupt": {
          const match = content.match(/^\/interrupt\s+@(\S+)\s+(.+)$/s);
          if (!match) {
            workspace.notify("Usage: /interrupt @agent <new prompt>");
            return false;
          }
          const [, target, prompt] = match;
          workspace.interrupt(target, prompt);
          return true;
        }
        default:
          workspace.notify(`Unknown command: /${command}`);
          return false;
      }
    }
    workspace.sendMessage(content, channel, attachmentIds, replyTo?.id);
    setReplyTo(null);
    return true;
  };

  return (
    <div className="app-frame flex h-full flex-col">
      <AppBar
        view={view}
        onSetView={setView}
        onToggleQueue={() => setQueueOpen((o) => !o)}
        channel={channel}
        activeWorkspace={activeWorkspace}
        workspaces={workspaces}
        onSelectWorkspace={onSelectWorkspace}
        onOpenLobby={onOpenLobby}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div className="flex min-h-0 flex-1">
        {/* The sidebar rests on the canvas, flush to the window edge;
            collapsing animates width+padding to zero while the inner aside
            holds its fixed 240px width. */}
        <div
          className={`shrink-0 overflow-hidden transition-[width,padding] duration-200 ease-out ${
            sidebarOpen ? "w-60 pr-2" : "w-0"
          }`}
        >
          <Sidebar
            channel={channel}
            onSelectChannel={setChannel}
            onDiscuss={discussItem}
            onPrefill={prefillText}
            canManageMembers={activeWorkspace.role === "owner"}
            addAgentOpen={addAgentOpen}
            onAddAgentOpenChange={setAddAgentOpen}
          />
        </div>
        <main
          className={`my-2 mr-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-divider bg-chat shadow-sm ${
            sidebarOpen ? "" : "ml-2"
          }`}
        >
        <PanelHeader
          view={view}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          channel={channel}
        />
        {view === "resources" ? (
          <ResourcesView />
        ) : view === "chat" ? (
          <FileDropZone
            onFiles={(files) => workspace.addAttachments(channel, files)}
          >
            <MessageList
              channel={channel}
              onRefClick={handleRefClick}
              onReply={setReplyTo}
              editingId={editingId}
              onEditingIdChange={setEditingId}
              onDiscuss={discussItem}
              onPrefill={prefillText}
              onAddAgent={() => setAddAgentOpen(true)}
            />
            <MessageInput
              channel={channel}
              onSend={handleSend}
              prefill={prefill}
              replyTo={replyTo}
              onCancelReply={() => setReplyTo(null)}
              editingId={editingId}
              onRequestEditLast={setEditingId}
            />
          </FileDropZone>
        ) : (
          <BoardView
            highlightRef={highlightRef}
            openItemId={openItemId}
            onOpenItem={setOpenItemId}
            onDiscuss={discussItem}
            onJumpToTrace={jumpToTrace}
          />
        )}
        </main>
      </div>
      <StatusBar channel={channel} view={view} />
      {queueOpen && (
        <ApprovalQueue
          items={workspace.board.filter((i) => i.status === "proposed")}
          interactions={workspace.pendingInteractions}
          onResolveInteraction={workspace.resolveInteraction}
          onDiscuss={(item) => {
            setQueueOpen(false);
            discussItem(item);
          }}
          onClose={() => setQueueOpen(false)}
        />
      )}
      {!workspace.connected && (
        <div
          role="status"
          className="elevated fixed top-14 left-1/2 z-[60] -translate-x-1/2 rounded-full px-3 py-1 text-xs font-semibold text-working"
        >
          {workspace.self ? "Reconnecting…" : "Connecting…"}
        </div>
      )}
      <Toasts
        toasts={workspace.toasts}
        onDismiss={workspace.dismissToast}
        onAction={(toast) => {
          if (!toast.action) return;
          // The card lives in chat; the Board tab is another view of it.
          setView("chat");
          window.setTimeout(() => {
            document
              .getElementById(`proposal-${toast.action!.itemId}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          }, 50);
        }}
      />
      {switcherOpen && (
        <QuickSwitcher
          channels={workspace.channels}
          unreadCount={workspace.unreadCount}
          onSelect={selectFromSwitcher}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {settingsOpen && (
        <WorkspaceSettings
          summary={activeWorkspace}
          onClose={() => setSettingsOpen(false)}
          onAccountRefresh={onAccountRefresh}
          onLeft={onOpenLobby}
        />
      )}
    </div>
  );
}
