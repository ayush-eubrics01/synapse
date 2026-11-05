import type {
  AIUsage,
  ConnectorStatus,
  QuotaSnapshot,
  QuotaWindow,
  RawToolResult,
} from "@synapse/contracts";

export interface ParsedRun {
  connectors: ConnectorStatus[];
  /** Tool names from the system/init event (names only, never content). */
  availableTools: string[];
  toolUses: Map<string, { name: string; input: unknown }>;
  toolResults: RawToolResult[];
  finalText: string;
  quota?: QuotaSnapshot;
  result?: {
    subtype: string;
    isError: boolean;
    numTurns: number;
    durationMs: number;
    usage: AIUsage;
    permissionDenials: string[];
    text: string;
  };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function parseWindow(v: unknown): QuotaWindow | undefined {
  if (!isObj(v)) return undefined;
  const secs = num(v.resetsAt);
  return {
    utilization: num(v.utilization),
    status: str(v.status),
    resetsAt: new Date(secs * 1000).toISOString(),
  };
}

/** Parses `claude -p --output-format stream-json` output. Only real tool_result events count as data. */
export class StreamParser {
  private buffer = "";
  private connectors: ConnectorStatus[] = [];
  private availableTools: string[] = [];
  private toolUses = new Map<string, { name: string; input: unknown }>();
  private toolResults: RawToolResult[] = [];
  private finalText = "";
  private windows?: { fiveHour: QuotaWindow; sevenDay: QuotaWindow };
  private result?: ParsedRun["result"];

  push(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      this.handleLine(this.buffer.slice(0, idx));
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf("\n");
    }
  }

  end(now: Date): ParsedRun {
    if (this.buffer.length > 0) {
      this.handleLine(this.buffer);
      this.buffer = "";
    }
    return {
      connectors: this.connectors,
      availableTools: this.availableTools,
      toolUses: this.toolUses,
      toolResults: this.toolResults,
      finalText: this.finalText,
      quota: this.windows ? { observedAt: now.toISOString(), ...this.windows } : undefined,
      result: this.result,
    };
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: unknown;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObj(ev)) return;
    switch (ev.type) {
      case "system":
        this.onSystem(ev);
        return;
      case "assistant":
        this.onAssistant(ev);
        return;
      case "user":
        this.onUser(ev);
        return;
      case "rate_limit_event":
        this.onRateLimit(ev);
        return;
      case "result":
        this.onResult(ev);
        return;
    }
  }

  private content(ev: Obj): unknown[] {
    const m = ev.message;
    return isObj(m) && Array.isArray(m.content) ? m.content : [];
  }

  private onSystem(ev: Obj): void {
    if (ev.subtype !== "init") return;
    if (Array.isArray(ev.tools)) {
      this.availableTools = ev.tools.filter((t): t is string => typeof t === "string");
    }
    if (Array.isArray(ev.mcp_servers)) {
      this.connectors = ev.mcp_servers.filter(isObj).map((s) => ({
        name: str(s.name),
        status: str(s.status),
      }));
    }
  }

  private onAssistant(ev: Obj): void {
    for (const block of this.content(ev)) {
      if (!isObj(block)) continue;
      if (block.type === "tool_use" && typeof block.id === "string") {
        this.toolUses.set(block.id, { name: str(block.name), input: block.input });
      } else if (block.type === "text" && typeof block.text === "string") {
        this.finalText += block.text;
      }
    }
  }

  private onUser(ev: Obj): void {
    for (const block of this.content(ev)) {
      if (!isObj(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") {
        continue;
      }
      const use = this.toolUses.get(block.tool_use_id);
      let content = "";
      if (typeof block.content === "string") content = block.content;
      else if (Array.isArray(block.content)) {
        content = block.content
          .filter((c): c is Obj => isObj(c) && c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("");
      }
      this.toolResults.push({
        toolUseId: block.tool_use_id,
        toolName: use?.name ?? "unknown",
        input: use?.input,
        isError: block.is_error === true,
        content,
      });
    }
  }

  private onRateLimit(ev: Obj): void {
    const info = ev.rate_limit_info;
    if (!isObj(info) || !isObj(info.unifiedWindows)) return;
    const fiveHour = parseWindow(info.unifiedWindows.five_hour);
    const sevenDay = parseWindow(info.unifiedWindows.seven_day);
    if (fiveHour && sevenDay) this.windows = { fiveHour, sevenDay };
  }

  private onResult(ev: Obj): void {
    const u = isObj(ev.usage) ? ev.usage : {};
    const denials = Array.isArray(ev.permission_denials) ? ev.permission_denials : [];
    this.result = {
      subtype: str(ev.subtype),
      isError: ev.is_error === true,
      numTurns: num(ev.num_turns),
      durationMs: num(ev.duration_ms),
      usage: {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheCreationInputTokens: num(u.cache_creation_input_tokens),
        cacheReadInputTokens: num(u.cache_read_input_tokens),
        costUsdEquivalent: num(ev.total_cost_usd),
      },
      permissionDenials: denials.filter(isObj).map((d) => str(d.tool_name)),
      text: str(ev.result),
    };
  }
}
