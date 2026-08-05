import { roundMoney } from "./round";
import type { LineItem } from "./invoice-render";

/** Totals for the customer-facing PDF. Converts the invoice total in one step. */
export function pdfInvoiceTotals(lines: LineItem[], fxRate: number) {
  const rawTotal = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  const total = roundMoney(rawTotal * fxRate);
  const lineTotals = lines.map((l) => roundMoney(l.qty * l.unitPrice * fxRate));
  return { lineTotals, total };
}
