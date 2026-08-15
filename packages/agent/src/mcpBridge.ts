import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolDeclaration, ToolExecutor } from "./brain";

/**
 * Localhost MCP-ish HTTP bridge. ACP gets only server-classified Toolman
 * tools through this; native Write/Edit/Bash stay disabled.
 */
export class LocalMcpBridge {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString("hex");
  private executor: ToolExecutor | null = null;
  url: string | null = null;

  setExecutor(executor: ToolExecutor | null): void {
    this.executor = executor;
  }

  async listen(tools: ToolDeclaration[]): Promise<{ url: string; token: string }> {
    if (this.server && this.url) return { url: this.url, token: this.token };
    this.server = http.createServer(async (req, res) => {
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        res.writeHead(401).end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ tools }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/call") {
        const body = await readJson(req);
        if (!this.executor || typeof body.name !== "string") {
          res.writeHead(400).end();
          return;
        }
        const result = await this.executor(body.name, (body.arguments ?? {}) as Record<string, unknown>);
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return { url: this.url, token: this.token };
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.url = null;
  }
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
