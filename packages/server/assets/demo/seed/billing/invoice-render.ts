import { roundMoney } from "./round";

export interface LineItem {
  description: string;
  qty: number;
  unitPrice: number; // in the invoice's base currency
}

/** Totals for the in-app invoice view. FX conversion happens per line. */
export function renderInvoiceTotals(lines: LineItem[], fxRate: number) {
  const lineTotals = lines.map((l) => roundMoney(l.qty * l.unitPrice * fxRate));
  const total = lineTotals.reduce((sum, t) => sum + t, 0);
  return { lineTotals, total };
}
