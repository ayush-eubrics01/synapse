"use client";

import type { DashboardLayoutSummary } from "@synapse/contracts";
import { useState } from "react";

export interface LayoutPickerProps {
  layouts: DashboardLayoutSummary[];
  activeId: string;
  onSwitch: (id: string) => void;
  onSaveAs: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  /** Resets the active layout to the default. */
  onReset: () => void;
  /** A layout call is running: every button waits. */
  busy?: boolean;
}

const btn = "syn-btn syn-btn--secondary syn-btn--sm";

export function LayoutPicker({
  layouts,
  activeId,
  onSwitch,
  onSaveAs,
  onRename,
  onDelete,
  onReset,
  busy = false,
}: LayoutPickerProps) {
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  return (
    <div className="syn-layout-picker">
      <h2 className="syn-hidden-tray-title">Layouts</h2>
      <ul>
        {layouts.map((l) => (
          <li key={l.id}>
            {editing?.id === l.id ? (
              <>
                <input
                  className="syn-layout-input"
                  aria-label="Layout name"
                  maxLength={40}
                  value={editing.name}
                  onChange={(e) => setEditing({ id: l.id, name: e.target.value })}
                />
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => {
                    onRename(l.id, editing.name);
                    setEditing(null);
                  }}
                >
                  Save name
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="syn-layout-name">{l.name}</span>
                {l.id === activeId ? (
                  <span className="syn-chip syn-chip--green">Active</span>
                ) : (
                  <button
                    type="button"
                    className={btn}
                    disabled={busy}
                    onClick={() => onSwitch(l.id)}
                  >
                    Switch
                  </button>
                )}
                <button
                  type="button"
                  className={btn}
                  disabled={busy}
                  onClick={() => setEditing({ id: l.id, name: l.name })}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className={btn}
                  disabled={busy || l.id === activeId}
                  onClick={() => onDelete(l.id)}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="syn-layout-new">
        <input
          className="syn-layout-input"
          aria-label="New layout name"
          placeholder="Name for a new layout"
          maxLength={40}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          type="button"
          className={btn}
          disabled={busy}
          onClick={() => {
            if (newName.trim() === "") return;
            onSaveAs(newName.trim());
            setNewName("");
          }}
        >
          Save as new
        </button>
        <button type="button" className={btn} disabled={busy} onClick={onReset}>
          Reset to default
        </button>
      </div>
    </div>
  );
}
