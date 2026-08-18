import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { httpUrlFromWs } from "../src/hostedSupervisor";

describe("hosted supervisor helpers", () => {
  test("converts websocket origins to HTTP", () => {
    assert.equal(httpUrlFromWs("ws://localhost:3001"), "http://localhost:3001");
    assert.equal(httpUrlFromWs("wss://app.convyio.com"), "https://app.convyio.com");
  });
});
