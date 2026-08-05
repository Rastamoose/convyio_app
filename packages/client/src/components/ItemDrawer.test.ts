import { describe, expect, it } from "vitest";
import { parseScopePaths } from "./ItemDrawer";

describe("parseScopePaths", () => {
  it("splits on newlines", () => {
    expect(parseScopePaths("billing/\ndocs/README.md")).toEqual([
      "billing/",
      "docs/README.md",
    ]);
  });

  it("splits on commas", () => {
    expect(parseScopePaths("a.ts, b.ts,c.ts")).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("mixes both separators and trims whitespace", () => {
    expect(parseScopePaths("  billing/ ,\n docs/README.md \n")).toEqual([
      "billing/",
      "docs/README.md",
    ]);
  });

  it("drops empty entries from consecutive separators", () => {
    expect(parseScopePaths("a.ts,,\n\n,b.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("treats empty or all-whitespace input as unrestricted (null)", () => {
    expect(parseScopePaths("")).toBeNull();
    expect(parseScopePaths("  \n , \n  ")).toBeNull();
  });
});
