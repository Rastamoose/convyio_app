import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentWorkAssignment, Attachment, ClientEvent } from "@workspace/shared";
import { AgentRunner } from "../src/runner";
import { Memory } from "../src/memory";
import { Presence } from "../src/presence";
import { ConversationSessions } from "../src/conversationSessions";
import type { AgentSocket } from "../src/socket";
import type { BoardClient } from "../src/boardClient";
import type { Brain, BrainCallbacks, BrainInput, BrainRunOptions } from "../src/brain";
import { tempDir, waitFor } from "./helpers";

// The brain (Gemini) and socket (server) are the runner's network
// boundaries; everything else here is the real implementation.

function fakeSocket(): { socket: AgentSocket; sent: ClientEvent[] } {
  const sent: ClientEvent[] = [];
  const socket = { send: (event: ClientEvent) => void sent.push(event) };
  return { socket: socket as unknown as AgentSocket, sent };
}

function fakeBoard(overrides: Record<string, unknown> = {}): BoardClient {
  return {
    summary: () => "(board is empty)",
    resolve: () => undefined,
    myProposedItems: () => [],
    ...overrides,
  } as unknown as BoardClient;
}

describe("AgentRunner", () => {
  test("batches queued work per channel and answers each channel in its own run", async () => {
    const prompts: string[] = [];
    const brain = {
      run: async (input: { prompt: string }) => {
        prompts.push(input.prompt);
        return { text: `reply ${prompts.length}`, providerSessionId: null };
      },
    } as unknown as Brain;
    const { socket, sent } = fakeSocket();
    const board = fakeBoard();
    const dir = await tempDir();
    const runner = new AgentRunner(
      socket,
      brain,
      await Memory.load(dir),
      board,
      await ConversationSessions.load(dir),
      new Presence(socket, board),
      "system prompt",
    );

    runner.enqueue({ authorName: "dana", content: "first general", channel: "general" });
    runner.enqueue({ authorName: "sam", content: "random question", channel: "random" });
    runner.enqueue({ authorName: "dana", content: "second general", channel: "general" });

    const finishes = await waitFor(() => {
      const got = sent.filter(
        (e): e is Extract<ClientEvent, { type: "agent_run_finish" }> => e.type === "agent_run_finish",
      );
      return got.length === 2 ? got : undefined;
    }, "one finish per channel");

    // Both #general messages ran as one batch, in arrival order…
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /#general/);
    assert.match(prompts[0], /dana: first general[\s\S]*dana: second general/);
    // …and #random got its own run without the other channel's work.
    assert.match(prompts[1], /#random/);
    assert.match(prompts[1], /sam: random question/);
    assert.doesNotMatch(prompts[1], /first general/);

    // Each reply lands in the channel that asked.
    assert.deepEqual(
      finishes.map((event) => ({ channelId: event.channelId, content: event.finalContent })),
      [
        { channelId: "general", content: "reply 1" },
        { channelId: "random", content: "reply 2" },
      ],
    );
  });
});

let attachmentSeq = 0;
function attachment(name: string, mime: string, size: number): Attachment {
  attachmentSeq += 1;
  const id = `up-${attachmentSeq}`;
  return { id, name, mime, size, url: `/api/uploads/${id}/${name}` };
}

describe("AgentRunner attachments", () => {
  /** Runner whose brain records each BrainInput and replies "ok". */
  async function makeRunner(
    board: BoardClient,
  ): Promise<{ runner: AgentRunner; inputs: BrainInput[]; sent: ClientEvent[] }> {
    const inputs: BrainInput[] = [];
    const brain = {
      run: async (input: BrainInput) => {
        inputs.push(input);
        return { text: "ok", providerSessionId: null };
      },
    } as unknown as Brain;
    const { socket, sent } = fakeSocket();
    const dir = await tempDir();
    const runner = new AgentRunner(
      socket,
      brain,
      await Memory.load(dir),
      board,
      await ConversationSessions.load(dir),
      new Presence(socket, board),
      "system prompt",
    );
    return { runner, inputs, sent };
  }

  async function runToSummary(
    runner: AgentRunner,
    sent: ClientEvent[],
    inputs: BrainInput[],
    work: Parameters<AgentRunner["enqueue"]>[0][],
  ): Promise<BrainInput> {
    for (const item of work) runner.enqueue(item);
    await waitFor(() => sent.find((e) => e.type === "agent_run_finish"), "run finish");
    assert.equal(inputs.length, 1);
    return inputs[0];
  }

  test("fetches trigger images for the brain and notes non-image files in the prompt", async () => {
    const fetchedUrls: string[] = [];
    const board = fakeBoard({
      fetchAttachment: async (url: string) => {
        fetchedUrls.push(url);
        return { mime: "image/test", data: url };
      },
    });
    const { runner, inputs, sent } = await makeRunner(board);

    const cat = attachment("cat.png", "image/png", 100);
    const dog = attachment("dog.jpg", "image/jpeg", 200);
    const report = attachment("report.pdf", "application/pdf", 12345);
    const input = await runToSummary(runner, sent, inputs, [
      { authorName: "dana", content: "@noodle look", channel: "general", attachments: [cat, report] },
      { authorName: "sam", content: "@noodle and this", channel: "general", attachments: [dog] },
    ]);

    // Both images arrive as base64 payloads with their served mime, in order.
    assert.deepEqual(fetchedUrls, [cat.url, dog.url]);
    assert.deepEqual(input.images, [
      { mimeType: "image/test", data: cat.url },
      { mimeType: "image/test", data: dog.url },
    ]);
    // The pdf is never fetched but the model is told it exists.
    assert.match(input.prompt, /report\.pdf \(application\/pdf, 12345 bytes\)/);
    assert.doesNotMatch(input.prompt, /omitted|unavailable/);
  });

  test("caps at the four most recent images and notes the ones dropped", async () => {
    const board = fakeBoard({
      fetchAttachment: async (url: string) => ({ mime: "image/png", data: url }),
    });
    const { runner, inputs, sent } = await makeRunner(board);

    const shots = [1, 2, 3, 4, 5].map((i) => attachment(`shot${i}.png`, "image/png", 10));
    const input = await runToSummary(runner, sent, inputs, [
      { authorName: "dana", content: "@noodle compare", channel: "general", attachments: shots },
    ]);

    assert.deepEqual(
      input.images?.map((i) => i.data),
      shots.slice(1).map((a) => a.url),
    );
    assert.match(input.prompt, /shot1\.png \(image\/png, 10 bytes\)/);
  });

  test("skips images that would blow the byte budget but keeps smaller later ones", async () => {
    const board = fakeBoard({
      fetchAttachment: async (url: string) => ({ mime: "image/png", data: url }),
    });
    const { runner, inputs, sent } = await makeRunner(board);

    const MiB = 1024 * 1024;
    const big = attachment("big.png", "image/png", 5 * MiB);
    const overflow = attachment("overflow.png", "image/png", 4 * MiB);
    const small = attachment("small.png", "image/png", 2 * MiB);
    const input = await runToSummary(runner, sent, inputs, [
      { authorName: "dana", content: "@noodle see", channel: "general", attachments: [big, overflow, small] },
    ]);

    // 5 + 4 MiB would cross 8 MiB, so overflow.png is skipped; 5 + 2 still fits.
    assert.deepEqual(
      input.images?.map((i) => i.data),
      [big.url, small.url],
    );
    assert.match(input.prompt, /\[image overflow\.png omitted: too large\]/);
  });

  test("a failed image fetch becomes a prompt note instead of killing the run", async () => {
    const broken = attachment("broken.png", "image/png", 10);
    const good = attachment("good.png", "image/png", 10);
    const board = fakeBoard({
      fetchAttachment: async (url: string) => {
        if (url === broken.url) throw new Error("boom");
        return { mime: "image/png", data: url };
      },
    });
    const { runner, inputs, sent } = await makeRunner(board);

    const input = await runToSummary(runner, sent, inputs, [
      { authorName: "dana", content: "@noodle look", channel: "general", attachments: [broken, good] },
    ]);

    assert.deepEqual(input.images?.map((i) => i.data), [good.url]);
    assert.match(input.prompt, /\[image broken\.png unavailable\]/);
    const finish = sent.find(
      (e): e is Extract<ClientEvent, { type: "agent_run_finish" }> => e.type === "agent_run_finish",
    );
    assert.equal(finish?.finalContent, "ok");
  });
});

function assignment(id: string): AgentWorkAssignment {
  return {
    request: {
      id,
      workspaceId: "workspace-1",
      channelId: "channel-1",
      agentId: "agent-1",
      messageId: `message-${id}`,
      conversationId: "conversation-1",
      status: "claimed",
      createdAt: 1,
      claimedAt: 2,
      completedAt: null,
    },
    conversation: {
      id: "conversation-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      channelId: "channel-1",
      providerSessionId: null,
      permissionMode: "default",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    },
    trigger: {
      id: `message-${id}`,
      authorId: "human-1",
      authorName: "dana",
      authorKind: "human",
      content: "@noodle please help",
      timestamp: 1,
      channelId: "channel-1",
      channel: "general",
      mentions: ["agent-1"],
    },
  };
}

describe("AgentRunner durable work protocol", () => {
  async function makeProtocolRunner(brain: Brain) {
    const { socket, sent } = fakeSocket();
    const board = fakeBoard();
    const dir = await tempDir();
    const sessions = await ConversationSessions.load(dir);
    const runner = new AgentRunner(
      socket,
      brain,
      await Memory.load(dir),
      board,
      sessions,
      new Presence(socket, board),
      "system prompt",
    );
    return { runner, sent, sessions };
  }

  test("resumes a session, emits bounded ordered activity, and finishes after output", async () => {
    let options: BrainRunOptions | undefined;
    const secretSession = "provider-secret-session";
    const brain = {
      run: async (_input: BrainInput, callbacks: BrainCallbacks, runOptions?: BrainRunOptions) => {
        options = runOptions;
        callbacks.onEvent({ type: "thought.delta", text: "thinking" });
        callbacks.onEvent({ type: "output.delta", text: "streamed" });
        callbacks.onEvent({
          type: "tool.started",
          toolCallId: "tool-1",
          name: "read_file",
          source: "native",
          input: { password: "do-not-expose" },
        });
        callbacks.onEvent({
          type: "tool.completed",
          toolCallId: "tool-1",
          name: "read_file",
          output: { token: "do-not-expose", content: "also-secret" },
        });
        callbacks.onEvent({ type: "usage.reported", usage: { inputTokens: 3, outputTokens: 2 } });
        callbacks.onEvent({ type: "provider.session", providerSessionId: secretSession });
        return {
          text: "final answer",
          providerSessionId: secretSession,
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    } as Brain;
    const { runner, sent, sessions } = await makeProtocolRunner(brain);
    await sessions.set("conversation-1", {
      providerSessionId: "persisted-session",
      permissionMode: "plan",
    });
    const work = assignment("request-1");
    work.conversation.permissionMode = "plan";
    runner.enqueueAssignment(work);

    const finish = await waitFor(
      () => sent.find(
        (event): event is Extract<ClientEvent, { type: "agent_run_finish" }> =>
          event.type === "agent_run_finish",
      ),
      "durable run finish",
    );
    assert.equal(options?.providerSessionId, "persisted-session");
    assert.equal(options?.permissionMode, "plan");
    assert.deepEqual(sessions.get("conversation-1"), {
      providerSessionId: secretSession,
      permissionMode: "plan",
    });
    const activity = sent.flatMap((event) => event.type === "activity_batch" ? event.events : []);
    assert.deepEqual(activity.map((event) => event.kind), [
      "agent.thought.delta",
      "agent.output.delta",
      "agent.tool.started",
      "agent.tool.completed",
      "agent.usage.reported",
      "agent.provider.session",
    ]);
    assert.deepEqual(
      activity.find((event) => event.kind === "agent.provider.session")?.payload,
      { captured: true },
    );
    assert.ok(sent.findIndex((event) => event.type === "activity_batch") < sent.indexOf(finish));
    assert.ok(sent.findIndex((event) => event.type === "conversation_session_set") < sent.indexOf(finish));
    assert.equal(JSON.stringify(activity).includes("do-not-expose"), false);
    assert.equal(JSON.stringify(activity).includes(secretSession), false);
    assert.deepEqual(finish, {
      type: "agent_run_finish",
      runId: finish.runId,
      channelId: "channel-1",
      conversationId: "conversation-1",
      requestIds: ["request-1"],
      outcome: "completed",
      finalContent: "final answer",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    assert.equal(sent.some((event) => event.type === "work_complete"), false);
    assert.equal(sent.some((event) => event.type === "summary"), false);

    runner.enqueueAssignment(work);
    await waitFor(
      () => sent.filter((event) => event.type === "agent_run_finish").length === 2,
      "idempotent finish replay",
    );
    assert.deepEqual(
      sent.filter((event) => event.type === "agent_run_finish")[1],
      finish,
    );
  });

  test("does not resend a conversation session the server already assigned", async () => {
    let options: BrainRunOptions | undefined;
    const providerSessionId = "server-provider-session";
    const brain = {
      run: async (_input: BrainInput, callbacks: BrainCallbacks, runOptions?: BrainRunOptions) => {
        options = runOptions;
        callbacks.onEvent({ type: "provider.session", providerSessionId });
        return { text: "done", providerSessionId };
      },
    } as Brain;
    const { runner, sent, sessions } = await makeProtocolRunner(brain);
    const work = assignment("request-session-match");
    work.conversation.providerSessionId = providerSessionId;
    work.conversation.permissionMode = "plan";

    runner.enqueueAssignment(work);
    await waitFor(
      () => sent.find((event) => event.type === "agent_run_finish"),
      "matching-session run finish",
    );

    assert.equal(options?.providerSessionId, providerSessionId);
    assert.equal(options?.permissionMode, "plan");
    assert.deepEqual(sessions.get("conversation-1"), {
      providerSessionId,
      permissionMode: "plan",
    });
    assert.equal(sent.some((event) => event.type === "conversation_session_set"), false);
  });

  test("reports a failed assigned run once with safe error detail", async () => {
    const brain = { run: async () => { throw new Error("token=do-not-expose"); } } as Brain;
    const { runner, sent } = await makeProtocolRunner(brain);
    runner.enqueueAssignment(assignment("request-failed"));
    const finish = await waitFor(
      () => sent.find(
        (event): event is Extract<ClientEvent, { type: "agent_run_finish" }> =>
          event.type === "agent_run_finish",
      ),
      "failed run finish",
    );
    assert.equal(finish.outcome, "failed");
    assert.equal(finish.error, "Brain run failed");
    assert.equal(JSON.stringify(finish).includes("do-not-expose"), false);
    assert.equal(sent.filter((event) => event.type === "agent_run_finish").length, 1);
  });

  test("an aborted assigned batch is cancelled while the interrupt still completes", async () => {
    let runs = 0;
    const brain = {
      run: async (_input: BrainInput, _callbacks: BrainCallbacks, options?: BrainRunOptions) => {
        runs += 1;
        if (runs > 1) return { text: "interrupt acknowledged", providerSessionId: null };
        return new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    } as Brain;
    const { runner, sent } = await makeProtocolRunner(brain);

    runner.enqueueAssignment(assignment("request-2"));
    await waitFor(() => sent.find((event) => event.type === "trace_start"), "run start");
    runner.interruptWith({ authorName: "dana", content: "stop", channel: "general" });
    const cancelled = await waitFor(
      () => sent.find(
        (event): event is Extract<ClientEvent, { type: "agent_run_finish" }> =>
          event.type === "agent_run_finish" && event.outcome === "cancelled",
      ),
      "work cancellation",
    );
    assert.deepEqual(cancelled.requestIds, ["request-2"]);
    assert.equal(cancelled.finalContent, "");
    await waitFor(
      () => sent.find(
        (event) => event.type === "agent_run_finish" && event.outcome === "completed",
      ),
      "interrupt finish",
    );
    assert.equal(sent.some((event) => event.type === "work_complete"), false);
    assert.equal(sent.some((event) => event.type === "summary"), false);
  });

  test("profile prompt updates apply to the next run without changing an active input", async () => {
    const prompts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const brain = {
      run: async (input: BrainInput) => {
        prompts.push(input.system);
        if (prompts.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { text: "ok", providerSessionId: null };
      },
    } as Brain;
    const { runner, sent } = await makeProtocolRunner(brain);
    runner.enqueueAssignment(assignment("prompt-1"));
    await waitFor(() => prompts.length === 1 ? true : undefined, "first prompt");
    runner.updateSystemPrompt("updated profile");
    assert.deepEqual(prompts, ["system prompt"]);
    releaseFirst?.();
    await waitFor(() => sent.some((event) => event.type === "agent_run_finish"), "first finish");
    runner.enqueueAssignment(assignment("prompt-2"));
    await waitFor(() => prompts.length === 2 ? true : undefined, "second prompt");
    assert.deepEqual(prompts, ["system prompt", "updated profile"]);
  });
});
