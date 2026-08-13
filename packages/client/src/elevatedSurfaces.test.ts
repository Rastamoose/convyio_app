import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guards the rule in AGENTS/AGENTS_PROGRAMMING_STANDARD.md §11: a surface that
 * floats above the page wears `.elevated`, never a bare `bg-popup`.
 *
 * The defect this exists to catch is invisible in a render test — `--color-popup`
 * and `--color-chat` are both `#ffffff`, so a borderless popover dissolves into
 * the message list while every assertion still passes. jsdom applies no
 * stylesheet, so the only place the mistake is observable is the source text.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)));

/** Every .tsx under src/, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")
      ? [full]
      : [];
  });
}

/**
 * Candidate class lists. Splitting on quote characters isolates each
 * `className="…"` value; code between them never mentions these utilities. A
 * className built from a template literal splits at its embedded quotes, which
 * can hide a violation but can never invent one — this errs toward silence.
 */
function classLists(src: string): string[] {
  return src.split(/["'`]/);
}

const FLOATS = /\b(?:fixed|absolute)\b/;
const LAYERED = /\bz-(?:\d|\[)/;

describe("elevated surfaces", () => {
  const files = sources(SRC);

  it("finds the components to check", () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it("gives every floating surface a border and shadow via .elevated", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const list of classLists(readFileSync(file, "utf8"))) {
        if (!list.includes("bg-popup")) continue;
        if (!FLOATS.test(list) || !LAYERED.test(list)) continue;
        offenders.push(`${path.relative(SRC, file)}: ${list.trim()}`);
      }
    }
    expect(offenders, "floating surfaces must use `elevated`, not raw `bg-popup`").toEqual([]);
  });

  it("keeps .elevated the single source of a popover's background and edge", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const list of classLists(readFileSync(file, "utf8"))) {
        if (!/\belevated\b/.test(list)) continue;
        const dupes = ["bg-popup", "shadow-lg", "shadow-sm", "shadow-2xl", "border-divider"].filter(
          (cls) => list.includes(cls),
        );
        if (dupes.length) offenders.push(`${path.relative(SRC, file)}: redundant ${dupes.join(", ")}`);
      }
    }
    expect(offenders, "`elevated` already sets background, border and shadow").toEqual([]);
  });
});
