// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chat.example.com/channels/general" }
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBaseUrl, wsUrl } from "./serverUrl";

afterEach(() => vi.unstubAllEnvs());

describe("wsUrl / apiBaseUrl", () => {
  it("VITE_WS_URL overrides everything, api swaps the scheme", () => {
    vi.stubEnv("VITE_WS_URL", "wss://elsewhere.example:9999");
    expect(wsUrl()).toBe("wss://elsewhere.example:9999");
    expect(wsUrl("ws-1")).toBe("wss://elsewhere.example:9999/ws/ws-1");
    expect(apiBaseUrl()).toBe("https://elsewhere.example:9999");
  });

  it("dev default is the localhost API port", () => {
    vi.stubEnv("VITE_WS_URL", "");
    vi.stubEnv("DEV", true);
    expect(wsUrl()).toBe("ws://localhost:3001");
    expect(apiBaseUrl()).toBe("http://localhost:3001");
  });

  it("production derives from the page's own https origin", () => {
    vi.stubEnv("VITE_WS_URL", "");
    vi.stubEnv("DEV", false);
    expect(wsUrl()).toBe("wss://chat.example.com");
    expect(apiBaseUrl()).toBe("https://chat.example.com");
  });
});
