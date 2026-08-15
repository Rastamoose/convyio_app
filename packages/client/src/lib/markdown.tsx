/**
 * Chat content rendering: two entry points sharing one mention/task-ref
 * tokenizer.
 *
 * `renderContent` is length-preserving — it only wraps @mentions and
 * task-refs in spans, never removing or hiding characters. MessageInput
 * paints it onto a transparent-textarea overlay that must stay pixel-aligned
 * with the real textarea text, so it must never gain markdown handling.
 *
 * `renderMessageContent` is the richer renderer for sent messages: code
 * blocks/spans, blockquotes, bold/underline/italic/strike, autolinked URLs,
 * then mentions/task-refs on whatever plain text is left. It never uses
 * dangerouslySetInnerHTML, so escaping is automatic — a "<script>" in a
 * message is just text.
 */
import { Fragment } from "react";

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildMentionRegex(names: string[]): RegExp | null {
  if (names.length === 0) return null;
  const sorted = [...names].sort((a, b) => b.length - a.length);
  return new RegExp(`@(${sorted.map(escapeRegex).join("|")})(?![\\w-])`, "g");
}

const TASK_REF_REGEX = /\btask-\d+\b/g;

export function renderContent(
  content: string,
  mentionRegex: RegExp | null,
  pill = true,
  onRefClick?: (ref: string) => void,
): React.ReactNode {
  interface Token {
    start: number;
    end: number;
    node: React.ReactNode;
  }
  const tokens: Token[] = [];
  if (mentionRegex && content.includes("@")) {
    for (const match of content.matchAll(mentionRegex)) {
      const index = match.index ?? 0;
      tokens.push({
        start: index,
        end: index + match[0].length,
        node: (
          <span
            key={`m${index}`}
            className={
              pill
                ? "box-decoration-clone rounded-sm bg-accent/25 px-0.5 font-medium"
                : "box-decoration-clone rounded-sm bg-accent/25 font-medium"
            }
          >
            {match[0]}
          </span>
        ),
      });
    }
  }
  for (const match of content.matchAll(TASK_REF_REGEX)) {
    const index = match.index ?? 0;
    const ref = match[0];
    tokens.push({
      start: index,
      end: index + ref.length,
      node: onRefClick ? (
        <span
          key={`t${index}`}
          onClick={() => onRefClick(ref)}
          className="cursor-pointer rounded bg-subtle px-1 font-mono text-[0.9em] font-semibold text-accent"
        >
          {ref}
        </span>
      ) : (
        <span
          key={`t${index}`}
          className="rounded bg-subtle px-1 font-mono text-[0.9em] font-semibold text-accent"
        >
          {ref}
        </span>
      ),
    });
  }
  if (tokens.length === 0) return content;
  tokens.sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const token of tokens) {
    if (token.start < last) continue; // skip overlapping tokens
    if (token.start > last) parts.push(content.slice(last, token.start));
    parts.push(token.node);
    last = token.end;
  }
  if (last < content.length) parts.push(content.slice(last));
  return parts;
}

// Fenced code blocks are pulled out of the whole message first (they can
// span lines); everything else is handled line by line.
const CODE_BLOCK_REGEX = /```(\w*)\n([\s\S]*?)```/g;

// Inline code takes precedence over markdown emphasis; among the emphasis
// delimiters, two-char ones (bold/underline/strike) are tried before the
// single-char italic ones so "**x**" doesn't parse as italic("*x*") wrapped
// in stray asterisks. Content must start/end on a non-space char so stray
// asterisks around spaced text (e.g. "3 * 4 * 5") don't turn into italics.
const INLINE_REGEX =
  /`([^`]+)`|\*\*(\S(?:.*?\S)?)\*\*|__(\S(?:.*?\S)?)__|~~(\S(?:.*?\S)?)~~|\*(\S(?:.*?\S)?)\*|_(\S(?:.*?\S)?)_/g;

const URL_REGEX = /\bhttps?:\/\/[^\s<]+/g;

// Trailing sentence punctuation, and a closing paren that isn't balanced by
// one earlier in the match, belong to the surrounding sentence, not the URL.
function trimUrlMatch(url: string): string {
  let end = url.length;
  for (;;) {
    if (end === 0) break;
    const ch = url[end - 1];
    if (".,;:!?".includes(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const head = url.slice(0, end);
      const opens = (head.match(/\(/g) ?? []).length;
      const closes = (head.match(/\)/g) ?? []).length;
      if (closes > opens) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

// URLs first, then the shared mention/task-ref tokenizer on whatever plain
// text is left between/around them.
function renderLeaf(
  text: string,
  mentionRegex: RegExp | null,
  onRefClick: ((ref: string) => void) | undefined,
  keyPrefix: string,
): React.ReactNode[] {
  if (!text) return [];
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(URL_REGEX)) {
    const index = match.index ?? 0;
    if (index < last) continue;
    const url = trimUrlMatch(match[0]);
    if (!url) continue;
    if (index > last) {
      parts.push(
        <Fragment key={`${keyPrefix}-p${i}`}>
          {renderContent(text.slice(last, index), mentionRegex, true, onRefClick)}
        </Fragment>,
      );
    }
    parts.push(
      <a
        key={`${keyPrefix}-u${i}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent underline"
      >
        {url}
      </a>,
    );
    last = index + url.length;
    i++;
  }
  if (last < text.length) {
    parts.push(
      <Fragment key={`${keyPrefix}-tail`}>
        {renderContent(text.slice(last), mentionRegex, true, onRefClick)}
      </Fragment>,
    );
  }
  return parts;
}

// Inline code and emphasis, recursing into emphasis content so bold/italic
// can nest (e.g. "**bold *and italic***").
function formatInline(
  text: string,
  mentionRegex: RegExp | null,
  onRefClick: ((ref: string) => void) | undefined,
  keyPrefix: string,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(INLINE_REGEX)) {
    const index = match.index ?? 0;
    if (index < last) continue;
    if (index > last) {
      nodes.push(...renderLeaf(text.slice(last, index), mentionRegex, onRefClick, `${keyPrefix}-p${i}`));
    }
    const key = `${keyPrefix}-m${i}`;
    const [, code, bold, underline, strike, italicStar, italicUnderscore] = match;
    if (code !== undefined) {
      nodes.push(
        <code key={key} className="rounded bg-subtle px-1 py-0.5 font-mono text-[0.85em]">
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      nodes.push(<strong key={key}>{formatInline(bold, mentionRegex, onRefClick, key)}</strong>);
    } else if (underline !== undefined) {
      nodes.push(
        <span key={key} className="underline">
          {formatInline(underline, mentionRegex, onRefClick, key)}
        </span>,
      );
    } else if (strike !== undefined) {
      nodes.push(
        <span key={key} className="line-through">
          {formatInline(strike, mentionRegex, onRefClick, key)}
        </span>,
      );
    } else {
      const italic = italicStar ?? italicUnderscore;
      nodes.push(<em key={key}>{formatInline(italic!, mentionRegex, onRefClick, key)}</em>);
    }
    last = index + match[0].length;
    i++;
  }
  if (last < text.length) {
    nodes.push(...renderLeaf(text.slice(last), mentionRegex, onRefClick, `${keyPrefix}-tail`));
  }
  return nodes;
}

// A line starting with "> " renders as a bordered blockquote line; anything
// else gets inline formatting. Lines stay joined by literal "\n"s so the
// caller's whitespace-pre-wrap wrapper keeps line breaks.
function renderPlainSegment(
  text: string,
  mentionRegex: RegExp | null,
  onRefClick: ((ref: string) => void) | undefined,
  keyPrefix: string,
): React.ReactNode[] {
  const lines = text.split("\n");
  const nodes: React.ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push("\n");
    const quote = /^> ?(.*)$/.exec(line);
    if (quote) {
      nodes.push(
        <div key={`${keyPrefix}-q${i}`} className="border-l-2 border-divider pl-2 text-muted">
          {formatInline(quote[1], mentionRegex, onRefClick, `${keyPrefix}-q${i}`)}
        </div>,
      );
    } else {
      nodes.push(...formatInline(line, mentionRegex, onRefClick, `${keyPrefix}-l${i}`));
    }
  });
  return nodes;
}

export function renderMessageContent(
  content: string,
  mentionRegex: RegExp | null,
  onRefClick?: (ref: string) => void,
): React.ReactNode {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of content.matchAll(CODE_BLOCK_REGEX)) {
    const index = match.index ?? 0;
    if (index > last) {
      nodes.push(...renderPlainSegment(content.slice(last, index), mentionRegex, onRefClick, `s${i}`));
    }
    const code = match[2].replace(/\n$/, "");
    nodes.push(
      <pre key={`cb${i}`} className="my-1 overflow-x-auto rounded-md bg-subtle p-2 font-mono text-[0.85em]">
        <code>{code}</code>
      </pre>,
    );
    last = index + match[0].length;
    i++;
  }
  if (last < content.length) {
    nodes.push(...renderPlainSegment(content.slice(last), mentionRegex, onRefClick, "stail"));
  }
  return nodes;
}
