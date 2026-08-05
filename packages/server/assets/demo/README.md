# Demo assets

Data consumed by `src/demo` — no code lives here.

## scripts/

One JSON file per demo channel, validated against the schema in
`src/demo/script.ts` at load. `{agent}` in a step's `say` is replaced with the
online agent's name. A step may `await`:

- `agent_reply` — pause until an agent posts in the demo channel
- `approve_proposal` — approve the proposal the agent filed during this run
  (as the step's author), then wait for the agent's completion reply

## seed/

Fixture trees copied verbatim into the shared workspace before playback when
a script sets `seedDir`. `billing/` is a fake billing module with a real,
findable rounding inconsistency:

- `invoice-render.ts` rounds each converted line, then sums the rounded
  floats (accumulating float dust in the total);
- `pdf-export.ts` sums the raw amounts and rounds the converted total once;
- `ledger-sync.ts` rounds per line like the renderer.

The three surfaces therefore disagree by cents on the same invoice. The
constraint the bug demo hinges on — ledger-sync must keep matching what
Stripe already charged — is deliberately NOT written anywhere in these
files: it only exists in a teammate's head and arrives via chat.
