/**
 * The single place server base URLs are derived, so no other module reads
 * VITE_WS_URL or hardcodes a host. The HTTP API always lives on the same
 * host/port as the websocket, hence the scheme swap.
 */

export function wsUrl(): string {
  return import.meta.env.VITE_WS_URL ?? "ws://localhost:3001";
}

/** ws:// → http:// and wss:// → https:// on the same host/port. */
export function apiBaseUrl(): string {
  return wsUrl().replace(/^ws/, "http");
}
