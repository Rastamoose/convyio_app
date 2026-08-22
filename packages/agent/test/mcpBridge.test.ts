import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LocalMcpBridge } from "../src/mcpBridge";
import { TOOL_DECLARATIONS } from "../src/tools";

describe("LocalMcpBridge", () => {
  const bridge = new LocalMcpBridge();
  after(() => bridge.close());

  test("exposes project tools over Streamable HTTP MCP and executes them", async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    bridge.setExecutor(async (name, args) => {
      calls.push({ name, args });
      return { done: "wrote 5 bytes to notes.txt" };
    });
    const { url, token } = await bridge.listen(TOOL_DECLARATIONS);
    const client = new Client({ name: "mcp-bridge-test", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((tool) => tool.name === "project_write_file"));
      assert.ok(listed.tools.some((tool) => tool.name === "project_list"));
      const result = await client.callTool({
        name: "project_write_file",
        arguments: {
          project_id: "proj-1",
          path: "notes.txt",
          content: "hello",
        },
      });
      assert.deepEqual(calls, [{
        name: "project_write_file",
        args: {
          project_id: "proj-1",
          path: "notes.txt",
          content: "hello",
        },
      }]);
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((part) => part.type === "text");
      assert.ok(text?.text);
      assert.deepEqual(JSON.parse(text.text), { done: "wrote 5 bytes to notes.txt" });
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
