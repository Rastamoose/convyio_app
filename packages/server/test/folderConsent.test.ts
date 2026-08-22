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
  test("ask always prompts, regardless of whether the owner is online right now", () => {
    assert.deepEqual(folderConsent(folder("ask")), { prompt: true });
  });

  test("always is durable consent", () => {
    assert.deepEqual(folderConsent(folder("always")), { allow: true });
  });

  test("deny refuses", () => {
    const denied = folderConsent(folder("deny"));
    assert.deepEqual(denied, {
      allow: false,
      code: "FOLDER_DENIED",
      message: "notes's owner has denied local access",
    });
  });
});
