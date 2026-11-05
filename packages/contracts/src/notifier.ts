/** Desktop notification port (adapter in `apps/api/src/infrastructure`). Title only: never message text. */
export interface DesktopNotifier {
  notify(n: { title: string; severity: "info" | "warning" | "high" }): Promise<void>;
}
