/**
 * Fake billing module seeded into the shared workspace for the #demo-bug
 * script. It contains a real, findable rounding inconsistency:
 *
 * - invoice-render rounds each converted line, then sums the rounded floats
 *   (accumulating float dust in the total);
 * - pdf-export sums the raw amounts and rounds the converted total once;
 * - ledger-sync rounds per line like the renderer.
 *
 * The three surfaces therefore disagree by cents on the same invoice. The
 * constraint the demo hinges on — ledger-sync must keep matching what Stripe
 * already charged — is deliberately NOT written anywhere in these files: it
 * only exists in a teammate's head and arrives via chat.
 */

const ROUND_TS = `/**
 * Shared money rounding helper. Every billing surface (invoice renderer,
 * PDF export, ledger sync) formats amounts through this function.
 */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}
`;

const INVOICE_RENDER_TS = `import { roundMoney } from "./round";

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
`;

const PDF_EXPORT_TS = `import { roundMoney } from "./round";
import type { LineItem } from "./invoice-render";

/** Totals for the customer-facing PDF. Converts the invoice total in one step. */
export function pdfInvoiceTotals(lines: LineItem[], fxRate: number) {
  const rawTotal = lines.reduce((sum, l) => sum + l.qty * l.unitPrice, 0);
  const total = roundMoney(rawTotal * fxRate);
  const lineTotals = lines.map((l) => roundMoney(l.qty * l.unitPrice * fxRate));
  return { lineTotals, total };
}
`;

const LEDGER_SYNC_TS = `import { roundMoney } from "./round";
import type { LineItem } from "./invoice-render";

/** Per-line charge amounts posted to the payments ledger. */
export function ledgerAmounts(lines: LineItem[], fxRate: number): number[] {
  return lines.map((l) => roundMoney(l.qty * l.unitPrice * fxRate));
}
`;

const README_MD = `# billing

Money math for invoices.

- \`round.ts\` — shared rounding helper used by everything below
- \`invoice-render.ts\` — in-app invoice totals
- \`pdf-export.ts\` — customer-facing PDF totals
- \`ledger-sync.ts\` — amounts posted to the payments ledger
`;

export const SEED_FILES: Record<string, string> = {
  "README.md": README_MD,
  "round.ts": ROUND_TS,
  "invoice-render.ts": INVOICE_RENDER_TS,
  "pdf-export.ts": PDF_EXPORT_TS,
  "ledger-sync.ts": LEDGER_SYNC_TS,
};
