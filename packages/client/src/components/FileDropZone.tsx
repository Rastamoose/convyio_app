import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Turns file drags anywhere in the window into an `onFiles` callback, with a
 * full-viewport "drop to upload" overlay while a drag hovers. Non-file drags
 * (text selections, DOM elements) pass through untouched.
 *
 * Listeners attach at the window level (not just this wrapper's DOM node) so
 * a drop over the sidebar, top bar, or board — anywhere outside the chat
 * pane — is still caught. Missing the target there is destructive: the
 * browser's default behavior for an unhandled drop is to navigate away and
 * open the file.
 */
export function FileDropZone({
  onFiles,
  children,
}: {
  onFiles: (files: File[]) => void;
  children: ReactNode;
}) {
  // Enter/leave fire for every element crossed, so a plain boolean flickers;
  // the depth only reaches zero when the drag truly left the window.
  const [dragDepth, setDragDepth] = useState(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;

  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      setDragDepth((d) => Math.max(0, d - 1));
    };
    const onDragOver = (e: DragEvent) => {
      // Required on every dragover: without preventDefault the browser
      // refuses the drop and falls back to opening the file itself.
      if (isFileDrag(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      // preventDefault unconditionally — even a non-file drop must not be
      // allowed to navigate the tab away.
      e.preventDefault();
      if (!isFileDrag(e)) return;
      setDragDepth(0);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) onFilesRef.current(files);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {children}
      {dragDepth > 0 && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-backdrop/70 p-6">
          <div className="rounded-xl border-2 border-dashed border-accent bg-popup px-8 py-6 text-center">
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
