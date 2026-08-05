/**
 * The single place server base URLs are derived, so no other module reads
 * VITE_WS_URL or hardcodes a host. The HTTP API always lives on the same
 * host/port as the websocket, hence the scheme swap.
 *
 * Production builds are served by the server itself (one origin), so the
 * page's own location is the server; dev runs the Vite server on :5173
 * against the API on :3001, hence the localhost default there.
 */

export function wsUrl(): string {
  const override = import.meta.env.VITE_WS_URL;
  if (override) return override;
  if (import.meta.env.DEV) return "ws://localhost:3001";
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}`;
}

/** ws:// → http:// and wss:// → https:// on the same host/port. */
export function apiBaseUrl(): string {
  return wsUrl().replace(/^ws/, "http");
}
