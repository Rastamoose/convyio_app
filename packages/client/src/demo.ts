import type { BoardItem } from "@workspace/shared";

export const AGENT_NAME = "Agent";

/** Channels that have a scripted demo (server-driven or local fallback). */
export const DEMO_CHANNELS = ["demo", "demo-bug"];

const STEP_DELAY_MS = 4500;
const BOARD_DELAY_MS = 1200;
const AGENT_THINKING_MS = 3500;

export type LocalStep =
  | { kind: "human"; author: string; content: string }
  | { kind: "agent"; content: string; status?: string; thinkingMs?: number }
  | { kind: "board"; line?: string; item?: BoardItem };

export interface LocalScript {
  personas: string[];
  steps: LocalStep[];
}

// ---------------------------------------------------------------------------
// #demo — marketing copy drafting
// ---------------------------------------------------------------------------

function buildCopyScript(agent: string): LocalScript {
  return {
    personas: ["Alex", "Blair"],
    steps: [
      {
        kind: "human",
        author: "Alex",
        content:
          'team — launch is Friday. the landing page hero still says "AI workspace beta" and it reads flat',
      },
      {
        kind: "human",
        author: "Blair",
        content:
          'yeah and we still don\'t have a one-liner for the HN post. we agreed the angle is "your team and your agents in one room" but nothing is written',
      },
      {
        kind: "human",
        author: "Alex",
        content:
          'constraints: no buzzwords, under 10 words for the hero, and don\'t use the word "platform" — we keep sounding like everyone else',
      },
      {
        kind: "human",
        author: "Blair",
        content:
          "also the HN crowd hates marketing speak, it should sound like it was written by an engineer",
      },
      {
        kind: "human",
        author: "Alex",
        content: `@${agent} read the conversation above. draft 3 options for the landing page hero line and 3 options for the HN post one-liner. respect the constraints we discussed.`,
      },
      {
        kind: "agent",
        status: "drafting…",
        content: `Here are a few options:

**Landing page hero**
1. Your team and agents, in one room.
2. Chat with your team and agents together.
3. One room for people and agents.

**HN one-liner**
1. Team chat that includes your agents.
2. A shared workspace for your team and its agents.
3. Your team and agents, collaborating in one room.`,
      },
      {
        kind: "human",
        author: "Blair",
        content: `@${agent} hero option 2 is closest. make it punchier and drop any mention of AI — the product is the room, not the model`,
      },
      {
        kind: "agent",
        status: "drafting…",
        content: `Done.

**Hero:** Your team and agents, together in one room.
**HN:** Team chat that includes your agents.`,
      },
      {
        kind: "human",
        author: "Alex",
        content: `@${agent} give me the final picks: one hero line, one HN one-liner, nothing else`,
      },
      {
        kind: "agent",
        status: "drafting…",
        content: `Final picks:
- Hero: Your team and agents, in one room.
- HN: Team chat that includes your agents.`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// #demo-bug — the multi-currency rounding bug: an agent investigates, is
// gated behind a board proposal, and a teammate's constraint lands before
// any code is written.
// ---------------------------------------------------------------------------

function buildBugScript(agent: string): LocalScript {
  const now = Date.now();
  const base: BoardItem = {
    id: "demo-bug-item",
    serverId: "local",
    ref: "task-7",
    title: "Unify multi-currency rounding across billing surfaces",
    description: null,
    status: "proposed",
    origin: "agent",
    createdBy: "demo-agent",
    approvedBy: null,
    owner: null,
    proposalWhy:
      "invoice render, PDF export, and ledger sync each round FX conversion differently, so the same invoice shows three different totals",
    proposalEffect:
      "all billing surfaces derive totals from the same rounded line amounts; totals agree to the cent",
    createdAt: now,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    createdByName: agent,
  };

  return {
    personas: ["Maya", "Tom"],
    steps: [
      {
        kind: "human",
        author: "Maya",
        content:
          "heads up — Meridian Accounting escalated this morning: every multi-currency invoice is off by a few cents per line item. their accountants are flagging each one by hand",
      },
      {
        kind: "human",
        author: "Tom",
        content:
          "I can reproduce it. it's worse than one bug — the in-app invoice, the PDF export, and the ledger all show slightly different totals for the same invoice",
      },
      {
        kind: "human",
        author: "Maya",
        content: `@${agent} before anyone touches code: read the files under billing/ in the workspace, find the root cause of the rounding discrepancy, and file a board proposal with your fix plan. do NOT modify any files yet.`,
      },
      {
        kind: "agent",
        status: "investigating billing/…",
        thinkingMs: 5000,
        content: `Maya: found it. all three surfaces round the FX conversion differently:

- \`invoice-render.ts\` rounds each converted line, then sums the already-rounded floats — the total accumulates floating-point dust
- \`pdf-export.ts\` sums the raw amounts first and rounds the converted total once
- \`ledger-sync.ts\` rounds per line, like the renderer

Same invoice, three rounding orders, three totals. Root cause: money lives in floats and each caller picks its own rounding order around the shared \`roundMoney\` helper.

I've filed **task-7** with my fix plan: do conversion in integer cents in one shared helper and make every surface derive its total from the same rounded line amounts. No files touched — waiting for approval.`,
      },
      {
        kind: "board",
        line: `${agent} proposed task-7 — "Unify multi-currency rounding across billing surfaces"`,
        item: base,
      },
      {
        kind: "human",
        author: "Tom",
        content: `@${agent} hold on before that gets approved — ledger-sync has to keep matching what Stripe already charged, to the cent. if rounding changes there, reconciliation breaks for every past invoice. confirm your plan leaves ledger-sync's output unchanged; don't file a new proposal, just restate the corrected plan here in chat.`,
      },
      {
        kind: "agent",
        status: "revising plan…",
        content: `Tom: good catch — that constraint isn't written anywhere in billing/, so I had no way to know it. Corrected plan for task-7:

1. \`ledger-sync.ts\` keeps its exact current behaviour, so amounts keep matching what Stripe already charged — plus a regression test pinning its per-line output
2. \`invoice-render.ts\` and \`pdf-export.ts\` are unified onto the same rounded line amounts (matching the ledger's per-line rounding), so all three surfaces agree

Net effect: the app, the PDF, and the ledger report identical totals, and nothing that already reconciled changes.`,
      },
      {
        kind: "human",
        author: "Maya",
        content:
          "good catch — that would have shipped broken and we'd have caught it in PR review after the work was done. approving the proposal now.",
      },
      {
        kind: "board",
        line: "Maya approved task-7",
        item: {
          ...base,
          status: "approved",
          approvedBy: "demo-maya",
          approvedByName: "Maya",
          approvedAt: now,
        },
      },
      {
        kind: "board",
        item: {
          ...base,
          status: "in_progress",
          approvedBy: "demo-maya",
          approvedByName: "Maya",
          approvedAt: now,
          owner: "demo-agent",
          ownerName: agent,
          startedAt: now,
        },
      },
      {
        kind: "agent",
        status: "Working on task-7…",
        thinkingMs: 6000,
        content: `Done — task-7 complete.

- \`round.ts\`: conversion now happens in integer cents in one shared helper
- \`invoice-render.ts\` + \`pdf-export.ts\`: totals are the sum of the same rounded line amounts — the app and the PDF can no longer disagree
- \`ledger-sync.ts\`: untouched, with a regression test pinning its per-line output so Stripe reconciliation holds

All three surfaces now report identical totals for the same invoice.`,
      },
      {
        kind: "board",
        line: `${agent} completed task-7`,
        item: {
          ...base,
          status: "done",
          approvedBy: "demo-maya",
          approvedByName: "Maya",
          approvedAt: now,
          owner: "demo-agent",
          ownerName: agent,
          startedAt: now,
          completedAt: now,
        },
      },
      {
        kind: "human",
        author: "Tom",
        content:
          "one run, one review. the ledger constraint got in front of the agent before the code existed instead of in a review comment after.",
      },
    ],
  };
}

export function getLocalScript(channel: string): LocalScript | null {
  switch (channel) {
    case "demo":
      return buildCopyScript(AGENT_NAME);
    case "demo-bug":
      return buildBugScript(AGENT_NAME);
    default:
      return null;
  }
}

export interface LocalDemoCallbacks {
  onPost: (kind: "human" | "agent", name: string, content: string) => void;
  onAgentStart: (status: string) => void;
  onAgentDone: () => void;
  onBoardLine: (text: string) => void;
  onBoardItem: (item: BoardItem) => void;
  onFinished: (personas: string[]) => void;
}

/**
 * Plays a scripted demo entirely in the browser. No websocket, no real
 * agent — just the conversation replay with hard-coded agent replies and
 * board updates.
 */
export function runLocalDemo(
  channel: string,
  callbacks: LocalDemoCallbacks,
): () => void {
  const script = getLocalScript(channel);
  let cancelled = false;
  let generation = 0;

  const cancel = () => {
    cancelled = true;
    generation++;
  };
  if (!script) return cancel;

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = window.setTimeout(finish, ms);
      const check = () => {
        if (done) return;
        if (cancelled) {
          window.clearTimeout(timer);
          finish();
          return;
        }
        window.setTimeout(check, 50);
      };
      window.setTimeout(check, 50);
    });

  (async () => {
    const gen = ++generation;

    for (const step of script.steps) {
      await delay(step.kind === "board" ? BOARD_DELAY_MS : STEP_DELAY_MS);
      if (cancelled || gen !== generation) return;

      switch (step.kind) {
        case "human":
          callbacks.onPost("human", step.author, step.content);
          break;
        case "agent": {
          callbacks.onAgentStart(step.status ?? "working…");
          await delay(step.thinkingMs ?? AGENT_THINKING_MS);
          if (cancelled || gen !== generation) return;
          callbacks.onAgentDone();
          callbacks.onPost("agent", AGENT_NAME, step.content);
          break;
        }
        case "board":
          if (step.item) callbacks.onBoardItem(step.item);
          if (step.line) callbacks.onBoardLine(step.line);
          break;
      }
    }

    await delay(STEP_DELAY_MS);
    if (cancelled || gen !== generation) return;
    callbacks.onFinished(script.personas);
  })();

  return cancel;
}
