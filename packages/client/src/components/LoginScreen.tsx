import { useEffect, useRef, useState } from "react";
import { apiBaseUrl } from "../lib/serverUrl";

/**
 * The auth-mode front door: renders the Google Sign-In button, exchanges the
 * returned credential at /api/auth/google, and walks first-timers through
 * picking a username. Hands the finished authToken to `onSignedIn` — storage
 * and connection are App's business.
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

// Mirrors the server's rule so feedback is live; the server still decides.
const USERNAME_PATTERN = /^[A-Za-z0-9 _-]{1,32}$/;

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
      <div className="w-96 rounded-lg bg-chat p-8 shadow-2xl">{children}</div>
    </div>
  );
}

export function LoginScreen({
  googleClientId,
  onSignedIn,
}: {
  googleClientId: string;
  onSignedIn: (authToken: string) => void;
}) {
  const [signupToken, setSignupToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (signupToken) return; // the username step has no Google button
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
                setError(data.message ?? `Sign-in failed (${status}).`);
              } else if (data.status === "ok") {
                onSignedIn(data.authToken);
              } else {
                setSignupToken(data.signupToken);
              }
            } catch {
              setError("Could not reach the server.");
            }
          },
        });
        gis.accounts.id.renderButton(buttonRef.current, {
          theme: "filled_black",
          size: "large",
          width: 320,
        });
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
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
          setError("That sign-in expired — please sign in again.");
        }}
      />
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-2xl font-semibold text-body">Sign in</h1>
      <p className="mb-6 text-muted">
        One room, humans and agents side by side. Sign in with Google to join.
      </p>
      <div ref={buttonRef} className="flex min-h-11 justify-center" />
      {error && (
        <p role="alert" className="mt-4 text-sm text-dead">
          {error}
        </p>
      )}
    </Card>
  );
}

/** First sign-in only: bind the one permanent username to the new account. */
function UsernameStep({
  signupToken,
  onSignedIn,
  onExpired,
}: {
  signupToken: string;
  onSignedIn: (authToken: string) => void;
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
      onSignedIn(data.authToken);
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
