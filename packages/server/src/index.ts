import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { config } from "./config";
import { createStaticSite } from "./staticSite";
import { Hub } from "./hub";
import { Roster } from "./roster";
import { WorkspaceDb } from "./db";
import { Attachments } from "./chat/Attachments";
import { Channels } from "./chat/Channels";
import { MessageStore } from "./chat/MessageStore";
import { Auth } from "./auth/Auth";
import { createJoinGate } from "./auth/joinPolicy";
import { BoardService } from "./board/BoardService";
import { Toolman } from "./board/Toolman";
import { Sessions } from "./board/sessions";
import { createApiHandler, type AuthGate } from "./board/api";
import { loadDemoScripts } from "./demo/script";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

async function main() {
  const db = await WorkspaceDb.create(config.supabaseDbUrl);
  const messages = new MessageStore(db);
  const service = new BoardService(db);
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
  const handleApi = createApiHandler(
    db,
    service,
    sessions,
    messages,
    channels,
    attachments,
    config.corsOrigin,
    authGate,
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

  const roster = await Roster.create(db);
  const hub = new Hub(server, roster, messages, channels, attachments, sessions, toolman, {
    serverId: db.serverId,
    demoChannels,
    // Unconfigured is not guest mode here: refuse every join rather than
    // trust self-declared names (the Hub's own undefined-gate fallback is
    // for tests that build it directly, never for the running server).
    authorizeJoin: authGate
      ? createJoinGate(authGate.auth, config.agentToken)
      : async () => ({ ok: false }),
  });
  service.onEvent = (envelope) => hub.broadcastBoardEvent(envelope);
  channels.onCreated = (name) => hub.broadcastChannelCreated(name);
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

  server.listen(config.port, () => {
    console.log(
      `[hub] listening on ws://localhost:${config.port} (http api on http://localhost:${config.port})`,
    );
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
