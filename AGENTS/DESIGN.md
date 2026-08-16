# Design Language

The visual contract for anything convyio renders. Written to be portable: this
file names no source files, so it can govern the app and the landing site alike.
Where it and the code disagree, one of them is wrong — decide which, and fix in
the same change.

**Thesis.** Calm canvas, warm signal. A workspace people stare at all day must
disappear: quiet neutral surfaces, hierarchy carried by type and space, color
spend almost nothing. The brand's warmth — the amber, the mono voice, the
play — is *concentrated*, not diluted: one accent family that means
action/attention/aliveness, and personality carried by copy and small moments
rather than by styling every surface.

Restraint is the aesthetic. If a screen needs a new color, radius, shadow, or
font to work, the screen is wrong before the palette is.

---

## 1. Tokens are named for their role, never their hue

A token says what a thing *is*, not what it looks like. `--color-accent`, not
`--color-blurple` (which was amber). `--color-on-accent` for ink sitting on a
saturated fill. A name that lies about its value, or describes a value instead
of a role, is renamed on sight — migrate every caller, delete the old name.

Layers, in order of how much they may draw the eye:

- **Surfaces** — `canvas` (the outermost backdrop), `chat` (the content
  panel), `input`, `popup`, `composer`, `subtle` / `subtle-hover` (generic
  rests and hovers). Neutral, warm-leaning greys.
- **Ink** — `body`, `muted`, `faint`, plus `on-accent` and `overlay-ink` for
  text on saturated fills and dimmed backdrops.
- **Accent** — `accent` and `accent-hover`. One family. See §3.
- **Status** — `online`, `working`, `away`, `dead`, `offline`. Semantic only;
  never borrowed for decoration (a status hue as a button hover is a leak).
- **Lines** — `divider`, `popup-border`. Hairlines, not borders-as-decoration.

Components address colors by these names and never hardcode a hex, and never
branch on the active theme — dark mode re-points the same tokens.

## 2. The desk: tonal zones, glass only for floats

The layout is full-bleed and flat — no floating content card, no boxed
panels. The `canvas` is the desk: the sidebar rests on it full-height with a
single hairline edge, and the content area (chat, board) runs edge-to-edge
on its own tone. Regions separate by tonal step plus at most one hairline,
never by nested rounded boxes. The sidebar is chrome, not content — it never
gets a panel of its own, and it collapses away entirely (⌘B / Ctrl-B) so the
content can take the window. The board is not a destination but a workbench:
it can pin open as a pane beside the chat, because sign-off belongs in the
same view as the conversation.

Only things that *float* above the page — popovers, menus, toasts, modals,
drawers, autocomplete — get shadow plus a hairline border, from the one
`elevated` utility (test-enforced), and they are **glass**: a translucent
tint over `backdrop-filter` blur with saturation pushed back up, so they read
as panes, not smudges. No hard offset ("neo-brutalist") shadows, no
`border-2` ink frames, no translate-on-press skeuomorphs: that is the
marketing site's dialect, and it stays there.

Every surface is a flat token colour — **no colour gradients anywhere**: no
background washes, glows, or fades. Depth comes from the tonal ladder and
hairlines, never from a gradient.

## 3. One accent, spent deliberately

The amber accent is the warmest thing on screen, so it is reserved for:

- the primary action on a surface (one per view),
- attention: mentions, unread counts, deep links, selection,
- aliveness: the accent family is deliberately close to the `working` status
  hue — an agent at work pulses in the brand color. That rhyme is intended;
  keep status and accent near each other and let *saturation/context* separate
  them.

Mentions are the one place the accent appears as a *wash* rather than a solid:
an @mention renders as a highlighter stroke (`bg-accent/25`, ink unchanged) —
the landing page's marker gesture inside the product. Never a solid pill for
inline text; solid accent is for buttons and badges only.

Everything else is neutral. Secondary actions are quiet (subtle fill or ghost);
danger is the red status hue and nothing else. A second accent color is a
design bug.

## 4. Typography does the hierarchy

- **Sans for reading.** UI text, messages, forms: the system sans stack
  (`ui-sans-serif` → SF on macOS). Weight and size — not color or decoration —
  separate heading from body from caption.
- **Mono for code only.** The platform's own mono (`ui-monospace` → SF Mono
  on macOS) sets literal code: inline code, code blocks, shell commands,
  invite codes. Everything else — micro-labels, pills, badges, board refs —
  is sans; hierarchy comes from size, weight and tracking, not a second
  voice. No webfonts are shipped.
- **No ad-hoc sizes.** The scale is `text-xs` / `text-sm` / `text-base` /
  `text-lg` / `text-xl` / `text-2xl`; micro-labels use `text-[10-11px]` with
  `uppercase tracking-wide`. A `text-[15px]`-style one-off wants a reason.

## 5. Consistency is the feature

- **Radii.** `rounded-md` for controls (buttons, inputs, chips),
  `rounded-lg` for cards, menus and popovers, `rounded-xl`/`2xl` for modals,
  drawers and auth panels. Nothing else without a reason.
- **Buttons.** Three shapes only: primary (solid accent, `on-accent` ink),
  secondary/ghost (subtle fill or bare text), danger (status red). All
  `rounded-md`, hover by fill-step, never by invented shadow.
- **Inputs.** `bg-input`, hairline `border-divider`, focus shown by the accent
  ring — one pattern, everywhere, including the accent `focus-visible` outline
  the stylesheet applies globally.
- **Focus is part of the design.** Never remove an outline without replacing
  it with an equally visible accent signal.

## 6. Both themes are designed, not derived

Dark mode is the same decisions re-made for dark surfaces, token by token.
It is **never pure black**: a warm charcoal ladder whose steps sit ~6-8
luminance points apart, so depth comes from light rather than borders.
Borders lead where shadows stop reading, status hues lift in lightness, the
accent warms. "It inverted okay" is not acceptance. Every screen is checked
in both themes before a visual change is done.

## 7. Personality lives in voice and moments

The playfulness is copy ("Nothing waiting on you", "choose well"), the smiley
mark, the tiny uppercase micro-labels, the dashed "add agent" invitation, the amber pulse
of an agent at work. Chrome stays quiet so those moments register. When a
screen feels bland, fix the words or the moment — do not decorate the chrome.
