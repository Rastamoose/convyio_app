import { renderInvoiceTotals } from "./invoice-render";
import { pdfInvoiceTotals } from "./pdf-export";
import { ledgerAmounts } from "./ledger-sync";

const lines = [
  { description: "consulting", qty: 1, unitPrice: 10.005 },
  { description: "support", qty: 1, unitPrice: 10.005 },
];
const fxRate = 1;

const invoice = renderInvoiceTotals(lines, fxRate);
const pdf = pdfInvoiceTotals(lines, fxRate);
const ledger = ledgerAmounts(lines, fxRate);

const expectedLedger = [10.01, 10.01];

let ok = true;
if (JSON.stringify(invoice.lineTotals) !== JSON.stringify(pdf.lineTotals)) {
  console.error(`lineTotals mismatch: invoice ${JSON.stringify(invoice.lineTotals)} vs pdf ${JSON.stringify(pdf.lineTotals)}`);
  ok = false;
}
if (invoice.total !== pdf.total) {
  console.error(`total mismatch: invoice ${invoice.total} vs pdf ${pdf.total}`);
  ok = false;
}
if (JSON.stringify(ledger) !== JSON.stringify(expectedLedger)) {
  console.error(`ledger output changed: ${JSON.stringify(ledger)} (expected ${JSON.stringify(expectedLedger)})`);
  ok = false;
}
if (invoice.total !== expectedLedger.reduce((s, v) => s + v, 0)) {
  console.error(`invoice total ${invoice.total} does not match ledger sum`);
  ok = false;
}

if (!ok) {
  process.exit(1);
}

console.log(`PASS invoice=${invoice.total} pdf=${pdf.total} ledger=${JSON.stringify(ledger)}`);
