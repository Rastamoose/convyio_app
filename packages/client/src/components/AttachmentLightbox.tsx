import { useEffect } from "react";
import type { Attachment } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";

/** Full-screen view of one image attachment; backdrop click or Escape closes. */
export function AttachmentLightbox({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const { attachmentUrl } = useWorkspace();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const url = attachmentUrl(attachment);
  return (
    <div
      role="dialog"
      aria-label={attachment.name}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex animate-fade-in flex-col items-center justify-center gap-2 bg-sidebar-dark/80"
    >
      <img
        src={url}
        alt={attachment.name}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
      />
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
          download={attachment.name}
          className="text-sm text-muted transition duration-150 hover:text-body hover:underline"
        >
          Download
        </a>
      </div>
    </div>
  );
}
