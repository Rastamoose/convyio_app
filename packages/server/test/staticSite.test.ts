import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { createStaticSite } from "../src/staticSite";

describe("static site serving", async () => {
  // A minimal Vite-shaped dist: entry html plus a content-hashed asset.
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "dist-test-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html>app</html>");
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "index-Ab12Cd34.js"), "console.log(1)");
  fs.writeFileSync(path.join(dist, "vite.svg"), "<svg/>");

  const serveStatic = createStaticSite(dist);
  const server = http.createServer(async (req, res) => {
    if (await serveStatic(req, res)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;

  after(() => {
    server.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  test("GET / serves index.html with no-cache", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(await res.text(), "<html>app</html>");
  });

  test("hashed assets get their type and an immutable cache header", async () => {
    const res = await fetch(`${baseUrl}/assets/index-Ab12Cd34.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(await res.text(), "console.log(1)");
  });

  test("a top-level file is served without a cache directive", async () => {
    const res = await fetch(`${baseUrl}/vite.svg`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    assert.equal(res.headers.get("cache-control"), null);
  });

  test("extensionless deep links fall back to index.html (SPA routing)", async () => {
    for (const deepLink of ["/board", "/channels/general"]) {
      const res = await fetch(`${baseUrl}${deepLink}`);
      assert.equal(res.status, 200, deepLink);
      assert.equal(await res.text(), "<html>app</html>");
    }
  });

  test("a missing asset also falls back to index.html", async () => {
    const res = await fetch(`${baseUrl}/assets/gone-00000000.js`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
  });

  test("traversal cannot escape the dist directory", async () => {
    // fetch() normalizes "..", so speak raw HTTP to keep the attack honest.
    const raw = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/assets/..%2f..%2f..%2f..%2fetc%2fpasswd`,
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(raw, "<html>app</html>");
  });

  test("HEAD returns headers without a body", async () => {
    const res = await fetch(`${baseUrl}/`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), String("<html>app</html>".length));
    assert.equal((await res.arrayBuffer()).byteLength, 0);
  });

  test("non-GET/HEAD and /api/ paths pass through to the 404 fallback", async () => {
    const post = await fetch(`${baseUrl}/`, { method: "POST" });
    assert.equal(post.status, 404);
    assert.deepEqual(await post.json(), { error: "NOT_FOUND" });
    const api = await fetch(`${baseUrl}/api/nope`);
    assert.equal(api.status, 404);
  });
});
