# Synapse

A local-first, single-user Engineering Ops Manager. It runs on your Linux machine and sits over Slack, Jira, Git repositories and Claude Code: it collects messages and issues, surfaces what needs attention, tracks commitments and runs controlled engineering work, with you approving every external action.

The web app is at **http://127.0.0.1:7401** and the API at **http://127.0.0.1:7400**. Both bind to localhost only.

For how it works, start with [`CLAUDE.md`](CLAUDE.md) and [`docs/architecture/system-architecture.md`](docs/architecture/system-architecture.md).

## Requirements

- Linux with systemd (user services).
- [Bun](https://bun.sh) 1.4.4 or newer. The system Node is never used.
- The Claude Code CLI (`claude`), logged in with your claude.ai account. Slack and Jira are reached through its connectors.
- For engineering develop runs: `bubblewrap` and `socat` (`sudo apt install bubblewrap socat`). See ADR-040.

Check the environment (read-only):

```bash
bun scripts/setup/check-env.ts
```

## First-time setup

```bash
git clone https://github.com/ayush-eubrics01/synapse.git
cd synapse
bun install
bun run --cwd apps/web build
```

Install and start the background services:

```bash
bun scripts/setup/install-services.ts      # writes ~/.config/systemd/user/synapse-{api,web}.service
systemctl --user daemon-reload
systemctl --user enable --now synapse-api synapse-web
loginctl enable-linger "$USER"             # keep them running after you log out
```

Then open http://127.0.0.1:7401.

## Everyday use

The services start at boot and keep running, so normally there is nothing to start. Open http://127.0.0.1:7401.

```bash
bun scripts/setup/service-status.ts                 # summary: active/enabled, linger, API health
systemctl --user status synapse-api synapse-web     # detailed status
systemctl --user restart synapse-api synapse-web    # restart both
systemctl --user stop synapse-api synapse-web       # stop both
systemctl --user start synapse-api synapse-web      # start both
journalctl --user -u synapse-api -f                 # follow the API logs
journalctl --user -u synapse-web -f                 # follow the web logs
```

### After pulling new code

```bash
bun install
bun run --cwd apps/web build
systemctl --user restart synapse-api synapse-web
```

Database migrations apply automatically when the API starts. If an engineering task is running, wait for it to finish first (`curl -s 127.0.0.1:7400/api/engineering/lock` shows `{"held":false}` when none is).

After installing or removing Claude Code plugins, restart the API too: the plugin list is read once at startup.

## Running it by hand (development)

Stop the services first, because they use the same ports:

```bash
systemctl --user stop synapse-api synapse-web
bun run dev        # API on 7400 and web on 7401 in one terminal; Ctrl+C stops both
```

Or run one side on its own:

```bash
bun run --cwd apps/api dev     # API only
bun run --cwd apps/web dev     # web only
```

Bring the services back afterwards with `systemctl --user start synapse-api synapse-web`.

Run the checks before committing:

```bash
bun run check      # typecheck + lint + tests
```

## Data and backups

- Database: `~/.local/share/synapse/synapse.db` (or `$XDG_DATA_HOME/synapse/`, or `SYNAPSE_DB_PATH`).
- Backups: `<data dir>/backups` (or `SYNAPSE_BACKUP_DIR`). A daily backup runs automatically and the System panel has "Back up now". The newest 7 are kept.
- Restore (replaces the live database, so stop the API first):

  ```bash
  systemctl --user stop synapse-api
  bun scripts/ops/restore.ts <backup-file> --yes
  systemctl --user start synapse-api
  ```

  The previous files are kept as `synapse.db.before-restore-<timestamp>`.

## Ports and settings

| Variable | Default | Meaning |
|---|---|---|
| `SYNAPSE_API_PORT` | 7400 | API port |
| `SYNAPSE_WEB_PORT` | 7401 | Web port shown in the sidebar (the web app itself listens on 7401) |
| `SYNAPSE_DB_PATH` | `~/.local/share/synapse/synapse.db` | Database file |
| `SYNAPSE_BACKUP_DIR` | `<data dir>/backups` | Backup directory (absolute, outside the repository) |

Everything else (Slack, Jira, repositories, away mode, backups, retention) is set in the web app.
