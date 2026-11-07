import type { RuntimeView } from "@synapse/contracts";

export type TimeOfDay = "morning" | "afternoon" | "evening" | "late";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** 5–11 morning, 12–16 afternoon, 17–21 evening, otherwise late (local time). */
export function timeOfDay(d: Date): TimeOfDay {
  const h = d.getHours();
  if (h >= 5 && h <= 11) return "morning";
  if (h >= 12 && h <= 16) return "afternoon";
  if (h >= 17 && h <= 21) return "evening";
  return "late";
}

const OPENERS: Record<TimeOfDay, string> = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  late: "Late night",
};

/** "Good morning, Ada." or, with no confirmed name, "Good morning." */
export function greeting(d: Date, name: string | null): string {
  const opener = OPENERS[timeOfDay(d)];
  const n = name?.trim();
  return n ? `${opener}, ${n}.` : `${opener}.`;
}

function weekdayDate(d: Date): string {
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "FRIDAY, 6 NOVEMBER · 2:25 AM": the time is in the browser locale's format. */
export function dateLine(d: Date): string {
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${weekdayDate(d)} · ${time}`.toUpperCase();
}

function parse(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "just now", "3 min ago", "2 h ago", "4 d ago"; "never" when there is no (valid) time. */
export function relMinutes(iso: string | null, now: Date): string {
  const t = parse(iso);
  if (t === null) return "never";
  const min = Math.floor((now.getTime() - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", or "Thursday, 5 November" (with the year when it is not this year). */
export function dayLabel(iso: string, now: Date): string {
  const t = parse(iso);
  if (t === null) return "";
  const d = new Date(t);
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const label = weekdayDate(d);
  return d.getFullYear() === now.getFullYear() ? label : `${label} ${d.getFullYear()}`;
}

/** A conversation's display name: "#name" for a channel, the bare name otherwise, the id when unnamed. */
export function conversationLabel(c: { name: string | null; id: string; type: string }): string {
  if (c.name === null) return c.id;
  return c.type === "channel" ? `#${c.name}` : c.name;
}

/** Binary units, one decimal from KiB: 0 -> "0 B", 1536 -> "1.5 KiB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n || 0))} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Sidebar footer addresses from the API's own config; null while the runtime view is unavailable. */
export function footerAddresses(r: RuntimeView | null): { api: string; web: string } | null {
  if (r === null) return null;
  const { api, web } = r.endpoints;
  return {
    api: api.host.includes(":") ? `[${api.host}]:${api.port}` : `${api.host}:${api.port}`,
    web: `:${web.port}`,
  };
}
