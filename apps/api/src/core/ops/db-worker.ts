import { Database } from "bun:sqlite";
import type { DbTask, DbTaskResult } from "./db-task";

declare const self: Worker;

/** A fixed error code such as SQLITE_FULL; anything else (messages, paths) is dropped. */
function causeOf(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{2,32}$/.test(code) ? code : undefined;
}

function singleOk(rows: unknown[], key: string): boolean {
  return rows.length === 1 && (rows[0] as Record<string, unknown>)[key] === "ok";
}

function open(path: string): Database {
  const d = new Database(path, { readonly: true });
  d.run("PRAGMA busy_timeout = 5000");
  return d;
}

function run(task: DbTask): DbTaskResult {
  if (task.op === "quick_check") {
    let d: Database | null = null;
    try {
      d = open(task.dbPath);
      return singleOk(d.query("pragma quick_check").all(), "quick_check")
        ? { ok: true }
        : { ok: false, code: "check_failed" };
    } catch {
      return { ok: false, code: "check_failed" };
    } finally {
      try {
        d?.close();
      } catch {
        // ignore
      }
    }
  }
  let src: Database | null = null;
  try {
    src = open(task.dbPath);
    src.run("VACUUM INTO ?", [task.target]);
  } catch (e) {
    const cause = causeOf(e);
    return cause
      ? { ok: false, code: "vacuum_failed", cause }
      : { ok: false, code: "vacuum_failed" };
  } finally {
    try {
      src?.close();
    } catch {
      // ignore
    }
  }
  let copy: Database | null = null;
  try {
    copy = new Database(task.target, { readonly: true });
    return singleOk(copy.query("pragma integrity_check").all(), "integrity_check")
      ? { ok: true }
      : { ok: false, code: "integrity_failed" };
  } catch {
    return { ok: false, code: "integrity_failed" };
  } finally {
    try {
      copy?.close();
    } catch {
      // ignore
    }
  }
}

self.onmessage = (e: MessageEvent<DbTask>) => {
  let result: DbTaskResult;
  try {
    result = run(e.data);
  } catch {
    result = { ok: false, code: "worker_failed" };
  }
  self.postMessage(result);
};
