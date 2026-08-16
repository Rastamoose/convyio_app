import type { WorkspaceAccessRequest, WorkspaceSummary } from "@workspace/shared";
import { apiBaseUrl } from "./serverUrl";

export interface WorkspaceAccount {
  username: string;
  workspaces: WorkspaceSummary[];
  accessRequests: WorkspaceAccessRequest[];
}

export function accountFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

export async function responseMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: string } | null;
  return body?.message ?? `Request failed (${response.status}).`;
}
