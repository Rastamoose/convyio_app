import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { deleteFile, editTextFile, listFiles, moveFile, PathDeniedError, readTextFile, writeTextFile } from "../src/fsSafe";
import { runCommand } from "../src/command";

describe("local checkout operations", () => {
  let root: string;

  before(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "toolman-fs-"));
    await fs.writeFile(path.join(root, "README.md"), "hello\n");
    await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  });
  after(() => fs.rm(root, { recursive: true, force: true }));

  test("reads and edits stay inside the checkout", async () => {
    assert.equal(await readTextFile(root, "README.md"), "hello\n");
    await editTextFile(root, "README.md", "hello", "hi");
    assert.equal(await readTextFile(root, "README.md"), "hi\n");
    await writeTextFile(root, "notes/a.md", "one");
    await moveFile(root, "notes/a.md", "notes/b.md");
    assert.deepEqual(await listFiles(root, "notes"), ["b.md"]);
    await deleteFile(root, "notes/b.md");
    assert.equal((await listFiles(root)).includes(".env"), false);
  });

  test("absolute, traversal, symlink, and sensitive paths are refused", async () => {
    await assert.rejects(() => readTextFile(root, "/etc/passwd"), PathDeniedError);
    await assert.rejects(() => readTextFile(root, "../secret"), PathDeniedError);
    await assert.rejects(() => readTextFile(root, ".env"), PathDeniedError);
    const outside = path.join(os.tmpdir(), `toolman-outside-${process.pid}`);
    await fs.writeFile(outside, "nope");
    await fs.symlink(outside, path.join(root, "escape"));
    await assert.rejects(() => readTextFile(root, "escape"), PathDeniedError);
    await fs.rm(outside, { force: true });
  });

  test("commands stream, clip, timeout, and cancel", async () => {
    const streamed: string[] = [];
    const ok = await runCommand(root, "printf hi", { onChunk: (chunk) => streamed.push(chunk) }).promise;
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.output, "hi");
    assert.deepEqual(streamed, ["hi"]);

    const clipped = await runCommand(root, "printf 'abcdefghij'", { maxBytes: 4 }).promise;
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.output, "abcd");

    const timed = await runCommand(root, "sleep 5", { timeoutMs: 50 }).promise;
    assert.equal(timed.timedOut, true);

    const running = runCommand(root, "sleep 5");
    running.cancel();
    const cancelled = await running.promise;
    assert.equal(cancelled.cancelled, true);
  });
});
