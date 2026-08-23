import { useEffect, useState } from "react";
import { useWorkspace } from "../hooks/WorkspaceContext";

const STORAGE_KEY = "convyio:onboarding";

const WORK_STARTERS = {
  investigate:
    "@noodle Help me investigate this before anyone changes code: [describe the problem]. Surface the assumptions, constraints and missing context, then propose a plan. Do not modify anything.",
  feature:
    "@noodle Turn this feature idea into a plan the team can review: [describe the idea]. Separate assumptions from known constraints and ask one important question before proposing work.",
  review:
    "@noodle Help me understand why this work keeps coming back from review: [describe it]. Identify the constraint we are discovering too late and propose a safer plan.",
};

export function OnboardingShell({
  channel,
  setChannel,
  onPrefill,
}: {
  channel: string;
  setChannel: (channel: string) => void;
  onPrefill: (text: string) => void;
}) {
  const workspace = useWorkspace();
  const [dismissed, setDismissed] = useState(false);
  const [showStarters, setShowStarters] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      if (parsed[workspace.workspaceId]) setDismissed(true);
    } catch {
      // Storage not available.
    }
  }, [workspace.workspaceId]);

  const persistDismissed = (value: boolean) => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      parsed[workspace.workspaceId] = value;
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      // Ignore storage errors.
    }
  };

  const active = workspace.demoProgress;
  const demoRunning = active !== null && active.stage !== "idle";
  const hasDemos = workspace.demoChannels.length > 0;

  if (dismissed && !demoRunning) return null;
  if (!hasDemos && !demoRunning) return null;

  const explore = () => {
    persistDismissed(true);
    setDismissed(true);
  };

  const startRealWork = (text: string) => {
    persistDismissed(true);
    setDismissed(true);
    if (channel !== "general") setChannel("general");
    onPrefill(text);
  };

  // Active demo progress bar.
  if (demoRunning && active) {
    const done = active.stage === "completed";
    const waitingToContinue =
      active.stage === "waiting_continue" ||
      active.stage === "waiting_accept_plan" ||
      active.stage === "waiting_approve_ticket";
    const continueLabel =
      active.focus?.kind === "plan_accept" ? "Accept" : active.focus?.kind === "ticket_approve" ? "Approve" : "Continue";

    if (!waitingToContinue && !done) return null;

    return (
      <div className="fixed bottom-4 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 px-4">
        <div className="elevated rounded-xl px-4 py-3" role="status" aria-live="polite">
          <div className="flex items-center justify-end gap-1.5">
            {waitingToContinue && (
              <button
                onClick={() => workspace.demoControl(active.channel, "continue")}
                className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
              >
                {continueLabel}
              </button>
            )}
            {done && (
              <button
                onClick={() => {
                  persistDismissed(true);
                  setDismissed(true);
                }}
                className="rounded-md bg-subtle px-2 py-1 text-xs font-medium text-body hover:bg-subtle-hover"
              >
                Close
              </button>
            )}
          </div>
          {done && (
            <div className="mt-3 border-t border-divider pt-3">
              <div className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
                Bring one piece of work
              </div>
              <div className="flex flex-wrap gap-2">
                <StarterButton onClick={() => startRealWork(WORK_STARTERS.investigate)}>Investigate</StarterButton>
                <StarterButton onClick={() => startRealWork(WORK_STARTERS.feature)}>Scope a feature</StarterButton>
                <StarterButton onClick={() => startRealWork(WORK_STARTERS.review)}>Untangle review</StarterButton>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Intro modal.
  if (dismissed) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-backdrop/55 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        className="elevated w-full max-w-lg animate-fade-in rounded-2xl p-6"
      >
        <div className="mb-4 flex items-center gap-2">
          <img src="/mark-yellow.svg" alt="" className="h-6 w-6" />
          <span className="text-xs font-medium text-faint">convyio</span>
        </div>
        <h1 id="onboarding-title" className="mb-2 text-2xl font-semibold text-body">
          See Convyio in one shared conversation.
        </h1>
        <p className="mb-6 text-sm text-muted">
          Watch two hackathon teammates and their own agents turn an idea into shared context, then hand off implementation without copy-pasting a single doc.
        </p>

        {showStarters ? (
          <>
            <div className="mb-2 text-[10px] font-bold tracking-wider text-muted uppercase">
              Bring one piece of work
            </div>
            <div className="mb-4 flex flex-col gap-2">
              <StarterButton onClick={() => startRealWork(WORK_STARTERS.investigate)}>Investigate before anyone changes code</StarterButton>
              <StarterButton onClick={() => startRealWork(WORK_STARTERS.feature)}>Turn a feature idea into a scoped plan</StarterButton>
              <StarterButton onClick={() => startRealWork(WORK_STARTERS.review)}>Untangle a change that keeps returning from review</StarterButton>
            </div>
            <button
              onClick={() => setShowStarters(false)}
              className="w-full rounded-md py-1.5 text-xs font-medium text-muted hover:text-body"
            >
              Back
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => setShowStarters(true)}
              className="mb-2 w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent transition hover:bg-accent-hover"
            >
              Bring one piece of work
            </button>
            <button
              onClick={explore}
              className="w-full rounded-md py-2 text-sm font-medium text-muted transition hover:text-body"
            >
              Explore on my own
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function StarterButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md bg-subtle px-3 py-2 text-left text-sm text-body transition hover:bg-subtle-hover"
    >
      {children}
    </button>
  );
}
