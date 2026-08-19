import type { CSSProperties } from "react";
import type { Attachment } from "@workspace/shared";
import { downloadFromResponse } from "../lib/download";
import { isTextAttachment } from "../lib/textAttachment";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { DownloadIcon, TextFileCard } from "./TextFileCard";

/** "824 B" / "12.3 KB" / "4.0 MB" — file-card size line. */
function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const isImage = (a: Attachment) => a.mime.startsWith("image/");

/**
 * Reserve the thumbnail's box from the upload-time pixel metadata so the
 * message list never shifts while images load. Bounds match the single-image
 * thumbnail cap: 400px wide, 350px tall.
 */
function reservedBox(a: Attachment): CSSProperties | undefined {
  if (!a.width || !a.height) return undefined;
  const scale = Math.min(400 / a.width, 350 / a.height, 1);
  return {
    width: Math.round(a.width * scale),
    aspectRatio: `${a.width} / ${a.height}`,
  };
}

/**
 * A sent message's attachments, Discord-style: images as click-to-enlarge
 * rounded thumbnails (a 2-column grid when there are several), text files
 * as inline readable cards, other files as download cards.
 */
export function AttachmentGallery({
  attachments,
  onImageClick,
  mentionRegex,
  onRefClick,
}: {
  attachments: Attachment[];
  onImageClick: (attachment: Attachment) => void;
  mentionRegex?: RegExp | null;
  onRefClick?: (ref: string) => void;
}) {
  const { attachmentUrl, apiFetch } = useWorkspace();
  const download = (a: Attachment) => {
    void (async () => {
      try {
        await downloadFromResponse(await apiFetch(a.url), a.name);
      } catch {
        // The card stays put; opening in a new tab would leave the chat.
      }
    })();
  };
  const images = attachments.filter(isImage);
  const texts = attachments.filter((a) => !isImage(a) && isTextAttachment(a));
  const files = attachments.filter((a) => !isImage(a) && !isTextAttachment(a));

  return (
    <div className="mt-1 space-y-1">
      {images.length === 1 && (
        <button
          onClick={() => onImageClick(images[0])}
          aria-label={`View ${images[0].name}`}
          className="block cursor-pointer"
        >
          <img
            src={attachmentUrl(images[0])}
            alt={images[0].name}
            loading="lazy"
            className="max-h-[350px] max-w-[min(400px,100%)] rounded-lg object-contain"
            style={reservedBox(images[0])}
          />
        </button>
      )}
      {images.length >= 2 && (
        <div className="grid max-w-[400px] grid-cols-2 gap-1">
          {images.map((a) => (
            <button
              key={a.id}
              onClick={() => onImageClick(a)}
              aria-label={`View ${a.name}`}
              className="aspect-square cursor-pointer overflow-hidden rounded-lg"
            >
              <img
                src={attachmentUrl(a)}
                alt={a.name}
                loading="lazy"
                className="h-full w-full object-cover"
              />
            </button>
          ))}
        </div>
      )}
      {texts.map((a) => (
        <TextFileCard
          key={a.id}
          attachment={a}
          mentionRegex={mentionRegex ?? null}
          onRefClick={onRefClick}
        />
      ))}
      {files.map((a) => (
        <div
          key={a.id}
          className="relative flex w-fit max-w-[min(400px,100%)] items-center gap-3 rounded-lg bg-subtle py-2 pr-9 pl-3"
        >
          <svg
            className="h-8 w-8 shrink-0 text-muted"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path d="M14 2v6h6" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div className="min-w-0">
            <div className="truncate font-medium text-body">{a.name}</div>
            <div className="text-xs text-muted">{formatBytes(a.size)}</div>
          </div>
          <button
            type="button"
            aria-label={`Download ${a.name}`}
            title="Download"
            onClick={() => download(a)}
            className="absolute top-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-subtle-hover hover:text-body"
          >
            <DownloadIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
