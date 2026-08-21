import { useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "@workspace/shared";
import { useWorkspace } from "../hooks/WorkspaceContext";
import { ChevronIcon } from "./Sidebar";
import { ThemeToggle } from "./ThemeToggle";

export type WorkspaceView = "chat" | "board" | "projects" | "resources";

/**
 * The app-level strip on the canvas above the content panel: brand on the
 * left, the view switch dead-center, demo playback + the pending-approval
 * signal + theme on the right. Chrome that operates on the app lives here;
 * the panel's own header (PanelHeader) carries only the room name and the
 * sidebar toggle — each control exists in exactly one place.
 */
export function AppBar({
  view,
  onSetView,
  onToggleQueue,
  channel,
  activeWorkspace,
  workspaces = [],
  onSelectWorkspace,
  onOpenLobby,
  onOpenSettings,
}: {
  view: WorkspaceView;
  onSetView: (view: WorkspaceView) => void;
  onToggleQueue: () => void;
  channel: string;
  activeWorkspace?: WorkspaceSummary;
  workspaces?: WorkspaceSummary[];
  onSelectWorkspace?: (workspaceId: string) => void;
  onOpenLobby?: () => void;
  onOpenSettings?: () => void;
}) {
  const { workspace, board, pendingInteractions, demoChannels, startDemo } = useWorkspace();
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  const pendingCount =
    board.filter((i) => i.status === "proposed").length + pendingInteractions.length;

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuOpen]);

  const tab = (target: WorkspaceView, label: string) => (
    <button
      role="tab"
      aria-selected={view === target}
      onClick={() => onSetView(target)}
      className={`cursor-pointer rounded-md px-4 py-1 text-sm font-bold tracking-wider uppercase transition select-none ${
        view === target
          ? "bg-popup text-body shadow-sm"
          : "text-muted hover:text-body"
      }`}
    >
      {label}
    </button>
  );

  return (
    <header className="relative flex h-10 shrink-0 items-end gap-3 px-3">
      <img
        src="/mark-yellow.svg"
        alt="convyio"
        draggable={false}
        className="h-7 w-7 shrink-0 select-none"
      />
      <span aria-hidden="true" className="h-5 w-px shrink-0 bg-divider" />
      <div ref={workspaceMenuRef} className="relative min-w-0">
        <button
          onClick={() => setWorkspaceMenuOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={workspaceMenuOpen}
          className="group flex max-w-64 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-base font-bold tracking-wider text-body uppercase transition-colors select-none hover:bg-subtle"
        >
          <span className="truncate">{activeWorkspace?.name ?? workspace?.name}</span>
          <ChevronIcon
            open={workspaceMenuOpen}
            flip
            className="h-3 w-3 shrink-0 text-muted transition-colors group-hover:text-body"
          />
        </button>
        {workspaceMenuOpen && (
          <div role="menu" aria-label="Switch workspace" className="elevated absolute top-full left-0 z-50 mt-1 w-64 rounded-lg p-1.5">
            <p className="px-2 py-1 text-[10px] font-bold tracking-wider text-muted uppercase">Workspaces</p>
            <div className="max-h-64 overflow-y-auto">
              {workspaces.map((item) => (
                <button
                  key={item.id}
                  role="menuitem"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    if (item.id !== activeWorkspace?.id) onSelectWorkspace?.(item.id);
                  }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-subtle-hover ${item.id === activeWorkspace?.id ? "font-semibold text-body" : "text-muted hover:text-body"}`}
                >
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="text-[10px] tracking-wider uppercase">{item.role}</span>
                </button>
              ))}
            </div>
            <div className="mt-1 border-t border-divider pt-1">
              <button
                role="menuitem"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  onOpenSettings?.();
                }}
                className="w-full rounded-md px-2 py-2 text-left text-sm text-muted hover:bg-subtle-hover hover:text-body"
              >
                Workspace settings
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  setWorkspaceMenuOpen(false);
                  onOpenLobby?.();
                }}
                className="w-full rounded-md px-2 py-2 text-left text-sm text-muted hover:bg-subtle-hover hover:text-body"
              >
                All workspaces
              </button>
            </div>
          </div>
        )}
      </div>
      <div
        role="tablist"
        aria-label="Workspace view"
        className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-subtle p-0.5"
      >
        {tab("chat", "Chat")}
        {tab("board", "Board")}
        {tab("projects", "Projects")}
        {tab("resources", "Resources")}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {demoChannels.includes(channel) && (
          <button
            onClick={() => startDemo(channel)}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-sm font-semibold text-on-accent transition select-none hover:bg-accent-hover"
            title="Play the scripted demo conversation"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M8 5v14l11-7z" />
            </svg>
            Run demo
          </button>
        )}
        {pendingCount > 0 && (
          <button
            onClick={onToggleQueue}
            aria-label={`Review ${pendingCount} pending approvals`}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent/15 px-2.5 py-1 text-sm font-bold text-accent transition select-none hover:bg-accent/25"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            {pendingCount} waiting
          </button>
        )}
        <ThemeToggle />
      </div>
    </header>
  );
}
