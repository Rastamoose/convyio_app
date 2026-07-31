import type { ChatMessage } from "@workspace/shared";
import type { Hub } from "../hub";

interface Step {
  author: string;
  content: string;
  /** Pause after posting until an agent replies in the demo channel. */
  waitForAgent?: boolean;
}

const PERSONA_A = "alex";
const PERSONA_B = "blair";
const STEP_DELAY_MS = 4500;
const AGENT_TIMEOUT_MS = 90_000;

const buildScript = (agent: string): Step[] => [
  {
    author: PERSONA_A,
    content:
      'team — launch is Friday. the landing page hero still says "AI workspace beta" and it reads flat',
  },
  {
    author: PERSONA_B,
    content:
      'yeah and we still don\'t have a one-liner for the HN post. we agreed the angle is "your team and your agents in one room" but nothing is written',
  },
  {
    author: PERSONA_A,
    content:
      'constraints: no buzzwords, under 10 words for the hero, and don\'t use the word "platform" — we keep sounding like everyone else',
  },
  {
    author: PERSONA_B,
    content:
      "also the HN crowd hates marketing speak, it should sound like it was written by an engineer",
  },
  {
    author: PERSONA_A,
    content: `@${agent} read the conversation above. draft 3 options for the landing page hero line and 3 options for the HN post one-liner. respect the constraints we discussed.`,
    waitForAgent: true,
  },
  {
    author: PERSONA_B,
    content: `@${agent} hero option 2 is closest. make it punchier and drop any mention of AI — the product is the room, not the model`,
    waitForAgent: true,
  },
  {
    author: PERSONA_A,
    content: `@${agent} give me the final picks: one hero line, one HN one-liner, nothing else`,
    waitForAgent: true,
  },
];

/**
 * Plays a scripted two-person conversation into a channel through the hub's
 * synthetic-participant API, pausing between lines and waiting for real agent
 * replies. Pure demo scaffolding — the hub itself stays dumb.
 */
export class DemoRunner {
  private running = false;
  /** Bumped on every start; a stale generation aborts its loop. */
  private generation = 0;
  private agentReplyWaiter: ((message: ChatMessage) => void) | null = null;
  private cancelWait: (() => void) | null = null;

  constructor(private hub: Hub) {
    hub.onDemoStart = (channel) => void this.start(channel);
    hub.onMessagePosted = (message) => {
      if (message.authorKind === "agent") {
        this.agentReplyWaiter?.(message);
      }
    };
  }

  /** Always restarts from the top: cancels any in-flight run and clears the channel. */
  private async start(channel: string): Promise<void> {
    const gen = ++this.generation;
    this.cancelWait?.();

    // Let a previous run unwind before starting over.
    while (this.running) {
      await delay(50);
      if (gen !== this.generation) return; // superseded by an even newer start
    }
    this.running = true;
    console.log(`[demo] starting scripted demo in #${channel}`);

    try {
      await this.hub.clearChannel(channel);

      const agentName = this.hub.findOnlineAgentName();
      if (!agentName) {
        await this.hub.postAsSynthetic(
          PERSONA_A,
          "(demo aborted: no agent is online — start the agent process first)",
          channel,
        );
        return;
      }

      for (const step of buildScript(agentName)) {
        await delay(STEP_DELAY_MS);
        if (gen !== this.generation) return;
        await this.hub.postAsSynthetic(step.author, step.content, channel);
        if (step.waitForAgent) {
          await this.waitForAgentReply(channel);
          if (gen !== this.generation) return;
        }
      }
    } catch (err) {
      console.warn("[demo] aborted:", err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
      if (gen === this.generation) {
        this.hub.removeSynthetic([PERSONA_A, PERSONA_B]);
      }
      console.log("[demo] finished");
    }
  }

  private waitForAgentReply(channel: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.agentReplyWaiter = null;
        this.cancelWait = null;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for agent reply"));
      }, AGENT_TIMEOUT_MS);

      this.cancelWait = () => {
        cleanup();
        resolve(); // generation check right after the await aborts the loop
      };
      this.agentReplyWaiter = (message) => {
        if ((message.channel ?? "general") !== channel) return;
        cleanup();
        resolve();
      };
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
