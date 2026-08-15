import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { authorizeMutation } from "../src/board/Toolman";
import { createEnv } from "./helpers";

describe("chat grants and permission modes", async () => {
  const env = await createEnv();
  const human = await env.actor("human", "dana");
  const agent = await env.actor("agent", "noodle");
  after(() => env.close());

  test("mutating work without a ticket is refused unless a chat grant is opted in", async () => {
    const denied = await authorizeMutation(
      agent.actor,
      null,
      { name: "write_file", path: "notes.md" },
      env.service,
    );
    assert.equal(denied.allow, false);
    assert.equal(!denied.allow && denied.code, "NO_BOARD_REF");

    const granted = await authorizeMutation(
      agent.actor,
      null,
      { name: "write_file", path: "notes.md" },
      env.service,
      { chatGrant: true },
    );
    assert.equal(granted.allow, true);
  });

  test("chat grants still fail closed on unclassified tools and path escape", async () => {
    const unknown = await authorizeMutation(
      agent.actor,
      null,
      { name: "brand_new_tool" },
      env.service,
      { chatGrant: true },
    );
    assert.equal(unknown.allow, false);
    assert.equal(!unknown.allow && unknown.code, "UNKNOWN_ACTION");

    const escape = await authorizeMutation(
      agent.actor,
      null,
      { name: "write_file", path: "../escape.txt" },
      env.service,
      { chatGrant: true },
    );
    assert.equal(escape.allow, false);
    assert.equal(!escape.allow && escape.code, "SCOPE_VIOLATION");
  });

  test("approveAll and bypass are stored conversation modes", async () => {
    const channel = await env.channels.get("general");
    assert.ok(channel);
    const updated = await env.agentWork.setPermissionMode(
      human.actor.id,
      agent.actor.id,
      channel.id,
      "approveAll",
    );
    assert.equal(updated.permissionMode, "approveAll");
    const bypass = await env.agentWork.setPermissionMode(human.actor.id, agent.actor.id, channel.id, "bypass");
    assert.equal(bypass.permissionMode, "bypass");
    assert.equal(await env.agentWork.permissionMode(agent.actor.id, bypass.id), "bypass");
  });
});
