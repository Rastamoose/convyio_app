const PALETTE = [
  "#cc241d",
  "#98971a",
  "#d79921",
  "#458588",
  "#b16286",
  "#689d6a",
  "#d65d0e",
  "#928374",
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
}: {
  name: string;
  size?: number;
  /** Desaturate, e.g. for offline members. */
  grayscale?: boolean;
}) {
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
