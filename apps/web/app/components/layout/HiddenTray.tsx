"use client";

import type { DashboardSectionId } from "@synapse/contracts";
import { SECTION_LABELS } from "../../../lib/layout";

export interface HiddenTrayProps {
  hidden: DashboardSectionId[];
  onShow: (id: DashboardSectionId) => void;
}

export function HiddenTray({ hidden, onShow }: HiddenTrayProps) {
  if (hidden.length === 0) return null;
  return (
    <div className="syn-hidden-tray">
      <h2 className="syn-hidden-tray-title">Hidden sections</h2>
      <ul>
        {hidden.map((id) => (
          <li key={id}>
            <span>{SECTION_LABELS[id]}</span>
            <button
              type="button"
              className="syn-btn syn-btn--secondary syn-btn--sm"
              onClick={() => onShow(id)}
            >
              Show
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
