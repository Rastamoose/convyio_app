import path from "node:path";

/**
 * Scope-path semantics for board items, in one place. An entry ending in "/"
 * grants a directory subtree; any other entry grants exactly that file. All
 * paths are workspace-relative — anything absolute or escaping the root is
 * invalid.
 */

/** Workspace-relative normal form of a path, or null if it escapes the root. */
export function normalizeWorkspacePath(p: string): string | null {
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return null;
  const normal = path.posix.normalize(p.replaceAll("\\", "/"));
  if (normal === ".." || normal.startsWith("../")) return null;
  return normal === "." ? "" : normal;
}

/** True when a normalized action path falls inside one of the scope entries. */
export function scopeAllows(scopePaths: string[], actionPath: string): boolean {
  const rel = normalizeWorkspacePath(actionPath);
  if (rel === null) return false;
  return scopePaths.some((entry) =>
    entry.endsWith("/") ? rel === entry.slice(0, -1) || rel.startsWith(entry) : rel === entry,
  );
}

/** Normalized copies of the entries, or an error naming the invalid one. */
export function validateScopePaths(
  entries: string[],
): { paths: string[] } | { error: string } {
  const paths: string[] = [];
  for (const entry of entries) {
    const isDir = entry.endsWith("/");
    const normal = normalizeWorkspacePath(entry.replace(/\/+$/, ""));
    if (normal === null || normal === "") {
      return { error: `invalid scope path: ${JSON.stringify(entry)}` };
    }
    paths.push(isDir ? `${normal}/` : normal);
  }
  return { paths };
}
