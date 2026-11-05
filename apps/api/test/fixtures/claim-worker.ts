import { existsSync, writeFileSync } from "node:fs";
import { openDatabase } from "@synapse/database";
import { systemClock } from "@synapse/shared";
import { JobQueue } from "../../src/core/jobs/queue";

const [dbPath, workerId] = process.argv.slice(2);
if (!dbPath || !workerId) throw new Error("usage: claim-worker.ts <dbPath> <workerId>");

const { db } = openDatabase(dbPath);
const queue = new JobQueue(db, systemClock);

// start barrier: signal readiness, then wait for the test to create the go-file
writeFileSync(`${dbPath}.ready.${workerId}`, "");
while (!existsSync(`${dbPath}.go`)) await Bun.sleep(1);

const claimed: string[] = [];
for (
  let job = queue.claim(workerId, 60_000, ["t"]);
  job;
  job = queue.claim(workerId, 60_000, ["t"])
) {
  claimed.push(job.id);
  queue.complete(job.id, workerId);
  await Bun.sleep(1); // yield so SQLite lock acquisition is not monopolised by one process
}
console.log(JSON.stringify(claimed));
