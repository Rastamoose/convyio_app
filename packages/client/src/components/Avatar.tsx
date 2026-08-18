/* Medium-light so near-black avatar text (--color-body) stays readable. */
const PALETTE = [
  "#eca400",
  "#e8935f",
  "#8fb96a",
  "#6bafa8",
  "#d98bab",
  "#c9c15a",
  "#e0a63e",
  "#a89a7c",
];

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function Avatar({
  name,
  size = 40,
  grayscale = false,
  mascot,
}: {
  name: string;
  size?: number;
  /** Desaturate, e.g. for offline members. */
  grayscale?: boolean;
  /** Force the hosted mascot. Noodle also matches by reserved name. */
  mascot?: boolean;
}) {
  if (mascot || name.toLowerCase() === "noodle") {
    return (
      <img
        src="/favicon.svg"
        alt=""
        className={`shrink-0 rounded-full object-cover ${grayscale ? "grayscale" : ""}`}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-body select-none ${
        grayscale ? "grayscale" : ""
      }`}
      style={{
        width: size,
        height: size,
        backgroundColor: colorFor(name),
        fontSize: size * 0.42,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
