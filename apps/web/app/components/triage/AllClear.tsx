/** The quiet checklist after the cards: one row per category with nothing waiting. */
export function AllClear({ rows }: { rows: Array<{ label: string; value: string }> }) {
  if (rows.length === 0) return null;
  return (
    <ul className="syn-allclear" aria-label="All clear">
      {rows.map((r) => (
        <li key={r.label} className="syn-allclear-row">
          <span className="syn-allclear-check" aria-hidden="true">
            ✓
          </span>
          <span className="syn-allclear-label">{r.label}</span>
          <span className="syn-allclear-fill" aria-hidden="true" />
          <span className="syn-allclear-value">{r.value}</span>
        </li>
      ))}
    </ul>
  );
}
