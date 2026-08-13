import assert from "node:assert/strict";
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
