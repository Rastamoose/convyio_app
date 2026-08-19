/// <reference types="vite/client" />

interface FileSystemDirectoryHandle {
  readonly name: string;
  entries(): AsyncIterableIterator<[string, { kind: string; name: string }]>;
}

interface Window {
  showDirectoryPicker?(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
}
