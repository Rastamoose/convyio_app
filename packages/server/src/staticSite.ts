import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * Serves the built client so production needs one origin and no second
 * server. GET/HEAD requests outside /api/ resolve inside the dist directory;
 * anything without an extension or not found falls back to index.html (the
 * SPA routes client-side). Returns false (unhandled) for everything else so
 * the caller's 404 fallback stays the single non-route answer.
 */
export function createStaticSite(distDir: string) {
  const root = path.resolve(distDir);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return false;

    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = "/"; // undecodable path: not an asset, let the SPA answer
    }
    const resolved = path.normalize(path.join(root, pathname));
    const contained = resolved === root || resolved.startsWith(root + path.sep);
    const isAsset = contained && path.extname(resolved) !== "" && fs.existsSync(resolved);
    const filePath = isAsset ? resolved : path.join(root, "index.html");

    let size: number;
    try {
      size = (await fs.promises.stat(filePath)).size;
    } catch {
      return false; // dist vanished since boot: fall through to the 404
    }

    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "Content-Length": size,
      // Vite content-hashes /assets/ filenames, so those bytes never change;
      // index.html is the mutable entry point and must revalidate.
      ...(filePath.startsWith(path.join(root, "assets") + path.sep)
        ? { "Cache-Control": "public, max-age=31536000, immutable" }
        : filePath === path.join(root, "index.html")
          ? { "Cache-Control": "no-cache" }
          : {}),
    });
    if (method === "HEAD") {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(filePath);
    // Headers are already sent; a mid-stream read failure can only abort.
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return true;
  };
}
