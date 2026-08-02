import { useRef, useState } from "react";
import type { BoardItem } from "@workspace/shared";
import { useWorkspace } from "./hooks/useWorkspace";
import { UsernameModal } from "./components/UsernameModal";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { MessageList } from "./components/MessageList";
import { MessageInput, type Prefill } from "./components/MessageInput";
import { BoardPanel } from "./components/BoardPanel";

const CHANNELS = ["general", "demo"];

export default function App() {
  const [name, setName] = useState<string | null>(
    () => sessionStorage.getItem("displayName"),
  );
  const [channel, setChannel] = useState("general");
  const workspace = useWorkspace(name);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [boardOpen, setBoardOpen] = useState(false);
  const [highlightRef, setHighlightRef] = useState<string | null>(null);
  const highlightTimer = useRef<number | null>(null);

  const prefillText = (text: string) => setPrefill({ text, nonce: Date.now() });

  const handleRefClick = (ref: string) => {
    setBoardOpen(true);
    setHighlightRef(ref);
    if (highlightTimer.current != null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(
      () => setHighlightRef(null),
      2000,
    );
  };

  const discussItem = (item: BoardItem) =>
    workspace.sendMessage(`discuss ${item.ref} — "${item.title}"`, channel);

  const handleSend = (content: string) => {
    if (content.startsWith("/")) {
      const command = content.slice(1).split(/\s+/)[0].toLowerCase();
      switch (command) {
        case "clear":
          workspace.clearMessages();
          return;
        case "interrupt": {
          const match = content.match(/^\/interrupt\s+@(\S+)\s+(.+)$/s);
          if (match) {
            const [, target, prompt] = match;
            workspace.interrupt(target, prompt);
          }
          return;
        }
      }
    }
    workspace.sendMessage(content, channel);
  };

  const channelMessages = workspace.messages.filter(
    (m) => (m.channel ?? "general") === channel,
  );

  if (!name) {
    return (
      <UsernameModal
        onJoin={(n) => {
          sessionStorage.setItem("displayName", n);
          setName(n);
        }}
      />
    );
  }

  return (
    <div className="flex h-full">
      <Sidebar
        participants={workspace.participants}
        self={workspace.self}
        channels={CHANNELS}
        channel={channel}
        onSelectChannel={setChannel}
        onSetStatus={workspace.setStatus}
        board={workspace.board}
        activeRuns={workspace.activeRuns}
        messages={workspace.messages}
        onApprove={workspace.approveItem}
        onDeny={workspace.denyItem}
        onDiscuss={discussItem}
        onPrefill={prefillText}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-chat">
        <TopBar
          channel={channel}
          onRunDemo={
            channel === "demo" ? () => workspace.startDemo(channel) : undefined
          }
          boardOpen={boardOpen}
          onToggleBoard={() => setBoardOpen((o) => !o)}
        />
        <MessageList
          channel={channel}
          messages={channelMessages}
          boardLines={workspace.boardLines}
          activeRuns={workspace.activeRuns}
          runDurations={workspace.runDurations}
          participants={workspace.participants}
          selfName={workspace.self?.name ?? null}
          onRefClick={handleRefClick}
        />
        <MessageInput
          channel={channel}
          participants={workspace.participants}
          onSend={handleSend}
          prefill={prefill}
        />
      </main>
      {boardOpen && (
        <BoardPanel
          board={workspace.board}
          activeRuns={workspace.activeRuns}
          highlightRef={highlightRef}
          onCreate={workspace.createBoardItem}
          onApprove={workspace.approveItem}
          onDeny={workspace.denyItem}
          onDiscuss={discussItem}
        />
      )}
    </div>
  );
}
