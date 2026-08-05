import { useRef, useState } from "react";
import type {
  Actor,
  BoardEventEnvelope,
  BoardItem,
  BoardItemEvent,
  ItemStatus,
} from "@workspace/shared";

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

function boardLineText(envelope: BoardEventEnvelope): string | null {
  const actor = envelope.actor.display_name;
  const ref = envelope.item.ref;
  switch (envelope.type) {
    case "item.proposed":
      return `${actor} proposed ${ref} — "${envelope.item.title}"`;
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
 * Board state plus its HTTP API client. Mutations update the local board
 * optimistically and roll back on failure; every failure is reported through
 * `onError` (and logged) so the user sees it.
 */
export function useBoard(onError: (message: string) => void) {
  const tokenRef = useRef<string | null>(null);
  const apiUrlRef = useRef<string | null>(null);
  const [items, setItems] = useState<BoardItem[]>([]);
  const [lines, setLines] = useState<BoardLine[]>([]);

  const fail = (what: string, detail: string) => {
    console.warn("[board]", what, detail);
    onError(`${what}: ${detail}`);
  };

  const responseError = async (res: Response): Promise<string> => {
    const data = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    return data?.message ?? `request failed: ${res.status}`;
  };

  const apiFetch = (
    path: string,
    init?: RequestInit,
  ): Promise<Response> | null => {
    const token = tokenRef.current;
    const apiUrl = apiUrlRef.current;
    if (!token || !apiUrl) return null;
    return fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
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
    const request = apiFetch(`/api/board/items/${itemId}/${action}`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!request) return;
    void request
      .then(async (res) => {
        if (res.ok) return;
        fail(`Could not ${action} ${previous.ref}`, await responseError(res));
        rollback();
      })
      .catch((err) => {
        fail(`Could not ${action} ${previous.ref}`, String(err));
        rollback();
      });
  };

  return {
    items,
    lines,
    /** Welcome frame arrived: bind the API session and load the snapshot. */
    startSession: (apiUrl: string, token: string) => {
      apiUrlRef.current = apiUrl;
      tokenRef.current = token;
      setLines([]);
      const request = apiFetch("/api/board/items?include_deleted=true");
      if (!request) return;
      void request
        .then(async (res) => {
          if (!res.ok) throw new Error(await responseError(res));
          return res.json() as Promise<{ items: BoardItem[] }>;
        })
        .then(({ items: loaded }) =>
          setItems(loaded.filter((i) => i.deletedAt == null)),
        )
        .catch((err) => fail("Could not load the board", String(err)));
    },
    /** A board event envelope arrived on the websocket. */
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
    createItem: (title: string, description?: string) => {
      const request = apiFetch("/api/board/items", {
        method: "POST",
        body: JSON.stringify({ title, description }),
      });
      if (!request) return;
      void request
        .then(async (res) => {
          if (!res.ok) {
            fail("Could not create the item", await responseError(res));
            return;
          }
          const data = (await res.json().catch(() => null)) as {
            item?: BoardItem;
          } | null;
          if (data?.item) upsertItem(data.item);
        })
        .catch((err) => fail("Could not create the item", String(err)));
    },
    approve: (itemId: string) => transition(itemId, "approve", "approved"),
    deny: (itemId: string) => transition(itemId, "deny", "denied", {}),
    start: (itemId: string) => transition(itemId, "start", "in_progress"),
    complete: (itemId: string) => transition(itemId, "complete", "done"),
    reopen: (itemId: string) => transition(itemId, "reopen", "approved"),
    deleteItem: (itemId: string) => {
      const previous = items.find((i) => i.id === itemId);
      if (!previous) return;
      setItems((prev) => prev.filter((i) => i.id !== itemId));
      const restore = () =>
        setItems((prev) =>
          prev.some((i) => i.id === itemId) ? prev : [previous, ...prev],
        );
      const request = apiFetch(`/api/board/items/${itemId}`, {
        method: "DELETE",
      });
      if (!request) return;
      void request
        .then(async (res) => {
          if (res.ok) return;
          fail(`Could not delete ${previous.ref}`, await responseError(res));
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
      const request = apiFetch(`/api/board/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
      if (!request) return;
      void request
        .then(async (res) => {
          if (!res.ok) {
            fail(`Could not edit ${previous.ref}`, await responseError(res));
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
      const request = apiFetch("/api/actors");
      if (!request) return [];
      try {
        const res = await request;
        if (!res.ok) {
          fail("Could not load actors", await responseError(res));
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
      const request = apiFetch(`/api/board/items/${itemId}/events`);
      if (!request) return [];
      try {
        const res = await request;
        if (!res.ok) {
          fail("Could not load item activity", await responseError(res));
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
