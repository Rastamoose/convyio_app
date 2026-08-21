# Demo assets

Data consumed by `src/demo` — no code lives here.

## scripts/

One JSON file per demo channel, validated against the schema in
`src/demo/script.ts` at load. `{agent}` in a step's `say` is replaced with the
online agent's name. Walkthrough scripts can post messages, focus semantic UI
targets, pause at chapter checkpoints, create Plans and Tickets, and wait for
real human acceptance or approval.

## seed/

Fixture trees copied verbatim into the shared workspace before playback when
a script sets `seedDir`.

`api-contract/` contains a small API and two independently owned consumers:

- `server/project-response.ts` exposes the existing `owner_name` field;
- `web/project-card.ts` is the web consumer that can update with the API;
- `mobile/project-client.ts` is an existing consumer that cannot update yet;
- `check.ts` verifies that the new `owner` field works while `owner_name` and the
  unchanged mobile client remain compatible.

The demo uses this split ownership to show why backend and client context must
meet before one implementation is authorized.
