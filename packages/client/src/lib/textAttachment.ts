import type { Attachment } from "@workspace/shared";

/** Chat body stays this short; anything longer is sent as a text file. */
export const MESSAGE_BODY_LIMIT = 4000;
export const LONG_MESSAGE_PREVIEW = 280;
export const LONG_MESSAGE_FILENAME = "message.txt";

const MENTION_RE = /@[\p{L}\p{N}_-]+/gu;

export function isTextAttachment(attachment: Attachment): boolean {
  if (attachment.mime.startsWith("text/")) return true;
  return /\.(txt|md|markdown|csv|json|log)$/i.test(attachment.name);
}

/**
 * When the draft is too long for a chat body, keep a short preview (and any
 * @mentions the preview would drop, so agent dispatch still fires) and put
 * the full text in a file.
 */
export function splitOversizedMessage(
  text: string,
): { content: string; file: File } | null {
  if (text.length <= MESSAGE_BODY_LIMIT) return null;
  const excerpt = preview(text, LONG_MESSAGE_PREVIEW);
  const leftover = leftoverMentions(text, excerpt);
  const content = leftover.length > 0 ? `${excerpt}\n${leftover.join(" ")}` : excerpt;
  const file = new File([text], LONG_MESSAGE_FILENAME, { type: "text/plain" });
  return { content, file };
}

function preview(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const newline = slice.lastIndexOf("\n");
  const space = slice.lastIndexOf(" ");
  const cut =
    newline >= max * 0.5 ? newline : space >= max * 0.5 ? space : max;
  return `${slice.slice(0, cut).trimEnd()}…`;
}

function leftoverMentions(text: string, excerpt: string): string[] {
  const found = text.match(MENTION_RE) ?? [];
  return [...new Set(found)].filter((mention) => !excerpt.includes(mention));
}
