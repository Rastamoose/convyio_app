import http from "node:http";
import path from "node:path";
import { config } from "./config";
import { Hub } from "./hub";
import { JsonStorage } from "./storage/JsonStorage";
import { BoardDb } from "./board/db";
import { BoardService } from "./board/BoardService";
import { Toolman } from "./board/Toolman";
import { Sessions, createApiHandler } from "./board/api";
import { DemoRunner } from "./demo/DemoRunner";

async function main() {
  const storage = new JsonStorage(config.dataDir);
  await storage.init();

  const db = new BoardDb(path.join(config.dataDir, "board.db"));
  const service = new BoardService(db);
  const sessions = new Sessions();
  const toolman = new Toolman(service, path.join(config.dataDir, "workspace"));
  await toolman.init();

  const handleApi = createApiHandler(db, service, sessions);
  const server = http.createServer(async (req, res) => {
    const handled = await handleApi(req, res);
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "NOT_FOUND" }));
    }
  });

  const apiUrl = `http://localhost:${config.port}`;
  const hub = new Hub(server, storage, db, sessions, toolman, apiUrl);
  service.onEvent = (envelope) => hub.broadcastBoardEvent(envelope);
  new DemoRunner(hub, db, service, path.join(config.dataDir, "workspace"));

  server.listen(config.port, () => {
    console.log(`[hub] listening on ws://localhost:${config.port} (http api on ${apiUrl})`);
  });
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
