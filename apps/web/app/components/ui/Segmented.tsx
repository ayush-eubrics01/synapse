"use client";

import { type KeyboardEvent, useEffect, useState } from "react";

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** The option an arrow key moves to from `current` (wrapping), or null for any other key. */
export function nextSegmentedValue<T extends string>(
  options: ReadonlyArray<{ value: T }>,
  current: T,
  key: string,
): T | null {
  const step =
    key === "ArrowRight" || key === "ArrowDown"
      ? 1
      : key === "ArrowLeft" || key === "ArrowUp"
        ? -1
        : 0;
  if (step === 0 || options.length === 0) return null;
  const index = options.findIndex((o) => o.value === current);
  const nextIndex = (Math.max(index, 0) + step + options.length) % options.length;
  return options[nextIndex]?.value ?? null;
}

/**
 * A radiogroup of buttons (spec D14): one tab stop, arrow keys move the choice. The selection is
 * kept locally so repeated arrow presses step on from the last one before the parent's value
 * catches up; each press commits once, and a new `value` from the parent resets it.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  const [local, setLocal] = useState<T>(value);
  useEffect(() => setLocal(value), [value]);
  const index = options.findIndex((o) => o.value === local);
  const choose = (next: T) => {
    setLocal(next);
    onChange(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = nextSegmentedValue(options, local, e.key);
    if (next === null) return;
    e.preventDefault();
    choose(next);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons[options.findIndex((o) => o.value === next)]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="syn-seg" onKeyDown={onKeyDown}>
      {options.map((o, i) => {
        const on = o.value === local;
        return (
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio-group pattern on buttons, styled as a segmented control (spec D14)
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={on}
            tabIndex={on || (index < 0 && i === 0) ? 0 : -1}
            className="syn-seg-option"
            onClick={() => choose(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
