import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "../lib/serverUrl";

/**
 * The auth-mode front door: email/password sign in and sign up, plus the
 * Google Sign-In button below when Google is configured. Both paths land on
 * a signupToken for brand-new humans (email signup collects a username
 * inline; Google signup needs one more step since Google never asked for
 * one). Hands the finished authToken to `onSignedIn` — storage and
 * connection are App's business.
 */

// Minimal ambient surface of Google Identity Services (loaded via script
// tag); typed by hand so no @types dependency rides in for two calls.
declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
          }) => void;
          renderButton: (
            parent: HTMLElement,
            options: { theme?: string; size?: string; width?: number },
          ) => void;
        };
      };
    };
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";

// Mirrors the server's rules so feedback is live; the server still decides.
const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function loadGis(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    const script =
      existing ?? Object.assign(document.createElement("script"), { src: GIS_SRC, async: true });
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () =>
      reject(new Error("Could not load Google Sign-In. Check the network and reload.")),
    );
    if (!existing) document.head.append(script);
  });
}

async function postJson(
  path: string,
  body: unknown,
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-sidebar-dark">
      <div className="w-96 animate-fade-in rounded-lg bg-chat p-8 shadow-2xl">
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
        className="mb-2 block text-xs font-bold tracking-wide text-muted uppercase"
      >
        {label}
      </label>
      <input
        id={id}
        className="w-full rounded bg-sidebar-dark px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
        {...inputProps}
      />
    </div>
  );
}

function Divider() {
  return (
    <div className="my-6 flex items-center gap-3">
      <div className="h-px flex-1 bg-divider" />
      <span className="text-xs font-medium text-faint uppercase">Or</span>
      <div className="h-px flex-1 bg-divider" />
    </div>
  );
}

export function LoginScreen({
  googleClientId,
  emailAuthEnabled,
  onSignedIn,
}: {
  googleClientId: string | null;
  emailAuthEnabled: boolean;
  onSignedIn: (authToken: string, rememberMe: boolean) => void;
}) {
  const [signupToken, setSignupToken] = useState<string | null>(null);
  const [googleError, setGoogleError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!googleClientId || signupToken) return;
    let cancelled = false;
    loadGis()
      .then(() => {
        const gis = window.google;
        if (cancelled || !buttonRef.current || !gis) return;
        gis.accounts.id.initialize({
          client_id: googleClientId,
          callback: async ({ credential }) => {
            try {
              const { status, data } = await postJson("/api/auth/google", { credential });
              if (status !== 200) {
                setGoogleError(data.message ?? `Sign-in failed (${status}).`);
              } else if (data.status === "ok") {
                onSignedIn(data.authToken, true);
              } else {
                setSignupToken(data.signupToken);
              }
            } catch {
              setGoogleError("Could not reach the server.");
            }
          },
        });
        gis.accounts.id.renderButton(buttonRef.current, {
          theme: "outline",
          size: "large",
          width: 320,
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setGoogleError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [googleClientId, signupToken]);

  if (signupToken) {
    return (
      <UsernameStep
        signupToken={signupToken}
        onSignedIn={onSignedIn}
        onExpired={() => {
          setSignupToken(null);
          setGoogleError("That sign-in expired — please sign in again.");
        }}
      />
    );
  }

  return (
    <Card>
      {emailAuthEnabled ? (
        <EmailAuthForm onSignedIn={onSignedIn} />
      ) : (
        <>
          <h1 className="mb-1 text-2xl font-semibold text-body">Sign in</h1>
          <p className="mb-6 text-muted">
            One room, humans and agents side by side. Sign in with Google to join.
          </p>
        </>
      )}
      {googleClientId && (
        <>
          {emailAuthEnabled && <Divider />}
          <div ref={buttonRef} className="flex min-h-11 justify-center" />
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

/** The email/password form: toggles between signing in and creating an account. */
function EmailAuthForm({
  onSignedIn,
}: {
  onSignedIn: (authToken: string, rememberMe: boolean) => void;
}) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
  const usernameValid = mode === "login" || USERNAME_PATTERN.test(username.trim());
  const canSubmit = emailValid && passwordValid && usernameValid && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const path = mode === "login" ? "/api/auth/email-login" : "/api/auth/email-signup";
      const body =
        mode === "login"
          ? { email: email.trim(), password }
          : { email: email.trim(), password, username: username.trim() };
      const { status, data } = await postJson(path, body);
      if (status !== 200) {
        setError(data.message ?? `Could not sign in (${status}).`);
        return;
      }
      onSignedIn(data.authToken, rememberMe);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <p className="mb-1 text-sm text-muted">Please enter your details</p>
      <h1 className="mb-6 text-2xl font-semibold text-body">
        {mode === "login" ? "Welcome back" : "Create your account"}
      </h1>

      <Field
        id="email"
        label="Email address"
        type="email"
        autoFocus
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        placeholder="you@example.com"
      />
      {mode === "signup" && (
        <Field
          id="username"
          label="Username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          placeholder="e.g. harris"
          maxLength={32}
        />
      )}
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

      <div className="mb-4 flex items-center justify-between text-sm">
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={rememberMe}
            onChange={(e) => setRememberMe(e.target.checked)}
            className="accent-blurple"
          />
          Remember for 30 days
        </label>
        {mode === "login" && (
          <button
            type="button"
            onClick={() => setForgotMsg("Password reset isn't set up yet — ask an admin for help.")}
            className="font-medium text-blurple hover:underline"
          >
            Forgot password
          </button>
        )}
      </div>
      {forgotMsg && <p className="mb-4 text-sm text-faint">{forgotMsg}</p>}

      <button
        onClick={() => void submit()}
        disabled={!canSubmit}
        className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
      >
        {mode === "login" ? "Sign in" : "Create account"}
      </button>

      {error && (
        <p role="alert" className="mt-4 text-sm text-dead">
          {error}
        </p>
      )}

      <p className="mt-6 text-center text-sm text-muted">
        {mode === "login" ? "Don't have an account?" : "Already have an account?"}{" "}
        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
          className="font-medium text-blurple hover:underline"
        >
          {mode === "login" ? "Sign up" : "Sign in"}
        </button>
      </p>
    </>
  );
}

/** First Google sign-in only: bind the one permanent username to the new account. */
function UsernameStep({
  signupToken,
  onSignedIn,
  onExpired,
}: {
  signupToken: string;
  onSignedIn: (authToken: string, rememberMe: boolean) => void;
  onExpired: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmed = name.trim();
  const valid = USERNAME_PATTERN.test(trimmed);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { status, data } = await postJson("/api/auth/username", {
        signupToken,
        username: trimmed,
      });
      if (status === 410) return onExpired();
      if (status !== 200) {
        setError(data.message ?? `Could not save the username (${status}).`);
        return;
      }
      onSignedIn(data.authToken, true);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <h1 className="mb-1 text-2xl font-semibold text-body">Pick a username</h1>
      <p className="mb-6 text-muted">
        This is who you are here, permanently — choose well.
      </p>
      <label
        htmlFor="username"
        className="mb-2 block text-xs font-bold tracking-wide text-muted uppercase"
      >
        Username
      </label>
      <input
        id="username"
        autoFocus
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && void submit()}
        className="mb-2 w-full rounded bg-sidebar-dark px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
        placeholder="e.g. harris"
        maxLength={32}
      />
      <p role={error ? "alert" : undefined} className={`mb-4 text-sm ${error ? "text-dead" : "text-faint"}`}>
        {error ?? "1-32 characters: letters, digits, spaces, - and _"}
      </p>
      <button
        onClick={() => void submit()}
        disabled={!valid || submitting}
        className="w-full rounded bg-blurple py-2.5 font-medium text-mention-text transition hover:bg-working disabled:cursor-not-allowed disabled:opacity-50"
      >
        Join Workspace
      </button>
    </Card>
  );
}
