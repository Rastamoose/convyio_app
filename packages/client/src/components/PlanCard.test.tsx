import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { emptyImpactMap, type BoardPlan } from "@workspace/shared";
import { PlanCard } from "./PlanCard";

const acceptPlan = vi.fn();
const addPlanConstraint = vi.fn().mockResolvedValue(true);
const createBoardItem = vi.fn().mockResolvedValue(true);
const fetchActors = vi.fn().mockResolvedValue([]);

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    acceptPlan,
    addPlanConstraint,
    createBoardItem,
    fetchActors,
    context: [],
  }),
}));

const plan: BoardPlan = {
  id: "plan-1",
  workspaceId: "srv-1",
  ref: "plan-1",
  title: "Align invoice totals",
  objective: "Invoice, PDF and ledger stay consistent where allowed",
  outline: ["Inspect the three surfaces", "Change invoice and PDF only"],
  impactMap: emptyImpactMap(),
  constraints: ["Ledger output must remain identical to existing Stripe charges"],
  decisions: [],
  acceptanceCriteria: ["Invoice and PDF agree"],
  clarifications: ["Asked whether the ledger may be renormalized"],
  status: "proposed",
  createdBy: "agent-1",
  acceptedBy: null,
  createdAt: Date.now() - 60_000,
  acceptedAt: null,
  completedAt: null,
  originChannelName: "general",
  changeLog: [{
    at: Date.now(),
    actorId: "human-1",
    actorName: "Tom",
    field: "constraints",
    summary: "Changed before execution: Ledger output must remain identical to existing Stripe charges",
  }],
  createdByName: "noodle",
};

describe("PlanCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the canonical plan fields and constraint change", () => {
    render(<PlanCard plan={plan} tickets={[]} onDiscuss={vi.fn()} onOpenBoard={vi.fn()} />);
    expect(screen.getByText("plan-1")).toBeInTheDocument();
    expect(screen.getByText("Align invoice totals")).toBeInTheDocument();
    expect(screen.getByText("Changed before execution")).toBeInTheDocument();
    expect(screen.getAllByText(/Ledger output must remain identical/).length).toBeGreaterThan(0);
  });

  it("accepts the plan without leaving conversation", async () => {
    const user = userEvent.setup();
    render(<PlanCard plan={plan} tickets={[]} onDiscuss={vi.fn()} onOpenBoard={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(acceptPlan).toHaveBeenCalledWith("plan-1");
  });
});
