import { useEffect, useRef } from "react";
import type { BoardItem } from "@workspace/shared";
import { ProposalCard } from "./ProposalCard";

export function ApprovalQueue({
  items,
  onApprove,
  onDeny,
  onDiscuss,
  onClose,
}: {
  items: BoardItem[];
  onApprove: (itemId: string) => void;
  onDeny: (itemId: string) => void;
  onDiscuss: (item: BoardItem) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed top-14 left-[248px] z-50 max-h-[70vh] w-80 overflow-y-auto rounded-lg bg-popup p-3 shadow-lg"
    >
      <h2 className="mb-2 text-[11px] font-bold tracking-wide text-muted uppercase">
        Awaiting approval — {items.length}
      </h2>
      <div className="space-y-2">
        {items.map((item) => (
          <ProposalCard
            key={item.id}
            item={item}
            onApprove={onApprove}
            onDeny={onDeny}
            onDiscuss={onDiscuss}
          />
        ))}
      </div>
    </div>
  );
}
