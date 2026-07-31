import { useState } from "react";
import { useWorkspace } from "./hooks/useWorkspace";
import { UsernameModal } from "./components/UsernameModal";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { MessageList } from "./components/MessageList";
import { MessageInput, type Prefill } from "./components/MessageInput";

const CHANNELS = ["general", "demo"];

export default function App() {
  const [name, setName] = useState<string | null>(
    () => sessionStorage.getItem("displayName"),
  );
  const [channel, setChannel] = useState("general");
  const workspace = useWorkspace(name);
  const [prefill, setPrefill] = useState<Prefill | null>(null);

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
        onDirect={(agentName) =>
          setPrefill({ text: `@${agentName} `, nonce: Date.now() })
        }
      />
      <main className="flex min-w-0 flex-1 flex-col bg-chat">
        <TopBar
          channel={channel}
          onRunDemo={
            channel === "demo" ? () => workspace.startDemo(channel) : undefined
          }
        />
        <MessageList
          channel={channel}
          messages={channelMessages}
          activeRuns={workspace.activeRuns}
          runDurations={workspace.runDurations}
          participants={workspace.participants}
          selfName={workspace.self?.name ?? null}
        />
        <MessageInput
          channel={channel}
          participants={workspace.participants}
          onSend={handleSend}
          prefill={prefill}
        />
      </main>
    </div>
  );
}
