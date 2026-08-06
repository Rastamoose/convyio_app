/**
 * Date/time formatting for chat and board timestamps — the single source so
 * every component renders times the same way.
 */

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today" / "Yesterday" by local calendar day, or null for anything older. */
function relativeDay(ts: number): string | null {
  const d = new Date(ts);
  const now = new Date();
  if (sameDay(d, now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return null;
}

/** "Today" / "Yesterday" / "12 March 2026" — day-divider line in the message list. */
export function formatDivider(ts: number): string {
  return (
    relativeDay(ts) ??
    new Date(ts).toLocaleDateString(undefined, {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
  );
}

/** "Today at 14:05" / "Yesterday at 14:05" / "12/03/2026, 14:05" — beside a message author. */
export function formatTimestamp(ts: number): string {
  const day = relativeDay(ts);
  if (day) return `${day} at ${formatShortTime(ts)}`;
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })}, ${formatShortTime(ts)}`;
}

/** "14:05" — hover timestamp on grouped messages. */
export function formatShortTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "12 March 2026, 14:05:32" — full-precision hover tooltip on any timestamp. */
export function formatFullDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  })}, ${d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })}`;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" — age of a board item or event. */
export function relativeTime(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "1h 2m" / "3m 4s" / "5s" — duration of an agent run or task (min 1s). */
export function formatElapsed(ms: number): string {
  const s = Math.max(1, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
