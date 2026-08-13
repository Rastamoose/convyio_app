import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import type { ChatMessage } from "@workspace/shared";
import { Memory } from "../src/memory";
import { tempDir, waitFor } from "./helpers";

let seq = 0;
function message(content: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  seq += 1;
  return {
    id: `m-${seq}`,
    authorId: "u-dana",
    authorName: "dana",
    authorKind: "human",
    content,
    timestamp: seq,
    channel: "general",
    ...overrides,
  };
}

/** Zero-padded label so no content is a substring of another ("m03" vs "m30"). */
const label = (i: number) => `m${String(i).padStart(2, "0")}`;

describe("Memory", () => {
  test("seed then append keeps the window at the rolling size", async () => {
    const memory = await Memory.load(await tempDir());
    memory.seed(Array.from({ length: 50 }, (_, i) => message(label(i + 1))));
    for (let i = 51; i <= 53; i++) memory.append(message(label(i)));

    const lines = memory.context().split("\n");
    assert.equal(lines.length, 50);
    assert.ok(lines[0].includes("m04"), `oldest three dropped, got: ${lines[0]}`);
    assert.ok(lines[49].includes("m53"));
    assert.ok(!memory.context().includes("m03"));
  });

  test("seed replaces earlier messages", async () => {
    const memory = await Memory.load(await tempDir());
    memory.append(message("before-seed"));
    memory.seed([message("from-history")]);
    assert.ok(memory.context().includes("from-history"));
    assert.ok(!memory.context().includes("before-seed"));
  });

  test("context renders channel, author, kind and content", async () => {
    const memory = await Memory.load(await tempDir());
    memory.seed([message("hello there", { channel: "random" })]);
    assert.equal(memory.context(), "[#random] dana (human): hello there");

    memory.seed([message("no channel", { channel: undefined })]);
    assert.equal(memory.context(), "[#general] dana (human): no channel");
  });

  test("context lists a message's attachments after its content", async () => {
    const memory = await Memory.load(await tempDir());
    memory.seed([
      message("look at these", {
        attachments: [
          { id: "a1", name: "cat.png", mime: "image/png", size: 5, url: "/api/uploads/a1/cat.png" },
          { id: "a2", name: "notes.pdf", mime: "application/pdf", size: 9, url: "/api/uploads/a2/notes.pdf" },
        ],
      }),
    ]);
    assert.equal(
      memory.context(),
      "[#general] dana (human): look at these [attachments: cat.png (image/png), notes.pdf (application/pdf)]",
    );
  });

  test("appended messages survive a fresh load", async () => {
    const dir = await tempDir();
    const memory = await Memory.load(dir);
    memory.append(message("survives-restart"));

    const reloaded = await waitFor(async () => {
      const fresh = await Memory.load(dir);
      return fresh.context().includes("survives-restart") ? fresh : undefined;
    }, "transcript to persist");
    assert.ok(reloaded.context().includes("survives-restart"));
  });

  test("repairs existing state permissions and writes private files", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "transcript.json");
    await fs.writeFile(file, "[]", { mode: 0o644 });
    await fs.chmod(dir, 0o755);
    const memory = await Memory.load(dir);
    memory.append(message("private"));
    await waitFor(async () => (await fs.readFile(file, "utf8")).includes("private") || undefined, "private transcript write");
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  test("a failed transcript write does not block later writes", async () => {
    const dir = await tempDir();
    const memory = await Memory.load(dir);

    await fs.rm(dir, { recursive: true, force: true });
    memory.append(message("during-outage"));
    // Let the doomed write hit the missing directory before restoring it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await fs.mkdir(dir, { recursive: true });
    memory.append(message("after-recovery"));

    const reloaded = await waitFor(async () => {
      const fresh = await Memory.load(dir);
      return fresh.context().includes("after-recovery") ? fresh : undefined;
    }, "write after directory restore to persist");
    assert.ok(reloaded.context().includes("after-recovery"));
  });
});
