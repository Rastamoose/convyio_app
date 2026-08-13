import { useEffect, useState } from "react";
import type { AgentProvider } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";

const NAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

/** The one-time secret for a just-created invite. Kept separate from the
 *  invite list itself (agentInvites, the source of truth) and only ever
 *  read back through it by id, so a revoked agent can never keep showing
 *  its secret: once the id drops out of agentInvites there is nothing left
 *  to join it to and the banner has nothing to render. */
interface CreatedSecret {
  id: string;
  token: string;
  command: string;
}

export function AddAgentModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { agentInvites, createAgent, revokeAgent } = useWorkspace();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("claude");
  const [creating, setCreating] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<CreatedSecret | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "command" | null>(null);

  // The modal stays mounted (Sidebar just toggles `open`), so each fresh
  // open should start from a clean slate rather than showing whatever was
  // left over from the last time it was open.
  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setCreatedSecret(null);
      setCopied(null);
    }
  }, [open]);

  if (!open) return null;

  const trimmed = name.trim();
  const valid = NAME_PATTERN.test(trimmed);
  // Only ever shown for an invite that's still actually in the list -
  // revoking it (locally, or the row disappearing after a refetch) takes
  // the banner with it automatically, no separate cleanup required.
  const createdInvite = createdSecret
    ? agentInvites.find((a) => a.id === createdSecret.id)
    : undefined;

  const submit = async () => {
    if (!valid || creating) return;
    setCreating(true);
    setError(null);
    setCreatedSecret(null);
    const result = await createAgent(trimmed, provider);
    setCreating(false);
    if (result) {
      setCreatedSecret({ id: result.id, token: result.token, command: result.command });
      setName("");
    } else {
      setError("Could not create the agent. The name may be taken or invalid.");
    }
  };

  const copy = async (text: string, what: "token" | "command") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
  };

  const remove = async (id: string) => {
    await revokeAgent(id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-lg bg-sidebar shadow-2xl">
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <h2 className="text-lg font-semibold text-body">Add an agent</h2>
          <button
            onClick={onClose}
            className="cursor-pointer text-xl leading-none text-muted hover:text-body"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          <p className="mb-4 text-sm text-muted">
            Create a token for an agent process you run locally. The token is
            shown only once.
          </p>

          <div className="mb-4">
            <label className="mb-1 block text-xs font-bold tracking-wide text-muted uppercase">
              Provider
            </label>
            <div className="flex gap-2">
              <ProviderButton
                label="Claude"
                selected={provider === "claude"}
                onClick={() => setProvider("claude")}
              />
              <ProviderButton
                label="Codex"
                note="(coming soon)"
                selected={provider === "codex"}
                onClick={() => setProvider("codex")}
              />
            </div>
          </div>

          <div className="mb-4">
            <label
              htmlFor="agent-name"
              className="mb-1 block text-xs font-bold tracking-wide text-muted uppercase"
            >
              Agent name
            </label>
            <input
              id="agent-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
                setCreatedSecret(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              maxLength={32}
              placeholder="e.g. claude-helper"
              className="w-full rounded border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
            />
            <p className="mt-1 text-xs text-faint">
              1-32 characters: letters, digits, spaces, - and _
            </p>
          </div>

          {error && (
            <p className="mb-4 rounded border-l-4 border-dead bg-mention-bg px-3 py-2 text-sm text-dead" role="alert">
              {error}
            </p>
          )}

          {createdSecret && createdInvite && (
            <div className="mb-4 rounded-lg border-l-4 border-working bg-mention-bg p-3">
              <p className="mb-2 text-sm font-medium text-working">
                {createdInvite.provider === "claude" ? "Claude" : "Codex"} agent
                <span className="text-body"> {createdInvite.name}</span> created.
              </p>
              <CopyField
                label="Token"
                value={createdSecret.token}
                copied={copied === "token"}
                onCopy={() => void copy(createdSecret.token, "token")}
              />
              <CopyField
                label="Run command"
                value={createdSecret.command}
                copied={copied === "command"}
                onCopy={() => void copy(createdSecret.command, "command")}
              />
              {createdInvite.provider === "codex" && (
                <p className="mt-2 text-xs text-muted">
                  Codex support is not yet available; save the token and command
                  for when it lands.
                </p>
              )}
            </div>
          )}

          <button
            onClick={() => void submit()}
            disabled={!valid || creating}
            className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? "Creating…" : "Create agent"}
          </button>

          {agentInvites.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-xs font-bold tracking-wide text-muted uppercase">
                Added agents
              </h3>
              <ul className="space-y-1.5">
                {agentInvites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex items-center justify-between rounded bg-input px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-body">
                        {invite.name}
                      </div>
                      <div className="text-xs text-muted">
                        {invite.provider === "claude" ? "Claude" : "Codex"}
                      </div>
                    </div>
                    <button
                      onClick={() => void remove(invite.id)}
                      className="ml-2 shrink-0 cursor-pointer rounded px-2 py-1 text-xs font-medium text-dead hover:bg-dead hover:text-mention-text"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderButton({
  label,
  note,
  selected,
  onClick,
}: {
  label: string;
  note?: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 cursor-pointer rounded-lg px-3 py-2 text-sm font-medium transition ${
        selected
          ? "bg-blurple text-mention-text"
          : "border border-divider bg-input text-muted hover:border-body hover:text-body"
      }`}
    >
      {label}
      {note && <span className="ml-1 text-xs opacity-60">{note}</span>}
    </button>
  );
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-bold tracking-wide text-muted uppercase">
          {label}
        </span>
        <button
          onClick={onCopy}
          className="text-xs font-medium text-blurple hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="break-all rounded border border-divider bg-input px-2 py-1.5 font-mono text-xs text-body">
        {value}
      </div>
    </div>
  );
}
