/**
 * Shared money rounding helper. Every billing surface (invoice renderer,
 * PDF export, ledger sync) formats amounts through this function.
 */
export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}
