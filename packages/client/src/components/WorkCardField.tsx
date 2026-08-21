export function WorkCardField({ label, value }: { label: string; value: string }) {
  return (
    <div className="mb-1.5">
      <div className="text-[10px] font-bold tracking-wider text-muted uppercase">{label}</div>
      <div className="text-sm leading-snug break-words whitespace-pre-wrap text-body">{value}</div>
    </div>
  );
}
