import { useState, type DragEvent, type ReactNode } from "react";

/**
 * Turns file drags over its children into an `onFiles` callback, with a
 * full-area "drop to upload" overlay while a drag hovers. Non-file drags
 * (text selections, DOM elements) pass through untouched.
 */
export function FileDropZone({
  onFiles,
  children,
}: {
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  // Enter/leave fire for every child crossed, so a plain boolean flickers;
  // the depth only reaches zero when the drag truly left the area.
  const [dragDepth, setDragDepth] = useState(0);

  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes("Files");

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragEnter={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragDepth((d) => d + 1);
      }}
      onDragLeave={(e) => {
        if (!isFileDrag(e)) return;
        setDragDepth((d) => Math.max(0, d - 1));
      }}
      onDragOver={(e) => {
        // Required: without preventDefault the browser refuses the drop.
        if (isFileDrag(e)) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!isFileDrag(e)) return;
        e.preventDefault();
        setDragDepth(0);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-sidebar-dark/70 p-6">
          <div className="rounded-lg border-2 border-dashed border-blurple bg-popup px-8 py-6 text-center">
            <div className="text-lg font-semibold text-body">
              Drop files to upload
            </div>
            <div className="mt-1 text-sm text-muted">
              Images preview inline; anything else becomes a download.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
