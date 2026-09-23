/**
 * Small, non-blocking loading indicator announced to assistive technology.
 * The spinner is decorative; animation is suppressed by the global
 * `prefers-reduced-motion` rule in `styles.css`.
 */
export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}