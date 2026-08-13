import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentWorkAssignment, Attachment, ClientEvent } from "@workspace/shared";
import { AgentRunner } from "../src/runner";
import { Memory } from "../src/memory";
import { PendingWork } from "../src/pendingWork";
import { Presence } from "../src/presence";
import { ConversationSessions } from "../src/conversationSessions";
import type { AgentSocket } from "../src/socket";
import type { BoardClient } from "../src/boardClient";
import type { Brain, BrainInput } from "../src/brain";
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
        return `reply ${prompts.length}`;
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
      await PendingWork.load(dir),
      await ConversationSessions.load(dir),
      new Presence(socket, board),
      "system prompt",
    );

    runner.enqueue({ authorName: "dana", content: "first general", channel: "general" });
    runner.enqueue({ authorName: "sam", content: "random question", channel: "random" });
    runner.enqueue({ authorName: "dana", content: "second general", channel: "general" });

    const summaries = await waitFor(() => {
      const got = sent.filter(
        (e): e is Extract<ClientEvent, { type: "summary" }> => e.type === "summary",
      );
      return got.length === 2 ? got : undefined;
    }, "one summary per channel");

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
      summaries.map((s) => ({ channel: s.channel, content: s.content })),
      [
        { channel: "general", content: "reply 1" },
        { channel: "random", content: "reply 2" },
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
        return "ok";
      },
    } as unknown as Brain;
    const { socket, sent } = fakeSocket();
    const dir = await tempDir();
    const runner = new AgentRunner(
      socket,
      brain,
      await Memory.load(dir),
      board,
      await PendingWork.load(dir),
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
    await waitFor(() => sent.find((e) => e.type === "summary"), "summary");
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
    const summary = sent.find((e): e is Extract<ClientEvent, { type: "summary" }> => e.type === "summary");
    assert.equal(summary?.content, "ok");
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
    const runner = new AgentRunner(
      socket,
      brain,
      await Memory.load(dir),
      board,
      await PendingWork.load(dir),
      await ConversationSessions.load(dir),
      new Presence(socket, board),
      "system prompt",
    );
    return { runner, sent };
  }

  test("claims notifications once per connection and completes only after its summary", async () => {
    const brain = { run: async () => "done" } as unknown as Brain;
    const { runner, sent } = await makeProtocolRunner(brain);

    runner.claimAvailable(["request-1"]);
    runner.claimAvailable(["request-1"]);
    assert.equal(sent.filter((event) => event.type === "work_claim").length, 1);
    runner.onWelcome();
    runner.claimAvailable(["request-1"]);
    assert.equal(sent.filter((event) => event.type === "work_claim").length, 2);

    runner.enqueueAssignment(assignment("request-1"));
    await waitFor(
      () => sent.find((event) => event.type === "work_complete"),
      "work completion",
    );
    const summaryIndex = sent.findIndex((event) => event.type === "summary");
    const completionIndex = sent.findIndex((event) => event.type === "work_complete");
    assert.ok(summaryIndex >= 0 && completionIndex > summaryIndex);
    assert.deepEqual(sent[completionIndex], {
      type: "work_complete",
      requestIds: ["request-1"],
      outcome: "completed",
    });
  });

  test("an aborted assigned batch is cancelled and never completed", async () => {
    let runs = 0;
    const brain = {
      run: async (_input: BrainInput, _callbacks: unknown, options?: { signal?: AbortSignal }) => {
        runs += 1;
        if (runs > 1) return "interrupt acknowledged";
        return new Promise<string>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    } as unknown as Brain;
    const { runner, sent } = await makeProtocolRunner(brain);

    runner.enqueueAssignment(assignment("request-2"));
    await waitFor(() => sent.find((event) => event.type === "trace_start"), "run start");
    runner.interruptWith({ authorName: "dana", content: "stop", channel: "general" });
    const cancelled = await waitFor(
      () => sent.find(
        (event): event is Extract<ClientEvent, { type: "work_complete" }> =>
          event.type === "work_complete" && event.outcome === "cancelled",
      ),
      "work cancellation",
    );
    assert.deepEqual(cancelled.requestIds, ["request-2"]);
    assert.equal(
      sent.some(
        (event) =>
          event.type === "work_complete" &&
          event.outcome === "completed" &&
          event.requestIds.includes("request-2"),
      ),
      false,
    );
  });
});
