import { roundMoney } from "./round";
import type { LineItem } from "./invoice-render";

/** Per-line charge amounts posted to the payments ledger. */
export function ledgerAmounts(lines: LineItem[], fxRate: number): number[] {
  return lines.map((l) => roundMoney(l.qty * l.unitPrice * fxRate));
}
