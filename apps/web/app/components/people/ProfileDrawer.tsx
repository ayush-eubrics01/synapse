"use client";

import type { PersonDetail, PersonPriority, ProfileSection } from "@synapse/contracts";
import { useEffect, useId, useRef } from "react";
import { Evidence } from "../triage/RecommendationCard";
import { Button } from "../ui/Button";
import { PriorityControl } from "./PriorityControl";

const SECTION_TITLES: Record<ProfileSection, string> = {
  professionalContext: "Professional context",
  communication: "Communication",
  responseGuidelines: "Response guidelines",
};
const SECTIONS = Object.keys(SECTION_TITLES) as ProfileSection[];

const FOCUSABLE = 'button, [href], input, [tabindex]:not([tabindex="-1"])';

export interface ProfileDrawerProps {
  person: PersonDetail | null;
  onClose: () => void;
  onEvaluate: (slackUserId: string) => void;
  onPriority: (person: PersonDetail, priority: PersonPriority, extraAttention: boolean) => void;
}

/** Right-side modal drawer (spec D13). Esc and Close dismiss; focus returns to the opener. */
export function ProfileDrawer(p: ProfileDrawerProps) {
  if (!p.person) return null;
  return <Drawer {...p} person={p.person} />;
}

function Drawer({
  person,
  onClose,
  onEvaluate,
  onPriority,
}: ProfileDrawerProps & { person: PersonDetail }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      // Keep Tab inside the modal.
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const profile = person.profile;
  const name = person.name ?? person.slackUserId;
  const meta = [person.title, person.team, person.email].filter(Boolean).join(" · ");
  return (
    <>
      {/* The backdrop is a pointer shortcut; Esc and Close are the keyboard paths. */}
      <div className="syn-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        className="syn-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="syn-drawer-head">
          <h3 id={titleId}>{name}</h3>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <p className="syn-card-sub">
          {meta}
          {person.flagCount > 0 && `${meta ? " · " : ""}${person.flagCount} red flag(s)`}
        </p>
        <PriorityControl
          person={person}
          onChange={(priority, extra) => onPriority(person, priority, extra)}
        />
        {person.temporaryContact && (
          <p className="syn-card-sub">
            Temporary contact, {person.temporaryContact.messageCount} messages, expires{" "}
            {person.temporaryContact.expiresAt}
          </p>
        )}
        {person.actions.includes("evaluate") && (
          <Button size="sm" onClick={() => onEvaluate(person.slackUserId)}>
            Evaluate
          </Button>
        )}
        {profile ? (
          <>
            <h4 className="syn-drawer-h">
              Current version {profile.version}{" "}
              <small className="syn-card-sub">updated {profile.updatedAt}</small>
            </h4>
            {SECTIONS.map((s) => (
              <div key={s} className="syn-drawer-sec">
                <strong>{SECTION_TITLES[s]}</strong>
                {profile.content[s].length === 0 ? (
                  <p className="syn-empty">None.</p>
                ) : (
                  <ul>
                    {profile.content[s].map((o) => (
                      <li key={o.key}>
                        {o.text} <small className="syn-card-sub">({o.confidence})</small>
                        <Evidence
                          items={profile.evidence.filter(
                            (e) => e.observationKey === `${s}.${o.key}`,
                          )}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <h4 className="syn-drawer-h">Versions</h4>
            <ul>
              {person.versions.map((v) => (
                <li key={v.version}>
                  v{v.version} <small className="syn-card-sub">{v.createdAt}</small>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="syn-empty">No profile yet.</p>
        )}
      </div>
    </>
  );
}
