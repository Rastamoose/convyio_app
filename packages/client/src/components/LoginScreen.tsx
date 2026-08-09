import { useState } from "react";
import { supabase } from "../lib/supabase";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-chat">
      <div className="w-96 animate-fade-in rounded-lg bg-sidebar p-8 shadow-2xl">
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
        className="w-full rounded border border-divider bg-input px-3 py-2.5 text-body outline-none focus:ring-2 focus:ring-blurple"
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
}: {
  googleAuthEnabled: boolean;
  emailAuthEnabled: boolean;
}) {
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const signInWithGoogle = async () => {
    setGoogleBusy(true);
    setGoogleError(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) {
      setGoogleError(error.message);
      setGoogleBusy(false);
    }
    // On success the browser navigates to Google and this component unmounts.
  };

  return (
    <Card>
      {emailAuthEnabled ? (
        <EmailAuthForm />
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
            className="w-full rounded border border-divider bg-input py-2.5 font-medium text-body transition hover:bg-popup disabled:cursor-not-allowed disabled:opacity-50"
          >
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

/** The email/password form: toggles between signing in and creating an
 *  account. Username is not collected here — both providers pick a
 *  username through the same post-auth step (App.tsx's UsernameStep). */
function EmailAuthForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const emailValid = EMAIL_PATTERN.test(email.trim());
  const passwordValid = password.length >= MIN_PASSWORD_LENGTH;
  const canSubmit = emailValid && passwordValid && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const { error } =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email: email.trim(), password })
        : await supabase.auth.signUp({ email: email.trim(), password });
    if (error) setError(error.message);
    setSubmitting(false);
    // On success App.tsx's onAuthStateChange picks up the new session.
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

      {mode === "login" && (
        <div className="mb-4 flex items-center justify-end text-sm">
          <button
            type="button"
            onClick={() => setForgotMsg("Password reset isn't set up yet — ask an admin for help.")}
            className="font-medium text-blurple hover:underline"
          >
            Forgot password
          </button>
        </div>
      )}
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
