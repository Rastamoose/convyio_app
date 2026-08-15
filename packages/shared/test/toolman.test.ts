import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isReadOnlyToolmanAction,
  requiredCapability,
  sanitizeRemoteUrl,
  TOOLMAN_ACTION_CAPABILITY,
} from "../src/toolman";

describe("toolman contracts", () => {
  test("only classified mutating actions consume a capability", () => {
    assert.equal(isReadOnlyToolmanAction("project_read_file"), true);
    assert.equal(isReadOnlyToolmanAction("project_write_file"), false);
    assert.equal(requiredCapability("project_write_file"), "file_write");
    assert.equal(requiredCapability("project_run_command"), "shell_repo");
    assert.equal(requiredCapability("project_read_file"), undefined);
    assert.equal("unknown_tool" in TOOLMAN_ACTION_CAPABILITY, false);
  });

  test("remote urls never retain credentials", () => {
    assert.equal(
      sanitizeRemoteUrl("https://user:secret@github.com/acme/app.git"),
      "https://github.com/acme/app.git",
    );
    assert.equal(
      sanitizeRemoteUrl("https://github.com/acme/app.git"),
      "https://github.com/acme/app.git",
    );
    assert.match(sanitizeRemoteUrl("git@github.com:acme/app.git"), /github\.com/);
  });
});
