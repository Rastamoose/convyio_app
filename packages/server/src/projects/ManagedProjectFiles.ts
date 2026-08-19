import fs from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_BYTES } from "@workspace/shared";

const SENSITIVE_NAMES = new Set([
  ".git",
  ".env",
  ".env.local",
  ".env.production",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "credentials",
  "credentials.json",
]);
const SENSITIVE_BASENAME = /^(id_rsa|id_ed25519|id_ecdsa|.*\.(pem|key|p12|pfx))$/i;

export async function resolveManagedPath(root: string, relative: string): Promise<string> {
  if (!relative || relative.startsWith("/") || relative.includes("\0")) throw new Error("path must be relative to the checkout");
  const rootReal = await fs.realpath(root);
  let current = rootReal;
  const parts = path.normalize(relative).split(path.sep).filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new Error("path traversal is not allowed");
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (SENSITIVE_NAMES.has(part) || SENSITIVE_BASENAME.test(part)) throw new Error(`${part} is a sensitive file`);
    const next = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      if (isNotFound(error)) {
        const remainder = path.join(next, ...parts.slice(index + 1));
        if (path.dirname(remainder) !== rootReal && !path.dirname(remainder).startsWith(rootReal + path.sep)) {
          throw new Error("path is outside the checkout");
        }
        return remainder;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("symlink traversal is not allowed");
    current = next;
  }
  if (current !== rootReal && !current.startsWith(rootReal + path.sep)) throw new Error("path is outside the checkout");
  return current;
}

export async function readManagedFile(root: string, relative: string): Promise<string> {
  const target = await resolveManagedPath(root, relative);
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

export async function writeManagedFile(root: string, relative: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error(`file exceeds ${MAX_FILE_BYTES} bytes`);
  const target = await resolveManagedPath(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, target);
}

export async function editManagedFile(root: string, relative: string, oldString: string, newString: string): Promise<void> {
  const current = await readManagedFile(root, relative);
  const count = current.split(oldString).length - 1;
  if (count === 0) throw new Error("old_string was not found");
  if (count > 1) throw new Error("old_string matched more than once");
  await writeManagedFile(root, relative, current.replace(oldString, newString));
}

export async function deleteManagedFile(root: string, relative: string): Promise<void> {
  await fs.unlink(await resolveManagedPath(root, relative));
}

export async function moveManagedFile(root: string, from: string, to: string): Promise<void> {
  const source = await resolveManagedPath(root, from);
  const destination = await resolveManagedPath(root, to);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

export async function listManagedFiles(root: string, relative = "."): Promise<string[]> {
  const target = relative === "." ? await fs.realpath(root) : await resolveManagedPath(root, relative);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink() && entry.name !== ".git")
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}
