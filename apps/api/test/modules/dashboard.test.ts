import { describe, expect, test } from "bun:test";
import { HEALTH_HINTS, HEALTH_LABELS } from "../../src/modules/dashboard/health-hints";
import { type PipelineInput, pipelineStages } from "../../src/modules/dashboard/pipeline";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function input(o: Partial<PipelineInput> = {}): PipelineInput {
  return {
    slack: { lastSuccessAt: minutesAgo(10), error: false, stalled: false, searchesToday: 4 },
    rulesOk: true,
    openRedFlags: 2,
    assess: { duePending: 0, running: 0, failedRecent: 0 },
    openUrgent: 0,
    pendingApprovals: 0,
    ...o,
  };
}
const stage = (i: PipelineInput, id: string) => {
  const s = pipelineStages(i, NOW).find((x) => x.id === id);
  if (!s) throw new Error("missing stage");
  return s;
};

describe("pipelineStages", () => {
  test("stage order and labels are fixed", () => {
    const s = pipelineStages(input(), NOW);
    expect(s.map((x) => x.id)).toEqual(["collect", "screen", "assess", "surface"]);
    expect(s.map((x) => x.label)).toEqual(["Collect", "Screen", "Assess", "Surface"]);
  });

  test("collect: waiting with no success, ok at 10 min, waiting at 26 min", () => {
    const none = stage(input({ slack: { ...input().slack, lastSuccessAt: null } }), "collect");
    expect(none.state).toBe("waiting");
    const ok = stage(input(), "collect");
    expect(ok.state).toBe("ok");
    expect(ok.summary).toBe("10 min ago · 4 searches today");
    const late = stage(
      input({ slack: { ...input().slack, lastSuccessAt: minutesAgo(26) } }),
      "collect",
    );
    expect(late.state).toBe("waiting");
  });

  test("collect: failing on error or stall, even when recent", () => {
    expect(stage(input({ slack: { ...input().slack, error: true } }), "collect").state).toBe(
      "failing",
    );
    expect(stage(input({ slack: { ...input().slack, stalled: true } }), "collect").state).toBe(
      "failing",
    );
  });

  test("screen: failing when rules are not ok", () => {
    expect(stage(input({ rulesOk: false }), "screen").state).toBe("failing");
    const ok = stage(input(), "screen");
    expect(ok.state).toBe("ok");
    expect(ok.summary).toBe("2 red flags open");
  });

  test("assess: failing beats pending; waiting for pending or running; else up to date", () => {
    const failed = stage(
      input({ assess: { duePending: 3, running: 0, failedRecent: 1 } }),
      "assess",
    );
    expect(failed.state).toBe("failing");
    expect(
      stage(input({ assess: { duePending: 2, running: 0, failedRecent: 0 } }), "assess"),
    ).toMatchObject({
      state: "waiting",
      summary: "2 waiting",
    });
    expect(
      stage(input({ assess: { duePending: 0, running: 1, failedRecent: 0 } }), "assess").state,
    ).toBe("waiting");
    expect(stage(input(), "assess")).toMatchObject({ state: "ok", summary: "up to date" });
  });

  test("surface: idle at 0/0, ok with an urgent item or an approval", () => {
    expect(stage(input(), "surface").state).toBe("idle");
    expect(stage(input({ openUrgent: 1 }), "surface")).toMatchObject({
      state: "ok",
      summary: "1 urgent · 0 approvals",
    });
    expect(stage(input({ pendingApprovals: 1 }), "surface").state).toBe("ok");
  });
});

describe("health hints", () => {
  test("every hinted check has a label; others have none", () => {
    for (const k of Object.keys(HEALTH_HINTS)) expect(HEALTH_LABELS[k]).toBeDefined();
    expect(HEALTH_HINTS.auth).toBe("Run `claude` once in a terminal to refresh the login.");
    expect(HEALTH_LABELS.jobs).toBe("Background jobs");
    expect(HEALTH_HINTS["no-such-check"]).toBeUndefined();
  });
});
