import { createClient } from "@supabase/supabase-js";

/**
 * "Remember me" routing for Supabase's auth tokens. The flag decides which
 * store the tokens land in: localStorage (survives the browser closing) when
 * remembering, sessionStorage (this tab only) when not. On top of that,
 * remembered tokens carry a 30-day stamp — refreshed on every write, so an
 * active device stays signed in but an idle one signs out.
 */
const REMEMBER_FLAG_KEY = "workspace.auth.remember";
const REMEMBER_UNTIL_KEY = "workspace.auth.rememberUntil";
const REMEMBER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Absent flag means remember — the checkbox defaults to checked. */
export function getRememberMe(): boolean {
  return localStorage.getItem(REMEMBER_FLAG_KEY) !== "0";
}

/**
 * Must be called BEFORE signInWithPassword/signUp so the resulting token
 * writes land in the right store. Flipping the flag clears both stores'
 * Supabase keys — a stale session left in the other store must not resurrect
 * on the next visit.
 */
export function setRememberMe(remember: boolean): void {
  const changed = getRememberMe() !== remember;
  localStorage.setItem(REMEMBER_FLAG_KEY, remember ? "1" : "0");
  if (changed) {
    clearSupabaseKeys(localStorage);
    clearSupabaseKeys(sessionStorage);
    localStorage.removeItem(REMEMBER_UNTIL_KEY);
  }
}

/** Every key supabase-js writes through the adapter starts with "sb-". */
function clearSupabaseKeys(store: Storage): void {
  for (let i = store.length - 1; i >= 0; i--) {
    const key = store.key(i);
    if (key?.startsWith("sb-")) store.removeItem(key);
  }
}

const rememberAwareStorage = {
  getItem(key: string): string | null {
    if (!getRememberMe()) return sessionStorage.getItem(key);
    const until = Number(localStorage.getItem(REMEMBER_UNTIL_KEY));
    if (until && Date.now() > until) {
      localStorage.removeItem(key);
      localStorage.removeItem(REMEMBER_UNTIL_KEY);
      return null;
    }
    return localStorage.getItem(key);
  },
  setItem(key: string, value: string): void {
    if (getRememberMe()) {
      localStorage.setItem(key, value);
      localStorage.setItem(REMEMBER_UNTIL_KEY, String(Date.now() + REMEMBER_WINDOW_MS));
    } else {
      sessionStorage.setItem(key, value);
    }
  },
  removeItem(key: string): void {
    // Removal targets both stores so sign-out works regardless of which
    // store the flag pointed at when the token was written.
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  },
};

/**
 * The one browser Supabase client. Auth (Google OAuth + email/password)
 * flows through this; the server never sees Supabase credentials, only the
 * resulting access token as a Bearer header / WS join `authToken`.
 * detectSessionInUrl stays at its default (enabled) — the OAuth redirect and
 * email confirmation links depend on it.
 */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { storage: rememberAwareStorage } },
);
