import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyImpactMap, workLifecycle, type BoardItem, type BoardPlan } from "../src/index";

function plan(overrides: Partial<BoardPlan> = {}): BoardPlan {
  return {
    id: "plan-1",
    workspaceId: "ws",
    ref: "plan-1",
    title: "Billing",
    objective: "Align invoice totals",
    outline: ["Inspect", "Fix invoice"],
    impactMap: emptyImpactMap(),
    constraints: [],
    decisions: [],
    acceptanceCriteria: [],
    clarifications: ["Asked whether ledger may change"],
    status: "proposed",
    createdBy: "a1",
    acceptedBy: null,
    createdAt: 1,
    acceptedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function ticket(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    workspaceId: "ws",
    ref: "task-1",
    title: "Fix invoice render",
    description: null,
    status: "proposed",
    origin: "agent",
    createdBy: "a1",
    approvedBy: null,
    owner: "noodle",
    planId: "plan-1",
    acceptanceCriteria: ["Invoice and PDF agree"],
    verificationEvidence: null,
    impactMap: emptyImpactMap(),
    proposalWhy: "Totals disagree",
    proposalEffect: "Surfaces agree",
    projectId: null,
    scopePaths: ["invoice/"],
    capabilities: null,
    createdAt: 1,
    approvedAt: null,
    startedAt: null,
    completedAt: null,
    deletedAt: null,
    ownerName: "noodle",
    ...overrides,
  };
}

describe("work lifecycle", () => {
  test("proposed plans wait for a human", () => {
    const life = workLifecycle({ plan: plan() });
    assert.equal(life.state, "waiting_for_you");
    assert.match(life.nextAction, /constraint|Accept/i);
  });

  test("done tickets are verified", () => {
    const life = workLifecycle({ plan: plan({ status: "accepted" }), ticket: ticket({ status: "done" }) });
    assert.equal(life.state, "verified");
    assert.match(life.nextAction, /Review/);
  });
});
