import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatElapsed,
  formatShortTime,
  formatTimestamp,
  relativeTime,
} from "./format";

// Local-time constructors keep these deterministic in any timezone; only the
// digits are asserted so the tests hold in any locale.
const localTs = (
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number => new Date(y, mo, d, h, mi).getTime();

const digits = (s: string) => s.replace(/\D/g, "");

describe("relativeTime", () => {
  afterEach(() => vi.useRealTimers());

  const NOW = new Date("2026-03-12T12:00:00Z").getTime();
  const at = (msAgo: number) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    return relativeTime(NOW - msAgo);
  };

  it("is 'just now' under a minute", () => {
    expect(at(0)).toBe("just now");
    expect(at(59_000)).toBe("just now");
  });

  it("switches to minutes at exactly one minute", () => {
    expect(at(60_000)).toBe("1m ago");
    expect(at(59 * 60_000 + 59_000)).toBe("59m ago");
  });

  it("switches to hours and then days at each boundary", () => {
    expect(at(60 * 60_000)).toBe("1h ago");
    expect(at(23 * 60 * 60_000)).toBe("23h ago");
    expect(at(24 * 60 * 60_000)).toBe("1d ago");
    expect(at(49 * 60 * 60_000)).toBe("2d ago");
  });

  it("clamps future timestamps to 'just now'", () => {
    expect(at(-5_000)).toBe("just now");
  });
});

describe("formatElapsed", () => {
  it("floors at one second", () => {
    expect(formatElapsed(0)).toBe("1s");
    expect(formatElapsed(400)).toBe("1s");
  });

  it("renders seconds only under a minute", () => {
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("renders minutes with remaining seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(3 * 60_000 + 4_000)).toBe("3m 4s");
  });

  it("renders hours with remaining minutes, dropping seconds", () => {
    expect(formatElapsed(60 * 60_000)).toBe("1h 0m");
    expect(formatElapsed(62 * 60_000 + 30_000)).toBe("1h 2m");
  });
});

describe("formatTimestamp", () => {
  it("contains the full date and the 24h time for a fixed instant", () => {
    const out = formatTimestamp(localTs(2026, 2, 7, 14, 5));
    expect(out).toContain("2026");
    // 2-digit day/month/hour/minute regardless of locale ordering.
    expect(digits(out)).toContain("07");
    expect(digits(out)).toContain("03");
    expect(digits(out)).toContain("1405");
  });

  it("changes the date part across a day boundary", () => {
    const datePart = (ts: number) => formatTimestamp(ts).split(",")[0];
    expect(datePart(localTs(2026, 2, 8, 0, 1))).not.toBe(
      datePart(localTs(2026, 2, 7, 23, 59)),
    );
  });
});

describe("formatShortTime", () => {
  it("renders 24h hours and minutes only", () => {
    expect(digits(formatShortTime(localTs(2026, 2, 7, 14, 5)))).toBe("1405");
    expect(digits(formatShortTime(localTs(2026, 2, 7, 0, 0)))).toMatch(
      /^(00|24)00$/,
    );
  });
});
