import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 3001),
  dataDir: process.env.DATA_DIR ?? path.resolve(__dirname, "../../../data"),
  serverName: process.env.SERVER_NAME ?? "Workspace HQ",
  channelName: "general",
};
