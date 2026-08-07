import { useEffect, useState } from "react";
import type { Attachment } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";

function NavButton({
  direction,
  onClick,
}: {
  direction: "prev" | "next";
  onClick: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        // Keep this off the backdrop's click-to-close path — a chevron
        // click should navigate, not dismiss the lightbox.
        e.stopPropagation();
        onClick();
      }}
      aria-label={direction === "prev" ? "Previous image" : "Next image"}
      className={`absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-sidebar-dark/60 p-2 text-body transition hover:bg-sidebar-dark/90 ${
        direction === "prev" ? "left-4" : "right-4"
      }`}
    >
      <svg
        className="h-6 w-6"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={direction === "prev" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
      </svg>
    </button>
  );
}

/**
 * Full-screen view of one image attachment; backdrop click or Escape closes.
 *
 * `siblings` — the other images from the same message — enables ←/→ (and
 * on-screen chevron) navigation between them. It's optional and defaults to
 * just `attachment` alone, so existing callers that only pass `attachment`
 * keep compiling and behaving exactly as before.
 */
export function AttachmentLightbox({
  attachment,
  siblings,
  onClose,
}: {
  attachment: Attachment;
  siblings?: Attachment[];
  onClose: () => void;
}) {
  const { attachmentUrl } = useWorkspace();

  // Fall back to a single-image "gallery" when no sibling set is given, or
  // when the opened attachment isn't actually among the siblings passed in.
  const images = siblings?.some((a) => a.id === attachment.id) ? siblings : [attachment];
  const [index, setIndex] = useState(() => Math.max(0, images.findIndex((a) => a.id === attachment.id)));

  // Re-sync to whichever image was clicked whenever the caller opens a
  // different attachment or sibling set (e.g. switching messages).
  useEffect(() => {
    const i = images.findIndex((a) => a.id === attachment.id);
    setIndex(i === -1 ? 0 : i);
    // images is derived fresh each render from attachment/siblings, so
    // depending on those two covers it without re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachment, siblings]);

  const current = images[index] ?? attachment;
  const canNavigate = images.length > 1;
  const goPrev = () => setIndex((i) => (i - 1 + images.length) % images.length);
  const goNext = () => setIndex((i) => (i + 1) % images.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (canNavigate && e.key === "ArrowLeft") goPrev();
      else if (canNavigate && e.key === "ArrowRight") goNext();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, canNavigate, images.length]);

  const url = attachmentUrl(current);
  return (
    <div
      role="dialog"
      aria-label={current.name}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center gap-2 bg-sidebar-dark/80"
    >
      <div className="relative flex max-h-[90vh] max-w-[90vw] items-center justify-center">
        {canNavigate && <NavButton direction="prev" onClick={goPrev} />}
        <img
          src={url}
          alt={current.name}
          className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        />
        {canNavigate && <NavButton direction="next" onClick={goNext} />}
      </div>
      <div className="flex items-center gap-4">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-muted transition duration-150 hover:text-body hover:underline"
        >
          Open original
        </a>
        <a
          href={url}
          download={current.name}
          className="text-sm text-muted transition duration-150 hover:text-body hover:underline"
        >
          Download
        </a>
      </div>
    </div>
  );
}
