import { useEffect, useState } from "react";
import { emptyImpactMap, type BoardItem, type ItemStatus } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { ITEM_STATUS_LABEL } from "../lib/status";
import { BoardCard } from "./BoardCard";
import { ItemDrawer } from "./ItemDrawer";

const COLUMN_STATUSES: ItemStatus[] = [
  "proposed",
  "approved",
  "in_progress",
  "blocked",
  "done",
];

export function BoardView({
  highlightRef,
  openItemId,
  onOpenItem,
  onDiscuss,
  onOpenConversation,
  onJumpToTrace,
}: {
  highlightRef: string | null;
  openItemId: string | null;
  onOpenItem: (itemId: string | null) => void;
  onDiscuss: (item: { ref: string; title: string }) => void;
  onOpenConversation: (target: { channel?: string | null; itemId?: string | null; planId?: string | null }) => void;
  onJumpToTrace: (runId: string) => void;
}) {
  const { board, plans, createBoardItem, createPlan, acceptPlan, fetchActors } = useWorkspace();
  const [title, setTitle] = useState("");
  const [why, setWhy] = useState("");
  const [effect, setEffect] = useState("");
  const [scope, setScope] = useState("");
  const [criteria, setCriteria] = useState("");
  const [planId, setPlanId] = useState("");
  const [owner, setOwner] = useState("");
  const [actors, setActors] = useState<{ id: string; displayName: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [showDenied, setShowDenied] = useState(false);
  const [creating, setCreating] = useState<"plan" | "ticket" | null>(null);
  const [planTitle, setPlanTitle] = useState("");
  const [planObjective, setPlanObjective] = useState("");
  const [planOutline, setPlanOutline] = useState("");
  const [planClarification, setPlanClarification] = useState("");

  const accepted = plans.filter((plan) => plan.status === "accepted");
  const proposedPlans = plans.filter((plan) => plan.status === "proposed" || plan.status === "draft");
  const openItem = openItemId ? (board.find((i) => i.id === openItemId) ?? null) : null;
  const canSubmit = !!title.trim() && !!why.trim() && !!effect.trim() && !!scope.trim() && !!criteria.trim() && !!planId && !adding;

  useEffect(() => {
    if (openItemId && !openItem) onOpenItem(null);
  }, [openItemId, openItem, onOpenItem]);

  useEffect(() => {
    if (!highlightRef) return;
    document.getElementById(`board-item-${highlightRef}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightRef]);

  useEffect(() => {
    if (planId || accepted.length === 0) return;
    setPlanId(accepted[0].id);
  }, [accepted, planId]);

  useEffect(() => {
    void fetchActors().then((list) => setActors(list.map((actor) => ({ id: actor.id, displayName: actor.displayName }))));
    // fetchActors is recreated each render; load the roster once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submitTicket = () => {
    if (!canSubmit) return;
    setAdding(true);
    const origin = plans.find((plan) => plan.id === planId);
    void createBoardItem({
      title: title.trim(),
      why: why.trim(),
      effect: effect.trim(),
      planId,
      owner: owner || undefined,
      channel: origin?.originChannelName,
      scopePaths: scope.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean),
      acceptanceCriteria: criteria.split(/[\n,]+/).map((line) => line.trim()).filter(Boolean),
      impactMap: emptyImpactMap(),
    }).then((ok) => {
      if (!ok) return;
      setTitle("");
      setWhy("");
      setEffect("");
      setScope("");
      setCriteria("");
      setCreating(null);
    }).finally(() => setAdding(false));
  };

  const submitPlan = () => {
    const outline = planOutline.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!planTitle.trim() || !planObjective.trim() || outline.length === 0 || !planClarification.trim()) return;
    void createPlan({
      title: planTitle.trim(),
      objective: planObjective.trim(),
      outline,
      clarifications: [planClarification.trim()],
      impactMap: emptyImpactMap(),
    }).then((ok) => {
      if (!ok) return;
      setPlanTitle("");
      setPlanObjective("");
      setPlanOutline("");
      setPlanClarification("");
      setCreating(null);
    });
  };

  const columns: ItemStatus[] = showDenied ? [...COLUMN_STATUSES, "denied"] : COLUMN_STATUSES;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-3 border-b border-divider px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-body">Board</span>
          <span className="text-xs text-muted">{plans.length} plan{plans.length === 1 ? "" : "s"} · {board.length} ticket{board.length === 1 ? "" : "s"}</span>
          <span className="text-xs text-faint">A projection of work already living in conversation.</span>
          <button
            onClick={() => setShowDenied((o) => !o)}
            className={`rounded-md px-2 py-1 text-xs font-semibold ${showDenied ? "bg-input text-body" : "text-muted hover:bg-subtle hover:text-body"}`}
          >
            {showDenied ? "Hide denied" : "Show denied"}
          </button>
          <button
            onClick={() => setCreating((cur) => (cur ? null : "plan"))}
            className="ml-auto rounded-md bg-input px-2 py-1 text-xs font-semibold text-body hover:bg-subtle"
          >
            {creating ? "Cancel" : "New"}
          </button>
        </div>
        {proposedPlans.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {proposedPlans.map((plan) => (
              <div key={plan.id} className="flex items-center gap-2 rounded-md bg-subtle px-2 py-1 text-xs">
                <span className="text-[10px] font-bold text-accent">{plan.ref}</span>
                <span className="text-body">{plan.title}</span>
                <button onClick={() => void acceptPlan(plan.id)} className="font-semibold text-accent hover:underline">Accept</button>
                <button
                  onClick={() => onOpenConversation({ channel: plan.originChannelName, planId: plan.id })}
                  className="font-semibold text-muted hover:underline"
                >
                  Open in conversation
                </button>
              </div>
            ))}
          </div>
        )}
        {creating && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setCreating("plan")}
              className={`rounded-md px-2 py-1 text-xs font-semibold ${creating === "plan" ? "bg-accent text-on-accent" : "bg-input text-body"}`}
            >
              New plan
            </button>
            <button
              onClick={() => setCreating("ticket")}
              className={`rounded-md px-2 py-1 text-xs font-semibold ${creating === "ticket" ? "bg-accent text-on-accent" : "bg-input text-body"}`}
            >
              Next ticket
            </button>
          </div>
        )}
        {creating === "plan" && (
          <div className="space-y-1.5">
            <input value={planTitle} onChange={(e) => setPlanTitle(e.target.value)} aria-label="New plan title" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Plan title" maxLength={200} />
            <input value={planObjective} onChange={(e) => setPlanObjective(e.target.value)} aria-label="New plan objective" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Objective" />
            <textarea value={planOutline} onChange={(e) => setPlanOutline(e.target.value)} aria-label="New plan outline" rows={2} className="w-full resize-none rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Outline, one step per line" />
            <input value={planClarification} onChange={(e) => setPlanClarification(e.target.value)} aria-label="New plan clarification" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="One clarification you asked" />
            <button onClick={submitPlan} className="rounded-md bg-input px-3 py-1.5 text-sm font-semibold text-body hover:bg-subtle">Propose plan</button>
          </div>
        )}
        {creating === "ticket" && (
          <div className="space-y-1.5">
            <select aria-label="Ticket plan" value={planId} onChange={(e) => setPlanId(e.target.value)} className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none focus:ring-2 focus:ring-accent">
              <option value="">Accepted plan…</option>
              {accepted.map((plan) => <option key={plan.id} value={plan.id}>{plan.ref} {plan.title}</option>)}
            </select>
            <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New board item title" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Ticket title" maxLength={200} />
            <input value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Ticket why" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Why" />
            <input value={effect} onChange={(e) => setEffect(e.target.value)} aria-label="Ticket effect" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Expected effect" />
            <input value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Ticket scope" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Scope paths, comma-separated" />
            <input value={criteria} onChange={(e) => setCriteria(e.target.value)} aria-label="Ticket acceptance criteria" className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none placeholder:text-faint focus:ring-2 focus:ring-accent" placeholder="Acceptance criteria" />
            <select aria-label="Ticket owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-full rounded-md bg-input px-2 py-1.5 text-sm text-body outline-none focus:ring-2 focus:ring-accent">
              <option value="">Owner (optional until approve)</option>
              {actors.map((actor) => <option key={actor.id} value={actor.id}>{actor.displayName}</option>)}
            </select>
            <button onClick={submitTicket} disabled={!canSubmit} className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">Add ticket</button>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        {columns.map((status) => {
          const items = board.filter((i) => i.status === status);
          const proposed = status === "proposed";
          return (
            <div key={status} className={`flex max-h-full w-72 shrink-0 flex-col self-start ${proposed ? "border-l-4 border-dead pl-3" : ""}`}>
              <div className="flex shrink-0 items-center gap-2 py-2">
                <span className={`text-[10px] font-bold tracking-wider uppercase ${proposed ? "text-dead" : "text-muted"}`}>{ITEM_STATUS_LABEL[status]}</span>
                <span className="text-[10px] font-bold text-faint">{items.length}</span>
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-3 pb-2">
                {items.length === 0 ? (
                  <div className="px-1 py-2 text-xs text-faint">Nothing here yet</div>
                ) : (
                  items.map((item) => (
                    <BoardCard
                      key={item.id}
                      item={item}
                      highlighted={highlightRef === item.ref}
                      planRef={plans.find((plan) => plan.id === item.planId)?.ref}
                      originChannel={item.originChannelName ?? plans.find((plan) => plan.id === item.planId)?.originChannelName}
                      onOpen={onOpenItem}
                      onDiscuss={onDiscuss}
                      onOpenConversation={() =>
                        onOpenConversation({
                          channel: item.originChannelName ?? plans.find((plan) => plan.id === item.planId)?.originChannelName,
                          itemId: item.id,
                        })
                      }
                      onJumpToTrace={onJumpToTrace}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {openItem && (
        <ItemDrawer
          item={openItem}
          originChannel={openItem.originChannelName ?? plans.find((plan) => plan.id === openItem.planId)?.originChannelName}
          onClose={() => onOpenItem(null)}
          onDiscuss={onDiscuss}
          onOpenConversation={() =>
            onOpenConversation({
              channel: openItem.originChannelName ?? plans.find((plan) => plan.id === openItem.planId)?.originChannelName,
              itemId: openItem.id,
            })
          }
        />
      )}
    </div>
  );
}
