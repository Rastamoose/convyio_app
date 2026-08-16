import { describe, expect, it } from "vitest";
import type { WorkspaceSummary } from "@workspace/shared";
import {
  chooseInitialWorkspace,
  inviteTokenFromPath,
  pendingInviteToken,
  PENDING_INVITE_KEY,
  workspaceIdFromPath,
} from "./workspaceNavigation";

const workspace = (id: string): WorkspaceSummary => ({
  id,
  name: id,
  publicCode: id.toUpperCase(),
  role: "member",
  joinedAt: 1_000,
});

const storage = (): Storage => {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
};

describe("workspace navigation", () => {
  it("auto-opens one membership", () => {
    expect(chooseInitialWorkspace([workspace("ws-1")], "/", null)).toBe("ws-1");
  });

  it("reopens a valid workspace route before the persisted selection", () => {
    expect(
      chooseInitialWorkspace([workspace("ws-1"), workspace("ws-2")], "/w/ws-2", "ws-1"),
    ).toBe("ws-2");
  });

  it("reopens the last valid workspace when several memberships exist", () => {
    expect(
      chooseInitialWorkspace([workspace("ws-1"), workspace("ws-2")], "/", "ws-1"),
    ).toBe("ws-1");
  });

  it("shows the lobby when several memberships have no valid selection", () => {
    expect(
      chooseInitialWorkspace([workspace("ws-1"), workspace("ws-2")], "/", "removed"),
    ).toBeNull();
  });

  it("parses workspace and invite routes", () => {
    expect(workspaceIdFromPath("/w/team%20one")).toBe("team one");
    expect(inviteTokenFromPath("/invite/token%2Fone")).toBe("token/one");
  });

  it("preserves an invite token through a return to the root route", () => {
    const session = storage();
    expect(pendingInviteToken("/invite/token-one", session)).toBe("token-one");
    expect(session.getItem(PENDING_INVITE_KEY)).toBe("token-one");
    expect(pendingInviteToken("/", session)).toBe("token-one");
  });
});
