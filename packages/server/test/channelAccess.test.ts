import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Actor } from "@workspace/shared";
import { createWsEnv, type WsEnv } from "./helpers";

let env: WsEnv;
before(async () => { env = await createWsEnv(); });
after(async () => { await env.close(); });

describe("agent channel confidentiality", () => {
  test("an ungranted agent receives only its invocation trigger until durable access is approved", async () => {
    const human = await env.connect("channel-human", "human");
    const channel = await env.channels.create(
      { id: human.welcome.self.id, workspaceId: env.db.workspaceId, kind: "human", displayName: human.welcome.self.name },
      "private-agent-room",
    );
    human.ws.send(JSON.stringify({ type: "message", channel: channel.name, content: "private history" }));
    await human.next((event) => event.type === "message" && event.message.content === "private history", 1000);

    const agent = await env.connect("channel-agent", "agent");
    assert.equal(agent.welcome.history.some((message: { content: string }) => message.content === "private history"), false);

    human.ws.send(JSON.stringify({
      type: "message",
      channel: channel.name,
      content: "@channel-agent confirm you can help",
    }));
    const occupancy = await human.next(
      (event) =>
        event.type === "message" &&
        event.message.authorKind === "agent" &&
        event.message.content.includes("waiting for a decision"),
      2000,
    );
    assert.match(occupancy.message.content, /#private-agent-room/);
    await assert.rejects(agent.next((event) => event.type === "work_available", 200), /timeout/);
    await assert.rejects(
      agent.next((event) => event.type === "message" && event.message.content.includes("confirm you can help"), 100),
      /timeout/,
    );
    const deniedHistory = await fetch(`${env.baseUrl}/api/agent-context/channels/${channel.id}/messages`, {
      headers: { Authorization: `Bearer ${agent.token}` },
    });
    assert.equal(deniedHistory.status, 403);

    const agentActor: Actor = {
      id: agent.welcome.self.id,
      workspaceId: env.db.workspaceId,
      kind: "agent",
      displayName: agent.welcome.self.name,
    };
    const humanActor: Actor = {
      id: human.welcome.self.id,
      workspaceId: env.db.workspaceId,
      kind: "human",
      displayName: human.welcome.self.name,
    };
    const pending = (await env.resourceAccess.requestsForAgent(agentActor.id)).find(
      (request) => request.status === "pending" && request.resourceId === channel.id,
    );
    assert.ok(pending);
    await env.resourceAccess.resolve(humanActor, pending.id, "approved");
    const grantedHistory = await fetch(`${env.baseUrl}/api/agent-context/channels/${channel.id}/messages`, {
      headers: { Authorization: `Bearer ${agent.token}` },
    });
    assert.equal(grantedHistory.status, 200);
    const historyBody = await grantedHistory.json();
    assert.equal(historyBody.messages.some((message: { content: string }) => message.content === "private history"), true);

    human.ws.send(JSON.stringify({
      type: "message",
      channel: channel.name,
      content: "@channel-agent confirm you can help",
    }));
    const available = await agent.next((event) => event.type === "work_available", 2000);
    agent.ws.send(JSON.stringify({ type: "work_claim", requestIds: available.requestIds }));
    const assigned = await agent.next((event) => event.type === "work_assigned", 1000);
    assert.match(assigned.assignments[0].trigger.content, /confirm you can help/);

    human.ws.send(JSON.stringify({ type: "message", channel: channel.name, content: "visible after grant" }));
    const visible = await agent.next(
      (event) => event.type === "message" && event.message.content === "visible after grant",
      1000,
    );
    assert.equal(visible.message.channelId, channel.id);
  });

  test("first mention requests durable access and does not start a run", async () => {
    const human = await env.connect("mention-human", "human");
    const agent = await env.connect("mention-agent", "agent");
    const general = await env.channels.get("general");
    assert.ok(general);

    human.ws.send(JSON.stringify({
      type: "message",
      channel: "general",
      content: "@mention-agent hello",
    }));
    const occupancy = await human.next(
      (event) =>
        event.type === "message" &&
        event.message.authorKind === "agent" &&
        event.message.content.includes("waiting for a decision"),
      2000,
    );
    assert.match(occupancy.message.content, /#general/);
    await assert.rejects(agent.next((event) => event.type === "work_available", 200), /timeout/);

    const requests = (await env.resourceAccess.requestsForAgent(agent.welcome.self.id))
      .filter((request) => request.status === "pending");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].resourceKind, "channel");
    assert.equal(requests[0].resourceId, general.id);
    assert.equal(requests[0].originChannelId, general.id);
  });

  test("a pending access request occupies the agent in other channels with origin and target", async () => {
    const human = await env.connect("busy-human", "human");
    const agent = await env.connect("busy-agent", "agent");
    const humanActor: Actor = {
      id: human.welcome.self.id,
      workspaceId: env.db.workspaceId,
      kind: "human",
      displayName: human.welcome.self.name,
    };
    const agentActor: Actor = {
      id: agent.welcome.self.id,
      workspaceId: env.db.workspaceId,
      kind: "agent",
      displayName: agent.welcome.self.name,
    };
    const general = await env.channels.get("general");
    assert.ok(general);
    const anoher = await env.channels.create(humanActor, "anoher");
    const elsewhere = await env.channels.create(humanActor, "elsewhere");

    await env.resourceAccess.request(agentActor, {
      resourceKind: "channel",
      resourceId: anoher.id,
      reason: "User asked to read messages from this channel.",
      originChannelId: general.id,
    });

    human.ws.send(JSON.stringify({
      type: "message",
      channel: elsewhere.name,
      content: "@busy-agent what else can you do",
    }));
    const reply = await human.next(
      (event) =>
        event.type === "message" &&
        event.message.authorKind === "agent" &&
        event.message.content.includes("waiting for a decision"),
      2000,
    );
    assert.match(reply.message.content, /#general/);
    assert.match(reply.message.content, /#anoher/);
    assert.doesNotMatch(reply.message.content, /waiting for a decision in #anoher/);
    await assert.rejects(
      agent.next((event) => event.type === "work_available", 200),
      /timeout/,
    );
  });
});
