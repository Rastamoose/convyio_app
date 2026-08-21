import { useState } from "react";
import type {
  Actor,
  BoardEventEnvelope,
  BoardItem,
  BoardItemEvent,
  BoardPlan,
  ContextEntry,
  EcosystemImpact,
  ItemStatus,
  WorkspaceSnapshot,
} from "@workspace/shared";
import { mergeLiveItems } from "@workspace/shared";
import type { ApiSession } from "./useApiSession";

/** Compact system line derived from a board event, interleaved into chat. */
export interface BoardLine {
  id: string;
  ts: number;
  text: string;
}

export interface BoardItemEdit {
  title?: string;
  description?: string;
  owner?: string | null;
  scopePaths?: string[] | null;
}

export interface TicketDraft {
  title: string;
  description?: string;
  why: string;
  effect: string;
  planId: string;
  owner?: string;
  scopePaths: string[];
  acceptanceCriteria: string[];
  channel?: string;
  impactMap?: EcosystemImpact;
}

export interface PlanDraft {
  title: string;
  objective: string;
  outline: string[];
  clarifications: string[];
  constraints?: string[];
  assumedOwnerId?: string;
  assumedProjectId?: string;
  channel?: string;
  impactMap?: EcosystemImpact;
}

function boardLineText(envelope: BoardEventEnvelope): string | null {
  const actor = envelope.actor.display_name;
  const ref = envelope.item.ref;
  switch (envelope.type) {
    case "item.proposed":
      // The live ProposalCard in chat is this event. A second system line
      // would be a copy of the same decision sitting next to the original.
      return null;
    case "item.approved":
      return `${actor} approved ${ref}`;
    case "item.denied":
      return `${actor} denied ${ref}`;
    case "item.completed":
      return `${actor} completed ${ref}`;
    case "item.deleted":
      return `${actor} deleted ${ref}`;
    default:
      return null;
  }
}

/**
 * Board state and its API calls. Mutations update the local board
 * optimistically and roll back on failure; every failure is reported through
 * `onError` (and logged) so the user sees it.
 */
export function useBoard(onError: (message: string) => void, api: ApiSession) {
  const [items, setItems] = useState<BoardItem[]>([]);
  const [plans, setPlans] = useState<BoardPlan[]>([]);
  const [context, setContext] = useState<ContextEntry[]>([]);
  const [lines, setLines] = useState<BoardLine[]>([]);

  const fail = (what: string, detail: string) => {
    console.warn("[board]", what, detail);
    onError(`${what}: ${detail}`);
  };

  const upsertItem = (item: BoardItem) => {
    setItems((prev) => {
      if (item.deletedAt != null) return prev.filter((i) => i.id !== item.id);
      return prev.some((i) => i.id === item.id)
        ? prev.map((i) => (i.id === item.id ? item : i))
        : [item, ...prev];
    });
  };

  /** Optimistically set a status, POST a transition, and roll back on failure. */
  const transition = (
    itemId: string,
    action: string,
    status: ItemStatus,
    body?: unknown,
  ) => {
    const previous = items.find((i) => i.id === itemId);
    if (!previous) return;
    setItems((prev) =>
      prev.map((i) => (i.id === itemId ? { ...i, status } : i)),
    );
    const rollback = () =>
      setItems((prev) => prev.map((i) => (i.id === itemId ? previous : i)));
    const request = api.fetch(`/api/board/items/${itemId}/${action}`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!request) return;
    void request
      .then(async (res) => {
        if (res.ok) return;
        fail(`Could not ${action} ${previous.ref}`, await api.errorMessage(res));
        rollback();
      })
      .catch((err) => {
        fail(`Could not ${action} ${previous.ref}`, String(err));
        rollback();
      });
  };

  const upsertPlan = (plan: BoardPlan) => {
    setPlans((prev) =>
      prev.some((p) => p.id === plan.id)
        ? prev.map((p) => (p.id === plan.id ? plan : p))
        : [plan, ...prev],
    );
  };

  return {
    items,
    plans,
    context,
    lines,
    /** Welcome frame arrived (API session already bound): load the snapshot. */
    startSession: () => {
      setLines([]);
      const request = api.fetch("/api/workspace/snapshot");
      if (!request) return;
      void request
        .then(async (res) => {
          if (!res.ok) throw new Error(await api.errorMessage(res));
          return res.json() as Promise<WorkspaceSnapshot>;
        })
        .then((snapshot) => {
          setItems((live) => mergeLiveItems(snapshot.items, live));
          setPlans((live) => {
            const map = new Map(live.map((plan) => [plan.id, plan]));
            for (const plan of snapshot.plans) map.set(plan.id, plan);
            return [...map.values()];
          });
          setContext(snapshot.context);
        })
        .catch((err) => fail("Could not load the board", String(err)));
    },
    /** A board event envelope arrived on the websocket. */
    applyPlan: (plan: BoardPlan) => upsertPlan(plan),
    clearChannel: (channel: string) => {
      const planIds = new Set(plans.filter((plan) => plan.originChannelName === channel).map((plan) => plan.id));
      setItems((prev) => prev.filter((item) => item.originChannelName !== channel && !planIds.has(item.planId ?? "")));
      setPlans((prev) => prev.filter((plan) => plan.originChannelName !== channel));
      setLines([]);
    },
    applyEnvelope: (envelope: BoardEventEnvelope) => {
      upsertItem(envelope.item);
      const text = boardLineText(envelope);
      if (text) {
        setLines((prev) => [
          ...prev,
          { id: crypto.randomUUID(), ts: Date.parse(envelope.ts), text },
        ]);
      }
    },
    /** Resolves true when the item landed — callers gate their form reset on it. */
    createItem: (draft: TicketDraft): Promise<boolean> => {
      const request = api.fetch("/api/board/items", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      if (!request) return Promise.resolve(false);
      return request
        .then(async (res) => {
          if (!res.ok) {
            fail("Could not create the item", await api.errorMessage(res));
            return false;
          }
          const data = (await res.json().catch(() => null)) as {
            item?: BoardItem;
          } | null;
          if (data?.item) upsertItem(data.item);
          return true;
        })
        .catch((err) => {
          fail("Could not create the item", String(err));
          return false;
        });
    },
    createPlan: (draft: PlanDraft): Promise<boolean> => {
      const request = api.fetch("/api/board/plans", {
        method: "POST",
        body: JSON.stringify(draft),
      });
      if (!request) return Promise.resolve(false);
      return request
        .then(async (res) => {
          if (!res.ok) {
            fail("Could not create the plan", await api.errorMessage(res));
            return false;
          }
          const data = (await res.json().catch(() => null)) as { plan?: BoardPlan } | null;
          if (data?.plan) upsertPlan(data.plan);
          return true;
        })
        .catch((err) => {
          fail("Could not create the plan", String(err));
          return false;
        });
    },
    addPlanConstraint: (planId: string, constraint: string): Promise<boolean> => {
      const request = api.fetch(`/api/board/plans/${planId}/constraints`, {
        method: "POST",
        body: JSON.stringify({ constraint }),
      });
      if (!request) return Promise.resolve(false);
      return request
        .then(async (res) => {
          if (!res.ok) {
            fail("Could not add the constraint", await api.errorMessage(res));
            return false;
          }
          const data = (await res.json().catch(() => null)) as { plan?: BoardPlan } | null;
          if (data?.plan) upsertPlan(data.plan);
          return true;
        })
        .catch((err) => {
          fail("Could not add the constraint", String(err));
          return false;
        });
    },
    acceptPlan: (planId: string): Promise<boolean> => {
      const request = api.fetch(`/api/board/plans/${planId}/accept`, { method: "POST" });
      if (!request) return Promise.resolve(false);
      return request
        .then(async (res) => {
          if (!res.ok) {
            fail("Could not accept the plan", await api.errorMessage(res));
            return false;
          }
          const data = (await res.json().catch(() => null)) as { plan?: BoardPlan } | null;
          if (data?.plan) upsertPlan(data.plan);
          return true;
        })
        .catch((err) => {
          fail("Could not accept the plan", String(err));
          return false;
        });
    },
    approve: (itemId: string, owner?: string) =>
      transition(itemId, "approve", "approved", owner ? { owner } : {}),
    deny: (itemId: string) => transition(itemId, "deny", "denied", {}),
    start: (itemId: string) => transition(itemId, "start", "in_progress"),
    complete: (itemId: string, evidence: string) =>
      transition(itemId, "complete", "done", { evidence }),
    reopen: (itemId: string) => transition(itemId, "reopen", "approved"),
    deleteItem: (itemId: string) => {
      const previous = items.find((i) => i.id === itemId);
      if (!previous) return;
      setItems((prev) => prev.filter((i) => i.id !== itemId));
      const restore = () =>
        setItems((prev) =>
          prev.some((i) => i.id === itemId) ? prev : [previous, ...prev],
        );
      const request = api.fetch(`/api/board/items/${itemId}`, {
        method: "DELETE",
      });
      if (!request) return;
      void request
        .then(async (res) => {
          if (res.ok) return;
          fail(`Could not delete ${previous.ref}`, await api.errorMessage(res));
          restore();
        })
        .catch((err) => {
          fail(`Could not delete ${previous.ref}`, String(err));
          restore();
        });
    },
    editItem: (itemId: string, fields: BoardItemEdit) => {
      const previous = items.find((i) => i.id === itemId);
      if (!previous) return;
      setItems((prev) =>
        prev.map((i) =>
          i.id === itemId
            ? {
                ...i,
                ...(fields.title !== undefined ? { title: fields.title } : {}),
                ...(fields.description !== undefined
                  ? { description: fields.description }
                  : {}),
                ...(fields.scopePaths !== undefined
                  ? { scopePaths: fields.scopePaths }
                  : {}),
                ...(fields.owner !== undefined
                  ? {
                      owner: fields.owner,
                      ownerName: fields.owner == null ? undefined : i.ownerName,
                    }
                  : {}),
              }
            : i,
        ),
      );
      const rollback = () =>
        setItems((prev) => prev.map((i) => (i.id === itemId ? previous : i)));
      const request = api.fetch(`/api/board/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
      if (!request) return;
      void request
        .then(async (res) => {
          if (!res.ok) {
            fail(`Could not edit ${previous.ref}`, await api.errorMessage(res));
            rollback();
            return;
          }
          const data = (await res.json().catch(() => null)) as {
            item?: BoardItem;
          } | null;
          if (data?.item) upsertItem(data.item);
        })
        .catch((err) => {
          fail(`Could not edit ${previous.ref}`, String(err));
          rollback();
        });
    },
    fetchActors: async (): Promise<Actor[]> => {
      const request = api.fetch("/api/actors");
      if (!request) return [];
      try {
        const res = await request;
        if (!res.ok) {
          fail("Could not load actors", await api.errorMessage(res));
          return [];
        }
        const data = (await res.json()) as { actors?: Actor[] };
        return data.actors ?? [];
      } catch (err) {
        fail("Could not load actors", String(err));
        return [];
      }
    },
    fetchItemEvents: async (itemId: string): Promise<BoardItemEvent[]> => {
      const request = api.fetch(`/api/board/items/${itemId}/events`);
      if (!request) return [];
      try {
        const res = await request;
        if (!res.ok) {
          fail("Could not load item activity", await api.errorMessage(res));
          return [];
        }
        const data = (await res.json()) as { events?: BoardItemEvent[] };
        return data.events ?? [];
      } catch (err) {
        fail("Could not load item activity", String(err));
        return [];
      }
    },
  };
}
