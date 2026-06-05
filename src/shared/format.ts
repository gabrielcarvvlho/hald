// ================================================================
// Number formatting — locale-independent by design
// ================================================================

/**
 * Format an integer with comma thousands separators, regardless of the host
 * system locale.
 *
 * `Number.prototype.toLocaleString()` (with no explicit locale) follows the
 * runtime's default locale: it renders `12345` as `'12.345'` on pt_BR/de_DE
 * but `'12,345'` on en-US. That made CLI output — and the tests asserting on
 * it — machine-dependent. This helper pins the grouping to commas so output is
 * deterministic everywhere.
 *
 * Fractional input is truncated toward zero before grouping. Non-finite input
 * (NaN, ±Infinity) renders as `'0'` rather than throwing, so a stray bad token
 * count never crashes a summary card.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const int = Math.trunc(n);
  // `Math.trunc(-0)` is `-0`; normalize so we never render "-0".
  if (int === 0) return "0";
  const negative = int < 0;
  const digits = String(Math.abs(int)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${digits}` : digits;
}
