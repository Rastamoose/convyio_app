import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedToolInput } from "../src/brain";

test("structured tool input redacts credential, auth, and private-key variants", () => {
  assert.deepEqual(boundedToolInput({
    credential: "one",
    credentialsFile: "two",
    auth: "three",
    authorizationHeader: "four",
    privateKey: "five",
    private_key_path: "six",
    accessKeyId: "seven",
    clientSecret: "eight",
    safe: { value: "visible" },
  }), {
    credential: "[redacted]",
    credentialsFile: "[redacted]",
    auth: "[redacted]",
    authorizationHeader: "[redacted]",
    privateKey: "[redacted]",
    private_key_path: "[redacted]",
    accessKeyId: "[redacted]",
    clientSecret: "[redacted]",
    safe: { value: "visible" },
  });
});
