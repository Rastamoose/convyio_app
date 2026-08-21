import { useEffect, useRef, useState } from "react";
import type {
  AgentAccessMode,
  AgentAccessPolicy,
  AgentResourceAccessRequest,
  AgentResourceGrant,
  AgentResourceManifest,
  AgentSummary,
  Participant,
  RunnerConfigOption,
} from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { runtimeHealthDot, runtimeHealthLabel } from "../lib/status";
import { PairingCopyRow, SetupPromptCard } from "./PairingCopy";

const NAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

const DEFAULT_INSTRUCTIONS =
  "You are a workspace teammate. Propose board items with a clear, narrow scope before you touch anything, and ask a human when you're blocked.";

/** Plain-language gloss for the diagnostic codes runner_status carries; an
 *  unrecognized code (new server/agent code shipped later) still reads as a
 *  sentence instead of raw SCREAMING_SNAKE_CASE wire text. */
const DIAGNOSTIC_MESSAGES: Record<string, string> = {
  CODEX_ADAPTER_UNAVAILABLE: "Codex support isn't available yet.",
  MODEL_UNAVAILABLE: "The requested model isn't available; running on the harness default instead.",
  HARNESS_MISMATCH: "This runner reports a different harness than the one this agent was created for.",
  PROTOCOL_UNSUPPORTED: "This runner speaks a protocol version the server doesn't support.",
  ACP_AUTH_REQUIRED: "The harness needs you to sign in (e.g. `claude login`) on the machine running it.",
  ACP_INCOMPATIBLE: "This harness version isn't compatible.",
  ACP_MISCONFIGURED: "The harness is misconfigured.",
  ACP_PREFLIGHT_FAILED: "The harness failed its startup check.",
};

function diagnosticMessage(code: string | undefined): string | null {
  if (!code) return null;
  return DIAGNOSTIC_MESSAGES[code] ?? code.toLowerCase().replace(/_/g, " ");
}

type Step = "create" | "pair" | "configure";

/**
 * The agent pairing + profile surface: create an agent, pair a local runner
 * to it (paste-into-Claude/Cursor prompt first, raw CLI as fallback), then
 * configure its instructions/model/access — and reopen straight into that
 * same configure step for any agent already in the list.
 */

export function pairCommand(apiUrl: string, pairingCode: string): string {
  return `npx convyio-agent connect --server ${apiUrl} --code ${pairingCode}`;
}

/** Prompt a local coding agent can follow to pair and start this runner. */
export function setupPrompt(apiUrl: string, pairingCode: string, agentName: string): string {
  return [
    `Set up the local Convyio runner for agent "${agentName}".`,
    "",
    "Convyio is only the workspace. Claude / Codex stay on this computer and keep using the subscription already signed in here. Do not send that login, an API key, or the pairing code to any remote service.",
    "",
    "Setup command (one-time, expires in about 10 minutes — run it immediately):",
    pairCommand(apiUrl, pairingCode),
    "",
    "Do this without asking for confirmation unless a command fails:",
    "1. Confirm Node.js 22+ with `node -v`.",
    "2. If Claude authentication is missing, run `claude login` and wait for the browser login to finish.",
    "3. From the project directory already open here (this agent's local workspace), run the setup command above.",
    "   It pairs the agent and installs a per-user login service, so the runner starts on every login",
    "   and restarts if it crashes. It needs no sudo, no administrator, and no password prompt.",
    "4. Tell the human to return to the Convyio tab. The agent will show as connected but asleep.",
    "",
    "The runner starts asleep on purpose: it holds a connection but runs no harness and reads no files",
    "until someone wakes it. Only the person who created the agent can do that — from the agent's card in",
    "Convyio, or from its settings. Other members see the control greyed out with the owner's name.",
    "Machine off means agent off; that is expected, and it comes back by itself on the next login.",
    "",
    "Do not invent an installer. Do not put the pairing code in git, chat, or logs.",
  ].join("\n");
}

export function AddAgentModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    agentInvites,
    apiUrl,
    apiFetch,
    createAgent,
    updateAgent,
    repairAgent,
    revokeAgent,
    refreshAgents,
    participants,
    self,
    setAgentActive,
  } = useWorkspace();

  const [step, setStep] = useState<Step>("create");
  // Only the id is kept; the entity is re-derived from agentInvites below so
  // a revoke, rename, or runtime update elsewhere is reflected automatically.
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  // The one-time pairing secret has no other source than the create/re-pair
  // response, so (unlike the agent itself) it has to live in local state.
  const [pairingCode, setPairingCode] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The modal stays mounted (Sidebar just toggles `open`), so each fresh
  // open must start clean rather than showing whatever was left over.
  useEffect(() => {
    if (open) {
      setStep("create");
      setActiveAgentId(null);
      setPairingCode(null);
      setName("");
      setInstructions(DEFAULT_INSTRUCTIONS);
      setCreating(false);
      setCreateError(null);
    }
  }, [open]);

  // Runtime health/effectiveModel move as the runner connects and the server
  // never pushes them, so this is the only way the pair/configure steps see
  // that happen without the user manually reopening the modal.
  // ponytail: dumb poll, fine for the handful of agents a workspace pairs at
  // once; the upgrade path is a ws broadcast of runner_status to the owning
  // human instead of the client polling GET /api/agents.
  // Held in a ref because the context hands out a fresh function identity every
  // render: as an effect dependency it would tear down and immediately re-run
  // the poll on each refresh's own state update, i.e. fetch in a tight loop.
  const refresh = useRef(refreshAgents);
  refresh.current = refreshAgents;
  useEffect(() => {
    if (!open) return;
    void refresh.current();
    const id = window.setInterval(() => void refresh.current(), 3000);
    return () => window.clearInterval(id);
  }, [open]);

  if (!open) return null;

  const activeAgent = activeAgentId
    ? (agentInvites.find((a) => a.id === activeAgentId) ?? null)
    : null;

  const trimmedName = name.trim();
  const nameValid = NAME_PATTERN.test(trimmedName);

  const submitCreate = async () => {
    if (!nameValid || creating) return;
    setCreating(true);
    setCreateError(null);
    const result = await createAgent({
      name: trimmedName,
      provider: "claude",
      instructions,
      model: null,
      access: { mode: "workspace", selectedActorIds: [] },
    });
    setCreating(false);
    if (!result) {
      setCreateError("Could not create the agent. The name may be taken or invalid.");
      return;
    }
    setActiveAgentId(result.id);
    setPairingCode(result.pairingCode);
    setStep("pair");
  };

  const openConfigure = (id: string) => {
    setActiveAgentId(id);
    setPairingCode(null);
    setStep("configure");
  };

  const repair = async () => {
    if (!activeAgent) return;
    const code = await repairAgent(activeAgent.id);
    if (code) {
      setPairingCode(code);
      setStep("pair");
    }
  };

  const revoke = async () => {
    if (!activeAgent) return;
    if (await revokeAgent(activeAgent.id)) {
      setActiveAgentId(null);
      setPairingCode(null);
      setStep("create");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="elevated flex max-h-[85vh] w-full max-w-md flex-col rounded-xl">
        <div className="flex items-center justify-between border-b border-divider px-4 py-3">
          <h2 className="text-lg font-semibold text-body">
            {step === "create" && "Add an agent"}
            {step === "pair" && "Connect locally"}
            {step === "configure" && (activeAgent?.name ?? "Agent")}
          </h2>
          <button
            onClick={onClose}
            className="cursor-pointer text-xl leading-none text-muted hover:text-body"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {step === "create" && (
            <CreateStep
              name={name}
              onNameChange={(value) => {
                setName(value);
                setCreateError(null);
              }}
              nameValid={nameValid}
              instructions={instructions}
              onInstructionsChange={setInstructions}
              creating={creating}
              error={createError}
              onSubmit={() => void submitCreate()}
            />
          )}

          {step === "pair" && activeAgent && (
            <PairStep
              agent={activeAgent}
              pairingCode={pairingCode}
              apiUrl={apiUrl}
              onContinue={() => setStep("configure")}
            />
          )}

          {step === "configure" && activeAgent && (
            <ConfigureStep
              key={activeAgent.id}
              agent={activeAgent}
              participants={participants}
              apiFetch={apiFetch}
              onSave={(fields) => updateAgent(activeAgent.id, fields)}
              onRepair={() => void repair()}
              onRevoke={() => void revoke()}
              canActivate={self?.id === activeAgent.createdBy}
              onSetActive={(active) => setAgentActive(activeAgent.actorId, active)}
            />
          )}

          {step === "create" && agentInvites.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
                Your agents
              </h3>
              <ul className="space-y-1.5">
                {agentInvites.map((invite) => (
                  <li key={invite.id}>
                    <button
                      onClick={() => openConfigure(invite.id)}
                      className="flex w-full cursor-pointer items-center justify-between rounded-md bg-subtle px-3 py-2 text-left hover:bg-subtle-hover"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-body">
                          {invite.name}
                        </div>
                        <div className="text-xs text-muted">
                          {invite.provider === "claude" ? "Claude" : "Codex"}
                        </div>
                      </div>
                      <span className="ml-2 flex shrink-0 items-center gap-1.5 text-xs text-muted">
                        <span className={`h-2 w-2 rounded-full ${runtimeHealthDot(invite.runtime)}`} />
                        {runtimeHealthLabel(invite.runtime)}
                      </span>
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

function InstructionsField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase"
      >
        Instructions
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={5}
        maxLength={20000}
        className="w-full resize-none rounded-md border border-divider bg-input px-3 py-2 text-sm text-body outline-none focus:ring-2 focus:ring-accent"
      />
    </div>
  );
}

function HarnessOption({
  label,
  note,
  selected,
  disabled,
  title,
}: {
  label: string;
  note?: string;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div
      title={title}
      className={`flex-1 rounded-md px-3 py-2 text-center text-sm font-medium select-none ${
        selected
          ? "bg-accent text-on-accent"
          : "border border-divider bg-input text-muted"
      } ${disabled ? "opacity-50" : ""}`}
    >
      {label}
      {note && <span className="ml-1 text-xs opacity-60">{note}</span>}
    </div>
  );
}

function CreateStep({
  name,
  onNameChange,
  nameValid,
  instructions,
  onInstructionsChange,
  creating,
  error,
  onSubmit,
}: {
  name: string;
  onNameChange: (value: string) => void;
  nameValid: boolean;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  creating: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <>
      <div className="mb-4">
        <label className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase">
          Harness
        </label>
        <div className="flex gap-2">
          <HarnessOption label="Claude" selected />
          <HarnessOption
            label="Codex"
            note="(coming soon)"
            disabled
            title="Not available yet — the runner rejects Codex agents with CODEX_ADAPTER_UNAVAILABLE."
          />
        </div>
      </div>

      <div className="mb-4">
        <label
          htmlFor="agent-name"
          className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase"
        >
          Agent name
        </label>
        <input
          id="agent-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
          maxLength={32}
          placeholder="e.g. claude-helper"
          className="w-full rounded-md border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-accent"
        />
        <p className="mt-1 text-xs text-faint">
          1-32 characters: letters, digits, spaces, - and _
        </p>
      </div>

      <InstructionsField id="agent-instructions" value={instructions} onChange={onInstructionsChange} />

      {error && (
        <p className="mb-4 rounded-md border-l-4 border-dead bg-subtle px-3 py-2 text-sm text-dead" role="alert">
          {error}
        </p>
      )}

      <button
        onClick={onSubmit}
        disabled={!nameValid || creating}
        className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {creating ? "Creating…" : "Create agent"}
      </button>
    </>
  );
}

function PairStep({
  agent,
  pairingCode,
  apiUrl,
  onContinue,
}: {
  agent: AgentSummary;
  pairingCode: string | null;
  apiUrl: string;
  onContinue: () => void;
}) {
  const cliCommand = pairingCode ? pairCommand(apiUrl, pairingCode) : "";
  const prompt = pairingCode ? setupPrompt(apiUrl, pairingCode, agent.name) : "";

  const diagnostic = diagnosticMessage(agent.runtime.diagnosticCode);
  let statusText: string;
  let statusClass: string;
  if (!agent.runtime.connected) {
    statusText = "Waiting for the agent to connect…";
    statusClass = "border-away text-muted";
  } else if (agent.runtime.health === "dormant") {
    // Pairing succeeded; the harness just has not been woken yet. Showing this
    // as a fault would make a correct first-run look broken.
    statusText = "Paired and connected — asleep until you activate it.";
    statusClass = "border-away text-muted";
  } else if (agent.runtime.health === "checking") {
    statusText = "Connected — running preflight checks…";
    statusClass = "border-away text-muted";
  } else if (agent.runtime.health === "ready") {
    statusText = "Connected and ready.";
    statusClass = "border-online text-online";
  } else {
    statusText = `${runtimeHealthLabel(agent.runtime)}${diagnostic ? ` — ${diagnostic}` : ""}`;
    statusClass = "border-dead text-dead";
  }

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        Paste this into Claude Code, Cursor, Codex, or any coding agent on this computer.
        It pairs <span className="text-body">{agent.name}</span> locally. Your subscription stays
        on this machine — Convyio never sees that login. Folders are attached later with Toolman.
      </p>

      {pairingCode && (
        <div className="mb-4 space-y-3">
          <SetupPromptCard value={prompt} />
          <div>
            <p className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
              Or run it yourself
            </p>
            <div className="space-y-2">
              <PairingCopyRow label="CLI" value={cliCommand} />
              <PairingCopyRow label="Pairing code" value={pairingCode} />
            </div>
          </div>
        </div>
      )}

      <div className={`mb-4 rounded-md border-l-4 bg-subtle px-3 py-2 text-sm ${statusClass}`}>
        {statusText}
      </div>

      {/* Any connected runner may continue, not just a healthy one: the
          configure step is where an auth_required or degraded runner gets
          fixed, and it is useless before the runner has reported its options. */}
      <button
        onClick={onContinue}
        disabled={!agent.runtime.connected}
        className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue
      </button>
    </>
  );
}

function isModelSelectOption(
  option: RunnerConfigOption,
): option is Extract<RunnerConfigOption, { kind: "select" }> {
  return option.category === "model" && option.kind === "select";
}

function ConfigureStep({
  agent,
  participants,
  apiFetch,
  onSave,
  onRepair,
  onRevoke,
  canActivate,
  onSetActive,
}: {
  agent: AgentSummary;
  participants: Participant[];
  apiFetch: (path: string, init?: RequestInit) => Promise<Response> | null;
  onSave: (fields: {
    instructions: string;
    model: string | null;
    access: AgentAccessPolicy;
  }) => Promise<boolean>;
  onRepair: () => void;
  onRevoke: () => void;
  canActivate: boolean;
  onSetActive: (active: boolean) => void;
}) {
  const [instructions, setInstructions] = useState(agent.instructions);
  const [model, setModel] = useState(agent.requestedModel ?? "");
  const [access, setAccess] = useState<AgentAccessPolicy>(agent.access);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [resourceAccess, setResourceAccess] = useState<{
    manifest: AgentResourceManifest;
    grants: AgentResourceGrant[];
    requests: AgentResourceAccessRequest[];
  } | null>(null);

  const refreshResourceAccess = async () => {
    const request = apiFetch(`/api/agents/${encodeURIComponent(agent.actorId)}/resource-access`);
    if (!request) return;
    const response = await request;
    if (response.ok) setResourceAccess(await response.json());
  };

  useEffect(() => {
    void refreshResourceAccess();
  }, [agent.actorId]);

  const resolveResourceRequest = async (requestId: string, decision: "approved" | "denied") => {
    const request = apiFetch(`/api/agent-context/access-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (request && (await request).ok) await refreshResourceAccess();
  };

  const revokeResourceGrant = async (grantId: string) => {
    const request = apiFetch(
      `/api/agents/${encodeURIComponent(agent.actorId)}/resource-grants/${encodeURIComponent(grantId)}`,
      { method: "DELETE" },
    );
    if (request && (await request).ok) await refreshResourceAccess();
  };

  const modelOption = agent.runtime.options.find(isModelSelectOption);
  const modelFallback =
    agent.requestedModel !== null &&
    agent.runtime.effectiveModel !== undefined &&
    agent.runtime.effectiveModel !== agent.requestedModel;

  const humans = participants.filter((p) => p.kind === "human");

  const dirty =
    instructions !== agent.instructions ||
    model !== (agent.requestedModel ?? "") ||
    access.mode !== agent.access.mode ||
    JSON.stringify([...access.selectedActorIds].sort()) !==
      JSON.stringify([...agent.access.selectedActorIds].sort());

  const save = async () => {
    setSaving(true);
    setSaved(false);
    const ok = await onSave({ instructions, model: model === "" ? null : model, access });
    setSaving(false);
    if (ok) {
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    }
  };

  const toggleSelected = (actorId: string) => {
    setAccess((prev) => ({
      mode: "selected",
      selectedActorIds: prev.selectedActorIds.includes(actorId)
        ? prev.selectedActorIds.filter((id) => id !== actorId)
        : [...prev.selectedActorIds, actorId],
    }));
  };

  const diagnostic = diagnosticMessage(agent.runtime.diagnosticCode);
  const asleep = agent.runtime.health === "dormant";

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-muted">
            {agent.runtime.harness
              ? `${agent.runtime.harness.id} v${agent.runtime.harness.version}`
              : "Harness not yet connected"}
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-xs">
            <span className={`h-2 w-2 rounded-full ${runtimeHealthDot(agent.runtime)}`} />
            <span className="text-muted">{runtimeHealthLabel(agent.runtime)}</span>
            {diagnostic && <span className="text-faint">— {diagnostic}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {canActivate && agent.runtime.connected && (
            <button
              onClick={() => onSetActive(asleep)}
              className="cursor-pointer rounded-md border border-subtle px-2.5 py-1 text-xs font-medium text-body hover:bg-subtle"
            >
              {asleep ? "Activate" : "Put to sleep"}
            </button>
          )}
          <button
            onClick={onRepair}
            className="cursor-pointer text-xs font-medium text-accent hover:underline"
          >
            Re-pair
          </button>
        </div>
      </div>

      {asleep && (
        <p className="mb-4 rounded-md border-l-4 border-away bg-subtle px-3 py-2 text-sm text-muted">
          {canActivate
            ? "This agent is connected but its local harness is not running. Activate it to start working."
            : "This agent is asleep. Only the person who created it can activate it."}
        </p>
      )}

      <InstructionsField id="agent-instructions-edit" value={instructions} onChange={setInstructions} />

      <div className="mb-4">
        <label
          htmlFor="agent-model"
          className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase"
        >
          Model
        </label>
        <select
          id="agent-model"
          value={model}
          disabled={!modelOption}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded-md border border-divider bg-input px-3 py-2 text-body outline-none focus:ring-2 focus:ring-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <option value="">Harness default</option>
          {modelOption?.choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        {!modelOption && (
          <p className="mt-1 text-xs text-faint">
            Becomes available once the agent connects.
          </p>
        )}
        {modelOption && modelFallback && (
          <p className="mt-1 text-xs text-away">
            Requested model unavailable — running on the harness default (
            {agent.runtime.effectiveModel}).
          </p>
        )}
      </div>

      <div className="mb-4">
        <div className="mb-1 text-[10px] font-bold tracking-wider text-muted uppercase">
          Resources and permissions
        </div>
        <div className="rounded-md border border-divider bg-subtle p-2.5">
          <div className="mb-2 text-xs text-muted">
            Board, platform policy, and workspace guidance are always available.
          </div>
          {!resourceAccess && <div className="text-xs text-faint">Loading access…</div>}
          {resourceAccess && (
            <ul className="space-y-2">
              {resourceAccess.manifest.resources
                .filter((resource) => resource.access !== "default")
                .map((resource) => {
                  const grant = resourceAccess.grants.find(
                    (candidate) => candidate.resourceKind === resource.kind && candidate.resourceId === resource.id,
                  );
                  const pending = resourceAccess.requests.find(
                    (candidate) =>
                      candidate.status === "pending" &&
                      candidate.resourceKind === resource.kind &&
                      candidate.resourceId === resource.id,
                  );
                  return (
                    <li key={`${resource.kind}:${resource.id}`} className="flex items-start justify-between gap-2 text-xs">
                      <div className="min-w-0">
                        <div className="truncate font-medium text-body">{resource.name}</div>
                        <div className="text-muted">
                          {resource.kind.replace("_", " ")} · {resource.access === "none" ? "No access" : resource.access}
                        </div>
                        {grant?.grantedByName && <div className="text-faint">Granted by {grant.grantedByName}</div>}
                      </div>
                      {pending ? (
                        <div className="flex shrink-0 gap-2">
                          <button
                            onClick={() => void resolveResourceRequest(pending.id, "approved")}
                            className="cursor-pointer font-medium text-accent hover:underline"
                          >
                            Allow
                          </button>
                          <button
                            onClick={() => void resolveResourceRequest(pending.id, "denied")}
                            className="cursor-pointer text-muted hover:text-body"
                          >
                            Deny
                          </button>
                        </div>
                      ) : grant ? (
                        <button
                          onClick={() => void revokeResourceGrant(grant.id)}
                          className="shrink-0 cursor-pointer text-muted hover:text-dead"
                        >
                          Revoke
                        </button>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      </div>

      <div className="mb-4">
        <label
          htmlFor="agent-access"
          className="mb-1 block text-[10px] font-bold tracking-wider text-muted uppercase"
        >
          Who can direct this agent
        </label>
        <select
          id="agent-access"
          value={access.mode}
          onChange={(e) => {
            const mode = e.target.value as AgentAccessMode;
            setAccess({
              mode,
              selectedActorIds: mode === "selected" ? access.selectedActorIds : [],
            });
          }}
          className="w-full rounded-md border border-divider bg-input px-3 py-2 text-body outline-none focus:ring-2 focus:ring-accent"
        >
          <option value="workspace">Anyone in the workspace</option>
          <option value="creator">Only the person who added it</option>
          <option value="selected">Selected members</option>
        </select>
        {access.mode === "selected" && (
          <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-md border border-divider p-1.5">
            {humans.length === 0 && (
              <li className="px-1.5 py-1 text-xs text-faint">No other members yet</li>
            )}
            {humans.map((human) => (
              <li key={human.id}>
                <label className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-body hover:bg-subtle-hover">
                  <input
                    type="checkbox"
                    checked={access.selectedActorIds.includes(human.id)}
                    onChange={() => toggleSelected(human.id)}
                  />
                  {human.name}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="flex-1 rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? "Saving…" : saved ? "Saved" : "Save changes"}
        </button>
        <button
          onClick={onRevoke}
          className="shrink-0 cursor-pointer rounded-md px-3 py-2.5 text-sm font-medium text-dead transition hover:bg-dead hover:text-on-accent"
        >
          Revoke
        </button>
      </div>
    </>
  );
}
