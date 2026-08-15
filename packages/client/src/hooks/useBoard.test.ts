import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { BoardItem } from "@workspace/shared";
import { useApiSession } from "./useApiSession";
import { useBoard } from "./useBoard";

// Only the network boundary is mocked; the hook itself runs for real.
const fetchMock = vi.fn<typeof fetch>();

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const makeItem = (overrides: Partial<BoardItem> = {}): BoardItem => ({
  id: "item-1",
  workspaceId: "srv-1",
  ref: "task-1",
  title: "Fix ICP rounding",
  description: null,
  status: "proposed",
  origin: "agent",
  createdBy: "agent-1",
  approvedBy: null,
  owner: null,
  planId: null,
  acceptanceCriteria: [],
  verificationEvidence: null,
  impactMap: null,
  proposalWhy: "Invoices round the wrong way",
  proposalEffect: "Totals match the ledger",
  projectId: null,
  scopePaths: ["billing/"],
  capabilities: null,
  createdAt: Date.now() - 60_000,
  approvedAt: null,
  startedAt: null,
  completedAt: null,
  deletedAt: null,
  createdByName: "agent-1",
  ...overrides,
});

/** Render the hook and load a snapshot containing `item` via startSession. */
async function renderBoard(item: BoardItem) {
  const onError = vi.fn();
  // Composed exactly as WorkspaceProvider composes them.
  const rendered = renderHook(() => {
    const api = useApiSession();
    return { ...useBoard(onError, api), bindSession: api.start };
  });
  fetchMock.mockResolvedValueOnce(jsonResponse(200, {
    seq: 1,
    generatedAt: Date.now(),
    items: [item],
    plans: [],
    context: [],
    members: [],
    projects: [],
  }));
  act(() => {
    rendered.result.current.bindSession("http://api.test", "tok-1");
    rendered.result.current.startSession();
  });
  await waitFor(() => expect(rendered.result.current.items).toHaveLength(1));
  return { ...rendered, onError };
}

describe("useBoard optimistic mutations", () => {
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("rolls approve back to the previous status and reports the error when the server refuses", async () => {
    const { result, onError } = await renderBoard(makeItem());

    let refuse!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (refuse = resolve)),
    );
    act(() => result.current.approve("item-1"));
    // Optimistic while the request is in flight.
    expect(result.current.items[0].status).toBe("approved");

    refuse(jsonResponse(403, { message: "no workable item" }));
    await waitFor(() =>
      expect(result.current.items[0].status).toBe("proposed"),
    );
    expect(onError).toHaveBeenCalledWith(
      "Could not approve task-1: no workable item",
    );
  });

  it("keeps the optimistic status when approve succeeds", async () => {
    const { result, onError } = await renderBoard(makeItem());

    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await act(async () => result.current.approve("item-1"));

    await waitFor(() =>
      expect(result.current.items[0].status).toBe("approved"),
    );
    expect(onError).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://api.test/api/board/items/item-1/approve",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer tok-1" }),
      }),
    );
  });

  it("rolls an edit back when the PATCH fails on the network", async () => {
    const { result, onError } = await renderBoard(makeItem());

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    act(() => result.current.editItem("item-1", { title: "New title" }));
    // Optimistic while the request is in flight.
    expect(result.current.items[0].title).toBe("New title");

    await waitFor(() =>
      expect(result.current.items[0].title).toBe("Fix ICP rounding"),
    );
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("Could not edit task-1"),
    );
  });

  it("createItem resolves true and lands the created item on success", async () => {
    const { result, onError } = await renderBoard(makeItem());

    const created = makeItem({ id: "item-2", ref: "task-2", title: "New" });
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { item: created }));
    let ok = false;
    await act(async () => {
      ok = await result.current.createItem({
        title: "New",
        why: "needed",
        effect: "done",
        planId: "plan-1",
        scopePaths: ["src/"],
        acceptanceCriteria: ["works"],
      });
    });

    expect(ok).toBe(true);
    expect(result.current.items.some((i) => i.id === "item-2")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("createItem resolves false and reports the error when the POST fails", async () => {
    const { result, onError } = await renderBoard(makeItem());

    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { message: "title required" }),
    );
    let ok = true;
    await act(async () => {
      ok = await result.current.createItem({
        title: "",
        why: "needed",
        effect: "done",
        planId: "plan-1",
        scopePaths: ["src/"],
        acceptanceCriteria: ["works"],
      });
    });

    expect(ok).toBe(false);
    expect(result.current.items).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(
      "Could not create the item: title required",
    );
  });

  it("does not add a chat system line for a proposal — the card is the event", async () => {
    const { result } = await renderBoard(makeItem({ id: "existing" }));
    const next = makeItem({ id: "item-2", ref: "task-2", title: "New work" });

    act(() =>
      result.current.applyEnvelope({
        channel: "board",
        type: "item.proposed",
        workspace_id: "srv-1",
        actor: { id: "agent-1", kind: "agent", display_name: "noodle" },
        item: next,
        payload: {},
        ts: new Date().toISOString(),
      }),
    );

    expect(result.current.items.some((i) => i.id === "item-2")).toBe(true);
    expect(result.current.lines).toHaveLength(0);
  });

  it("applies the server's item when the PATCH succeeds", async () => {
    const { result, onError } = await renderBoard(makeItem());

    const updated = makeItem({ title: "New title" });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { item: updated }));
    await act(async () =>
      result.current.editItem("item-1", { title: "New title" }),
    );

    await waitFor(() =>
      expect(result.current.items[0].title).toBe("New title"),
    );
    expect(onError).not.toHaveBeenCalled();
  });
});
