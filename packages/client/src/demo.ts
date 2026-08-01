export interface DemoStep {
  author: string;
  content: string;
  waitForAgent?: boolean;
}

export const PERSONA_A = "Alex";
export const PERSONA_B = "Blair";
export const AGENT_NAME = "Agent";

const STEP_DELAY_MS = 4500;
const AGENT_THINKING_MS = 3500;

function buildScript(agent: string): DemoStep[] {
  return [
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
}

const AGENT_REPLIES: Record<number, string> = {
  4: `Here are a few options:

**Landing page hero**
1. Your team and agents, in one room.
2. Chat with your team and agents together.
3. One room for people and agents.

**HN one-liner**
1. Team chat that includes your agents.
2. A shared workspace for your team and its agents.
3. Your team and agents, collaborating in one room.`,
  5: `Done.

**Hero:** Your team and agents, together in one room.
**HN:** Team chat that includes your agents.`,
  6: `Final picks:
- Hero: Your team and agents, in one room.
- HN: Team chat that includes your agents.`,
};

export interface LocalDemoCallbacks {
  onPost: (
    kind: "human" | "agent",
    name: string,
    content: string,
  ) => void;
  onAgentStart: () => void;
  onAgentDone: () => void;
  onFinished: () => void;
}

/**
 * Plays the scripted demo entirely in the browser. No websocket, no real
 * agent — just the conversation replay with hard-coded agent replies.
 */
export function runLocalDemo(
  channel: string,
  callbacks: LocalDemoCallbacks,
): () => void {
  const script = buildScript(AGENT_NAME);
  let cancelled = false;
  let generation = 0;

  const cancel = () => {
    cancelled = true;
    generation++;
  };

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

    for (let i = 0; i < script.length; i++) {
      await delay(STEP_DELAY_MS);
      if (cancelled || gen !== generation) return;

      const step = script[i];
      callbacks.onPost("human", step.author, step.content);

      if (step.waitForAgent) {
        callbacks.onAgentStart();
        await delay(AGENT_THINKING_MS);
        if (cancelled || gen !== generation) return;
        callbacks.onAgentDone();

        const reply = AGENT_REPLIES[i];
        if (reply) {
          callbacks.onPost("agent", AGENT_NAME, reply);
        }
      }
    }

    await delay(STEP_DELAY_MS);
    if (cancelled || gen !== generation) return;
    callbacks.onFinished();
  })();

  return cancel;
}
