import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isJoinNotice, joinNoticeMemberKind, memberJoinedNotice } from "../src/joinNotice";

describe("join notices", () => {
  test("people and agents share the same line", () => {
    assert.equal(memberJoinedNotice("hana", "human"), "hana joined the workspace");
    assert.equal(memberJoinedNotice("noodle", "agent"), "noodle joined the workspace");
  });

  test("noodle and legacy agent wording still count as agents", () => {
    assert.equal(
      joinNoticeMemberKind({ id: "member-joined:ws:managed-agent:noodle:ws", content: "noodle joined the workspace", authorId: "n" }),
      "agent",
    );
    assert.equal(
      joinNoticeMemberKind({ id: "member-joined:ws:actor", content: "reader joined as an agent", authorId: "a" }),
      "agent",
    );
    assert.equal(
      joinNoticeMemberKind({ id: "member-joined:ws:user", content: "hana joined the workspace", authorId: "h" }),
      "human",
    );
  });

  test("only durable member-joined ids count as join notices", () => {
    assert.equal(isJoinNotice({ id: "member-joined:ws:actor", authorKind: "system" }), true);
    assert.equal(isJoinNotice({ id: "member-joined:ws:actor", authorKind: "human" }), false);
    assert.equal(isJoinNotice({ id: "managed-welcome:ws:1", authorKind: "system" }), false);
  });
});
