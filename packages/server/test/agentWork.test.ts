import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import type { AgentRunFinishEvent, ChatMessage } from "@workspace/shared";
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

async function claimMention(
  agent: WsClient,
  human: WsClient,
  content: string,
): Promise<any> {
  await env.grantChannel(agent.welcome.self.id, human.welcome.self.id);
  human.ws.send(JSON.stringify({ type: "message", content }));
  await human.next((event) => event.type === "message" && event.message.content === content);
  const available = await agent.next((event) => event.type === "work_available");
  agent.ws.send(JSON.stringify({ type: "work_claim", requestIds: available.requestIds }));
  const assigned = await agent.next((event) => event.type === "work_assigned");
  return assigned.assignments[0];
}

describe("durable mention delivery", () => {
  test("only a human's bounded roster mention queues offline work with authoritative ids", async () => {
    const agent = await env.connect("n.oodle", "agent");
    const human = await env.connect("dana", "human");
    await env.grantChannel(agent.welcome.self.id, human.welcome.self.id);
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
    await env.grantChannel(agent.welcome.self.id, human.welcome.self.id);
    await takeAgentOffline(agent, human);
    const actor = (await env.db.getActor(human.welcome.self.id))!;
    const secondChannel = await env.channels.create(actor, "second");
    await env.grantChannel(agent.welcome.self.id, human.welcome.self.id, secondChannel.name);

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
    await env.grantChannel(target.welcome.self.id, human.welcome.self.id);

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
    await env.grantChannel(agent.welcome.self.id, human.welcome.self.id);
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

describe("canonical agent activity and finalization", () => {
  test("activity is agent-owned, conversation-scoped, all-or-nothing, live, and idempotent", async () => {
    const target = await env.connect("noodle", "agent");
    const other = await env.connect("other", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle activity test");
    const item = {
      clientEventId: "activity-1",
      kind: "agent.tool.started",
      channelId: assignment.request.channelId,
      conversationId: assignment.conversation.id,
      runId: "run-activity",
      subjectId: "tool-1",
      payload: { name: "Read", input: { path: "README.md" } },
    };

    target.ws.send(JSON.stringify({ type: "activity_batch", events: [item] }));
    const live = await human.next(
      (event) => event.type === "thread_event" && event.event.clientEventId === "activity-1",
    );
    assert.equal(live.event.actorId, target.welcome.self.id);
    assert.equal(live.event.kind, "agent.tool.started");

    target.ws.send(JSON.stringify({ type: "activity_batch", events: [item] }));
    target.ws.send(JSON.stringify({ type: "status_set", status: "activity barrier" }));
    await human.next(
      (event) => event.type === "presence_sync" && event.participants.some(
        (participant: { id: string; status: string }) =>
          participant.id === target.welcome.self.id && participant.status === "activity barrier",
      ),
    );
    const [{ count }] = await env.db.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM thread_events
      WHERE actor_id = ${target.welcome.self.id} AND client_event_id = 'activity-1'
    `;
    assert.equal(count, 1);

    other.ws.send(JSON.stringify({
      type: "activity_batch",
      events: [{ ...item, clientEventId: "other-activity" }],
    }));
    assert.equal((await other.next((event) => event.type === "error")).error, "agent activity unavailable");

    target.ws.send(JSON.stringify({
      type: "activity_batch",
      events: [
        { ...item, clientEventId: "atomic-good" },
        { ...item, clientEventId: "atomic-bad", conversationId: "missing-conversation" },
      ],
    }));
    assert.equal((await target.next((event) => event.type === "error")).error, "agent activity unavailable");
    const [{ atomic }] = await env.db.sql<{ atomic: number }[]>`
      SELECT count(*)::int AS atomic FROM thread_events
      WHERE client_event_id IN ('atomic-good', 'atomic-bad')
    `;
    assert.equal(atomic, 0);

    human.ws.send(JSON.stringify({ type: "activity_batch", events: [item] }));
    assert.equal((await human.next((event) => event.type === "error")).error, "agent-only event");
  });

  test("a later database failure rolls back activity appended earlier in the same batch", async () => {
    const target = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle atomic activity");
    const forcedConflictId = "activity-forced-primary-key-conflict";
    await env.db.transaction((sql) => env.threadEvents.append(sql, {
      id: forcedConflictId,
      workspaceId: assignment.request.workspaceId,
      channelId: assignment.request.channelId,
      actorId: target.welcome.self.id,
      kind: "agent.tool.started",
      conversationId: assignment.conversation.id,
      runId: "activity-seed-run",
      clientEventId: "activity-seed",
      payload: { seed: true },
    }));

    const appendBatch = env.threadEvents.appendBatch.bind(env.threadEvents);
    env.threadEvents.appendBatch = (sql, inputs) => appendBatch(
      sql,
      inputs.map((input, index) => index === 1 ? { ...input, id: forcedConflictId } : input),
    );
    try {
      await assert.rejects(env.agentWork.appendActivity(target.welcome.self.id, {
        type: "activity_batch",
        events: [
          {
            clientEventId: "activity-transaction-first",
            kind: "agent.tool.started",
            channelId: assignment.request.channelId,
            conversationId: assignment.conversation.id,
            runId: "activity-transaction-run",
            payload: { name: "first" },
          },
          {
            clientEventId: "activity-transaction-late",
            kind: "agent.tool.completed",
            channelId: assignment.request.channelId,
            conversationId: assignment.conversation.id,
            runId: "activity-transaction-run",
            payload: { name: "late" },
          },
        ],
      }));
    } finally {
      env.threadEvents.appendBatch = appendBatch;
    }

    const [{ attempted, seed }] = await env.db.sql<{ attempted: number; seed: number }[]>`
      SELECT
        count(*) FILTER (
          WHERE client_event_id IN ('activity-transaction-first', 'activity-transaction-late')
        )::int AS attempted,
        count(*) FILTER (WHERE id = ${forcedConflictId})::int AS seed
      FROM thread_events
    `;
    assert.deepEqual({ attempted, seed }, { attempted: 0, seed: 1 });
  });

  test("finish atomically creates the final message and terminal run state without requeue", async () => {
    const target = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle finish this");

    target.ws.send(JSON.stringify({
      type: "agent_run_finish",
      runId: "run-finished",
      channelId: assignment.request.channelId,
      conversationId: assignment.conversation.id,
      requestIds: [assignment.request.id],
      outcome: "completed",
      finalContent: "finished atomically",
      usage: { inputTokens: 8, outputTokens: 3 },
    }));
    const message = await human.next(
      (event) => event.type === "message" && event.message.content === "finished atomically",
    );
    const runEvent = await human.next(
      (event) => event.type === "thread_event" && event.event.subjectId === "run-finished",
    );
    assert.equal(message.message.runId, "run-finished");
    assert.equal(runEvent.event.kind, "agent.run.completed");

    const [request] = await env.db.sql<{ status: string }[]>`
      SELECT status FROM agent_run_requests WHERE id = ${assignment.request.id}
    `;
    assert.equal(request.status, "completed");
    const [{ messages, runEvents }] = await env.db.sql<{ messages: number; runEvents: number }[]>`
      SELECT
        (SELECT count(*)::int FROM messages WHERE run_id = 'run-finished') AS messages,
        (SELECT count(*)::int FROM thread_events WHERE client_event_id = 'agent-run-finish:run-finished') AS "runEvents"
    `;
    assert.deepEqual({ messages, runEvents }, { messages: 1, runEvents: 1 });

    const reconnected = await env.connect("noodle", "agent");
    await assert.rejects(reconnected.next((event) => event.type === "work_available", 100), /timeout/);
    assert.deepEqual(await env.agentWork.listPending(reconnected.welcome.self.id), []);
  });

  test("failed finishes are terminal and persist a failed run event", async () => {
    const target = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle fail this");

    target.ws.send(JSON.stringify({
      type: "agent_run_finish",
      runId: "run-failed",
      channelId: assignment.request.channelId,
      conversationId: assignment.conversation.id,
      requestIds: [assignment.request.id],
      outcome: "failed",
      finalContent: "I could not finish",
      error: "Brain run failed",
    }));
    await human.next((event) => event.type === "message" && event.message.runId === "run-failed");
    await human.next(
      (event) => event.type === "thread_event" && event.event.subjectId === "run-failed",
    );

    const [request] = await env.db.sql<{ status: string }[]>`
      SELECT status FROM agent_run_requests WHERE id = ${assignment.request.id}
    `;
    assert.equal(request.status, "failed");
    const [run] = await env.db.sql<{ kind: string }[]>`
      SELECT kind FROM thread_events WHERE client_event_id = 'agent-run-finish:run-failed'
    `;
    assert.equal(run.kind, "agent.run.failed");
  });

  test("finish replay rejects mismatched outcome, channel, or request scope without new events", async () => {
    const target = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle replay this finish");
    const actor = (await env.db.getActor(human.welcome.self.id))!;
    const otherChannel = await env.channels.create(actor, "finish-replay-other");
    const finish: AgentRunFinishEvent = {
      type: "agent_run_finish",
      runId: "run-finish-replay",
      channelId: assignment.request.channelId,
      conversationId: assignment.conversation.id,
      requestIds: [assignment.request.id],
      outcome: "failed",
      finalContent: "failed once",
      error: "Brain run failed",
    };

    await env.agentWork.finishRun(target.welcome.self.id, finish, []);
    assert.deepEqual(
      await env.agentWork.finishRun(target.welcome.self.id, finish, []),
      { message: null, events: [] },
    );
    const [{ before }] = await env.db.sql<{ before: number }[]>`
      SELECT count(*)::int AS before FROM thread_events
    `;
    const mismatches: AgentRunFinishEvent[] = [
      { ...finish, outcome: "completed" },
      { ...finish, channelId: otherChannel.id },
      { ...finish, requestIds: [] },
    ];
    for (const mismatch of mismatches) {
      await assert.rejects(env.agentWork.finishRun(target.welcome.self.id, mismatch, []));
    }

    const [{ after, finishes }] = await env.db.sql<{ after: number; finishes: number }[]>`
      SELECT
        count(*)::int AS after,
        count(*) FILTER (
          WHERE client_event_id = 'agent-run-finish:run-finish-replay'
        )::int AS finishes
      FROM thread_events
    `;
    assert.deepEqual({ before, after, finishes }, { before, after: before, finishes: 1 });
  });

  test("a finish failure rolls back message, request, and run event together", async () => {
    const target = await env.connect("noodle", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle rollback this");
    const append = env.threadEvents.append.bind(env.threadEvents);
    env.threadEvents.append = async (sql, input) => {
      if (input.clientEventId === "agent-run-finish:run-rollback") throw new Error("forced rollback");
      return append(sql, input);
    };
    try {
      await assert.rejects(
        env.agentWork.finishRun(target.welcome.self.id, {
          type: "agent_run_finish",
          runId: "run-rollback",
          channelId: assignment.request.channelId,
          conversationId: assignment.conversation.id,
          requestIds: [assignment.request.id],
          outcome: "completed",
          finalContent: "must roll back",
        }, []),
        /forced rollback/,
      );
    } finally {
      env.threadEvents.append = append;
    }

    const [request] = await env.db.sql<{ status: string }[]>`
      SELECT status FROM agent_run_requests WHERE id = ${assignment.request.id}
    `;
    assert.equal(request.status, "claimed");
    const [{ messages, events }] = await env.db.sql<{ messages: number; events: number }[]>`
      SELECT
        (SELECT count(*)::int FROM messages WHERE run_id = 'run-rollback') AS messages,
        (SELECT count(*)::int FROM thread_events WHERE run_id = 'run-rollback') AS events
    `;
    assert.deepEqual({ messages, events }, { messages: 0, events: 0 });
  });

  test("conversation sessions are owner-scoped, persisted, and returned in later assignments", async () => {
    const target = await env.connect("noodle", "agent");
    const other = await env.connect("other", "agent");
    const human = await env.connect("dana", "human");
    const assignment = await claimMention(target, human, "@noodle session one");
    const frame = {
      type: "conversation_session_set",
      conversationId: assignment.conversation.id,
      providerSessionId: "provider-session-1",
      permissionMode: "plan",
      clientEventId: "session-event-1",
    };

    other.ws.send(JSON.stringify(frame));
    assert.equal((await other.next((event) => event.type === "error")).error, "conversation unavailable");
    target.ws.send(JSON.stringify(frame));
    const updated = await target.next(
      (event) => event.type === "conversation_updated" && event.conversation.id === assignment.conversation.id,
    );
    assert.equal(updated.conversation.providerSessionId, "provider-session-1");
    assert.equal(updated.conversation.permissionMode, "plan");
    const sessionEvent = await human.next(
      (event) => event.type === "thread_event" && event.event.clientEventId === "session-event-1",
    );
    assert.equal(sessionEvent.event.kind, "agent.provider.session");
    assert.deepEqual(sessionEvent.event.payload, {
      providerSessionIdSet: true,
      permissionMode: "plan",
    });
    assert.equal(JSON.stringify(sessionEvent).includes("provider-session-1"), false);

    target.ws.send(JSON.stringify({
      type: "agent_run_finish",
      runId: "run-session-one",
      channelId: assignment.request.channelId,
      conversationId: assignment.conversation.id,
      requestIds: [assignment.request.id],
      outcome: "completed",
      finalContent: "session saved",
    }));
    await human.next((event) => event.type === "message" && event.message.runId === "run-session-one");
    human.ws.send(JSON.stringify({ type: "message", content: "@noodle session two" }));
    const posted = await human.next(
      (event) => event.type === "message" && event.message.content === "@noodle session two",
    );
    const [request] = await env.db.sql<{ id: string }[]>`
      SELECT id FROM agent_run_requests WHERE message_id = ${posted.message.id}
    `;
    const available = await target.next(
      (event) => event.type === "work_available" && event.requestIds.includes(request.id),
    );
    target.ws.send(JSON.stringify({ type: "work_claim", requestIds: available.requestIds }));
    const next = await target.next(
      (event) => event.type === "work_assigned" && event.assignments[0].request.id === request.id,
    );
    assert.equal(next.assignments[0].conversation.providerSessionId, "provider-session-1");
    assert.equal(next.assignments[0].conversation.permissionMode, "plan");
  });
});
