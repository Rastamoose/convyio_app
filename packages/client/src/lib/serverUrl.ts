/**
 * The single place server base URLs are derived, so no other module reads
 * VITE_WS_URL or hardcodes a host. The HTTP API always lives on the same
 * host/port as the websocket, hence the scheme swap.
 *
 * Production builds are served by the server itself (one origin), so the
 * page's own location is the server; dev runs the Vite server on :5173
 * against the API on :3001, hence the localhost default there.
 */

export function wsUrl(workspaceId?: string): string {
  const override = import.meta.env.VITE_WS_URL;
  const base = override
    ? override
    : import.meta.env.DEV
      ? "ws://localhost:3001"
      : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`;
  return workspaceId
    ? `${base.replace(/\/$/, "")}/ws/${encodeURIComponent(workspaceId)}`
    : base;
}

/** ws:// → http:// and wss:// → https:// on the same host/port. */
export function apiBaseUrl(): string {
  return wsUrl().replace(/^ws/, "http");
}
