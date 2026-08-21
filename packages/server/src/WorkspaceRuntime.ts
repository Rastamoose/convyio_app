import { createHash } from "node:crypto";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentInvite } from "@workspace/shared";
import { AgentInvites } from "./auth/AgentInvites";
import type { Auth } from "./auth/Auth";
import { createJoinGate } from "./auth/joinPolicy";
import { BoardService } from "./board/BoardService";
import { PlanService } from "./board/PlanService";
import { Sessions } from "./board/sessions";
import { Toolman } from "./board/Toolman";
import { AgentWorkStore } from "./chat/AgentWorkStore";
import { Attachments } from "./chat/Attachments";
import { Channels } from "./chat/Channels";
import { InteractionStore } from "./chat/InteractionStore";
import { MessageStore } from "./chat/MessageStore";
import { ThreadEventStore } from "./chat/ThreadEventStore";
import { ContextCursorStore } from "./context/ContextCursorStore";
import { ContextStore } from "./context/ContextStore";
import { PromptEnvelopeBuilder } from "./context/PromptEnvelope";
import { WorkspaceSnapshotBuilder } from "./context/WorkspaceSnapshot";
import { WorkspaceDb } from "./db";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";
import type { DemoScript } from "./demo/script";
import { Hub } from "./hub";
import { GitRepositories } from "./projects/GitRepositories";
import type { GitHub } from "./projects/GitHub";
import { ProjectStore } from "./projects/ProjectStore";
import { ToolExecutionStore } from "./projects/ToolExecutionStore";
import { ToolmanGateway } from "./projects/ToolmanGateway";
import { ToolmanNodes } from "./projects/ToolmanNodes";
import { Roster } from "./roster";
import { RunnerRuntime } from "./RunnerRuntime";

export interface WorkspaceRuntimeOptions {
  db: WorkspaceDb;
  sessions: Sessions;
  auth: Auth | null;
  agentToken: string | null;
  supabase: SupabaseClient;
  github: GitHub;
  dataDir: string;
  demoScripts?: Map<string, DemoScript>;
  demoSeedRoot?: string;
}

export class WorkspaceRuntime {
  readonly db!: WorkspaceDb;
  readonly threadEvents!: ThreadEventStore;
  readonly messages!: MessageStore;
  readonly agentWork!: AgentWorkStore;
  readonly plans!: PlanService;
  readonly board!: BoardService;
  readonly context!: ContextStore;
  readonly contextCursors!: ContextCursorStore;
  readonly projects!: ProjectStore;
  readonly gitRepositories!: GitRepositories;
  readonly toolmanNodes!: ToolmanNodes;
  readonly snapshot!: WorkspaceSnapshotBuilder;
  readonly envelope!: PromptEnvelopeBuilder;
  readonly interactions!: InteractionStore;
  readonly channels!: Channels;
  readonly attachments!: Attachments;
  readonly agentInvites!: AgentInvites;
  readonly runnerRuntime!: RunnerRuntime;
  readonly executions!: ToolExecutionStore;
  readonly toolman!: Toolman;
  readonly toolmanGateway!: ToolmanGateway;
  readonly roster!: Roster;
  readonly hub!: Hub;

  private constructor() {}

  static async create(options: WorkspaceRuntimeOptions): Promise<WorkspaceRuntime> {
    const db = options.db;
    const threadEvents = new ThreadEventStore(db);
    const messages = new MessageStore(db, threadEvents);
    const agentWork = new AgentWorkStore(db, threadEvents, messages);
    const channels = new Channels(db);
    const plans = new PlanService(db, threadEvents, channels);
    const board = new BoardService(db, threadEvents, plans, channels);
    const context = new ContextStore(db, threadEvents);
    const contextCursors = new ContextCursorStore(db, threadEvents);
    const workspaceDir = path.join(
      options.dataDir,
      "workspaces",
      createHash("sha256").update(db.workspaceId).digest("hex"),
    );
    const projects = new ProjectStore(db, threadEvents);
    const gitRepositories = new GitRepositories(
      db,
      threadEvents,
      projects,
      options.github,
      channels,
      path.join(workspaceDir, "repositories"),
    );
    await gitRepositories.init();
    const toolmanNodes = new ToolmanNodes(db, threadEvents);
    const snapshot = new WorkspaceSnapshotBuilder(db, board, plans, context, projects);
    const envelope = new PromptEnvelopeBuilder(snapshot, { id: db.workspaceId, name: db.workspaceName });
    const interactions = new InteractionStore(db, threadEvents);
    const demoScripts = options.demoScripts ?? new Map<string, DemoScript>();
    const demoChannels = [...demoScripts.keys()].sort();
    await channels.seed([
      { name: "general", isDemo: false },
      ...demoChannels.map((name) => ({ name, isDemo: true })),
    ]);
    const attachments = new Attachments(db, options.supabase);
    const agentInvites = new AgentInvites(db);
    const runnerRuntime = new RunnerRuntime();
    const executions = new ToolExecutionStore(db, threadEvents, options.supabase);
    const toolman = new Toolman(board, workspaceDir);
    await toolman.init();
    const roster = await Roster.create(db, agentInvites);
    const toolmanGateway = new ToolmanGateway(null, toolmanNodes, projects);
    const hub = new Hub(
      null,
      roster,
      messages,
      agentWork,
      channels,
      attachments,
      options.sessions,
      toolman,
      interactions,
      runnerRuntime,
      {
        workspace: { id: db.workspaceId, name: db.workspaceName },
        demoChannels,
        authorizeJoin: options.auth
          ? createJoinGate(options.auth, db.workspaceId, options.agentToken, agentInvites, db)
          : async () => ({ ok: false }),
        authorizeAgentWork: (agentId, authorId) => agentInvites.allowsAuthor(agentId, authorId),
        threadEvents,
        contextCursors,
        projects,
        gitRepositories,
        toolmanGateway,
        executions,
      },
    );
    const runtime = new WorkspaceRuntime();
    Object.assign(runtime, {
      db,
      threadEvents,
      messages,
      agentWork,
      plans,
      board,
      context,
      contextCursors,
      projects,
      gitRepositories,
      toolmanNodes,
      snapshot,
      envelope,
      interactions,
      channels,
      attachments,
      agentInvites,
      runnerRuntime,
      executions,
      toolman,
      toolmanGateway,
      roster,
      hub,
    });
    board.onEvent = (event) => hub.broadcastBoardEvent(event);
    plans.onEvent = (event) => hub.broadcastPlanEvent(event);
    channels.onCreated = (channel) => hub.broadcastChannelCreated(channel);
    channels.onRenamed = (oldName, newName) => hub.broadcastChannelRenamed(oldName, newName);
    channels.onArchived = (name, archived) => hub.broadcastChannelArchived(name, archived);
    channels.onPinned = (name, pinned) => hub.broadcastChannelPinned(name, pinned);
    channels.onDeleted = (name) => hub.broadcastChannelDeleted(name);
    channels.onSectionCreated = (section) => hub.broadcastChannelSectionCreated(section);
    channels.onMoved = (name, sectionId) => hub.broadcastChannelMoved(name, sectionId);
    await interactions.expireStale(db.workspaceId).catch((error: unknown) => {
      console.warn(
        `[workspace ${db.workspaceId}] could not expire stale permission prompts:`,
        error instanceof Error ? error.message : error,
      );
    });
    if (options.demoSeedRoot && demoScripts.size > 0) {
      new DemoOrchestrator(
        hub,
        roster,
        db,
        board,
        plans,
        workspaceDir,
        options.demoSeedRoot,
        demoScripts,
      );
    }
    return runtime;
  }

  updateAgent(profile: AgentInvite): void {
    this.hub.updateAgentConfig(profile);
  }

  async close(): Promise<void> {
    await Promise.all([this.hub.close(), this.toolmanGateway.close()]);
  }
}
