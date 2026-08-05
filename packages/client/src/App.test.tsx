import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

// Only the network boundary is mocked; the boot decision itself runs for real.
const fetchMock = vi.fn<typeof fetch>();

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  }) as Response;

// node's experimental localStorage global (undefined without a flag) shadows
// jsdom's in this test process, so back it with a real in-memory Storage.
const storageStub = (): Storage => {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

describe("App boot decision", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("localStorage", storageStub());
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("guest mode (no Google client id) keeps the guest name modal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { googleClientId: null }));

    render(<App />);

    expect(await screen.findByText("Join the workspace")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/auth/config"));
  });

  it("auth mode shows the Google login screen instead", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { googleClientId: "client-1.apps.googleusercontent.com" }),
    );

    render(<App />);

    expect(await screen.findByText("Sign in")).toBeInTheDocument();
    expect(screen.queryByText("Join the workspace")).not.toBeInTheDocument();
  });
});
