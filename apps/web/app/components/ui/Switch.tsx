"use client";

import { useId } from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  /** Helper text, shown under the switch and as its tooltip. */
  hint?: string;
}

/**
 * A real button with role="switch" (spec D14). Disabled uses aria-disabled rather than the
 * `disabled` attribute so it stays focusable and its hint stays readable (spec D9).
 */
export function Switch({ checked, onChange, label, disabled = false, hint }: SwitchProps) {
  const hintId = useId();
  return (
    <span className="syn-switch-wrap">
      <button
        type="button"
        role="switch"
        className="syn-switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        aria-describedby={hint ? hintId : undefined}
        title={hint}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
      >
        <span className="syn-switch-track" aria-hidden="true">
          <span className="syn-switch-thumb" />
        </span>
        <span>{label}</span>
      </button>
      {hint && (
        <span id={hintId} className="syn-switch-hint">
          {hint}
        </span>
      )}
    </span>
  );
}
