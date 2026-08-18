import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@workspace/shared";
import { renderMessageContent } from "../lib/markdown";
import { useWorkspace } from "../hooks/WorkspaceContext";

const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 800;

export function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function clipPreview(text: string): { shown: string; clipped: boolean } {
  const lines = text.split("\n");
  if (lines.length > PREVIEW_LINES) {
    return { shown: lines.slice(0, PREVIEW_LINES).join("\n"), clipped: true };
  }
  if (text.length > PREVIEW_CHARS) {
    return { shown: text.slice(0, PREVIEW_CHARS), clipped: true };
  }
  return { shown: text, clipped: false };
}

/** Inline readable view of a text attachment: preview in the thread, expand for the rest. */
export function TextFileCard({
  attachment,
  mentionRegex,
  onRefClick,
}: {
  attachment: Attachment;
  mentionRegex: RegExp | null;
  onRefClick?: (ref: string) => void;
}) {
  const { apiFetch, attachmentUrl } = useWorkspace();
  const fetchRef = useRef(apiFetch);
  fetchRef.current = apiFetch;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    void (async () => {
      const res = await fetchRef.current(attachment.url);
      if (!res) {
        if (!cancelled) setError("not connected");
        return;
      }
      if (!res.ok) {
        if (!cancelled) setError("could not load file");
        return;
      }
      const body = await res.text();
      if (!cancelled) setText(body);
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.url]);

  const preview = text === null ? null : clipPreview(text);
  const shown = text === null ? null : expanded || !preview?.clipped ? text : preview.shown;
  const url = attachmentUrl(attachment);

  return (
    <div className="relative w-fit max-w-[min(520px,100%)] overflow-hidden rounded-lg bg-subtle">
      <a
        href={url}
        download={attachment.name}
        aria-label={`Download ${attachment.name}`}
        title="Download"
        className="absolute top-1.5 right-1.5 z-10 flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-subtle-hover hover:text-body"
      >
        <DownloadIcon className="h-3.5 w-3.5" />
      </a>
      <div className="flex items-center gap-2 border-b border-divider py-1.5 pr-9 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-body">{attachment.name}</span>
        <span className="shrink-0 text-[10px] text-faint">{formatBytes(attachment.size)}</span>
      </div>
      {error && <div className="px-3 py-2 text-xs text-muted">{error}</div>}
      {!error && text === null && <div className="px-3 py-2 text-xs text-faint">Loading…</div>}
      {shown !== null && (
        <div className="max-h-80 overflow-auto px-3 py-2 text-sm leading-[1.375rem] break-words whitespace-pre-wrap text-body">
          {renderMessageContent(shown, mentionRegex, onRefClick)}
        </div>
      )}
      {preview?.clipped && (
        <button
          onClick={() => setExpanded((open) => !open)}
          className="w-full border-t border-divider px-3 py-1.5 text-left text-[11px] font-medium text-muted hover:bg-subtle-hover hover:text-body"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
