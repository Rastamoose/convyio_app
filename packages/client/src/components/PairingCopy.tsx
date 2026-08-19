import { useState } from "react";

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${expanded ? "rotate-90" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function SetupPromptCard({
  value,
  onOpenFolder,
  folderName,
  folderEntries,
}: {
  value: string;
  onOpenFolder?: () => void;
  folderName?: string;
  folderEntries?: string[];
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The prompt stays selectable so the human can copy it by hand.
    }
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] font-bold tracking-wider text-muted uppercase">
          Setup prompt
        </p>
        <span className="flex shrink-0 items-center gap-1.5">
          {onOpenFolder && (
            <button
              type="button"
              onClick={onOpenFolder}
              aria-label="Open local folder"
              className="cursor-pointer rounded-md border border-divider bg-input px-2.5 py-1 text-xs font-medium text-body hover:bg-subtle-hover"
            >
              Open folder
            </button>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            aria-label="Copy setup prompt"
            className="cursor-pointer rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
          >
            {copied ? "Copied" : "Copy prompt"}
          </button>
        </span>
      </div>
      {folderName && (
        <div className="mb-2 rounded-md border border-divider bg-subtle px-2.5 py-2">
          <p className="text-[10px] font-bold tracking-wider text-muted uppercase">
            This computer
          </p>
          <p className="mt-0.5 font-mono text-xs text-body">{folderName}</p>
          {folderEntries && folderEntries.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 font-mono text-xs text-muted">
              {folderEntries.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <pre
        aria-label="Setup prompt"
        className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-divider bg-composer px-2.5 py-2 font-mono text-xs text-body"
      >
        {value}
      </pre>
    </div>
  );
}

/** A pairing secret or command: Copy is always on the row; the value sits
 *  behind the same chevron the rest of the product uses for disclosures. */
export function PairingCopyRow({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string;
  multiline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The value stays selectable once the row is opened.
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[10px] font-bold tracking-wider text-muted uppercase hover:text-body"
        >
          <Chevron expanded={open} />
          {label}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${label}`}
          className="shrink-0 cursor-pointer rounded-md border border-divider bg-input px-2 py-1 text-xs font-medium text-body hover:bg-subtle-hover"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {open && (
        <pre
          className={`mt-1.5 overflow-x-auto rounded-md border border-divider bg-composer px-2.5 py-2 font-mono text-xs text-body ${
            multiline ? "whitespace-pre-wrap break-words" : "whitespace-pre"
          }`}
        >
          {value}
        </pre>
      )}
    </div>
  );
}
