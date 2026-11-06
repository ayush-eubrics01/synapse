import { BANNER_TITLE, bannerCopy } from "../../../lib/away";
import { Button } from "../ui/Button";

/** Shown under the header while away mode is on (spec A18). */
export function AwayBanner({
  highPriorityCount,
  onSetPriority,
}: {
  highPriorityCount: number;
  onSetPriority: () => void;
}) {
  return (
    <div className="syn-away-banner" role="status">
      <div className="syn-away-banner-text">
        <strong>{BANNER_TITLE}</strong>
        <span>{bannerCopy(highPriorityCount)}</span>
      </div>
      <Button variant="secondary" size="sm" onClick={onSetPriority}>
        Set priority people
      </Button>
    </div>
  );
}
