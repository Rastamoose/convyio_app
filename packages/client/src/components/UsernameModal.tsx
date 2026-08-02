import { useState } from "react";

export function UsernameModal({ onJoin }: { onJoin: (name: string) => void }) {
  const [name, setName] = useState("");

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed) onJoin(trimmed);
  };

  return (
    <div className="flex h-full items-center justify-center bg-sidebar-dark">
      <div className="w-96 rounded-lg bg-chat p-8 shadow-2xl">
        <h1 className="mb-1 text-2xl font-semibold text-body">Join the workspace</h1>
        <p className="mb-6 text-muted">
          One room, humans and agents side by side. Pick a display name.
        </p>
        <label className="mb-2 block text-xs font-bold tracking-wide text-muted uppercase">
          Display name
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          className="mb-5 w-full rounded bg-sidebar-dark px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
          placeholder="e.g. harris"
          maxLength={32}
        />
        <button
          onClick={submit}
          disabled={!name.trim()}
          className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
        >
          Join Workspace
        </button>
      </div>
    </div>
  );
}
