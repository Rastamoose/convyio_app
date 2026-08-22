import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { launchAgentPlist, serviceSlug, systemdUnit, windowsWrapperScript } from "../src/service";

const target = { name: "cc", runRef: "agent-id-123", script: "/home/u/.local/bin/cli.js", node: "/usr/bin/node" };

describe("login service definitions", () => {
  test("the systemd unit never gives up restarting", () => {
    const unit = systemdUnit(target);
    assert.match(unit, /Restart=always/);
    // Without this the default start limit strands the agent after 5 crashes,
    // which is the exact failure the service exists to prevent.
    assert.match(unit, /StartLimitIntervalSec=0/);
    assert.match(unit, /WantedBy=default\.target/);
    assert.match(unit, /ExecStart=\/usr\/bin\/node \/home\/u\/\.local\/bin\/cli\.js run agent-id-123/);
  });

  // The unit runs by id, not name: two agents paired on one machine can share
  // a display name, and a name-based target would deadlock on "more than one
  // paired agent named X" every time the supervisor restarts it.
  test("the unit targets the agent id, not its display name, even when they'd collide", () => {
    const unit = systemdUnit({ ...target, name: "claude", runRef: "claude" });
    assert.match(unit, /run claude$/m);
    const unit2 = systemdUnit({ ...target, runRef: "id with spaces" });
    assert.match(unit2, /run "id with spaces"$/m);
  });

  test("plist escapes XML rather than emitting broken markup", () => {
    const plist = launchAgentPlist("com.convyio.agent.x", { ...target, runRef: 'a&b<c"' });
    assert.match(plist, /<string>a&amp;b&lt;c&quot;<\/string>/);
    assert.doesNotMatch(plist, /<string>a&b/);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  });

  test("slugs stay filesystem-safe and never collapse to empty", () => {
    assert.equal(serviceSlug("My Agent!"), "my-agent");
    assert.equal(serviceSlug("../../etc/passwd"), "etc-passwd");
    assert.equal(serviceSlug("!!!"), "agent");
  });

  // A systemd/launchd user service starts with a clean environment, not the
  // shell `connect` ran in — a provider without an on-disk login (unlike
  // Claude's `claude login`) needs its key baked into the service definition
  // itself, or the installed process can never see it.
  test("the systemd unit bakes provided env vars in, quoted and escaped", () => {
    const unit = systemdUnit({ ...target, env: { OPENAI_API_KEY: 'sk-has "quotes" and \\backslash' } });
    assert.match(unit, /Environment="OPENAI_API_KEY=sk-has \\"quotes\\" and \\\\backslash"/);
  });

  test("the plist bakes provided env vars into EnvironmentVariables, XML-escaped", () => {
    const plist = launchAgentPlist("com.convyio.agent.x", { ...target, env: { OPENAI_API_KEY: "sk-a&b" } });
    assert.match(plist, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>OPENAI_API_KEY<\/key>\s*<string>sk-a&amp;b<\/string>\s*<\/dict>/);
  });

  test("no env means no Environment= line or EnvironmentVariables block", () => {
    assert.doesNotMatch(systemdUnit(target), /Environment=/);
    assert.doesNotMatch(launchAgentPlist("com.convyio.agent.x", target), /EnvironmentVariables/);
  });

  // schtasks's /tr is a single already-quoted command line, not a shell — a
  // wrapper .cmd file sets the environment first so nothing has to nest
  // quotes around the node/script paths inline.
  test("the windows wrapper script sets each var with the whole-assignment quote form, then runs the command", () => {
    const script = windowsWrapperScript({ ...target, env: { OPENAI_API_KEY: "sk-a&b c" } });
    assert.match(script, /^@echo off\r\n/);
    assert.match(script, /\r\nset "OPENAI_API_KEY=sk-a&b c"\r\n/);
    assert.match(script, /\r\n"\/usr\/bin\/node" "\/home\/u\/\.local\/bin\/cli\.js" run "agent-id-123"\r\n/);
  });

  test("the windows wrapper script has no set line when there is no env", () => {
    assert.doesNotMatch(windowsWrapperScript(target), /set "/);
  });
});
