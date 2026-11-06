"use client";

import type { KeyboardEvent } from "react";

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** A radiogroup of buttons (spec D14): one tab stop, arrow keys move the choice. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  const index = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0 || options.length === 0) return;
    e.preventDefault();
    const nextIndex = (Math.max(index, 0) + step + options.length) % options.length;
    const next = options[nextIndex];
    if (!next) return;
    onChange(next.value);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons[nextIndex]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="syn-seg" onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio-group pattern on buttons, styled as a segmented control (spec D14)
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (index < 0 && i === 0) ? 0 : -1}
            className="syn-seg-option"
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
