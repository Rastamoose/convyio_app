import { afterEach, describe, expect, it, vi } from "vitest";
import { folderFromFiles, folderPreview, isAbortError, pickLocalFolder } from "./localFolder";

function fileAt(relative: string): File {
  const file = new File(["x"], relative.split("/").at(-1) ?? "file");
  Object.defineProperty(file, "webkitRelativePath", { value: relative });
  return file;
}

describe("folderFromFiles", () => {
  it("uses the webkit root and lists only immediate children", () => {
    expect(folderFromFiles([
      fileAt("notes/README.md"),
      fileAt("notes/src/index.ts"),
      fileAt("notes/.git/config"),
    ])).toEqual({
      name: "notes",
      entries: [".git/", "README.md", "src/"],
    });
  });

  it("returns null when the file list has no folder path", () => {
    expect(folderFromFiles([new File(["x"], "README.md")])).toBeNull();
    expect(folderFromFiles([])).toBeNull();
  });
});

describe("folderPreview", () => {
  it("caps the listing and marks directories", async () => {
    const handle = {
      name: "app",
      async *entries() {
        yield ["src", { kind: "directory", name: "src" }];
        yield ["package.json", { kind: "file", name: "package.json" }];
        yield ["extra", { kind: "file", name: "extra" }];
      },
    } as unknown as FileSystemDirectoryHandle;

    expect(await folderPreview(handle, 2)).toEqual({
      name: "app",
      entries: ["package.json", "src/"],
    });
  });
});

describe("pickLocalFolder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });

  it("returns null when the native picker is cancelled", async () => {
    window.showDirectoryPicker = vi.fn().mockRejectedValue(new DOMException("cancel", "AbortError"));
    expect(await pickLocalFolder()).toBeNull();
    expect(isAbortError(new DOMException("cancel", "AbortError"))).toBe(true);
  });

  it("uses the native directory picker when available", async () => {
    window.showDirectoryPicker = vi.fn().mockResolvedValue({
      name: "desk",
      async *entries() {
        yield ["todo.txt", { kind: "file", name: "todo.txt" }];
      },
    });
    expect(await pickLocalFolder()).toEqual({ name: "desk", entries: ["todo.txt"] });
  });
});
