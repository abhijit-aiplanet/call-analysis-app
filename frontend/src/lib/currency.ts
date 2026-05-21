// Currency helpers — convert USD → INR and format using the Indian
// numbering system (lakh / crore grouping). Single source of truth.

export const USD_TO_INR = 95;

const inrFormatter = (decimals: number) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

/**
 * Format a USD value as INR.
 *
 * decimals === "auto" picks a sensible precision for the magnitude:
 *   • < ₹0.10   → 4 decimals (paise-level granularity for per-call costs)
 *   • < ₹100    → 2 decimals
 *   • >= ₹100   → 0 decimals + Indian-style grouping (1,23,456)
 */
export function inr(
  usd: number | null | undefined,
  options: { decimals?: number | "auto"; symbol?: boolean } = {},
): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return "—";
  const { decimals = "auto", symbol = true } = options;
  const rupees = usd * USD_TO_INR;

  let d: number;
  if (decimals === "auto") {
    if (Math.abs(rupees) < 0.1) d = 4;
    else if (Math.abs(rupees) < 100) d = 2;
    else d = 0;
  } else {
    d = decimals;
  }

  const body = inrFormatter(d).format(rupees);
  return symbol ? `₹${body}` : body;
}

/** USD/min → ₹/min, same formatting rules as inr() */
export function inrPerMin(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return "—";
  return `${inr(usd)} / min`;
}

/** Group a large rupee count with Indian commas. Always 0 decimals. */
export function inrInt(rupees: number): string {
  return `₹${inrFormatter(0).format(Math.round(rupees))}`;
}

/** USD → INR with explicit lakh/crore label when the rupee value is huge. */
export function inrScale(usd: number): string {
  const rupees = usd * USD_TO_INR;
  if (rupees >= 1_00_00_000) return `₹${(rupees / 1_00_00_000).toFixed(2)} Cr`;
  if (rupees >= 1_00_000) return `₹${(rupees / 1_00_000).toFixed(2)} L`;
  return inr(usd);
}
