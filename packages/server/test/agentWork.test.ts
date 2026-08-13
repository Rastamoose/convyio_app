import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import type { ChatMessage } from "@workspace/shared";
import { createWsEnv, type WsClient } from "./helpers";

let env: Awaited<ReturnType<typeof createWsEnv>>;

before(async () => {
  env = await createWsEnv();
});

afterEach(async () => {
  await env.reset();
});

after(async () => {
  if (env) await env.close();
});

async function takeAgentOffline(agent: WsClient, observer: WsClient): Promise<void> {
  const agentId = agent.welcome.self.id;
  agent.ws.terminate();
  await observer.next(
    (event) =>
      event.type === "presence_sync" &&
      event.participants.some(
        (participant: { id: string; online: boolean }) =>
          participant.id === agentId && !participant.online,
      ),
  );
}

describe("durable mention delivery", () => {
  test("only a human's bounded roster mention queues offline work with authoritative ids", async () => {
    const agent = await env.connect("n.oodle", "agent");
    const human = await env.connect("dana", "human");
    await takeAgentOffline(agent, human);

    human.ws.send(JSON.stringify({ type: "message", content: "email@n.oodle is ordinary text" }));
    const ordinary = await human.next(
      (event) => event.type === "message" && event.message.content.endsWith("ordinary text"),
    );
    assert.deepEqual(ordinary.message.mentions, []);

    human.ws.send(JSON.stringify({ type: "message", content: "Please ask @N.OODLE about this" }));
    const mentioned = await human.next(
      (event) => event.type === "message" && event.message.content.startsWith("Please ask"),
    );
    assert.deepEqual(mentioned.message.mentions, [agent.welcome.self.id]);
    assert.ok(mentioned.message.channelId);

    const rejoinedAgent = await env.connect("n.oodle", "agent");
    const available = await rejoinedAgent.next((event) => event.type === "work_available");
    assert.equal(available.requestIds.length, 1);
    rejoinedAgent.ws.send(
      JSON.stringify({ type: "message", content: "Agent-authored @n.oodle does not recurse" }),
    );
    const agentMessage = await human.next(
      (event) => event.type === "message" && event.message.content.startsWith("Agent-authored"),
    );
    assert.deepEqual(agentMessage.message.mentions, []);

    const requests = await env.db.sql<
      { id: string; agent_id: string; message_id: string; status: string }[]
    >`SELECT id, agent_id, message_id, status FROM agent_run_requests`;
    assert.deepEqual([...requests].map((request) => ({ ...request })), [
      {
        id: available.requestIds[0],
        agent_id: agent.welcome.self.id,
        message_id: mentioned.message.id,
        status: "queued",
      },
    ]);
  });

  test("agent/message dedupe shares one conversation per stable channel and splits channels", async () => {
    const agent = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    await takeAgentOffline(agent, human);
    const actor = (await env.db.getActor(human.welcome.self.id))!;
    const secondChannel = await env.channels.create(actor, "second");

    const post = async (content: string, channel?: string) => {
      human.ws.send(JSON.stringify({ type: "message", content, channel }));
      return human.next(
        (event) => event.type === "message" && event.message.content === content,
      );
    };
    const first = await post("@noodle first");
    const second = await post("@noodle second");
    const third = await post("@noodle elsewhere", secondChannel.name);

    const duplicate = await env.db.transaction((sql) =>
      env.agentWork.queue(sql, first.message, [agent.welcome.self.id]),
    );
    assert.deepEqual(duplicate, []);

    const requests = await env.db.sql<
      { message_id: string; conversation_id: string; channel_id: string }[]
    >`
      SELECT message_id, conversation_id, channel_id
      FROM agent_run_requests
      ORDER BY created_at, id
    `;
    const byMessage = new Map(requests.map((request) => [request.message_id, request]));
    assert.equal(requests.length, 3);
    assert.equal(
      byMessage.get(first.message.id)?.conversation_id,
      byMessage.get(second.message.id)?.conversation_id,
    );
    assert.notEqual(
      byMessage.get(first.message.id)?.conversation_id,
      byMessage.get(third.message.id)?.conversation_id,
    );
    assert.equal(byMessage.get(third.message.id)?.channel_id, secondChannel.id);

    const [{ conversations }] = await env.db.sql<{ conversations: number }[]>`
      SELECT count(*)::int AS conversations FROM agent_conversations
    `;
    assert.equal(conversations, 2);
    const lifecycle = await env.db.sql<{ kind: string }[]>`
      SELECT kind FROM thread_events
      WHERE kind IN ('conversation.created', 'agent.run.requested')
      ORDER BY seq
    `;
    assert.equal(lifecycle.filter((event) => event.kind === "conversation.created").length, 2);
    assert.equal(lifecycle.filter((event) => event.kind === "agent.run.requested").length, 3);
  });

  test("claim and completion are owned, hydrated, and idempotent", async () => {
    const target = await env.connect("noodle", "agent");
    const other = await env.connect("other", "agent");
    const human = await env.connect("dana", "human");

    human.ws.send(JSON.stringify({ type: "message", content: "@noodle handle this" }));
    const trigger = await human.next(
      (event) => event.type === "message" && event.message.content === "@noodle handle this",
    );
    const available = await target.next((event) => event.type === "work_available");
    const requestId = available.requestIds[0];

    human.ws.send(JSON.stringify({ type: "work_claim", requestIds: [requestId] }));
    const humanRefusal = await human.next((event) => event.type === "error");
    assert.equal(humanRefusal.error, "agent-only event");
    other.ws.send(JSON.stringify({ type: "work_claim", requestIds: [requestId] }));
    const ownershipRefusal = await other.next((event) => event.type === "error");
    assert.equal(ownershipRefusal.error, "work request unavailable");

    let assignmentFrames = 0;
    target.ws.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "work_assigned") assignmentFrames += 1;
    });
    target.ws.send(JSON.stringify({ type: "work_claim", requestIds: [requestId] }));
    const assigned = await target.next((event) => event.type === "work_assigned");
    assert.equal(assigned.assignments[0].request.id, requestId);
    assert.equal(assigned.assignments[0].conversation.channelId, trigger.message.channelId);
    assert.deepEqual(assigned.assignments[0].trigger, trigger.message);

    target.ws.send(JSON.stringify({ type: "work_claim", requestIds: [requestId] }));
    target.ws.send(JSON.stringify({ type: "status_set", status: "claim barrier" }));
    await human.next(
      (event) =>
        event.type === "presence_sync" &&
        event.participants.some(
          (participant: { id: string; status: string }) =>
            participant.id === target.welcome.self.id && participant.status === "claim barrier",
        ),
    );
    assert.equal(assignmentFrames, 2);

    target.ws.send(
      JSON.stringify({ type: "work_complete", requestIds: [requestId], outcome: "completed" }),
    );
    target.ws.send(JSON.stringify({ type: "status_set", status: "completion barrier" }));
    await human.next(
      (event) =>
        event.type === "presence_sync" &&
        event.participants.some(
          (participant: { id: string; status: string }) =>
            participant.id === target.welcome.self.id && participant.status === "completion barrier",
        ),
    );
    target.ws.send(
      JSON.stringify({ type: "work_complete", requestIds: [requestId], outcome: "completed" }),
    );
    target.ws.send(JSON.stringify({ type: "status_set", status: "repeat barrier" }));
    await human.next(
      (event) =>
        event.type === "presence_sync" &&
        event.participants.some(
          (participant: { id: string; status: string }) =>
            participant.id === target.welcome.self.id && participant.status === "repeat barrier",
        ),
    );

    const [request] = await env.db.sql<{ status: string; completed_at: number | null }[]>`
      SELECT status, completed_at FROM agent_run_requests WHERE id = ${requestId}
    `;
    assert.equal(request.status, "completed");
    assert.ok(request.completed_at);
    const [{ claimed, completed }] = await env.db.sql<
      { claimed: number; completed: number }[]
    >`
      SELECT
        count(*) FILTER (WHERE kind = 'agent.run.claimed')::int AS claimed,
        count(*) FILTER (WHERE kind = 'agent.run.completed')::int AS completed
      FROM thread_events WHERE subject_id = ${requestId}
    `;
    assert.deepEqual({ claimed, completed }, { claimed: 1, completed: 1 });
  });

  test("an agent reconnect requeues only its stale claim and advertises it again", async () => {
    const agent = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    human.ws.send(JSON.stringify({ type: "message", content: "@noodle reconnect test" }));
    const available = await agent.next((event) => event.type === "work_available");
    const requestId = available.requestIds[0];
    agent.ws.send(JSON.stringify({ type: "work_claim", requestIds: [requestId] }));
    await agent.next((event) => event.type === "work_assigned");

    const reconnected = await env.connect("noodle", "agent");
    const advertised = await reconnected.next((event) => event.type === "work_available");
    assert.deepEqual(advertised.requestIds, [requestId]);
    const [request] = await env.db.sql<{ status: string; claimed_at: number | null }[]>`
      SELECT status, claimed_at FROM agent_run_requests WHERE id = ${requestId}
    `;
    assert.deepEqual(request, { status: "queued", claimed_at: null });
    const lifecycle = await env.db.sql<{ kind: string }[]>`
      SELECT kind FROM thread_events WHERE subject_id = ${requestId} ORDER BY seq
    `;
    assert.deepEqual(lifecycle.map((event) => event.kind), [
      "agent.run.requested",
      "agent.run.claimed",
      "agent.run.requeued",
    ]);
  });

  test("message and derived request roll back together when projection fails", async () => {
    const author = await env.db.upsertActor("human", "dana");
    const channel = (await env.channels.get("general"))!;
    const message: ChatMessage = {
      id: "atomic-message",
      authorId: author.id,
      authorName: author.displayName,
      authorKind: "human",
      content: "@missing must roll back",
      timestamp: Date.now(),
      channelId: channel.id,
      channel: channel.name,
      mentions: ["missing-agent"],
    };

    await assert.rejects(
      env.messages.appendAtomically(message, (sql) =>
        env.agentWork.queue(sql, message, message.mentions ?? []),
      ),
    );
    assert.equal(await env.messages.get(message.id), null);
    const [{ requests, events }] = await env.db.sql<{ requests: number; events: number }[]>`
      SELECT
        (SELECT count(*)::int FROM agent_run_requests) AS requests,
        (SELECT count(*)::int FROM thread_events WHERE subject_id = ${message.id}) AS events
    `;
    assert.deepEqual({ requests, events }, { requests: 0, events: 0 });
  });
});
