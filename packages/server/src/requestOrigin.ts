import type { IncomingMessage } from "node:http";

/** Derive the public HTTP origin from a direct or reverse-proxied request. */
export function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  const scheme = forwardedProto === "https" ? "https" : "http";
  const host = request.headers.host ?? `localhost:${request.socket.localPort}`;
  return `${scheme}://${host}`;
}

export function websocketUrl(origin: string): string {
  return origin.replace(/^http/, "ws");
}
