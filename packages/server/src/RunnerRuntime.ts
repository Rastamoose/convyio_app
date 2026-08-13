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

  connect(profile: AgentInvite): void {
    this.states.set(profile.actorId, {
      connected: true,
      health: "checking",
      configRevision: profile.configRevision,
      options: [],
      expectedHarness: profile.provider,
      helloCompatible: false,
    });
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
  }
}
