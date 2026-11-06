import type { ReactNode } from "react";
import { relMinutes } from "../../../lib/format";
import { Chip, type ChipTone } from "../ui/Chip";

export interface CardFrameProps {
  /** Mono kind tag, e.g. "RED FLAG · WARNING". */
  tag: string;
  tone: ChipTone;
  /** Extra small tags after the kind tag (e.g. "rule-based"). */
  tags?: string[];
  /** Right-aligned mono meta: "time · source". */
  meta?: string;
  title: ReactNode;
  children?: ReactNode;
  id?: string;
}

/** The shared Needs-you card: kind tag + meta row, title, then the card's body. */
export function CardFrame({ tag, tone, tags = [], meta, title, children, id }: CardFrameProps) {
  return (
    <article className="syn-ncard" id={id}>
      <div className="syn-ncard-top">
        <span className="syn-ncard-tags">
          <Chip tone={tone} mono>
            {tag}
          </Chip>
          {tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </span>
        {meta && <span className="syn-ncard-meta">{meta}</span>}
      </div>
      <h3 className="syn-ncard-title">{title}</h3>
      {children}
    </article>
  );
}

/** "5 min ago · #ops"; without a clock (server render) only the source. */
export function metaLine(at: string | null, now: Date | null, source: string | null): string {
  const parts: string[] = [];
  if (at && now) parts.push(relMinutes(at, now));
  if (source) parts.push(source);
  return parts.join(" · ");
}

export function Quote({ children }: { children: ReactNode }) {
  return <blockquote className="syn-ncard-quote">{children}</blockquote>;
}

export function Explainer({ children }: { children: ReactNode }) {
  return <p className="syn-ncard-explainer">{children}</p>;
}

/** Actions row; `end` is pushed to the right (a link such as "History ↗"). */
export function Actions({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="syn-ncard-actions">
      {children}
      {end && <span className="syn-ncard-end">{end}</span>}
    </div>
  );
}

export function SlackLink({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a className="syn-ncard-link" href={href} target="_blank" rel="noreferrer noopener">
      Open in Slack ↗
    </a>
  );
}

export function conversationLabel(c: { name: string | null; id: string; type: string }): string {
  if (c.name === null) return c.id;
  return c.type === "channel" ? `#${c.name}` : c.name;
}

export const SEND_STATUS: Record<string, string> = {
  pending: "Awaiting approval",
  sending: "Sending",
  sent: "Sent",
  sent_unverified: "Sent (unverified)",
  needs_attention: "Needs attention — check Slack",
  failed: "Not sent",
};

export const MAX_TEXT = 4000;
