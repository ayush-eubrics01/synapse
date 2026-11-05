export interface LiveMessage {
  type: string;
  data: unknown;
}

export class LiveBus {
  private readonly subscribers = new Set<(msg: LiveMessage) => void>();

  publish(msg: LiveMessage): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(msg);
      } catch {
        // a broken subscriber must not affect others or the publisher
      }
    }
  }

  subscribe(fn: (msg: LiveMessage) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
