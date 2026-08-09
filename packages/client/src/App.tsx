import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import type { BoardItem, ChatMessage } from "@workspace/shared";
import { WorkspaceProvider, useWorkspace } from "./hooks/WorkspaceContext";
import { LoginScreen } from "./components/LoginScreen";
import { Sidebar } from "./components/Sidebar";
import { TopBar, type WorkspaceView } from "./components/TopBar";
import { FileDropZone } from "./components/FileDropZone";
import { MessageList } from "./components/MessageList";
import { MessageInput, type Prefill } from "./components/MessageInput";
import { BoardView } from "./components/BoardView";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { Toasts } from "./components/Toasts";
import { apiBaseUrl } from "./lib/serverUrl";
import { supabase } from "./lib/supabase";

const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

/**
 * Boot: ask the server which mode it runs in, then gate accordingly. No auth
 * method configured is treated as a misconfigured deployment, not guest mode
 * — it shows a dead-end screen instead of letting anyone in unauthenticated.
 * Auth mode tracks the Supabase session directly (supabase-js persists and
 * refreshes it in localStorage on its own, no app-managed token storage
 * needed); a brand-new Supabase user who has not yet picked a username sees
 * UsernameStep before the workspace, for either sign-in provider alike.
 */
export default function App() {
  const [authMode, setAuthMode] = useState<{
    googleAuthEnabled: boolean;
    emailAuthEnabled: boolean;
  } | null>(null);
  // undefined = still resolving the initial session; null = signed out.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  // "unknown" = still checking whether this session has a bound actor yet —
  // see the race note above for why WorkspaceProvider must never render
  // until this resolves to "ok".
  const [usernameStatus, setUsernameStatus] = useState<"unknown" | "ok" | "needs_username">(
    "unknown",
  );

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(`${apiBaseUrl()}/api/auth/config`);
        const data = (await res.json()) as { googleAuthEnabled: boolean; emailAuthEnabled: boolean };
        if (!cancelled) setAuthMode(data);
      } catch {
        // Server not up yet (dev restarts): keep asking, it decides the flow.
        if (!cancelled) retry = window.setTimeout(() => void load(), 2000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setUsernameStatus("unknown");
      return;
    }
    setUsernameStatus("unknown");
    let cancelled = false;
    (async () => {
      const res = await fetch(`${apiBaseUrl()}/api/auth/session`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = (await res.json()) as { status: "ok" | "needs_username" };
      if (!cancelled) setUsernameStatus(data.status);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.access_token]);

  if (!authMode || session === undefined) {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <p role="status" className="text-muted">
          Connecting…
        </p>
      </div>
    );
  }

  const authEnabled = authMode.googleAuthEnabled || authMode.emailAuthEnabled;

  if (!authEnabled) {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <div className="w-96 rounded-lg bg-sidebar p-8 text-center shadow-2xl">
          <h1 className="mb-2 text-2xl font-semibold text-body">Sign-in unavailable</h1>
          <p className="text-muted">
            This workspace isn't configured for sign-in yet. Contact{" "}
            <a href="mailto:hello@convyio.com" className="font-medium text-blurple hover:underline">
              hello@convyio.com
            </a>{" "}
            for access.
          </p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <LoginScreen
        googleAuthEnabled={authMode.googleAuthEnabled}
        emailAuthEnabled={authMode.emailAuthEnabled}
      />
    );
  }

  if (usernameStatus === "unknown") {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <p role="status" className="text-muted">
          Connecting…
        </p>
      </div>
    );
  }

  if (usernameStatus === "needs_username") {
    return (
      <UsernameStep accessToken={session.access_token} onDone={() => setUsernameStatus("ok")} />
    );
  }

  return (
    <WorkspaceProvider
      credentials={{ authToken: session.access_token }}
      onAuthRejected={() => void supabase.auth.signOut()}
      onSignOut={() => void supabase.auth.signOut()}
    >
      <Workspace />
    </WorkspaceProvider>
  );
}

/** First sign-in only (either provider): bind the one permanent username to
 *  the new Supabase account. */
function UsernameStep({ accessToken, onDone }: { accessToken: string; onDone: () => void }) {
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
    <div className="flex h-full items-center justify-center bg-chat">
      <div className="w-96 animate-fade-in rounded-lg bg-sidebar p-8 shadow-2xl">
        <h1 className="mb-1 text-2xl font-semibold text-body">Pick a username</h1>
        <p className="mb-6 text-muted">
          This is who you are here, permanently — choose well.
        </p>
        <label
          htmlFor="username"
          className="mb-2 block text-xs font-bold tracking-wide text-muted uppercase"
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
          className="mb-2 w-full rounded border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
          placeholder="e.g. harris"
          maxLength={32}
        />
        <p role={error ? "alert" : undefined} className={`mb-4 text-sm ${error ? "text-dead" : "text-faint"}`}>
          {error ?? "1-32 characters: letters, digits, spaces, - and _"}
        </p>
        <button
          onClick={() => void submit()}
          disabled={!valid || submitting}
          className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
        >
          Join Workspace
        </button>
      </div>
    </div>
  );
}

/** The workspace shell: view/channel navigation and cross-view jumps. */
function Workspace() {
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
    const { channels } = workspace;
    if (channels.length === 0) return;
    const idx = channels.indexOf(channel);
    setChannel(channels[(idx + dir + channels.length) % channels.length]);
  };

  const selectFromSwitcher = (target: string) => {
    setChannel(target);
    setView("chat");
    setSwitcherOpen(false);
  };

  // Single window-level listener for the two global shortcuts, registered
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
      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        e.stopPropagation();
        cycleChannel(e.key === "ArrowUp" ? -1 : 1);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [workspace.channels, channel]);

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
    <div className="flex h-full">
      <Sidebar
        channel={channel}
        onSelectChannel={setChannel}
        onDiscuss={discussItem}
        onPrefill={prefillText}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-chat">
        <TopBar channel={channel} view={view} onSetView={setView} />
        {view === "chat" ? (
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
      {!workspace.connected && (
        <div
          role="status"
          className="fixed top-14 left-1/2 z-[60] -translate-x-1/2 rounded-full bg-popup px-3 py-1 text-xs font-semibold text-working shadow-lg"
        >
          {workspace.self ? "Reconnecting…" : "Connecting…"}
        </div>
      )}
      <Toasts
        toasts={workspace.toasts}
        onDismiss={workspace.dismissToast}
        onAction={(toast) => {
          if (!toast.action) return;
          setView("board");
          setOpenItemId(toast.action.itemId);
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
    </div>
  );
}
