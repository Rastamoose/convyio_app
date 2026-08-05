import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config";
import { Hub } from "./hub";
import { Roster } from "./roster";
import { WorkspaceDb } from "./db";
import { Attachments } from "./chat/Attachments";
import { Channels } from "./chat/Channels";
import { MessageStore } from "./chat/MessageStore";
import { BoardService } from "./board/BoardService";
import { Toolman } from "./board/Toolman";
import { Sessions } from "./board/sessions";
import { createApiHandler } from "./board/api";
import { loadDemoScripts } from "./demo/script";
import { DemoOrchestrator } from "./demo/DemoOrchestrator";

const ASSETS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets");

async function main() {
  const db = new WorkspaceDb(path.join(config.dataDir, "board.db"));
  const messages = new MessageStore(db);
  messages.importLegacyJson(config.dataDir);
  const service = new BoardService(db);
  const sessions = new Sessions();
  const workspaceDir = path.join(config.dataDir, "workspace");
  const toolman = new Toolman(service, workspaceDir);
  await toolman.init();

  const scripts = await loadDemoScripts(path.join(ASSETS_DIR, "demo/scripts"));
  const demoChannels = [...scripts.keys()].sort();
  const channels = new Channels(db);
  channels.seed([
    { name: "general", isDemo: false },
    ...demoChannels.map((name) => ({ name, isDemo: true })),
  ]);

  const attachments = new Attachments(db, path.join(config.dataDir, "uploads"));
  const handleApi = createApiHandler(db, service, sessions, channels, attachments, config.corsOrigin);
  const server = http.createServer(async (req, res) => {
    const handled = await handleApi(req, res);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
    }
  });

  const roster = new Roster(db);
  const apiUrl = `http://localhost:${config.port}`;
  const hub = new Hub(server, roster, messages, channels, attachments, sessions, toolman, {
    apiUrl,
    serverId: db.serverId,
    demoChannels,
  });
  service.onEvent = (envelope) => hub.broadcastBoardEvent(envelope);
  channels.onCreated = (name) => hub.broadcastChannelCreated(name);
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
    console.log(`[hub] listening on ws://localhost:${config.port} (http api on ${apiUrl})`);
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
