import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { ContextNotes } from "../src/context/ContextNotes";
import { ThreadEventStore } from "../src/chat/ThreadEventStore";
import { createTestDb } from "./pgSchema";

const env = await createTestDb();
const notes = new ContextNotes(env.db, new ThreadEventStore(env.db));
after(() => env.drop());

describe("persistent agent context notes", () => {
  test("all humans publish workspace guidance while agents keep human-readable private notebooks", async () => {
    const human = await env.db.upsertActor("human", "note-human");
    const firstAgent = await env.db.upsertActor("agent", "first-note-agent");
    const secondAgent = await env.db.upsertActor("agent", "second-note-agent");

    const workspace = await notes.create(human, { scope: "workspace", body: "Preserve customer data" });
    const notebook = await notes.create(firstAgent, { scope: "agent", body: "The billing folder owns invoices" });
    await assert.rejects(
      () => notes.create(firstAgent, { scope: "workspace", body: "Override everyone" }),
      /only humans/i,
    );

    assert.deepEqual((await notes.listForAgent(firstAgent.id)).map((note) => note.id), [workspace.id, notebook.id]);
    assert.deepEqual((await notes.listForAgent(secondAgent.id)).map((note) => note.id), [workspace.id]);
    assert.deepEqual((await notes.listFor(human)).map((note) => note.id), [workspace.id, notebook.id]);
  });
});
