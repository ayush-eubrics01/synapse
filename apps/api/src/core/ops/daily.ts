/** Once-a-day scheduling over a 15-minute coalesced tick (same mechanism as the A10 reminders). */
export type LocalTime = (now: Date) => { date: string; hour: number };

const p2 = (n: number) => String(n).padStart(2, "0");

export const processLocalTime: LocalTime = (now) => ({
  date: `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`,
  hour: now.getHours(),
});

export function dailyDue(
  now: Date,
  hour: number,
  lastRunDate: string | null,
  localTime: LocalTime = processLocalTime,
): { due: boolean; date: string; reason?: "not_due" | "done_today" } {
  const local = localTime(now);
  if (local.hour < hour) return { due: false, date: local.date, reason: "not_due" };
  if (lastRunDate === local.date) return { due: false, date: local.date, reason: "done_today" };
  return { due: true, date: local.date };
}
