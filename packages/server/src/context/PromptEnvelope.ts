import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Actor, PermissionMode, PolicyRef, PromptEnvelope } from "@workspace/shared";
import { renderPromptEnvelope } from "@workspace/shared";
import type { WorkspaceSnapshotBuilder } from "./WorkspaceSnapshot";

const POLICY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/policy",
);

const POLICY_FILES = ["agent-workflow.json", "context-selection.json"] as const;

interface PolicyFile {
  id: string;
  version: string;
  instructions?: string[];
  alwaysInclude?: string[];
  omit?: string[];
}

/**
 * Compiles the typed prompt envelope the runner must consume. Policy files
 * are loaded at boot and hashed so every run can record what it received.
 */
export class PromptEnvelopeBuilder {
  private readonly policy: PolicyRef[];

  constructor(
    private snapshot: WorkspaceSnapshotBuilder,
    private workspace: { id: string; name: string },
  ) {
    this.policy = POLICY_FILES.map((file) => loadPolicy(path.join(POLICY_DIR, file)));
  }

  refs(): PolicyRef[] {
    return this.policy;
  }

  async build(actor: Actor, permissionMode: PermissionMode = "default"): Promise<PromptEnvelope> {
    const snapshot = await this.snapshot.build();
    return {
      generatedAt: Date.now(),
      seq: snapshot.seq,
      policy: this.policy,
      workspace: this.workspace,
      actor,
      plans: snapshot.plans.filter((plan) => plan.status === "accepted" || plan.status === "proposed"),
      tickets: snapshot.items.filter((item) =>
        item.status === "proposed" ||
        item.status === "approved" ||
        item.status === "in_progress" ||
        item.status === "blocked",
      ),
      context: snapshot.context,
      members: snapshot.members,
      permissionMode,
    };
  }

  async render(actor: Actor, permissionMode: PermissionMode = "default"): Promise<string> {
    return renderPromptEnvelope(await this.build(actor, permissionMode));
  }
}

function loadPolicy(file: string): PolicyRef {
  const raw = fs.readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as PolicyFile;
  if (!parsed.id || !parsed.version) throw new Error(`${path.basename(file)} is missing id/version`);
  const text = parsed.instructions?.join("\n")
    ?? [
      ...(parsed.alwaysInclude ?? []).map((line) => `Always include: ${line}`),
      ...(parsed.omit ?? []).map((line) => `Do not inject: ${line}`),
    ].join("\n");
  return {
    id: parsed.id,
    version: parsed.version,
    hash: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    text,
  };
}
