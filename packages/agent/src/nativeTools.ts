/**
 * Provider-neutral native-tool ceiling. Claude, ACP and any later harness
 * may expose read/search/think/fetch locally; mutations still go through
 * the server Toolman path. Unknown native tools fail closed.
 */
export const SAFE_CLAUDE_NATIVE_TOOLS = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

export const SAFE_ACP_KINDS = ["search", "think", "fetch", "read"] as const;

export function isSafeClaudeNativeTool(name: string): boolean {
  return (SAFE_CLAUDE_NATIVE_TOOLS as readonly string[]).includes(name);
}

export function isSafeAcpKind(kind: string | null | undefined): boolean {
  return kind === "search" || kind === "think" || kind === "fetch" || kind === "read";
}
