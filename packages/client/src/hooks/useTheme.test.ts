import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { initialTheme, useTheme } from "./useTheme";

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

// jsdom has no matchMedia; each test decides what the OS "prefers".
const stubPrefersDark = (matches: boolean) =>
  vi.stubGlobal(
    "matchMedia",
    (query: string) => ({ matches, media: query }) as MediaQueryList,
  );

describe("useTheme", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storageStub());
    stubPrefersDark(false);
    document.documentElement.className = "";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to the OS preference with nothing stored", () => {
    expect(initialTheme()).toBe("light");
    stubPrefersDark(true);
    expect(initialTheme()).toBe("dark");
  });

  it("prefers a stored choice over the OS preference", () => {
    stubPrefersDark(true);
    window.localStorage.setItem("convyio:theme", "light");

    expect(initialTheme()).toBe("light");
  });

  it("toggling paints <html> and persists the choice", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    act(() => result.current.toggleTheme());

    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem("convyio:theme")).toBe("dark");

    act(() => result.current.toggleTheme());

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem("convyio:theme")).toBe("light");
  });

  it("restores the stored theme on a fresh mount", () => {
    window.localStorage.setItem("convyio:theme", "dark");

    renderHook(() => useTheme());

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
