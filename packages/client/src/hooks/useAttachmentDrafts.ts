import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@workspace/shared";
import type { ApiSession } from "./useApiSession";

export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
// Client-side pre-check only; the server enforces the same cap (413).
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface AttachmentDraft {
  localId: string;
  name: string;
  mime: string;
  /** Object URL for image previews; null for non-images. Owned by this hook. */
  previewUrl: string | null;
  status: "uploading" | "ready" | "failed";
  /** The server's attachment record, once the upload completed. */
  attachment?: Attachment;
  /** Why the upload failed, for the entry's tooltip. */
  error?: string;
}

/**
 * Per-channel draft attachments for the message input: each added file
 * uploads immediately through the API session; send collects the ids of the
 * uploads that completed. Removing an entry only drops it locally — the
 * server sweeps unbound uploads on its own.
 */
export function useAttachmentDrafts(
  onError: (message: string) => void,
  api: ApiSession,
) {
  const [drafts, setDrafts] = useState<Record<string, AttachmentDraft[]>>({});
  // Mirror for event handlers that need the latest list synchronously.
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(
    () => () => {
      for (const entries of Object.values(draftsRef.current)) {
        for (const entry of entries) {
          if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
        }
      }
    },
    [],
  );

  const settle = (
    channel: string,
    localId: string,
    outcome: Pick<AttachmentDraft, "status" | "attachment" | "error">,
  ) => {
    // The entry may have been removed or sent while the upload was in
    // flight; in that case the outcome has nowhere to land and is dropped.
    setDrafts((prev) => ({
      ...prev,
      [channel]: (prev[channel] ?? []).map((d) =>
        d.localId === localId ? { ...d, ...outcome } : d,
      ),
    }));
  };

  const upload = async (
    channel: string,
    localId: string,
    file: File,
    previewUrl: string | null,
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": file.type || "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
    };
    if (previewUrl) {
      const size = await probeImageSize(previewUrl);
      if (size) {
        headers["X-Image-Width"] = String(size.width);
        headers["X-Image-Height"] = String(size.height);
      }
    }
    const request = api.fetch("/api/uploads", {
      method: "POST",
      body: file,
      headers,
    });
    if (!request) {
      settle(channel, localId, { status: "failed", error: "not connected" });
      return;
    }
    try {
      const res = await request;
      if (!res.ok) {
        settle(channel, localId, {
          status: "failed",
          error: await api.errorMessage(res),
        });
        return;
      }
      const data = (await res.json()) as { attachment: Attachment };
      settle(channel, localId, { status: "ready", attachment: data.attachment });
    } catch (err) {
      settle(channel, localId, { status: "failed", error: String(err) });
    }
  };

  return {
    draftsFor: (channel: string): AttachmentDraft[] => drafts[channel] ?? [],
    add: (channel: string, files: File[]) => {
      let room =
        MAX_ATTACHMENTS_PER_MESSAGE - (draftsRef.current[channel] ?? []).length;
      const accepted: AttachmentDraft[] = [];
      for (const file of files) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          onError(`${file.name} is larger than 10 MiB and was skipped`);
          continue;
        }
        if (room <= 0) {
          onError(
            `A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
          );
          break;
        }
        room--;
        const localId = crypto.randomUUID();
        const previewUrl = file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : null;
        accepted.push({
          localId,
          name: file.name,
          mime: file.type || "application/octet-stream",
          previewUrl,
          status: "uploading",
        });
        void upload(channel, localId, file, previewUrl);
      }
      if (accepted.length === 0) return;
      setDrafts((prev) => ({
        ...prev,
        [channel]: [...(prev[channel] ?? []), ...accepted],
      }));
    },
    remove: (channel: string, localId: string) => {
      const entry = (draftsRef.current[channel] ?? []).find(
        (d) => d.localId === localId,
      );
      if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      setDrafts((prev) => ({
        ...prev,
        [channel]: (prev[channel] ?? []).filter((d) => d.localId !== localId),
      }));
    },
    /** Clear the channel's drafts, returning the completed uploads' ids. */
    takeReadyIds: (channel: string): string[] => {
      const entries = draftsRef.current[channel] ?? [];
      for (const entry of entries) {
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
      }
      setDrafts((prev) => ({ ...prev, [channel]: [] }));
      return entries
        .filter((d) => d.status === "ready" && d.attachment)
        .map((d) => d.attachment!.id);
    },
  };
}

/** Read an image file's pixel size off its object URL; null if undecodable. */
function probeImageSize(
  objectUrl: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve(
        image.naturalWidth > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : null,
      );
    image.onerror = () => resolve(null);
    image.src = objectUrl;
  });
}
