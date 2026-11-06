"use client";

import type { BackupEntry, RuntimeView } from "@synapse/contracts";
import type { OpsSettingsDto, SettingsDto } from "../../../lib/api";
import { formatBytes, relMinutes } from "../../../lib/format";
import { Card } from "../ui/Card";
import { Switch } from "../ui/Switch";

type OpsKey = keyof OpsSettingsDto;

const NUMBERS: { key: OpsKey; label: string; min: number; max: number }[] = [
  { key: "ops.backup.hour", label: "Backup hour (local, 0-23)", min: 0, max: 23 },
  { key: "ops.backup.keep", label: "Backups to keep", min: 1, max: 60 },
  { key: "ops.disk.warnFreeGiB", label: "Warn below free space (GiB)", min: 1, max: 100 },
  { key: "retention.jobsDays", label: "Keep finished jobs (days)", min: 7, max: 365 },
  { key: "retention.notificationsDays", label: "Keep read notifications (days)", min: 7, max: 365 },
  { key: "retention.claudeRunsDays", label: "Keep Claude run detail (days)", min: 14, max: 730 },
  { key: "retention.auditDays", label: "Keep audit entries (days)", min: 90, max: 3650 },
];

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="syn-kv">
      <span className="syn-kv-label">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export interface RuntimePanelProps {
  runtime: RuntimeView | null;
  backups: BackupEntry[];
  settings: SettingsDto | null;
  now: Date | null;
  onBackupNow: () => void;
  backupPending: boolean;
  onSetting: (key: OpsKey, value: boolean | number) => void;
  /** Bumped when a save is rejected, so the inputs drop the rejected text and show the stored value. */
  resetKey?: number;
}

/** Operational numbers, backups, retention and the R7 settings. Values come from the API as is. */
export function RuntimePanel({
  runtime,
  backups,
  settings,
  now,
  onBackupNow,
  backupPending,
  onSetting,
  resetKey = 0,
}: RuntimePanelProps) {
  const r = runtime;
  return (
    <Card className="syn-runtime">
      <div className="syn-card-head">
        <h3>Runtime</h3>
      </div>
      {r === null ? (
        <p className="syn-empty">Runtime unavailable.</p>
      ) : (
        <>
          <Row label="Uptime">{uptime(r.uptimeSeconds)}</Row>
          <Row label="Version">{r.version ?? "unknown"}</Row>
          <Row label="Memory">{formatBytes(r.memoryRssBytes)}</Row>
          <Row label="Database">
            {formatBytes(r.dbBytes)} + WAL {formatBytes(r.walBytes)}
          </Row>
          <Row label="Free space">
            {r.dataDirFreeBytes === null ? "unknown" : formatBytes(r.dataDirFreeBytes)}
          </Row>
          <Row label="Queue">
            {r.queue.pending} pending · {r.queue.running} running · {r.queue.retry} retrying ·{" "}
            {r.queue.needsAttention} need attention
            {r.queue.oldestPendingAgeSeconds === null
              ? ""
              : ` · oldest waiting ${uptime(r.queue.oldestPendingAgeSeconds)}`}
          </Row>
          <Row label="Last backup">
            {r.lastBackup
              ? `${r.lastBackup.name}${now !== null ? ` · ${relMinutes(r.lastBackup.createdAt, now)}` : ""}`
              : "none yet"}
          </Row>
          <Row label="Retention">
            {r.retention === null ? (
              "Retention has not run yet"
            ) : (
              <span className="syn-retention">
                {r.retention.date}: {r.retention.jobs} jobs, {r.retention.notifications}{" "}
                notifications, {r.retention.events} events, {r.retention.audit} audit,{" "}
                {r.retention.claudeRunsCompacted} runs compacted · check {r.retention.quickCheck}
              </span>
            )}
          </Row>
        </>
      )}
      <div className="syn-card-head">
        <h3>Backups</h3>
        <button type="button" className="syn-btn" disabled={backupPending} onClick={onBackupNow}>
          Back up now
        </button>
      </div>
      {r?.lastBackupAttempt?.ok === false ? (
        <p className="syn-runtime-error" role="alert">
          {`The last backup failed (${r.lastBackupAttempt.code ?? "unexpected"}). See the jobs list.`}
        </p>
      ) : null}
      {backups.length === 0 ? (
        <p className="syn-empty">No backups yet</p>
      ) : (
        <ul className="syn-backups">
          {backups.map((b) => (
            <li key={b.name} className="syn-kv">
              <span>{b.name}</span>
              <span className="syn-kv-label">{formatBytes(b.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {settings === null ? null : (
        <>
          <div className="syn-card-head">
            <h3>Operations settings</h3>
          </div>
          <div className="syn-kv">
            <Switch
              checked={settings["ops.backup.enabled"]}
              onChange={(next) => onSetting("ops.backup.enabled", next)}
              label="Daily backup"
            />
          </div>
          {NUMBERS.map((n) => (
            <div key={n.key} className="syn-kv">
              <label htmlFor={`syn-set-${n.key}`} className="syn-kv-label">
                {n.label}
              </label>
              <input
                key={`${settings[n.key]}-${resetKey}`}
                id={`syn-set-${n.key}`}
                type="number"
                min={n.min}
                max={n.max}
                defaultValue={settings[n.key] as number}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (e.target.value !== "" && v !== settings[n.key]) onSetting(n.key, v);
                }}
              />
            </div>
          ))}
        </>
      )}
    </Card>
  );
}
