import fs from "node:fs/promises";
import path from "node:path";
import type { PermissionMode } from "@workspace/shared";
import { atomicWriteStateFile, secureExistingStateFile, secureStateDirectory } from "./stateFile";

export interface ConversationSession {
  providerSessionId: string | null;
  permissionMode: PermissionMode;
}

/** Persists the provider resume metadata for each Convyio conversation. */
export class ConversationSessions {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private file: string,
    private sessions: Map<string, ConversationSession>,
  ) {}

  static async load(dataDir: string): Promise<ConversationSessions> {
    await secureStateDirectory(dataDir);
    const file = path.join(dataDir, "conversation-sessions.json");
    await secureExistingStateFile(file);
    return new ConversationSessions(file, await readSessions(file));
  }

  get(conversationId: string): ConversationSession | undefined {
    const session = this.sessions.get(conversationId);
    return session ? { ...session } : undefined;
  }

  async set(conversationId: string, session: ConversationSession): Promise<void> {
    requireConversationId(conversationId);
    requireSession(session);
    this.sessions.set(conversationId, { ...session });
    const snapshot = Object.fromEntries(this.sessions);
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => atomicWriteStateFile(this.file, JSON.stringify(snapshot, null, 2)));
    this.writeQueue = write;
    return write;
  }
}

async function readSessions(file: string): Promise<Map<string, ConversationSession>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf-8")) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw err;
  }
  if (!isRecord(parsed)) throw new Error("conversation session file must contain an object");

  const sessions = new Map<string, ConversationSession>();
  for (const [conversationId, value] of Object.entries(parsed)) {
    requireConversationId(conversationId);
    if (!isRecord(value)) throw new Error("conversation session entry must contain an object");
    const session = {
      providerSessionId: value.providerSessionId,
      permissionMode: value.permissionMode,
    };
    requireSession(session);
    sessions.set(conversationId, session);
  }
  return sessions;
}

function requireConversationId(conversationId: string): void {
  if (conversationId.length === 0 || conversationId.length > 128) {
    throw new Error("conversation id must be 1-128 characters");
  }
}

function requireSession(value: {
  providerSessionId: unknown;
  permissionMode: unknown;
}): asserts value is ConversationSession {
  if (
    value.providerSessionId !== null &&
    (typeof value.providerSessionId !== "string" || value.providerSessionId.length > 4096)
  ) {
    throw new Error("provider session id must be null or a bounded string");
  }
  if (!isPermissionMode(value.permissionMode)) {
    throw new Error("invalid conversation permission mode");
  }
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "plan" || value === "acceptEdits";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
