import fs from "node:fs/promises";
import path from "node:path";

const SENSITIVE_NAMES = new Set([
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

export const MAX_FILE_BYTES = 1_048_576;

export class PathDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathDeniedError";
  }
}

export async function resolveInside(root: string, relative: string): Promise<string> {
  if (!relative || relative.startsWith("/") || relative.includes("\0")) {
    throw new PathDeniedError("path must be relative to the checkout");
  }
  const rootReal = await fs.realpath(root);
  let current = rootReal;
  const parts = path.normalize(relative).split(path.sep).filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) throw new PathDeniedError("path traversal is not allowed");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (SENSITIVE_NAMES.has(part) || SENSITIVE_BASENAME.test(part)) {
      throw new PathDeniedError(`${part} is a sensitive file`);
    }
    const next = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(next);
    } catch (error) {
      if (isNotFound(error)) {
        const remainder = path.join(next, ...parts.slice(i + 1));
        if (!path.dirname(remainder).startsWith(rootReal) && path.dirname(remainder) !== rootReal) {
          throw new PathDeniedError("path is outside the checkout");
        }
        return remainder;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) throw new PathDeniedError("symlink traversal is not allowed");
    current = next;
  }
  if (current !== rootReal && !current.startsWith(rootReal + path.sep)) {
    throw new PathDeniedError("path is outside the checkout");
  }
  return current;
}

export async function readTextFile(root: string, relative: string): Promise<string> {
  const target = await resolveInside(root, relative);
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (stat.size > MAX_FILE_BYTES) throw new PathDeniedError(`file exceeds ${MAX_FILE_BYTES} bytes`);
    const contents = await handle.readFile({ encoding: "utf8" });
    return contents;
  } finally {
    await handle.close();
  }
}

export async function writeTextFile(root: string, relative: string, content: string): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new PathDeniedError(`file exceeds ${MAX_FILE_BYTES} bytes`);
  }
  const target = await resolveInside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, target);
}

export async function editTextFile(
  root: string,
  relative: string,
  oldString: string,
  newString: string,
): Promise<void> {
  const current = await readTextFile(root, relative);
  const count = current.split(oldString).length - 1;
  if (count === 0) throw new Error("old_string was not found");
  if (count > 1) throw new Error("old_string matched more than once");
  await writeTextFile(root, relative, current.replace(oldString, newString));
}

export async function deleteFile(root: string, relative: string): Promise<void> {
  const target = await resolveInside(root, relative);
  await fs.unlink(target);
}

export async function moveFile(root: string, from: string, to: string): Promise<void> {
  const source = await resolveInside(root, from);
  const destination = await resolveInside(root, to);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
}

export async function listFiles(root: string, relative = "."): Promise<string[]> {
  const target = relative === "." ? await fs.realpath(root) : await resolveInside(root, relative);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.isSymbolicLink())
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort();
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "ENOENT";
}
