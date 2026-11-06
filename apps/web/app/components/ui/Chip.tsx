import type { HTMLAttributes } from "react";

export type ChipTone = "neutral" | "red" | "amber" | "green" | "blue";

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  /** Mono uppercase kind tag, e.g. "RED FLAG · WARNING". */
  mono?: boolean;
}

export function Chip({ tone = "neutral", mono = false, className, ...rest }: ChipProps) {
  const cls = `syn-chip syn-chip--${tone}${mono ? " syn-chip--mono" : ""}${className ? ` ${className}` : ""}`;
  return <span className={cls} {...rest} />;
}
