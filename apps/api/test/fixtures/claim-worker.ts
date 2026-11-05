import { openDatabase } from "@synapse/database";
import { systemClock } from "@synapse/shared";
import { JobQueue } from "../../src/core/jobs/queue.ts";

const [dbPath, workerId] = process.argv.slice(2);
if (!dbPath || !workerId) throw new Error("usage: claim-worker.ts <dbPath> <workerId>");

const { db } = openDatabase(dbPath);
const queue = new JobQueue(db, systemClock);
const claimed: string[] = [];
for (
  let job = queue.claim(workerId, 60_000, ["t"]);
  job;
  job = queue.claim(workerId, 60_000, ["t"])
) {
  claimed.push(job.id);
  queue.complete(job.id, workerId);
}
console.log(JSON.stringify(claimed));
