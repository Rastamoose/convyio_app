import { useRef } from "react";

export interface ApiSession {
  /** Bind (or rebind) the credentials carried by the welcome frame. */
  start: (apiUrl: string, token: string) => void;
  /** Authenticated fetch; null until a welcome frame has bound a session. */
  fetch: (path: string, init?: RequestInit) => Promise<Response> | null;
  /**
   * Absolute URL for a server-relative path (e.g. Attachment.url), for src/
   * href use where headers cannot ride along. Path-only until a session binds.
   */
  url: (path: string) => string;
  /** The server's message for a failed response, for user-facing errors. */
  errorMessage: (res: Response) => Promise<string>;
}

/**
 * The authenticated HTTP API session bound from the welcome frame. Exists so
 * there is exactly one token/fetch path, whatever domain the call serves.
 */
export function useApiSession(): ApiSession {
  const tokenRef = useRef<string | null>(null);
  const apiUrlRef = useRef<string | null>(null);
  return {
    start: (apiUrl, token) => {
      apiUrlRef.current = apiUrl;
      tokenRef.current = token;
    },
    url: (path) => `${apiUrlRef.current ?? ""}${path}`,
    fetch: (path, init) => {
      const token = tokenRef.current;
      const apiUrl = apiUrlRef.current;
      if (!token || !apiUrl) return null;
      return fetch(`${apiUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...init?.headers,
        },
      });
    },
    errorMessage: async (res) => {
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      return data?.message ?? `request failed: ${res.status}`;
    },
  };
}
