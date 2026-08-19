export type PickedLocalFolder = {
  name: string;
  entries: string[];
};

const PREVIEW_LIMIT = 12;

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function previewName(name: string, kind: string): string {
  return kind === "directory" ? `${name}/` : name;
}

export async function folderPreview(
  handle: FileSystemDirectoryHandle,
  limit = PREVIEW_LIMIT,
): Promise<PickedLocalFolder> {
  const entries: string[] = [];
  for await (const [name, entry] of handle.entries()) {
    entries.push(previewName(name, entry.kind));
    if (entries.length >= limit) break;
  }
  entries.sort((a, b) => a.localeCompare(b));
  return { name: handle.name, entries };
}

export async function pickLocalFolder(): Promise<PickedLocalFolder | null> {
  if (typeof window.showDirectoryPicker !== "function") {
    return pickLocalFolderViaInput();
  }
  try {
    return await folderPreview(await window.showDirectoryPicker({ mode: "read" }));
  } catch (error) {
    if (isAbortError(error)) return null;
    throw error;
  }
}

function pickLocalFolderViaInput(): Promise<PickedLocalFolder | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(folderFromFiles(files));
    }, { once: true });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    }, { once: true });
    document.body.append(input);
    input.click();
  });
}

export function folderFromFiles(files: File[]): PickedLocalFolder | null {
  const first = files[0] as (File & { webkitRelativePath?: string }) | undefined;
  const root = first?.webkitRelativePath?.split("/")[0];
  if (!root) return null;
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? "";
    const parts = relative.split("/").filter(Boolean);
    if (parts[0] !== root || parts.length < 2) continue;
    const name = parts.length > 2 ? `${parts[1]}/` : parts[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push(name);
    if (entries.length >= PREVIEW_LIMIT) break;
  }
  entries.sort((a, b) => a.localeCompare(b));
  return { name: root, entries };
}
