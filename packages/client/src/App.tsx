import { useEffect, useRef, useState } from "react";
import type { BoardItem, ChatMessage } from "@workspace/shared";
import { WorkspaceProvider, useWorkspace } from "./hooks/WorkspaceContext";
import { UsernameModal } from "./components/UsernameModal";
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

/**
 * Boot: ask the server which mode it runs in, then gate accordingly.
 * Guest mode (no Google client id) keeps the old flow: pick a display name,
 * connect. Auth mode requires a stored session token, obtained through the
 * LoginScreen; a token the server rejects is cleared and we return to login.
 */
export default function App() {
  const [authMode, setAuthMode] = useState<{
    googleClientId: string | null;
    emailAuthEnabled: boolean;
  } | null>(null);
  const [guestName, setGuestName] = useState<string | null>(
    () => sessionStorage.getItem("displayName"),
  );
  const [authToken, setAuthToken] = useState<string | null>(
    () => window.localStorage.getItem("authToken") ?? window.sessionStorage.getItem("authToken"),
  );

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    const load = async () => {
      try {
        const res = await fetch(`${apiBaseUrl()}/api/auth/config`);
        const data = (await res.json()) as { googleClientId: string | null; emailAuthEnabled: boolean };
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

  if (!authMode) {
    return (
      <div className="flex h-full items-center justify-center bg-chat">
        <p role="status" className="text-muted">
          Connecting…
        </p>
      </div>
    );
  }

  const authEnabled = authMode.googleClientId !== null || authMode.emailAuthEnabled;

  if (!authEnabled) {
    if (!guestName) {
      return (
        <UsernameModal
          onJoin={(n) => {
            sessionStorage.setItem("displayName", n);
            setGuestName(n);
          }}
        />
      );
    }
    return (
      <WorkspaceProvider credentials={{ name: guestName }}>
        <Workspace />
      </WorkspaceProvider>
    );
  }

  if (!authToken) {
    return (
      <LoginScreen
        googleClientId={authMode.googleClientId}
        emailAuthEnabled={authMode.emailAuthEnabled}
        onSignedIn={(token, rememberMe) => {
          (rememberMe ? window.localStorage : window.sessionStorage).setItem("authToken", token);
          setAuthToken(token);
        }}
      />
    );
  }

  return (
    <WorkspaceProvider
      credentials={{ authToken }}
      onAuthRejected={() => {
        window.localStorage.removeItem("authToken");
        window.sessionStorage.removeItem("authToken");
        setAuthToken(null);
      }}
      onSignOut={() => {
        void fetch(`${apiBaseUrl()}/api/auth/logout`, {
          method: "POST",
          headers: { Authorization: `Bearer ${authToken}` },
        }).finally(() => {
          window.localStorage.removeItem("authToken");
          window.sessionStorage.removeItem("authToken");
          location.reload();
        });
      }}
    >
      <Workspace />
    </WorkspaceProvider>
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
          className="fixed top-14 left-1/2 z-[60] -translate-x-1/2 rounded-full border-2 border-body bg-popup px-3 py-1 text-xs font-semibold text-working shadow-hard"
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
