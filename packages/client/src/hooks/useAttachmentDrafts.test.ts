import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Attachment } from "@workspace/shared";
import { useApiSession } from "./useApiSession";
import { useAttachmentDrafts } from "./useAttachmentDrafts";

// Only the environment seams are stubbed: the network, object URLs, and
// image decoding (jsdom implements none of them). The hook runs for real.
const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(
  (_blob: Blob | MediaSource) => `blob:preview-${createObjectURL.mock.calls.length}`,
);
const revokeObjectURL = vi.fn();

class FakeImage {
  naturalWidth = 640;
  naturalHeight = 480;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

const makeAttachment = (id: string, name: string): Attachment => ({
  id,
  name,
  mime: "image/png",
  size: 5,
  width: 640,
  height: 480,
  url: `/api/uploads/${id}/${name}`,
});

const makeFile = (name: string, type: string): File =>
  new File(["hello"], name, { type });

/** Render the hook with a bound API session, as WorkspaceProvider wires it. */
function renderDrafts() {
  const onError = vi.fn();
  const rendered = renderHook(() => {
    const api = useApiSession();
    return { ...useAttachmentDrafts(onError, api), bindSession: api.start };
  });
  act(() => rendered.result.current.bindSession("http://api.test", "tok-1"));
  return { ...rendered, onError };
}

describe("useAttachmentDrafts", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Image", FakeImage);
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  it("uploads an image per the wire contract and hands out its id on take", async () => {
    const { result } = renderDrafts();
    const attachment = makeAttachment("up-1", "cat.png");
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { attachment }));

    act(() => result.current.add("general", [makeFile("cat.png", "image/png")]));
    expect(result.current.draftsFor("general")[0].status).toBe("uploading");
    expect(result.current.draftsFor("general")[0].previewUrl).toMatch(/^blob:/);

    await waitFor(() =>
      expect(result.current.draftsFor("general")[0].status).toBe("ready"),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://api.test/api/uploads",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer tok-1",
          "Content-Type": "image/png",
          "X-File-Name": "cat.png",
          "X-Image-Width": "640",
          "X-Image-Height": "480",
        }),
      }),
    );

    const previewUrl = result.current.draftsFor("general")[0].previewUrl;
    let ids: string[] = [];
    act(() => {
      ids = result.current.takeReadyIds("general");
    });
    expect(ids).toEqual(["up-1"]);
    expect(result.current.draftsFor("general")).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith(previewUrl);
  });

  it("gives non-images no preview and no dimension headers", async () => {
    const { result } = renderDrafts();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { attachment: makeAttachment("up-2", "notes.txt") }),
    );

    act(() =>
      result.current.add("general", [makeFile("notes.txt", "text/plain")]),
    );
    expect(result.current.draftsFor("general")[0].previewUrl).toBeNull();

    await waitFor(() =>
      expect(result.current.draftsFor("general")[0].status).toBe("ready"),
    );
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("text/plain");
    expect(headers["X-Image-Width"]).toBeUndefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("skips oversize files with a toast and keeps the rest", async () => {
    const { result, onError } = renderDrafts();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(201, { attachment: makeAttachment("up-3", "ok.txt") }),
    );
    const big = makeFile("big.bin", "application/octet-stream");
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });

    act(() =>
      result.current.add("general", [big, makeFile("ok.txt", "text/plain")]),
    );

    expect(onError).toHaveBeenCalledWith(
      "big.bin is larger than 10 MiB and was skipped",
    );
    expect(result.current.draftsFor("general")).toHaveLength(1);
    expect(result.current.draftsFor("general")[0].name).toBe("ok.txt");
    await waitFor(() =>
      expect(result.current.draftsFor("general")[0].status).toBe("ready"),
    );
  });

  it("caps a channel at 10 attachments and reports the overflow", async () => {
    const { result, onError } = renderDrafts();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse(201, { attachment: makeAttachment("up-n", "f.txt") }),
      ),
    );
    const files = Array.from({ length: 11 }, (_, i) =>
      makeFile(`f${i}.txt`, "text/plain"),
    );

    act(() => result.current.add("general", files));

    expect(result.current.draftsFor("general")).toHaveLength(10);
    expect(onError).toHaveBeenCalledWith(
      "A message can carry at most 10 attachments",
    );
  });

  it("marks a refused upload failed and excludes it from take", async () => {
    const { result } = renderDrafts();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(413, { message: "attachment exceeds 10 MiB" }),
    );

    act(() =>
      result.current.add("general", [makeFile("huge.txt", "text/plain")]),
    );
    await waitFor(() =>
      expect(result.current.draftsFor("general")[0].status).toBe("failed"),
    );
    expect(result.current.draftsFor("general")[0].error).toBe(
      "attachment exceeds 10 MiB",
    );

    let ids: string[] = ["sentinel"];
    act(() => {
      ids = result.current.takeReadyIds("general");
    });
    expect(ids).toEqual([]);
    expect(result.current.draftsFor("general")).toHaveLength(0);
  });

  it("remove drops an in-flight entry and revokes its preview URL", async () => {
    const { result } = renderDrafts();
    // The upload never settles; removal must not wait for it.
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));

    act(() => result.current.add("general", [makeFile("cat.png", "image/png")]));
    await waitFor(() =>
      expect(result.current.draftsFor("general")).toHaveLength(1),
    );
    const entry = result.current.draftsFor("general")[0];

    act(() => result.current.remove("general", entry.localId));
    expect(result.current.draftsFor("general")).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledWith(entry.previewUrl);
  });
});
