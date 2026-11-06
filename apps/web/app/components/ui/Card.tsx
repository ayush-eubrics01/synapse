import type { HTMLAttributes } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "quiet";
}

export function Card({ tone = "default", className, ...rest }: CardProps) {
  const cls = `syn-card${tone === "quiet" ? " syn-card--quiet" : ""}${className ? ` ${className}` : ""}`;
  return <div className={cls} {...rest} />;
}
