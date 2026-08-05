import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { after, describe, test } from "node:test";
import { clientEventSchema } from "@workspace/shared";
import { createEnv, createWsEnv } from "./helpers";

// 1x1 red pixel, a real PNG so mime and bytes are honest.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function upload(
  baseUrl: string,
  token: string | null,
  bytes: Buffer,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "image/png",
      "X-File-Name": encodeURIComponent("pixel.png"),
      ...headers,
    },
    body: bytes,
  });
}

describe("upload HTTP endpoints", async () => {
  const env = await createEnv();
  const human = env.actor("human", "dana");
  const other = env.actor("human", "erik");
  after(() => env.close());

  test("POST upload → 201 with metadata and the file lands on disk", async () => {
    const res = await upload(env.baseUrl, human.token, PNG_BYTES, {
      "X-Image-Width": "1",
      "X-Image-Height": "1",
    });
    assert.equal(res.status, 201);
    const { attachment } = await res.json();
    assert.equal(attachment.name, "pixel.png");
    assert.equal(attachment.mime, "image/png");
    assert.equal(attachment.size, PNG_BYTES.length);
    assert.equal(attachment.width, 1);
    assert.equal(attachment.height, 1);
    assert.equal(attachment.url, `/api/uploads/${attachment.id}/pixel.png`);
    assert.ok(
      Buffer.from(fs.readFileSync(path.join(env.uploadsDir, attachment.id))).equals(PNG_BYTES),
    );
  });

  test("upload without auth → 401", async () => {
    const res = await upload(env.baseUrl, null, PNG_BYTES);
    assert.equal(res.status, 401);
  });

  test("upload over 10 MiB → 413", async () => {
    const res = await upload(env.baseUrl, human.token, Buffer.alloc(10 * 1024 * 1024 + 1));
    assert.equal(res.status, 413);
  });

  test("empty upload → 400", async () => {
    const res = await upload(env.baseUrl, human.token, Buffer.alloc(0));
    assert.equal(res.status, 400);
  });

  test("filename is sanitized to a safe basename", async () => {
    const res = await upload(env.baseUrl, human.token, PNG_BYTES, {
      "X-File-Name": encodeURIComponent("../../etc/pass\u0000wd"),
    });
    assert.equal(res.status, 201);
    const { attachment } = await res.json();
    assert.equal(attachment.name, "passwd");
  });

  test("GET serves the bytes back without auth; HEAD matches minus body", async () => {
    const created = await upload(env.baseUrl, human.token, PNG_BYTES);
    const { attachment } = await created.json();

    const res = await fetch(`${env.baseUrl}${attachment.url}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-length"), String(PNG_BYTES.length));
    assert.equal(res.headers.get("content-disposition"), 'inline; filename="pixel.png"');
    assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES));

    const head = await fetch(`${env.baseUrl}${attachment.url}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(PNG_BYTES.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });

  test("GET with an unknown id → 404", async () => {
    const res = await fetch(`${env.baseUrl}/api/uploads/${randomUUID()}/nope.png`);
    assert.equal(res.status, 404);
  });

  test("bind rejects unknown, foreign, and already-bound ids", async () => {
    const mineRes = await upload(env.baseUrl, human.token, PNG_BYTES);
    const { attachment: mine } = await mineRes.json();
    const theirsRes = await upload(env.baseUrl, other.token, PNG_BYTES);
    const { attachment: theirs } = await theirsRes.json();

    assert.throws(
      () => env.attachments.bind("m1", [randomUUID()], human.actor.id),
      (err: any) => err.status === 400 && err.code === "BAD_ATTACHMENT",
    );
    assert.throws(
      () => env.attachments.bind("m1", [theirs.id], human.actor.id),
      (err: any) => err.status === 400 && err.code === "BAD_ATTACHMENT",
    );

    env.attachments.bind("m1", [mine.id], human.actor.id);
    assert.throws(
      () => env.attachments.bind("m2", [mine.id], human.actor.id),
      (err: any) => err.status === 400 && err.code === "BAD_ATTACHMENT",
    );

    // A failed multi-bind rolls back entirely: the good id stays unbound.
    const freshRes = await upload(env.baseUrl, human.token, PNG_BYTES);
    const { attachment: fresh } = await freshRes.json();
    assert.throws(() => env.attachments.bind("m3", [fresh.id, theirs.id], human.actor.id));
    assert.deepEqual(
      env.attachments.bind("m3", [fresh.id], human.actor.id).map((a) => a.id),
      [fresh.id],
    );
  });

  test("sweepOrphans removes old unbound uploads, keeps bound ones", async () => {
    const orphanRes = await upload(env.baseUrl, human.token, PNG_BYTES);
    const { attachment: orphan } = await orphanRes.json();
    const boundRes = await upload(env.baseUrl, human.token, PNG_BYTES);
    const { attachment: bound } = await boundRes.json();
    env.attachments.bind("m-sweep", [bound.id], human.actor.id);

    // Backdate both rows past the 1h TTL, then sweep.
    const old = Date.now() - 2 * 60 * 60 * 1000;
    env.db.db
      .prepare(`UPDATE attachments SET created_at = ? WHERE id IN (?, ?)`)
      .run(old, orphan.id, bound.id);
    env.attachments.sweepOrphans();

    assert.equal(env.attachments.get(orphan.id), null);
    assert.equal(fs.existsSync(path.join(env.uploadsDir, orphan.id)), false);
    assert.ok(env.attachments.get(bound.id));
    assert.ok(fs.existsSync(path.join(env.uploadsDir, bound.id)));
  });
});

describe("message schema with attachments", () => {
  test("empty content with attachmentIds is valid; fully empty is not", () => {
    const ok = clientEventSchema.parse({ type: "message", content: "", attachmentIds: ["a"] });
    assert.equal(ok.type, "message");
    assert.throws(() => clientEventSchema.parse({ type: "message", content: "" }));
    assert.throws(() =>
      clientEventSchema.parse({ type: "message", content: "   ", attachmentIds: [] }),
    );
  });
});

describe("attachments on the websocket", async () => {
  test("message with attachmentIds broadcasts and persists them; bad ids drop the message", async () => {
    const env = await createWsEnv();
    const { messages, baseUrl } = env;

    const dana = await env.connect("dana", "human");
    const erik = await env.connect("erik", "human");

    const uploaded = await upload(baseUrl, dana.token, PNG_BYTES, {
      "X-Image-Width": "1",
      "X-Image-Height": "1",
    });
    const { attachment } = await uploaded.json();

    // The other participant receives the full attachment on the broadcast.
    dana.ws.send(
      JSON.stringify({ type: "message", content: "look", attachmentIds: [attachment.id] }),
    );
    const frame = await erik.next((e) => e.type === "message" && e.message.content === "look");
    assert.equal(frame.message.attachments.length, 1);
    assert.deepEqual(frame.message.attachments[0], {
      id: attachment.id,
      name: "pixel.png",
      mime: "image/png",
      size: PNG_BYTES.length,
      width: 1,
      height: 1,
      url: `/api/uploads/${attachment.id}/pixel.png`,
    });

    // The persisted message round-trips the attachments.
    const stored = messages.list().find((m) => m.content === "look");
    assert.ok(stored);
    assert.deepEqual(stored.attachments, frame.message.attachments);
    assert.equal(stored.id, frame.message.id);

    // Erik cannot send Dana's upload (already bound anyway) nor an unknown id:
    // the sender gets an error frame and nothing is persisted or broadcast.
    const countBefore = messages.list().length;
    erik.ws.send(
      JSON.stringify({ type: "message", content: "steal", attachmentIds: [attachment.id] }),
    );
    const refusal = await erik.next((e) => e.type === "error");
    assert.match(refusal.error, /not an unbound upload/);
    const ghostId = randomUUID();
    erik.ws.send(
      JSON.stringify({ type: "message", content: "ghost", attachmentIds: [ghostId] }),
    );
    await erik.next((e) => e.type === "error" && e.error.includes(ghostId));
    assert.equal(messages.list().length, countBefore);

    env.close();
  });
});
