import { z } from "zod";

export interface BackupEntry {
  name: string;
  bytes: number;
  createdAt: string;
}

export type BackupFailureCode =
  | "insufficient_space"
  | "vacuum_failed"
  | "integrity_failed"
  | "name_conflict"
  | "dir_unavailable"
  | "unexpected";

export const retentionSummarySchema = z.strictObject({
  at: z.string(),
  date: z.string(),
  jobs: z.number().int(),
  notifications: z.number().int(),
  events: z.number().int(),
  audit: z.number().int(),
  claudeRunsCompacted: z.number().int(),
  quickCheck: z.enum(["ok", "failed"]),
});
export type RetentionSummary = z.infer<typeof retentionSummarySchema>;

export interface RuntimeView {
  startedAt: string;
  uptimeSeconds: number;
  version: string | null;
  memoryRssBytes: number;
  dbBytes: number;
  walBytes: number;
  dataDirFreeBytes: number | null;
  lastBackup: { name: string; createdAt: string } | null;
  backupCount: number;
  queue: {
    pending: number;
    running: number;
    retry: number;
    needsAttention: number;
    oldestPendingAgeSeconds: number | null;
  };
  retention: RetentionSummary | null;
}
