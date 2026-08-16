import { useState } from "react";
import type { WorkspaceInvitePreview } from "@workspace/shared";
import { getRememberMe, setRememberMe, supabase } from "../lib/supabase";
import { invitePath } from "../lib/workspaceNavigation";
import { apiBaseUrl } from "../lib/serverUrl";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LENGTH = 8;

// Same rule as the server's username claim and App.tsx's UsernameStep.
const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;
const USERNAME_HINT = "1-32 characters: letters, digits, spaces, - and _";

const authRedirectUrl = (inviteToken?: string) =>
  `${window.location.origin}${inviteToken ? invitePath(inviteToken) : ""}`;

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-frame flex h-full items-center justify-center">
      <div className="elevated w-96 animate-fade-in rounded-2xl p-8">
        {children}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  ...inputProps
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="mb-4">
      <label
        htmlFor={id}
        className="mb-2 block text-[11px] font-bold tracking-wider text-muted uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        className="w-full rounded-md border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-accent"
        {...inputProps}
      />
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

function Divider() {
  return (
    <div className="my-6 flex items-center gap-3">
      <div className="h-px flex-1 bg-divider" />
      <span className="text-[10px] font-medium tracking-wider text-faint uppercase">Or</span>
      <div className="h-px flex-1 bg-divider" />
    </div>
  );
}

/**
 * The auth-mode front door: starts a Supabase sign-in (email/password
 * directly, Google via redirect) and nothing else — it never sees or hands
 * back a token. App.tsx reacts to the resulting Supabase session via
 * supabase.auth.onAuthStateChange for both providers alike, including the
 * post-auth "pick a username" step (App.tsx's UsernameStep).
 */
export function LoginScreen({
  googleAuthEnabled,
  emailAuthEnabled,
  invitePreview,
  inviteToken,
}: {
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
  invitePreview?: WorkspaceInvitePreview;
  inviteToken?: string;
}) {
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const signInWithGoogle = async () => {
    setGoogleBusy(true);
    setGoogleError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: authRedirectUrl(inviteToken) },
    });
    if (error) {
      setGoogleError(error.message);
      setGoogleBusy(false);
    }
    // On success the browser navigates to Google and this component unmounts.
  };

  return (
    <Card>
      {invitePreview && (
        <div className="mb-6 border-b border-divider pb-5">
          <p className="mb-1 text-[11px] font-bold tracking-wider text-muted uppercase">Workspace invite</p>
          <h1 className="text-xl font-semibold text-body">Join {invitePreview.workspace.name}</h1>
          <p className="mt-1 text-sm text-muted">Invited by {invitePreview.inviterName}</p>
        </div>
      )}
      {emailAuthEnabled ? (
        <EmailAuthForm inviteToken={inviteToken} />
      ) : (
        <>
          <h1 className="mb-1 text-2xl font-semibold text-body">Sign in</h1>
          <p className="mb-6 text-muted">
            One room, humans and agents side by side. Sign in with Google to join.
          </p>
        </>
      )}
      {googleAuthEnabled && (
        <>
          {emailAuthEnabled && <Divider />}
          <button
            onClick={() => void signInWithGoogle()}
            disabled={googleBusy}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-divider bg-input py-2.5 font-medium text-body transition hover:bg-subtle-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <GoogleLogo />
            Sign in with Google
          </button>
        </>
      )}
      {googleError && (
        <p role="alert" className="mt-4 text-sm text-dead">
          {googleError}
        </p>
      )}
    </Card>
  );
}

/** The email/password form: toggles between signing in, creating an account
 *  (username collected up front, claimed server-side from
 *  user_metadata.desired_username on first session — App.tsx's UsernameStep
 *  stays as the fallback), and requesting a password reset. */
function EmailAuthForm({ inviteToken }: { inviteToken?: string }) {
  // The landing page's "Start using Convyio" links arrive with ?signup so a
  // new visitor lands on account creation, not the sign-in form.
  const [mode, setMode] = useState<"login" | "signup" | "forgot">(() =>
    new URLSearchParams(window.location.search).has("signup") ? "signup" : "login",
  );
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMeChecked] = useState(getRememberMe);
  const [usernameError, setUsernameError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signupSentTo, setSignupSentTo] = useState<string | null>(null);
  const [accountExists, setAccountExists] = useState(false);

  const trimmedUsername = username.trim();
  const emailValid = EMAIL_PATTERN.test(email.trim());
  const usernameValid = USERNAME_PATTERN.test(trimmedUsername);
  // The length rule applies to NEW passwords only — signing in must accept
  // whatever the account was created with (the server verifies it anyway).
  const passwordValid = mode === "signup" ? password.length >= MIN_PASSWORD_LENGTH : password.length > 0;
  const canSubmit =
    emailValid &&
    passwordValid &&
    !submitting &&
    (mode !== "signup" || (usernameValid && !usernameError));

  const switchMode = (next: "login" | "signup") => {
    setMode(next);
    setError(null);
    setUsernameError(null);
    setSignupSentTo(null);
    setAccountExists(false);
  };

  /** Returns whether signup may proceed. An unreachable availability check
   *  never blocks — the server-side claim falls back to UsernameStep. */
  const checkUsername = async (): Promise<boolean> => {
    if (!USERNAME_PATTERN.test(trimmedUsername)) {
      setUsernameError(USERNAME_HINT);
      return false;
    }
    try {
      const res = await fetch(
        `${apiBaseUrl()}/api/auth/username-available?name=${encodeURIComponent(trimmedUsername)}`,
      );
      const data = (await res.json()) as { available: boolean; reason?: "INVALID" | "TAKEN" };
      if (!data.available) {
        setUsernameError(data.reason === "TAKEN" ? "That username is taken" : USERNAME_HINT);
        return false;
      }
    } catch {
      // Server down or mid-restart: let the signup through anyway.
    }
    setUsernameError(null);
    return true;
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    // Set before the auth call so the token writes land in the right store.
    setRememberMe(rememberMe);
    if (mode === "signup") {
      if (!(await checkUsername())) {
        setSubmitting(false);
        return;
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: { desired_username: trimmedUsername },
          emailRedirectTo: authRedirectUrl(inviteToken),
        },
      });
      if (error) {
        setError(error.message);
      } else if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        // Supabase's anti-enumeration fake user: no identities means the
        // email is already registered, and no confirmation email went out.
        setAccountExists(true);
      } else if (!data.session && data.user) {
        setSignupSentTo(email.trim());
      }
      // With a session, App.tsx's onAuthStateChange takes over.
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      // Supabase deliberately doesn't reveal whether the email exists, so
      // neither can we — one message covers both wrong-password and no-account.
      if (error) {
        setError("Invalid email or password. If you don't have an account yet, sign up first.");
      }
    }
    setSubmitting(false);
  };

  if (mode === "forgot") {
    return <ForgotPasswordForm initialEmail={email} onBack={() => switchMode("login")} />;
  }

  if (signupSentTo) {
    return (
      <>
        <h1 className="mb-1 text-2xl font-semibold text-body">Check your email</h1>
        <p className="mb-6 text-muted">
          Account created — we sent a confirmation link to{" "}
          <span className="font-medium text-body">{signupSentTo}</span>. Click it, then come back
          and sign in.
        </p>
        <button
          onClick={() => switchMode("login")}
          className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover"
        >
          Go to sign in
        </button>
      </>
    );
  }

  return (
    <>
      <p className="mb-1 text-sm text-muted">Please enter your details</p>
      <h1 className="mb-6 text-2xl font-semibold text-body">
        {mode === "login" ? "Welcome back" : "Create your account"}
      </h1>

      {mode === "signup" && (
        <div className="mb-4">
          <Field
            id="username"
            label="Username"
            autoFocus
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setUsernameError(null);
            }}
            onBlur={() => trimmedUsername && void checkUsername()}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="e.g. harris"
            maxLength={32}
          />
          <p
            role={usernameError ? "alert" : undefined}
            className={`-mt-2 text-sm ${usernameError ? "text-dead" : "text-faint"}`}
          >
            {usernameError ?? USERNAME_HINT}
          </p>
        </div>
      )}
      <Field
        id="email"
        label="Email address"
        type="email"
        autoFocus={mode === "login"}
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError(null);
          setAccountExists(false);
        }}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="you@example.com"
      />
      <Field
        id="password"
        label="Password"
        type="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="••••••••"
      />

      <div className="mb-4 text-sm">
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => {
              setRememberMeChecked(e.target.checked);
              setRememberMe(e.target.checked);
            }}
            className="accent-accent"
          />
          Remember for 30 days
        </label>
        {mode === "login" && (
          <button
            type="button"
            onClick={() => setMode("forgot")}
            className="mt-2 font-medium text-accent hover:underline"
          >
            Forgot password
          </button>
        )}
      </div>

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
      >
        {mode === "login" ? "Sign in" : "Create account"}
      </button>

      {accountExists && (
        <p role="alert" className="mt-4 text-sm text-dead">
          An account with this email already exists —{" "}
          <button
            type="button"
            onClick={() => switchMode("login")}
            className="font-medium text-accent hover:underline"
          >
            sign in instead
          </button>
          .
        </p>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-dead">
          {error}
        </p>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => switchMode(mode === "login" ? "signup" : "login")}
          className="font-medium text-accent hover:underline"
        >
          {mode === "login" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </>
  );
}

/** Requests a Supabase reset email. The confirmation copy never reveals
 *  whether the account exists, so the call's outcome is deliberately not
 *  surfaced. The reset link lands back on the app origin, where App.tsx's
 *  PASSWORD_RECOVERY handling shows the new-password screen. */
function ForgotPasswordForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const [email, setEmail] = useState(initialEmail);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const valid = EMAIL_PATTERN.test(email.trim());

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: window.location.origin,
    });
    setSentTo(email.trim());
    setSubmitting(false);
  };

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold text-body">Reset your password</h1>
      <p className="mb-6 text-muted">Enter your email and we'll send you a reset link.</p>
      {sentTo ? (
        <p className="mb-4 text-sm text-body">
          If an account exists for <span className="font-medium">{sentTo}</span>, a password reset
          link is on its way.
        </p>
      ) : (
        <>
          <Field
            id="reset-email"
            label="Email address"
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            placeholder="you@example.com"
          />
          <button
            onClick={() => void submit()}
            disabled={!valid || submitting}
            className="w-full rounded-md bg-accent py-2.5 font-medium text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Send reset link
          </button>
        </>
      )}
      <p className="mt-6 text-center text-sm text-muted">
        <button type="button" onClick={onBack} className="font-medium text-accent hover:underline">
          Back to sign in
        </button>
      </p>
    </>
  );
}
