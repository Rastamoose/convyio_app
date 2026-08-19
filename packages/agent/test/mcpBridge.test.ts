import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalMcpBridge } from "../src/mcpBridge";
import { TOOL_DECLARATIONS } from "../src/tools";

describe("LocalMcpBridge", () => {
  const bridge = new LocalMcpBridge();
  after(() => bridge.close());

  test("exposes board tools over Streamable HTTP MCP and executes them", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    bridge.setExecutor(async (name, args) => {
      calls.push({ name, args });
      return { ref: "plan-1", status: "proposed" };
    });
    const { url, token } = await bridge.listen(TOOL_DECLARATIONS);
    const client = new Client({ name: "mcp-bridge-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "board_propose_plan"));
      assert.ok(listed.tools.some((tool) => tool.name === "project_list"));
      const result = await client.callTool({
        name: "board_propose_plan",
        arguments: {
          title: "Align totals",
          objective: "Invoice and ledger agree",
          outline: ["Inspect both files"],
          clarifications: ["Asked whether ledger may change"],
        },
      });
      assert.deepEqual(calls, [{
        name: "board_propose_plan",
        args: {
          title: "Align totals",
          objective: "Invoice and ledger agree",
          outline: ["Inspect both files"],
          clarifications: ["Asked whether ledger may change"],
        },
      }]);
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((part) => part.type === "text");
      assert.ok(text?.text);
      assert.deepEqual(JSON.parse(text.text), { ref: "plan-1", status: "proposed" });
    } finally {
      await client.close();
    }
  });

  test("rejects an unauthenticated MCP request", async () => {
    const { url } = await bridge.listen(TOOL_DECLARATIONS);
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 401);
  });
});
