import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { PendingWork } from "../src/pendingWork";
import { tempDir, waitFor } from "./helpers";

describe("PendingWork", () => {
  test("loads empty from an empty directory", async () => {
    const work = await PendingWork.load(await tempDir());
    assert.deepEqual(work.entries(), []);
    assert.equal(work.get("anything"), undefined);
  });

  test("set/get/delete round-trips across a fresh load", async () => {
    const dir = await tempDir();
    const work = await PendingWork.load(dir);
    work.set("item-a", { origin: "dana: do the thing", channel: "general" });
    work.set("item-b", { origin: "sam: other thing", channel: "random" });
    work.delete("item-b");
    assert.deepEqual(work.get("item-a"), { origin: "dana: do the thing", channel: "general" });
    assert.equal(work.get("item-b"), undefined);

    const reloaded = await waitFor(async () => {
      const fresh = await PendingWork.load(dir);
      return fresh.get("item-a") && fresh.get("item-b") === undefined ? fresh : undefined;
    }, "stash to persist");
    assert.deepEqual(reloaded.entries(), [
      ["item-a", { origin: "dana: do the thing", channel: "general" }],
    ]);
  });

  test("a corrupt stash file loads empty without crashing", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "pending-work.json"), "{not json");
    const work = await PendingWork.load(dir);
    assert.deepEqual(work.entries(), []);
  });

  test("repairs existing state permissions and writes private files", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "pending-work.json");
    await fs.writeFile(file, "{}", { mode: 0o644 });
    await fs.chmod(dir, 0o755);
    const work = await PendingWork.load(dir);
    work.set("private", { origin: "x", channel: "general" });
    await waitFor(async () => (await fs.readFile(file, "utf8")).includes("private") || undefined, "private pending-work write");
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  });

  test("a failed write does not block later writes", async () => {
    const dir = await tempDir();
    const work = await PendingWork.load(dir);

    await fs.rm(dir, { recursive: true, force: true });
    work.set("during-outage", { origin: "x", channel: "general" });
    // Let the doomed write hit the missing directory before restoring it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await fs.mkdir(dir, { recursive: true });
    work.set("after-recovery", { origin: "y", channel: "general" });

    const reloaded = await waitFor(async () => {
      const fresh = await PendingWork.load(dir);
      return fresh.get("after-recovery") ? fresh : undefined;
    }, "write after directory restore to persist");
    assert.deepEqual(reloaded.get("after-recovery"), { origin: "y", channel: "general" });
  });
});
