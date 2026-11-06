"use client";

import { useEffect, useId, useRef, useState } from "react";
import { filterPalette, movePalette, type PaletteItem } from "../../../lib/palette";

export interface CommandPaletteProps {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
}

/** Centered modal (spec D14): focus moves to the input, Esc closes, focus returns to the opener. */
export function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const baseId = useId();

  useEffect(() => {
    if (!open) return;
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQuery("");
    setIndex(0);
    inputRef.current?.focus();
    return () => {
      // Restore focus unless the chosen item moved it somewhere else.
      const a = document.activeElement;
      if (!a || a === document.body) openerRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const shown = filterPalette(items, query);
  const active = Math.min(index, Math.max(0, shown.length - 1));
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIndex(movePalette(active, e.key === "ArrowDown" ? 1 : -1, shown.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      e.preventDefault(); // the input is the only stop inside the dialog
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse-only dismiss; Esc closes from the input
    <div className="syn-palette-backdrop" role="presentation" onClick={onClose}>
      <div
        className="syn-palette syn-in"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="syn-palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={shown.length > 0 ? optionId(active) : undefined}
          aria-label="Jump to"
          placeholder="Jump to a conversation, person or action…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
        />
        {shown.length === 0 ? (
          <p className="syn-palette-empty">No matches.</p>
        ) : (
          <div className="syn-palette-list" id={`${baseId}-list`} role="listbox">
            {shown.map((item, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys (arrows, Enter) are handled on the dialog via aria-activedescendant
              <div
                key={item.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`syn-palette-row${i === active ? " is-active" : ""}`}
                onMouseMove={() => setIndex(i)}
                onClick={() => run(item)}
                tabIndex={-1}
              >
                <span>{item.label}</span>
                <span className="syn-palette-group">{item.group}</span>
              </div>
            ))}
          </div>
        )}
        <div className="syn-palette-foot">
          <span>↑↓ move</span>
          <span>↵ run</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
