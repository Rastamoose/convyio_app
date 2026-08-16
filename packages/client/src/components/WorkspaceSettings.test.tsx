import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSettings } from "./WorkspaceSettings";

const apiFetch = vi.fn();

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    apiFetch,
    self: { id: "owner" },
    connected: true,
  }),
}));

const response = (body: unknown): Response => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
}) as Response;

describe("WorkspaceSettings invites", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/workspace/members") return response({ members: [] });
      if (path === "/api/workspace/access-requests") return response({ requests: [] });
      if (path === "/api/workspace/invites" && !init) {
        return response({
          invites: [{
            id: "invite-1",
            workspaceId: "workspace-1",
            createdBy: "owner",
            createdAt: 1_000,
            expiresAt: Date.now() + 86_400_000,
            uses: 2,
            maxUses: 0,
            revokedAt: null,
          }],
        });
      }
      if (path === "/api/workspace/invites" && init?.method === "POST") {
        return response({
          invite: {
            id: "invite-2",
            workspaceId: "workspace-1",
            createdBy: "owner",
            createdAt: 2_000,
            expiresAt: Date.now() + 86_400_000,
            uses: 0,
            maxUses: 5,
            revokedAt: null,
          },
          token: "reusable-token",
        });
      }
      throw new Error(`unexpected request: ${path}`);
    });
  });

  it("shows invite usage and creates a link with the selected limits", async () => {
    const user = userEvent.setup();
    render(
      <WorkspaceSettings
        summary={{
          id: "workspace-1",
          name: "Example",
          publicCode: "CV-EXAMPLE",
          role: "owner",
          joinedAt: 1_000,
        }}
        onClose={vi.fn()}
        onAccountRefresh={vi.fn()}
        onLeft={vi.fn()}
      />,
    );

    expect(await screen.findByText("2 uses")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Invite expiry"), "86400");
    await user.selectOptions(screen.getByLabelText("Invite max uses"), "5");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    const createCall = apiFetch.mock.calls.find(([path, init]) =>
      path === "/api/workspace/invites" && init?.method === "POST"
    );
    expect(JSON.parse(createCall?.[1]?.body as string)).toEqual({ maxAgeSeconds: 86_400, maxUses: 5 });
    expect((screen.getByLabelText("New invite link") as HTMLInputElement).value).toContain("/invite/reusable-token");
    expect(screen.getByText("0 of 5 uses")).toBeInTheDocument();
  });
});
