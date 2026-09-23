/**
 * Format an integer minor-unit amount (e.g. cents) as a localized currency
 * string. The API always communicates money as integers in a `currency`
 * field, so no floating point arithmetic is performed here.
 */
export function formatCents(amountCents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amountCents / 100);
}