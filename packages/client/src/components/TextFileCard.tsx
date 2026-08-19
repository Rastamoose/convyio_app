import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { Attachment } from "@workspace/shared";
import { downloadFromResponse } from "../lib/download";
import { renderMessageContent } from "../lib/markdown";
import { useWorkspace } from "../hooks/WorkspaceContext";

const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 800;

function ExpandIcon({ className }: { className?: string }) {
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
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </svg>
  );
}

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

function IconButton({
  className,
  ...props
}: ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={`flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-subtle-hover hover:text-body ${className ?? ""}`}
      {...props}
    />
  );
}

/** Inline readable view of a text attachment; expand pops the full file out. */
export function TextFileCard({
  attachment,
  mentionRegex,
  onRefClick,
}: {
  attachment: Attachment;
  mentionRegex: RegExp | null;
  onRefClick?: (ref: string) => void;
}) {
  const { apiFetch } = useWorkspace();
  const fetchRef = useRef(apiFetch);
  fetchRef.current = apiFetch;
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const preview = text === null ? null : clipPreview(text);
  const shown = preview?.shown ?? null;

  const download = async () => {
    try {
      await downloadFromResponse(await fetchRef.current(attachment.url), attachment.name);
    } catch {
      // Preview still works; the human can copy from the card.
    }
  };

  return (
    <>
      <div className="relative w-full max-w-[min(720px,100%)] overflow-hidden rounded-lg border border-divider bg-chat">
        <div className="absolute top-1.5 right-1.5 z-10 flex gap-0.5">
          <IconButton
            aria-label={`Expand ${attachment.name}`}
            title="Expand"
            onClick={() => setOpen(true)}
          >
            <ExpandIcon className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton
            aria-label={`Download ${attachment.name}`}
            title="Download"
            onClick={() => void download()}
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </IconButton>
        </div>
        <div className="flex items-center gap-2 border-b border-divider bg-composer py-1.5 pr-16 pl-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold tracking-wider text-muted uppercase">Text file</div>
            <div className="truncate text-xs font-medium text-body">{attachment.name}</div>
          </div>
          <span className="shrink-0 text-[10px] text-faint">{formatBytes(attachment.size)}</span>
        </div>
        {error && <div className="bg-chat px-3 py-2 text-xs text-muted">{error}</div>}
        {!error && text === null && <div className="bg-chat px-3 py-2 text-xs text-faint">Loading…</div>}
        {shown !== null && (
          <div
            onClick={() => setOpen(true)}
            className="max-h-80 cursor-pointer overflow-hidden bg-chat px-3 py-2 text-sm leading-[1.375rem] break-words whitespace-pre-wrap text-body"
          >
            {renderMessageContent(shown, mentionRegex, onRefClick)}
          </div>
        )}
        {preview?.clipped && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="w-full border-t border-divider bg-composer px-3 py-1.5 text-left text-[11px] font-medium text-muted hover:bg-subtle-hover hover:text-body"
          >
            Expand
          </button>
        )}
      </div>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-backdrop/55 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={attachment.name}
            className="elevated flex max-h-[88vh] w-full max-w-3xl animate-pop-in flex-col overflow-hidden rounded-2xl"
          >
            <div className="flex items-center gap-2 border-b border-divider bg-composer px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-bold tracking-wider text-muted uppercase">Text file</div>
                <div className="truncate text-sm font-medium text-body">{attachment.name}</div>
              </div>
              <span className="shrink-0 text-[10px] text-faint">{formatBytes(attachment.size)}</span>
              <IconButton
                className="h-7 w-7"
                aria-label={`Download ${attachment.name}`}
                title="Download"
                onClick={() => void download()}
              >
                <DownloadIcon className="h-4 w-4" />
              </IconButton>
              <IconButton
                className="h-7 w-7"
                aria-label="Close"
                title="Close"
                onClick={() => setOpen(false)}
              >
                <span className="text-lg leading-none">×</span>
              </IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-chat px-5 py-4 text-sm leading-[1.5rem] break-words whitespace-pre-wrap text-body">
              {text === null && !error && <span className="text-faint">Loading…</span>}
              {error && <span className="text-muted">{error}</span>}
              {text !== null && renderMessageContent(text, mentionRegex, onRefClick)}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
