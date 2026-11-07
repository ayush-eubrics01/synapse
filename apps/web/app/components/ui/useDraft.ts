"use client";

import { useState } from "react";
import { type DraftKey, readDraft, writeDraft } from "../../../lib/drafts";

/** A textarea value that is mirrored into the in-memory draft store, so a remount restores it. */
export function useDraft(key: DraftKey, initial: string): [string, (text: string) => void] {
  const [text, setText] = useState(() => readDraft(key) ?? initial);
  return [
    text,
    (next) => {
      setText(next);
      writeDraft(key, next);
    },
  ];
}
