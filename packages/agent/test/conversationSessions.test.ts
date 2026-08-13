import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { ConversationSessions } from "../src/conversationSessions";
import { tempDir } from "./helpers";

test("conversation session mapping persists provider metadata without transcript data", async () => {
  const dir = await tempDir();
  const sessions = await ConversationSessions.load(dir);
  await Promise.all([
    sessions.set("conversation-a", {
      providerSessionId: "provider-session-a",
      permissionMode: "plan",
    }),
    sessions.set("conversation-b", {
      providerSessionId: null,
      permissionMode: "acceptEdits",
    }),
  ]);

  const reloaded = await ConversationSessions.load(dir);
  assert.deepEqual(reloaded.get("conversation-a"), {
    providerSessionId: "provider-session-a",
    permissionMode: "plan",
  });
  assert.deepEqual(reloaded.get("conversation-b"), {
    providerSessionId: null,
    permissionMode: "acceptEdits",
  });
  assert.equal(reloaded.get("unknown"), undefined);
});

test("conversation sessions repair existing state permissions and write private files", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "conversation-sessions.json");
  await fs.writeFile(file, "{}", { mode: 0o644 });
  await fs.chmod(dir, 0o755);
  const sessions = await ConversationSessions.load(dir);
  await sessions.set("conversation-a", { providerSessionId: null, permissionMode: "default" });
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});
