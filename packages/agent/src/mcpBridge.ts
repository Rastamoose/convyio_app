import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { ToolDeclaration, ToolExecutor } from "./brain";

/**
 * Localhost Streamable HTTP MCP server. ACP receives only these classified
 * Toolman/board tools; native Write/Edit/Bash stay disabled.
 */
export class LocalMcpBridge {
  private server: http.Server | null = null;
  private token = randomBytes(24).toString("hex");
  private executor: ToolExecutor | null = null;
  private tools: ToolDeclaration[] = [];
  url: string | null = null;

  setExecutor(executor: ToolExecutor | null): void {
    this.executor = executor;
  }

  async listen(tools: ToolDeclaration[]): Promise<{ url: string; token: string }> {
    if (this.server && this.url) return { url: this.url, token: this.token };
    this.tools = tools;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
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

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === "GET" || req.method === "DELETE") {
      res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const mcp = new McpServer({ name: "convyio-toolman", version: "0.1.0" });
    for (const decl of this.tools) {
      mcp.registerTool(decl.name, {
        description: decl.description,
        inputSchema: toZodShape(decl.parameters),
      }, async (args) => {
        if (!this.executor) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "tool executor is not ready" }) }], isError: true };
        }
        const result = await this.executor(decl.name, args as Record<string, unknown>);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        }));
      }
    } finally {
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    }
  }
}

function toZodShape(params: ToolDeclaration["parameters"]): Record<string, z.ZodTypeAny> {
  const required = new Set(params.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(params.properties)) {
    const field = zodFieldFor(prop);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function zodFieldFor(prop: { type: string; description?: string; items?: { type: string } }): z.ZodTypeAny {
  const base = ((): z.ZodTypeAny => {
    switch (prop.type) {
      case "number":
        return z.number();
      case "integer":
        return z.number().int();
      case "boolean":
        return z.boolean();
      case "array":
        return z.array(zodFieldFor(prop.items ?? { type: "string" }));
      default:
        return z.string();
    }
  })();
  return prop.description ? base.describe(prop.description) : base;
}
