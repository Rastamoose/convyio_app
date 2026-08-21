import {
  RUNNER_PROTOCOL_VERSION,
  type AgentInvite,
  type AgentRuntimeSummary,
  type RunnerHelloEvent,
  type RunnerStatusEvent,
} from "@workspace/shared";

interface RuntimeState extends AgentRuntimeSummary {
  expectedHarness: string;
  helloCompatible: boolean;
  workSentRevision?: number;
}

export class RunnerRuntime {
  private states = new Map<string, RuntimeState>();
  /** Creators who have woken their runner. Deliberately outlives `clear()`
   *  so a crash-restart or a laptop re-login comes back in the state its
   *  creator chose, rather than silently falling asleep again.
   *  ponytail: in-memory, so a *server* restart drops everyone to dormant —
   *  move to a column on agent_invites if that turns out to matter. */
  private activated = new Set<string>();

  connect(profile: AgentInvite): void {
    this.states.set(profile.actorId, {
      connected: true,
      health: this.activated.has(profile.actorId) ? "checking" : "dormant",
      configRevision: profile.configRevision,
      options: [],
      expectedHarness: profile.provider,
      helloCompatible: false,
    });
  }

  /** True once the creator has activated this runner and not put it back to sleep. */
  isActivated(actorId: string): boolean {
    return this.activated.has(actorId);
  }

  setActivated(actorId: string, active: boolean): void {
    if (active) this.activated.add(actorId);
    else this.activated.delete(actorId);
    const state = this.states.get(actorId);
    if (!state) return;
    // Reflect the intent immediately so the roster stops advertising a
    // just-slept runner as available before its status frame lands.
    state.health = active ? "checking" : "dormant";
    state.diagnosticCode = undefined;
    if (!active) state.workSentRevision = undefined;
  }

  /** Drop activation intent for an agent that is gone for good (revoked/removed). */
  forget(actorId: string): void {
    this.activated.delete(actorId);
    this.states.delete(actorId);
  }

  hello(actorId: string, event: RunnerHelloEvent): void {
    const state = this.states.get(actorId);
    if (!state) return;
    state.protocolVersion = event.protocolVersion;
    state.harness = event.harness;
    state.options = event.options;
    state.effectiveModel = undefined;
    const protocolMatches = event.protocolVersion === RUNNER_PROTOCOL_VERSION;
    const harnessMatches = event.harness.id === state.expectedHarness;
    state.helloCompatible = protocolMatches && harnessMatches;
    if (state.helloCompatible) {
      state.health = "checking";
      state.diagnosticCode = undefined;
    } else {
      state.health = "incompatible";
      state.diagnosticCode = protocolMatches ? "HARNESS_MISMATCH" : "PROTOCOL_UNSUPPORTED";
    }
  }

  status(actorId: string, event: RunnerStatusEvent): boolean {
    const state = this.states.get(actorId);
    if (!state || event.configRevision !== state.configRevision || !state.helloCompatible) return false;
    // Activation is a permission barrier, not a hint: without this a runner
    // that was never woken could announce itself ready and start taking work,
    // leaving the creator's approval advisory.
    if (!this.activated.has(actorId)) return false;
    state.health = event.health;
    state.effectiveModel = event.effectiveModel;
    state.diagnosticCode = event.diagnosticCode;
    if (!this.isAvailable(actorId) || state.workSentRevision === state.configRevision) return false;
    state.workSentRevision = state.configRevision;
    return true;
  }

  update(profile: AgentInvite): void {
    const state = this.states.get(profile.actorId);
    if (!state) return;
    state.configRevision = profile.configRevision;
    state.expectedHarness = profile.provider;
    state.health = "checking";
    state.effectiveModel = undefined;
    state.diagnosticCode = undefined;
  }

  isAvailable(actorId: string): boolean {
    const health = this.states.get(actorId)?.health;
    return health === undefined || health === "ready" || health === "degraded";
  }

  summary(actorId: string, configRevision: number): AgentRuntimeSummary {
    const state = this.states.get(actorId);
    if (!state) return { connected: false, health: "checking", configRevision, options: [] };
    const {
      expectedHarness: _expectedHarness,
      helloCompatible: _helloCompatible,
      workSentRevision: _workSentRevision,
      ...summary
    } = state;
    return {
      ...summary,
      harness: summary.harness ? { ...summary.harness } : undefined,
      options: summary.options.map((option) =>
        option.kind === "select"
          ? { ...option, choices: option.choices.map((choice) => ({ ...choice })) }
          : { ...option },
      ),
    };
  }

  clear(actorId: string): void {
    this.states.delete(actorId);
  }

  clearAll(): void {
    this.states.clear();
    this.activated.clear();
  }
}
