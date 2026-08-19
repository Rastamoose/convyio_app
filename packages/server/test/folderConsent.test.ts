import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Project } from "@workspace/shared";
import { folderConsent } from "../src/projects/folderConsent";

function folder(accessMode: Project["accessMode"]): Project {
  return {
    id: "folder-1",
    workspaceId: "ws-1",
    name: "notes",
    kind: "directory",
    remoteUrl: null,
    defaultBranch: null,
    createdBy: "human-1",
    createdAt: 1,
    archivedAt: null,
    accessMode,
  };
}

describe("folderConsent", () => {
  test("ask requires the owner online", () => {
    const denied = folderConsent(folder("ask"), false);
    assert.deepEqual(denied, {
      allow: false,
      code: "OWNER_OFFLINE",
      message: "notes is unavailable because its owner is offline",
    });
  });

  test("always is durable consent while the Toolman node remains available", () => {
    assert.deepEqual(folderConsent(folder("always"), false), { allow: true });
  });

  test("deny refuses even when the owner is online", () => {
    const denied = folderConsent(folder("deny"), true);
    assert.deepEqual(denied, {
      allow: false,
      code: "FOLDER_DENIED",
      message: "notes's owner has denied local access",
    });
  });

  test("always allows while the owner is online", () => {
    assert.deepEqual(folderConsent(folder("always"), true), { allow: true });
  });

  test("ask prompts the owner", () => {
    assert.deepEqual(folderConsent(folder("ask"), true), { prompt: true });
  });
});
