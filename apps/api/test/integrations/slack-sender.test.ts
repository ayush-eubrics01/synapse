import { describe, expect, test } from "bun:test";
import {
  type AIExecutionResult,
  type ClaudeJobRequest,
  type CollectRequest,
  type CollectResult,
  JobError,
  type RawToolResult,
  type SendMessageCommand,
  type SourceMessage,
} from "@synapse/contracts";
import { FakeClock } from "@synapse/shared";
import { createContainer } from "../../src/container";
import { loadConfig } from "../../src/core/config/config";
import { buildSendRequest, SEND, SlackSender } from "../../src/integrations/slack/sender";

const signal = new AbortController().signal;
const TEXT = "SYNTH-APPROVED-TEXT: deploy is done";
const SELF = "U0SYNTHSELF";

const cmd = (over: Partial<SendMessageCommand> = {}): SendMessageCommand => ({
  outgoingId: "out-1",
  approvalId: "appr-1",
  conversationExternalId: "C0SYNTHCHN1",
  threadTs: "1793872900.000300",
  text: TEXT,
  jobId: "job-1",
  ...over,
});

const args = { channel_id: "C0SYNTHCHN1", message: TEXT, thread_ts: "1793872900.000300" };

let n = 0;
const tr = (input: unknown, isError = false, toolName = SEND): RawToolResult => ({
  toolUseId: `t${n++}`,
  toolName,
  input,
  isError,
  content: "synthetic result",
});

const result = (toolResults: RawToolResult[]): AIExecutionResult => ({
  status: "succeeded",
  toolResults,
  finalText: "DONE",
  numTurns: 3,
  durationMs: 1,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsdEquivalent: 0,
  },
  permissionDenials: [],
  connectors: [],
  availableTools: [],
  exitCode: 0,
});

interface Setup {
  run?: (req: ClaudeJobRequest) => Promise<AIExecutionResult>;
  collect?: (req: CollectRequest) => Promise<CollectResult>;
  self?: string | null;
  runIds?: (string | null)[];
}

function setup(o: Setup = {}) {
  const seen: ClaudeJobRequest[] = [];
  const collects: CollectRequest[] = [];
  const runIds = [...(o.runIds ?? [null, "run-1"])];
  const sender = new SlackSender({
    orchestrator: {
      run: async (req) => {
        seen.push(req);
        return (o.run ?? (async () => result([tr(args)])))(req);
      },
    },
    clock: new FakeClock("2026-11-06T10:00:00.000Z"),
    searchSource: {
      collect: async (req) => {
        collects.push(req);
        if (!o.collect) throw new Error("collect not expected");
        return o.collect(req);
      },
    },
    selfUserId: () => (o.self === undefined ? SELF : o.self),
    runIdForJob: () => (runIds.length > 1 ? (runIds.shift() ?? null) : (runIds[0] ?? null)),
  });
  return { sender, seen, collects };
}

const withResults = (...rs: RawToolResult[]) => ({ run: async () => result(rs) });

describe("buildSendRequest", () => {
  test("only the send tool, a system part and the exact approved JSON; no untrusted parts", () => {
    const req = buildSendRequest(cmd());
    expect(req).toMatchObject({
      jobId: "job-1",
      workerProfile: "collector",
      priorityClass: "send",
      allowedTools: [SEND, "ToolSearch"],
      maxTurns: 3,
    });
    expect(req.expectedToolNames).toBeUndefined();
    const parts = req.parts ?? [];
    expect(parts.map((p) => p.provenance)).toEqual(["system", "user_approved"]);
    expect(parts[0]?.content).toContain(SEND);
    expect(parts[0]?.content).toContain("exactly once");
    expect(parts[1]?.content).toBe(JSON.stringify(args));
    expect(Object.keys(JSON.parse(parts[1]?.content ?? "{}"))).toEqual([
      "channel_id",
      "message",
      "thread_ts",
    ]);
    // the approved text appears only in the user_approved part
    expect(req.instructions).not.toContain(TEXT);
    expect(parts[0]?.content).not.toContain(TEXT);
    expect(req.systemPrompt ?? "").not.toContain(TEXT);
  });

  test("no thread: thread_ts is omitted; trailing whitespace is trimmed", () => {
    const req = buildSendRequest(
      cmd({ threadTs: undefined, text: `${TEXT}  \n`, jobId: undefined }),
    );
    expect(req.parts?.[1]?.content).toBe(
      JSON.stringify({ channel_id: "C0SYNTHCHN1", message: TEXT }),
    );
    expect("jobId" in req).toBe(false);
  });
});

describe("SlackSender.send", () => {
  test("happy path: sent_unverified with the run id; the request is the built send request", async () => {
    const { sender, seen } = setup();
    expect(await sender.send(cmd(), signal)).toEqual({ status: "sent_unverified", runId: "run-1" });
    expect(seen).toEqual([buildSendRequest(cmd())]);
  });

  test("ToolSearch results are ignored; unfurl_app_links false is accepted", async () => {
    const { sender } = setup(
      withResults(
        tr({ query: `select:${SEND}` }, false, "ToolSearch"),
        tr({ ...args, unfurl_app_links: false }),
      ),
    );
    expect((await sender.send(cmd(), signal)).status).toBe("sent_unverified");
  });

  test("trailing whitespace on either side still matches", async () => {
    const { sender } = setup(withResults(tr({ ...args, message: `${TEXT}\n` })));
    expect((await sender.send(cmd({ text: `${TEXT}  ` }), signal)).status).toBe("sent_unverified");
  });

  test("no thread on either side matches", async () => {
    const { sender } = setup(withResults(tr({ channel_id: args.channel_id, message: TEXT })));
    expect((await sender.send(cmd({ threadTs: undefined }), signal)).status).toBe(
      "sent_unverified",
    );
  });

  const mismatches: [string, unknown][] = [
    ["a different channel", { ...args, channel_id: "C0SYNTHOTHR" }],
    ["a dropped thread_ts", { channel_id: args.channel_id, message: TEXT }],
    ["an altered text", { ...args, message: `${TEXT}!` }],
    ["leading whitespace added", { ...args, message: ` ${TEXT}` }],
    ["reply_broadcast true", { ...args, reply_broadcast: true }],
    ["a draft_id", { ...args, draft_id: "d1" }],
    ["unfurl_app_links true", { ...args, unfurl_app_links: true }],
    ["a thread added", { ...args, thread_ts: "1793872999.000100" }],
    ["a non-object input", "not an object"],
  ];
  for (const [name, input] of mismatches) {
    test(`argument_mismatch: ${name}`, async () => {
      const { sender } = setup(withResults(tr(input)));
      const r = await sender.send(cmd(), signal);
      expect(r).toEqual({
        status: "failed",
        failure: "argument_mismatch",
        mismatch: true,
        runId: "run-1",
      });
    });
  }

  test("a thread added when the command has none -> argument_mismatch", async () => {
    const { sender } = setup(withResults(tr(args)));
    const r = await sender.send(cmd({ threadTs: undefined }), signal);
    expect(r).toMatchObject({ status: "failed", failure: "argument_mismatch", mismatch: true });
  });

  test("a mismatched input that also errored is still argument_mismatch", async () => {
    const { sender } = setup(withResults(tr({ ...args, channel_id: "C0SYNTHOTHR" }, true)));
    expect(await sender.send(cmd(), signal)).toMatchObject({
      failure: "argument_mismatch",
      mismatch: true,
    });
  });

  test("tool_error", async () => {
    const { sender } = setup(withResults(tr(args, true)));
    expect(await sender.send(cmd(), signal)).toEqual({
      status: "failed",
      failure: "tool_error",
      runId: "run-1",
    });
  });

  test("zero sends -> failed no_send", async () => {
    const { sender } = setup(withResults(tr({ query: "x" }, false, "ToolSearch")));
    expect(await sender.send(cmd(), signal)).toEqual({
      status: "failed",
      failure: "no_send",
      runId: "run-1",
    });
  });

  test("two sends -> uncertain", async () => {
    const { sender } = setup(withResults(tr(args), tr(args)));
    expect(await sender.send(cmd(), signal)).toEqual({
      status: "uncertain",
      failure: "uncertain_outcome",
      runId: "run-1",
    });
  });

  test("two sends, one mismatched -> uncertain and flagged", async () => {
    const { sender } = setup(withResults(tr(args), tr({ ...args, message: "other" })));
    expect(await sender.send(cmd(), signal)).toEqual({
      status: "uncertain",
      failure: "uncertain_outcome",
      mismatch: true,
      runId: "run-1",
    });
  });

  test("a timeout after spawn (details.uncertain) -> uncertain, not thrown", async () => {
    const { sender } = setup({
      run: async () => {
        throw new JobError({
          kind: "timeout",
          message: "claude run failed (timeout)",
          details: { uncertain: true },
        });
      },
    });
    expect(await sender.send(cmd(), signal)).toEqual({
      status: "uncertain",
      failure: "uncertain_outcome",
      runId: "run-1",
    });
  });

  test("a quota error before spawn is rethrown", async () => {
    const quota = new JobError({ kind: "quota_exhausted", message: "quota level stop" });
    const { sender } = setup({
      run: async () => {
        throw quota;
      },
    });
    await expect(sender.send(cmd(), signal)).rejects.toBe(quota);
  });

  test("a non-JobError is rethrown", async () => {
    const boom = new TypeError("boom");
    const { sender } = setup({
      run: async () => {
        throw boom;
      },
    });
    await expect(sender.send(cmd(), signal)).rejects.toBe(boom);
  });

  test("no run id when no new run row was recorded for the job", async () => {
    const { sender } = setup({ runIds: ["run-0", "run-0"] });
    expect(await sender.send(cmd(), signal)).toEqual({ status: "sent_unverified" });
  });

  test("no content in the result", async () => {
    const { sender } = setup(withResults(tr({ ...args, message: "changed" })));
    const r = await sender.send(cmd(), signal);
    expect(JSON.stringify(r)).not.toContain("SYNTH-APPROVED");
    expect(JSON.stringify(r)).not.toContain("changed");
  });
});

const msg = (over: Partial<SourceMessage> = {}): SourceMessage => {
  const m = {
    conversationId: "C0SYNTHCHN1",
    conversationType: "channel" as const,
    ts: "1793873000.000100",
    senderId: SELF,
    text: TEXT,
    sentAt: "2026-11-06T10:00:00.000Z",
    ...over,
  };
  return { externalId: `${m.conversationId}:${m.ts}`, ...m } as SourceMessage;
};

const pages = (messages: SourceMessage[], complete = true): CollectResult => ({
  pages: [{ messages, rejected: 0 }],
  searches: 1,
  complete,
});

describe("SlackSender.findSent", () => {
  const SINCE = "1793873000.000000";

  test("true on an exact match; collect is an incremental 2-page search from floor(since) - 1", async () => {
    const { sender, collects, seen } = setup({ collect: async () => pages([msg()]) });
    expect(await sender.findSent(cmd(), SINCE)).toBe(true);
    expect(collects).toEqual([{ afterTs: "1793872999", maxPages: 2 }]);
    expect(seen).toHaveLength(0); // never runs a send
  });

  test("whitespace differences are normalised", async () => {
    const { sender } = setup({
      collect: async () => pages([msg({ text: `\n SYNTH-APPROVED-TEXT:   deploy\nis done ` })]),
    });
    expect(await sender.findSent(cmd(), SINCE)).toBe(true);
  });

  test("false on a different text", async () => {
    const { sender } = setup({ collect: async () => pages([msg({ text: `${TEXT} more` })]) });
    expect(await sender.findSent(cmd(), SINCE)).toBe(false);
  });

  test("false on an earlier ts", async () => {
    const { sender } = setup({ collect: async () => pages([msg({ ts: "1793872999.900000" })]) });
    expect(await sender.findSent(cmd(), SINCE)).toBe(false);
  });

  test("false on another conversation or another sender", async () => {
    const { sender } = setup({
      collect: async () =>
        pages([msg({ conversationId: "C0SYNTHOTHR" }), msg({ senderId: "U0SYNTH0001" })]),
    });
    expect(await sender.findSent(cmd(), SINCE)).toBe(false);
  });

  test("a match on the second page counts", async () => {
    const { sender } = setup({
      collect: async () => ({
        pages: [
          { messages: [msg({ text: "other" })], rejected: 0, nextCursor: "c1" },
          { messages: [msg()], rejected: 0 },
        ],
        searches: 2,
        complete: true,
      }),
    });
    expect(await sender.findSent(cmd(), SINCE)).toBe(true);
  });

  test("null when not found and the search was incomplete", async () => {
    const { sender } = setup({ collect: async () => pages([msg({ text: "other" })], false) });
    expect(await sender.findSent(cmd(), SINCE)).toBeNull();
  });

  test("null on a search failure", async () => {
    const { sender } = setup({
      collect: async () => {
        throw new JobError({ kind: "provider_error", message: "slack search returned an error" });
      },
    });
    expect(await sender.findSent(cmd(), SINCE)).toBeNull();
  });

  test("null without searching when the self id is unset", async () => {
    const { sender, collects } = setup({ self: null, collect: async () => pages([msg()]) });
    expect(await sender.findSent(cmd(), SINCE)).toBeNull();
    expect(collects).toHaveLength(0);
  });
});

describe("container wiring", () => {
  test("Container.messageSink is the SlackSender over the orchestrator and the self id setting", async () => {
    const c = createContainer(loadConfig({ SYNAPSE_DB_PATH: ":memory:" }), {
      run: async () => "Linger=yes",
      provider: {
        execute: async () => {
          throw new Error("fake provider must not execute");
        },
        getHealth: async () => ({ status: "ok", version: "fake" }),
      },
    });
    try {
      expect(c.messageSink).toBeInstanceOf(SlackSender);
      // no self id configured -> cannot check, and nothing runs
      expect(await c.messageSink.findSent(cmd(), "1793873000.000000")).toBeNull();
    } finally {
      c.sqlite.close();
    }
  });
});
