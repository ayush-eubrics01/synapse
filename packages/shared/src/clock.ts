export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private ms: number;

  constructor(start: Date | string) {
    this.ms = toMs(start);
  }

  now(): Date {
    return new Date(this.ms);
  }

  advance(ms: number): void {
    this.ms += ms;
  }

  set(t: Date | string): void {
    this.ms = toMs(t);
  }
}

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

function toMs(t: Date | string): number {
  return (t instanceof Date ? t : new Date(t)).getTime();
}
