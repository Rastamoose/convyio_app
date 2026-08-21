import { useEffect, useState } from "react";
import type { DemoFocusTarget } from "@workspace/shared";

interface SpotlightRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export function ShowcaseSpotlight({ focus }: { focus?: DemoFocusTarget }) {
  const [rect, setRect] = useState<SpotlightRect | null>(null);

  useEffect(() => {
    if (!focus || focus.kind === "guide") {
      setRect(null);
      return;
    }

    let target: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let retry: number | undefined;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const update = () => {
      if (!target?.isConnected) target = findTarget(focus);
      if (!target) {
        setRect(null);
        return;
      }
      const box = target.getBoundingClientRect();
      const padding = 8;
      const top = Math.max(8, box.top - padding);
      const left = Math.max(8, box.left - padding);
      const right = Math.min(window.innerWidth - 8, box.right + padding);
      const bottom = Math.min(window.innerHeight - 96, box.bottom + padding);
      setRect({ top, left, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) });
    };

    const attach = () => {
      target = findTarget(focus);
      if (!target) return false;
      target.scrollIntoView?.({ block: "center", inline: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(update);
        resizeObserver.observe(target);
      }
      if (focus.kind === "plan_accept" || focus.kind === "ticket_approve" || focus.kind === "composer") {
        window.setTimeout(() => (target?.querySelector<HTMLElement>("button, textarea, input") ?? target)?.focus({ preventScroll: true }), reducedMotion ? 0 : 300);
      }
      update();
      return true;
    };

    if (!attach()) {
      mutationObserver = new MutationObserver(() => {
        if (target || !attach()) return;
        mutationObserver?.disconnect();
      });
      mutationObserver.observe(document.body, { childList: true, subtree: true });
      retry = window.setTimeout(update, 3000);
    }

    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      if (retry !== undefined) window.clearTimeout(retry);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [focus?.kind, focus?.id]);

  useEffect(() => {
    if (!focus) return;
    const trapTab = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const guide = document.querySelector<HTMLElement>('[data-onboarding-target="demo-guide"]');
      const target = focus.kind === "guide" ? null : findTarget(focus);
      const focusable = [guide, target]
        .flatMap((element) => element ? [...element.querySelectorAll<HTMLElement>('button, textarea, input, select, [tabindex]:not([tabindex="-1"])')] : [])
        .filter((element, index, all) => !element.hasAttribute("disabled") && all.indexOf(element) === index);
      if (focusable.length === 0) return;
      const current = focusable.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? current <= 0 ? focusable.length - 1 : current - 1
        : current < 0 || current === focusable.length - 1 ? 0 : current + 1;
      event.preventDefault();
      focusable[next].focus();
    };
    document.addEventListener("keydown", trapTab);
    return () => document.removeEventListener("keydown", trapTab);
  }, [focus?.kind, focus?.id]);

  if (!focus) return null;
  if (focus.kind === "guide") return <div data-testid="showcase-dim" aria-hidden="true" className="fixed inset-0 z-40 bg-backdrop/70" />;
  if (!rect) return null;

  return (
    <>
      <div aria-hidden="true" className="fixed top-0 right-0 left-0 z-40 bg-backdrop/70" style={{ height: rect.top }} />
      <div aria-hidden="true" className="fixed left-0 z-40 bg-backdrop/70" style={{ top: rect.top, width: rect.left, height: rect.height }} />
      <div aria-hidden="true" className="fixed right-0 z-40 bg-backdrop/70" style={{ top: rect.top, left: rect.right, height: rect.height }} />
      <div aria-hidden="true" className="fixed right-0 bottom-0 left-0 z-40 bg-backdrop/70" style={{ top: rect.bottom }} />
      <div
        data-testid="showcase-spotlight"
        aria-hidden="true"
        className="pointer-events-none fixed z-40 rounded-lg ring-2 ring-accent transition-[top,left,width,height] duration-300 motion-reduce:transition-none"
        style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
      />
    </>
  );
}

function findTarget(focus: DemoFocusTarget): HTMLElement | null {
  const match = (attribute: string, value?: string) => {
    const elements = document.querySelectorAll<HTMLElement>(`[${attribute}]`);
    return [...elements].find((element) => value === undefined || element.getAttribute(attribute) === value) ?? null;
  };
  switch (focus.kind) {
    case "conversation":
      return match("data-onboarding-target", "conversation");
    case "message":
      return match("data-demo-message-id", focus.id);
    case "plan":
      return match("data-demo-plan-ref", focus.id);
    case "plan_change":
      return match("data-demo-plan-change", focus.id);
    case "plan_accept":
      return match("data-demo-plan-accept", focus.id);
    case "ticket":
      return match("data-demo-ticket-ref", focus.id);
    case "ticket_approve":
      return match("data-demo-ticket-approve", focus.id);
    case "result":
      return match("data-demo-result-ref", focus.id);
    case "composer":
      return match("data-onboarding-target", "composer");
    default:
      return null;
  }
}
