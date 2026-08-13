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
import { Toolman } from "./board/Toolman";
import { Sessions } from "./board/sessions";
import { createApiHandler, type AuthGate } from "./board/api";
import { loadDemoScripts } from "./demo/script";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";
import { RunnerRuntime } from "./RunnerRuntime";
import { assertSchemaCurrent, SchemaOutOfDateError } from "./schemaCheck";

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
  const threadEvents = new ThreadEventStore(db);
  const messages = new MessageStore(db, threadEvents);
  const agentWork = new AgentWorkStore(db, threadEvents, messages);
  const service = new BoardService(db, threadEvents);
  const interactions = new InteractionStore(db, threadEvents);
  // Prompts from a previous process have no waiter left to answer them. This
  // is tidying, not a precondition: a transient database hiccup here must not
  // stop the server from listening, or the whole workspace is down over stale
  // rows that the next mutation would re-request anyway.
  interactions.expireStale(db.workspaceId).catch((err: unknown) => {
    console.warn(
      "[hub] could not expire stale permission prompts:",
      err instanceof Error ? err.message : err,
    );
  });
  const sessions = new Sessions();
  const workspaceDir = path.join(config.dataDir, "workspace");
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();

  const scripts = await loadDemoScripts(path.join(ASSETS_DIR, "demo/scripts"));
  const demoChannels = [...scripts.keys()].sort();
  const channels = new Channels(db);
  await channels.seed([
    { name: "general", isDemo: false },
    ...demoChannels.map((name) => ({ name, isDemo: true })),
  ]);

  const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey);

  let authGate: AuthGate | null = null;
  if (config.googleAuthEnabled || config.emailAuthEnabled) {
    authGate = {
      googleAuthEnabled: config.googleAuthEnabled,
      emailAuthEnabled: config.emailAuthEnabled,
      auth: new Auth(db, supabase),
    };
    if (config.googleAuthEnabled) console.log("[auth] Google sign-in enabled");
    if (config.emailAuthEnabled) console.log("[auth] Email sign-in enabled");
    if (!config.agentToken) {
      console.warn("[auth] AGENT_TOKEN is not set: no agent can join this server");
    }
  } else {
    console.warn("[auth] no sign-in method configured: all joins will be refused");
  }

  const attachments = new Attachments(db, supabase);
  const agentInvites = new AgentInvites(db);
  const runnerRuntime = new RunnerRuntime();
  const agentConfigUpdater: { update?: (profile: AgentInvite) => void } = {};
  const agentRevoker: { close?: (actorId: string) => void } = {};
  const memberRemover: { close?: (actorId: string) => void } = {};
  const handleApi = createApiHandler(
    db,
    service,
    sessions,
    messages,
    threadEvents,
    channels,
    attachments,
    config.corsOrigin,
    authGate,
    agentInvites,
    runnerRuntime,
    (profile) => agentConfigUpdater.update?.(profile),
    (actorId) => agentRevoker.close?.(actorId),
    (actorId) => memberRemover.close?.(actorId),
  );
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

  const roster = await Roster.create(db, agentInvites);
  const hub = new Hub(
    server,
    roster,
    messages,
    agentWork,
    channels,
    attachments,
    sessions,
    toolman,
    interactions,
    runnerRuntime,
    {
      workspace: { id: db.workspaceId, name: db.workspaceName },
      demoChannels,
      // Unconfigured is not guest mode here: refuse every join rather than
      // trust self-declared names (the Hub's own undefined-gate fallback is
      // for tests that build it directly, never for the running server).
      authorizeJoin: authGate
        ? createJoinGate(authGate.auth, config.agentToken, agentInvites)
        : async () => ({ ok: false }),
      authorizeAgentWork: (agentId, authorId) => agentInvites.allowsAuthor(agentId, authorId),
    },
  );
  agentConfigUpdater.update = (profile) => hub.updateAgentConfig(profile);
  agentRevoker.close = (actorId) => hub.closeAgentConnection(actorId);
  memberRemover.close = (actorId) => hub.closeHumanConnection(actorId);
  service.onEvent = (envelope) => hub.broadcastBoardEvent(envelope);
  channels.onCreated = (channel) => hub.broadcastChannelCreated(channel);
  channels.onRenamed = (oldName, newName) => hub.broadcastChannelRenamed(oldName, newName);
  channels.onArchived = (name, archived) => hub.broadcastChannelArchived(name, archived);
  channels.onPinned = (name, pinned) => hub.broadcastChannelPinned(name, pinned);
  channels.onDeleted = (name) => hub.broadcastChannelDeleted(name);
  new DemoOrchestrator(
    hub,
    roster,
    db,
    service,
    workspaceDir,
    path.join(ASSETS_DIR, "demo/seed"),
    scripts,
  );

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
