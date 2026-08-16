import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceInviteFlow } from "./WorkspaceInviteFlow";

vi.mock("../lib/supabase", () => ({
  supabase: { auth: {} },
  getRememberMe: () => true,
  setRememberMe: vi.fn(),
}));

const response = (status: number, body: unknown): Response => ({
  ok: status < 400,
  status,
  json: () => Promise.resolve(body),
}) as Response;

describe("WorkspaceInviteFlow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("previews an invitation and accepts it with the authenticated session", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(200, {
        workspace: { id: "ws-2", name: "Second Space" },
        inviterName: "Mina",
        expiresAt: Date.now() + 10_000,
      }))
      .mockResolvedValueOnce(response(200, {
        workspace: {
          id: "ws-2",
          name: "Second Space",
          publicCode: "SECOND",
          role: "member",
          joinedAt: 1_000,
        },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const onAccepted = vi.fn();
    const user = userEvent.setup();

    render(
      <WorkspaceInviteFlow
        token="invite-token"
        accessToken="access-token"
        googleAuthEnabled={true}
        emailAuthEnabled={true}
        onAccepted={onAccepted}
        onLeave={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Join Second Space" })).toBeInTheDocument();
    expect(screen.getByText("Mina invited you to work alongside their team.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));

    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/invites/invite-token/accept"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
    expect(onAccepted).toHaveBeenCalledWith(expect.objectContaining({ id: "ws-2" }));
  });
});
