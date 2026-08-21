import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DemoFocusTarget } from "@workspace/shared";
import { OnboardingShell } from "./OnboardingShell";

const mockWorkspace = {
  startDemo: vi.fn(),
  demoControl: vi.fn(),
  demoProgress: null as {
    channel: string;
    stage: string;
    message: string;
    paused: boolean;
    focus?: DemoFocusTarget;
  } | null,
  demoChannels: ["demo"],
  workspaceId: "ws-1",
};

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => mockWorkspace,
}));

const localStore: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkspace.demoProgress = null;
  mockWorkspace.demoChannels = ["demo"];
  Object.keys(localStore).forEach((k) => delete localStore[k]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => localStore[k] ?? null,
    setItem: (k: string, v: string) => { localStore[k] = v; },
    removeItem: (k: string) => { delete localStore[k]; },
    clear: () => { for (const k of Object.keys(localStore)) delete localStore[k]; },
  });
});

describe("OnboardingShell", () => {
  it("shows the intro modal and can start the demo", async () => {
    const user = userEvent.setup();
    render(<OnboardingShell channel="general" setChannel={vi.fn()} onPrefill={vi.fn()} />);

    expect(screen.getByText(/See Convyio in one shared conversation/i)).toBeInTheDocument();
    expect(screen.queryByText(/Before:/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Play the demo/i }));
    expect(mockWorkspace.startDemo).toHaveBeenCalledWith("demo", "walkthrough");
  });

  it("offers a 'Bring one piece of work' CTA that prefills the composer", async () => {
    const user = userEvent.setup();
    const onPrefill = vi.fn();
    render(<OnboardingShell channel="general" setChannel={vi.fn()} onPrefill={onPrefill} />);

    await user.click(screen.getByRole("button", { name: /Bring one piece of work/i }));
    await user.click(screen.getByText(/Investigate before anyone changes code/i));
    await waitFor(() => expect(onPrefill).toHaveBeenCalled());
    expect(onPrefill.mock.calls[0][0]).toContain("@noodle");
  });

  it("waits for an explicit Continue between demo chapters", async () => {
    const user = userEvent.setup();
    mockWorkspace.demoProgress = {
      channel: "demo",
      stage: "waiting_continue",
      message: "Shared evidence is visible to both founders.",
      paused: false,
      focus: { kind: "guide", label: "Shared evidence" },
    };
    render(<OnboardingShell channel="demo" setChannel={vi.fn()} onPrefill={vi.fn()} />);

    expect(screen.getByText("Shared evidence")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(mockWorkspace.demoControl).toHaveBeenCalledWith("demo", "continue");
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("shows demo progress controls when a demo is running", async () => {
    const user = userEvent.setup();
    mockWorkspace.demoProgress = {
      channel: "demo",
      stage: "executing",
      message: "Running the authorized changes.",
      paused: false,
    };
    const { rerender } = render(<OnboardingShell channel="demo" setChannel={vi.fn()} onPrefill={vi.fn()} />);

    expect(await screen.findByText("Running the authorized changes.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Pause/i }));
    expect(mockWorkspace.demoControl).toHaveBeenCalledWith("demo", "pause");

    mockWorkspace.demoProgress = { channel: "demo", stage: "completed", message: "Demo complete.", paused: false };
    rerender(<OnboardingShell channel="demo" setChannel={vi.fn()} onPrefill={vi.fn()} />);
    expect(await screen.findByText(/Bring one piece of work/i)).toBeInTheDocument();
  });

  it("can skip the demo from the intro", async () => {
    const user = userEvent.setup();
    render(<OnboardingShell channel="general" setChannel={vi.fn()} onPrefill={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Explore on my own/i }));
    expect(window.localStorage.getItem("convyio:onboarding")).toContain("ws-1");
  });
});
