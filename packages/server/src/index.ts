import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import type { AgentInvite } from "@workspace/shared";
import { config } from "./config";
import { createStaticSite } from "./staticSite";
import { Hub } from "./hub";
import { Roster } from "./roster";
import { WorkspaceDb } from "./db";
import { Attachments } from "./chat/Attachments";
import { Channels } from "./chat/Channels";
import { AgentWorkStore } from "./chat/AgentWorkStore";
import { MessageStore } from "./chat/MessageStore";
import { InteractionStore } from "./chat/InteractionStore";
import { ThreadEventStore } from "./chat/ThreadEventStore";
import { Auth } from "./auth/Auth";
import { AgentInvites } from "./auth/AgentInvites";
import { createJoinGate } from "./auth/joinPolicy";
import { BoardService } from "./board/BoardService";
import { PlanService } from "./board/PlanService";
import { Toolman } from "./board/Toolman";
import { Sessions } from "./board/sessions";
import { createApiHandler, type AuthGate } from "./board/api";
import { loadDemoScripts } from "./demo/script";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";
import { RunnerRuntime } from "./RunnerRuntime";
import { assertSchemaCurrent, SchemaOutOfDateError } from "./schemaCheck";
import { ContextStore } from "./context/ContextStore";
import { ContextCursorStore } from "./context/ContextCursorStore";
import { WorkspaceSnapshotBuilder } from "./context/WorkspaceSnapshot";
import { PromptEnvelopeBuilder } from "./context/PromptEnvelope";
import { GitHub } from "./projects/GitHub";
import { ProjectStore } from "./projects/ProjectStore";
import { ToolmanNodes } from "./projects/ToolmanNodes";
import { ToolmanGateway } from "./projects/ToolmanGateway";
import { ToolExecutionStore } from "./projects/ToolExecutionStore";
import { AccountStore } from "./auth/AccountStore";
import { WorkspaceAccess } from "./auth/WorkspaceAccess";
import { WorkspaceRegistry } from "./WorkspaceRegistry";

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);
/** A `tsx watch` restart releases the port in well under a second. */
const LISTEN_RETRIES = 10;
const LISTEN_RETRY_MS = 300;

async function main() {
  const db = await WorkspaceDb.create(config.supabaseDbUrl);
  // Refuse to serve on a schema the code does not match: the alternative is
  // starting fine and then failing feature by feature, which reads as an
  // unexplained hang in the browser rather than as a missing migration.
  await assertSchemaCurrent(db.sql, MIGRATIONS_DIR);
  const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);
  const accounts = new AccountStore(db.sql);
  const workspaceAccess = new WorkspaceAccess(db.sql, accounts);
  const github = new GitHub(db.sql, config.github);
  const sessions = new Sessions();
  const auth = config.googleAuthEnabled || config.emailAuthEnabled
    ? new Auth(accounts, supabase, workspaceAccess)
    : null;
  const authGate: AuthGate | null = auth
    ? {
        googleAuthEnabled: config.googleAuthEnabled,
        emailAuthEnabled: config.emailAuthEnabled,
        auth,
      }
    : null;
  if (config.googleAuthEnabled) console.log("[auth] Google sign-in enabled");
  if (config.emailAuthEnabled) console.log("[auth] Email sign-in enabled");
  if (!auth) console.warn("[auth] no sign-in method configured: all joins will be refused");
  if (auth && !config.agentToken) {
    console.warn("[auth] AGENT_TOKEN is not set: no server-owned agent can join the legacy workspace");
  }

  const scripts = await loadDemoScripts(path.join(ASSETS_DIR, "demo/scripts"));
  const registry = new WorkspaceRegistry(
    db,
    sessions,
    auth,
    config.agentToken,
    supabase,
    github,
    config.dataDir,
    config.port,
    db.workspaceId,
    scripts,
    path.join(ASSETS_DIR, "demo/seed"),
  );
  const runtime = await registry.require(db.workspaceId);
  const handleApi = createApiHandler({
    db: runtime.db,
    service: runtime.board,
    sessions,
    messages: runtime.messages,
    threadEvents: runtime.threadEvents,
    channels: runtime.channels,
    attachments: runtime.attachments,
    corsOrigin: config.corsOrigin,
    authGate,
    hostedAgentToken: config.agentToken,
    agentInvites: runtime.agentInvites,
    runnerRuntime: runtime.runnerRuntime,
    onUpdateAgent: (profile) => runtime.updateAgent(profile),
    onRevokeAgent: (actorId) => {
      runtime.hub.closeAgentConnection(actorId);
      runtime.stopApiKeyAgent(actorId);
    },
    onCreateAgent: (invite, apiKey) => void runtime.startApiKeyAgent(invite, apiKey),
    onRemoveMember: (actorId) => {
      runtime.hub.closeAgentConnection(actorId);
      runtime.hub.closeHumanConnection(actorId);
    },
    onAddMember: (actorId) => void runtime.hub.addOfflineMember(actorId),
    snapshot: runtime.snapshot,
    plans: runtime.plans,
    envelope: runtime.envelope,
    context: runtime.context,
    github,
    gitRepositories: runtime.gitRepositories,
    projects: runtime.projects,
    toolmanNodes: runtime.toolmanNodes,
    toolmanGateway: runtime.toolmanGateway,
    executions: runtime.executions,
    accounts,
    workspaceAccess,
    workspaceRegistry: registry,
  });
  const staticSite = fs.existsSync(path.join(config.clientDist, "index.html"))
    ? createStaticSite(config.clientDist)
    : null;
  console.log(
    staticSite
      ? `[static] serving client from ${config.clientDist}`
      : `[static] no client build at ${config.clientDist}; API only`,
  );
  const server = http.createServer(async (req, res) => {
    if (await handleApi(req, res)) return;
    if (staticSite && (await staticSite(req, res))) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });

  registry.attach(server);

  // A listen failure arrives as an event, not a rejection, so without a
  // handler the process dies with an unhandled 'error' and no usable message —
  // and the browser is left spinning on "Connecting…" with nothing to read.
  //
  // EADDRINUSE is usually not a real conflict under `tsx watch`: the previous
  // process is still releasing the port ("Previous process hasn't exited yet").
  // Retry briefly, then say plainly what is holding it.
  let listenAttempts = 0;
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && ++listenAttempts <= LISTEN_RETRIES) {
      setTimeout(() => server.listen(config.port), LISTEN_RETRY_MS);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(
        `[server] fatal: port ${config.port} is still in use after ` +
          `${LISTEN_RETRIES} retries — another server is running. ` +
          `Stop it with: lsof -ti:${config.port} | xargs kill`,
      );
    } else {
      console.error("[server] fatal: could not listen:", err.message);
    }
    process.exit(1);
  });

  server.listen(config.port, () => {
    console.log(
      `[hub] listening on ws://localhost:${config.port} (http api on http://localhost:${config.port})`,
    );
  });
}

main().catch((err) => {
  // A schema mismatch is a setup problem with a known fix, not a crash to
  // debug: print the instruction, not a stack trace.
  if (err instanceof SchemaOutOfDateError) console.error(`[server] fatal: ${err.message}`);
  else console.error("[server] fatal:", err);
  process.exit(1);
});
