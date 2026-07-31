import { config } from "./config";
import { Hub } from "./hub";
import { JsonStorage } from "./storage/JsonStorage";
import { DemoRunner } from "./demo/DemoRunner";

async function main() {
  const storage = new JsonStorage(config.dataDir);
  await storage.init();
  const hub = new Hub(config.port, storage);
  new DemoRunner(hub);
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
