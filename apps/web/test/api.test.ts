import { expect, test } from "bun:test";
import { decideApproval, getHealth, getJobs } from "../lib/api";

type Call = { url: string; init?: RequestInit };

function fake(status: number, body: unknown): { calls: Call[]; impl: typeof fetch } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}

test("decideApproval POSTs the reason as JSON", async () => {
  const { calls, impl } = fake(200, { id: "a1", status: "rejected" });
  const result = await decideApproval("a1", "reject", "no", impl);
  expect(result.id).toBe("a1");
  expect(calls[0]?.url).toBe("/api/approvals/a1/reject");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ reason: "no" });
});

test("non-2xx throws with status and error field", async () => {
  const { impl } = fake(409, { error: "invalid transition" });
  await expect(decideApproval("a1", "approve", undefined, impl)).rejects.toThrow(
    /409.*invalid transition/,
  );
});

test("non-2xx without a JSON body still includes the status", async () => {
  const impl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
  await expect(getJobs(20, impl)).rejects.toThrow(/500/);
});

test("getJobs passes the limit; getHealth reads the report", async () => {
  const jobs = fake(200, []);
  await getJobs(20, jobs.impl);
  expect(jobs.calls[0]?.url).toBe("/api/jobs?limit=20");
  const health = fake(200, { status: "ok", checks: {} });
  expect((await getHealth(health.impl)).status).toBe("ok");
  expect(health.calls[0]?.url).toBe("/health/ready");
});
