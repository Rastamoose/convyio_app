import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LoginScreen } from "./LoginScreen";

// The Supabase auth boundary, mocked the same way App.test.tsx does it.
// Each auth method is a spy the tests program per-scenario; getRememberMe
// defaults to true (the checkbox's real default when the flag is absent).
const { signInWithPassword, signUp, signInWithOAuth, resetPasswordForEmail, getRememberMe, setRememberMe } =
  vi.hoisted(() => ({
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signInWithOAuth: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    getRememberMe: vi.fn(() => true),
    setRememberMe: vi.fn(),
  }));

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: { signInWithPassword, signUp, signInWithOAuth, resetPasswordForEmail },
  },
  getRememberMe,
  setRememberMe,
}));

// Only the username-availability endpoint goes over fetch here.
const fetchMock = vi.fn<typeof fetch>();

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const renderScreen = () => render(<LoginScreen googleAuthEnabled={true} emailAuthEnabled={true} />);

/** Switch the form into signup mode via the visible toggle. */
const toSignup = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "Sign up" }));
  return screen.getByLabelText("Username");
};

describe("LoginScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRememberMe.mockReturnValue(true);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    window.history.replaceState({}, "", "/");
  });

  it("opens on signup mode when the URL carries ?signup", () => {
    window.history.replaceState({}, "", "/?signup");
    renderScreen();

    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByAltText("convyio")).toHaveAttribute("src", "/mark-yellow.svg");
  });

  it("opens on login mode without ?signup", () => {
    renderScreen();

    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(screen.queryByAltText("convyio")).not.toBeInTheDocument();
  });

  it("enables Sign in with a short password — the >=8 rule only gates signup", async () => {
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.type(screen.getByLabelText("Password"), "abc123");

    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("shows the anti-enumeration message when sign-in fails", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.type(screen.getByLabelText("Password"), "wrongpass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/Invalid email or password/)).toBeInTheDocument();
  });

  it("calls setRememberMe before signInWithPassword and trims the email", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderScreen();

    await user.type(screen.getByLabelText("Email address"), "  hana@example.com  ");
    await user.type(screen.getByLabelText("Password"), "abc123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(signInWithPassword).toHaveBeenCalled());
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "hana@example.com",
      password: "abc123",
    });
    expect(setRememberMe).toHaveBeenCalledWith(true);
    // Token writes must land in the right store, so the flag is set first.
    expect(setRememberMe.mock.invocationCallOrder[0]).toBeLessThan(
      signInWithPassword.mock.invocationCallOrder[0],
    );
  });

  it("signup mode flags a taken username on blur and blocks submit", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { available: false, reason: "TAKEN" }));
    const user = userEvent.setup();
    renderScreen();

    const username = await toSignup(user);
    await user.type(username, "harris");
    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough");
    // Typing in the other fields blurred the username field, firing the check.
    expect(await screen.findByText("That username is taken")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create account" })).toBeDisabled();
    expect(signUp).not.toHaveBeenCalled();
  });

  it("signup sends desired_username + emailRedirectTo and shows the check-email state", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { available: true }));
    signUp.mockResolvedValue({
      data: { user: { identities: [{}] }, session: null },
      error: null,
    });
    const user = userEvent.setup();
    renderScreen();

    const username = await toSignup(user);
    await user.type(username, "harris ");
    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalled());
    expect(signUp).toHaveBeenCalledWith({
      email: "hana@example.com",
      password: "longenough",
      options: {
        data: { desired_username: "harris" },
        emailRedirectTo: window.location.origin,
      },
    });
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText("hana@example.com")).toBeInTheDocument();
  });

  it("signup against an existing email shows the sign-in-instead notice", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { available: true }));
    // Supabase's anti-enumeration fake user: no identities = already registered.
    signUp.mockResolvedValue({
      data: { user: { identities: [] }, session: null },
      error: null,
    });
    const user = userEvent.setup();
    renderScreen();

    const username = await toSignup(user);
    await user.type(username, "harris");
    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText(/An account with this email already exists/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sign in instead" })).toBeInTheDocument();
    expect(screen.queryByText("Check your email")).not.toBeInTheDocument();
  });

  it("signup fails open when the availability endpoint is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    signUp.mockResolvedValue({
      data: { user: { identities: [{}] }, session: null },
      error: null,
    });
    const user = userEvent.setup();
    renderScreen();

    const username = await toSignup(user);
    await user.type(username, "harris");
    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.type(screen.getByLabelText("Password"), "longenough");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(signUp).toHaveBeenCalled());
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
  });

  it("forgot password prefills the email, sends the reset, and stays neutral", async () => {
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
    const user = userEvent.setup();
    renderScreen();

    // type="email" inputs strip edge whitespace per the HTML value
    // sanitization spec (jsdom included), so edge spaces can't be typed here;
    // the component's own .trim() is belt-and-braces on top of that.
    await user.type(screen.getByLabelText("Email address"), "hana@example.com");
    await user.click(screen.getByRole("button", { name: "Forgot password" }));

    // The reset form pre-fills from the login email field.
    const resetEmail = screen.getByLabelText("Email address");
    expect(resetEmail).toHaveValue("hana@example.com");
    await user.click(screen.getByRole("button", { name: "Send reset link" }));

    await waitFor(() => expect(resetPasswordForEmail).toHaveBeenCalled());
    expect(resetPasswordForEmail).toHaveBeenCalledWith("hana@example.com", {
      redirectTo: window.location.origin,
    });
    expect(await screen.findByText(/If an account exists/)).toBeInTheDocument();
  });

  it("the Google button starts the OAuth flow with provider google", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderScreen();

    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));

    await waitFor(() => expect(signInWithOAuth).toHaveBeenCalled());
    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  });

  it("keeps the invite route in the Google redirect", async () => {
    signInWithOAuth.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    render(
      <LoginScreen
        googleAuthEnabled={true}
        emailAuthEnabled={false}
        inviteToken="invite-token"
        invitePreview={{
          workspace: { id: "ws-2", name: "Second Space" },
          inviterName: "Mina",
          expiresAt: Date.now() + 10_000,
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Join Second Space" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in with Google" }));

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/invite/invite-token` },
    });
  });
});
