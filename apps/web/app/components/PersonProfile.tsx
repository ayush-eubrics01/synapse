"use client";

import type { PersonDetail, PersonPriority, ProfileSection } from "@synapse/contracts";
import { PriorityControls } from "./PriorityPeople";
import { Evidence } from "./triage/RecommendationCard";

const SECTION_TITLES: Record<ProfileSection, string> = {
  professionalContext: "Professional context",
  communication: "Communication",
  responseGuidelines: "Response guidelines",
};
const SECTIONS = Object.keys(SECTION_TITLES) as ProfileSection[];

export function PersonProfile({
  person,
  onClose,
  onEvaluate,
  onPriority,
}: {
  person: PersonDetail | null;
  onClose: () => void;
  onEvaluate: (slackUserId: string) => void;
  onPriority: (person: PersonDetail, priority: PersonPriority, extraAttention: boolean) => void;
}) {
  if (!person) return null;
  const profile = person.profile;
  return (
    <section aria-label="Person profile">
      <h3>
        {person.name ?? person.slackUserId}{" "}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </h3>
      <p>
        {[person.title, person.team, person.email].filter(Boolean).join(" · ")}
        {person.flagCount > 0 && ` · ${person.flagCount} red flag(s)`}
      </p>
      <p>
        Priority:{" "}
        <PriorityControls
          person={person}
          onChange={(priority, extra) => onPriority(person, priority, extra)}
        />
      </p>
      {person.temporaryContact && (
        <p>
          Temporary contact, {person.temporaryContact.messageCount} messages, expires{" "}
          {person.temporaryContact.expiresAt}
        </p>
      )}
      {person.actions.includes("evaluate") && (
        <button type="button" onClick={() => onEvaluate(person.slackUserId)}>
          Evaluate
        </button>
      )}
      {profile ? (
        <>
          <h4>
            Current version {profile.version} <small>updated {profile.updatedAt}</small>
          </h4>
          {SECTIONS.map((s) => (
            <div key={s}>
              <strong>{SECTION_TITLES[s]}</strong>
              {profile.content[s].length === 0 ? (
                <p>None.</p>
              ) : (
                <ul>
                  {profile.content[s].map((o) => (
                    <li key={o.key}>
                      {o.text} <small>({o.confidence})</small>
                      <Evidence
                        items={profile.evidence.filter((e) => e.observationKey === `${s}.${o.key}`)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
          <h4>Versions</h4>
          <ul>
            {person.versions.map((v) => (
              <li key={v.version}>
                v{v.version} <small>{v.createdAt}</small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>No profile yet.</p>
      )}
    </section>
  );
}
