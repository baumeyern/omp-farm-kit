# omp-portable-kit

A manager + named-worker "agent farm" for [oh-my-pi](https://github.com/can1357/oh-my-pi) (omp), packaged so it can be rebuilt on another machine with other subscriptions and another project. It carries no secrets, sessions, history or machine paths: everything account- or project-specific is a placeholder.

## Get the kit

This repository is private; the owner adds you as a collaborator first. Then:

```
gh repo clone baumeyern/omp-farm-kit
cd omp-farm-kit
```

and run the installer (details in the setup checklist below):

- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Owner <YourName>`
- macOS/Linux: `bash install.sh --owner <YourName>`

The impeccable engine binary isn't in the repo: the installer downloads it from impeccable's official GitHub release (version pinned in `home/.omp/agent/skills/impeccable/scripts/VERSION`, checked against the release's `.sha256`).

## What's inside

| Path (installed under `~/.omp/`) | What it is |
|---|---|
| `agent/config.yml` | Settings template: model roles, fallback chains, subagent request budget, compaction. Provider/model choices are commented placeholders with the source farm's values beside them. |
| `agent/mcp.json` | MCP servers (Linear, Vercel, Gmail, Google Drive, Mobbin, Figma desktop, Figma remote), all `"enabled": false` until you opt in. |
| `agent/APPEND_SYSTEM.md` | Manager rules appended to the main session's system prompt: delegation loop, roster, routing, compaction, overflow workers, todo conventions, DB-approval protocol, ship flow. |
| `agent/agents/{claude,codex,cursor}-worker.md` | The three worker types: one git worktree each, a worklog, autonomous ship, DB-change stop. |
| `agent/skills/ship` | Lockless concurrent ship flow (generic; fill the placeholders in your CLAUDE.md). |
| `agent/skills/impeccable`, `agent/skills/skill-creator` | Third-party skills (Apache 2.0). The installer downloads the impeccable engine binary. |
| `agent/extensions/agent-monitor` | Farm panel + task board; reads `farm.json` (roster order) and `owner` from `farm.config.json`. `/agent-monitor on|off`. |
| `agent/extensions/db-guard` | Blocks database writes from any agent until the owner approves (`OMP_DB_APPROVED=1`). Self-test: `node agent/extensions/db-guard/test/selftest.ts` (Node 22.6+) or `bun …`. |
| `agent/extensions/usage-bars` | Claude / Codex / Cursor quota bars in the status line. |
| `agent/mcp-servers/gmail` | Local stdio Gmail MCP server (needs `npm ci` once). |
| `agent/scripts/collab-mailer*` | Optional, Windows only: emails you the omp phone-control link (see its README). |
| `farm-add-worker.mjs` | Provision / retire a named worker: worktree + branch, node_modules junction, worklog, `farm.json`, roster line. Rolls back on failure. |
| `compact-worker.mjs` | Compacts a parked worker's session once it passes 200k tokens, with a verified backup. |
| `farm.config.json` | Settings for the two scripts and the panel (below). |
| `wt/_logs`, `wt/_compact`, `secrets/` | Created empty: worklogs, compaction backups, credential files. |

`repo-template/` is not installed: `CLAUDE.md` is a skeleton for the project's agent brief, and `snippets.md` holds the `.gitignore` line, the CI concurrency block and a sample `farm.config.json`.

**Left out on purpose:**
- `docx`/`pdf`/`pptx`/`xlsx` skills are Anthropic-proprietary and tied to a Claude account. They sync automatically when Claude Desktop/Code is signed in (`~/.claude/skills/synced/...`), or see github.com/anthropics/skills. Add that dir under `skills.customDirectories`.
- Account-synced skills (docs, google-workspace, morning, import-memory) are the same story.
- `ui-ux-pro-max` has no license file locally; reinstall it from its upstream if you want it.
- Project skills (`feedback-triage`, `yc-*`) are specific to the source project. `ship` was generalised instead.
- `farm-rename.mjs` was a one-off migration of old worker names, tied to one saved session.
- No sessions, `agent.db`, OAuth tokens, worklogs, `models.db` or caches.

## Setup checklist

1. **Install the prerequisites.** Node 20+, Git (on Windows, Git for Windows for Git Bash), the GitHub CLI (`gh auth login`), and omp. Optional: Playwright, ffmpeg and Blender.
2. **Run the installer.** It never overwrites a changed file unless forced, and it backs up anything it replaces to `~/.omp/_kit-backup/<timestamp>/`.
   - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Owner <YourName>` (`-Force` to replace existing files).
   - macOS/Linux: `bash install.sh --owner <YourName>` (`--force` to replace existing files).
   - To rehearse first, set `OMP_KIT_HOME=<temp dir>`, or pass `-TargetHome` / `--home`.
3. **Log in to each provider** you pay for: `omp login anthropic`, `omp login openai-codex`, `omp login cursor`, etc. Then check `omp usage` and `omp models <provider>`.
4. **Fill in the placeholders:**
   - `agent/config.yml`: `modelRoles.default` and `retry.fallbackChains`, for providers you actually have. Order chains so a whole farm can't drain a paid pool.
   - `agent/agents/*-worker.md`: the `model:` lines. Delete worker types you have no subscription for.
   - `agent/APPEND_SYSTEM.md`: the `<FILL: …>` lines (routing, datastores, concurrent build limit).
   - `farm.config.json` (keys below): at least `repo`.
5. **Set up MCP auth.** Flip `"enabled": true` for each server you use, then run `/mcp` in omp.
   - **linear, vercel, mobbin:** OAuth in the browser on first use, or `/mcp reauth <name>`. Tokens are stored per profile in omp's `agent.db`.
   - **gmail:** run `npm ci` in `agent/mcp-servers/gmail`. Create a Google Cloud OAuth client (Desktop app) with the Gmail API enabled and mint a refresh token. Then write `GMAIL_CLIENT_ID=…`, `GMAIL_CLIENT_SECRET=…` and `GMAIL_REFRESH_TOKEN=…` into `~/.omp/secrets/gmail.env`.
   - **google-drive:** set the env vars `GOOGLE_WORKSPACE_MCP_CLIENT_ID` and `GOOGLE_WORKSPACE_MCP_CLIENT_SECRET` (an OAuth client with redirect `http://localhost:3334/callback`), then authorise via `/mcp`.
   - **figma-desktop:** in the Figma desktop app, press Ctrl/⌘+K and tick **"Enable desktop MCP server"** (it listens on `127.0.0.1:3845`). No OAuth. It has a daily rate limit per Figma account, so share one cache between workers.
   - **figma** (remote): Figma only allows listed clients. On the source machine it worked through Claude Code's Figma plugin, not omp. Leave it disabled unless omp is listed for your account.
6. **Recreate secrets outside every repo.** Put MCP credentials in `~/.omp/secrets/` and project env in the project's untracked `.env*` files or CI secrets. Never commit them, paste them into chat, or print them. Agents report only key names and whether each one is present.
7. **Set up the project.**
   - Clone it (the "main checkout") and install its dependencies there once. Worker worktrees share that `node_modules` through a junction.
   - Write its `CLAUDE.md` from `repo-template/CLAUDE.md`.
   - Add the snippets from `repo-template/snippets.md`.
   - Set `repo` in `farm.config.json`.
8. **Add workers:** `node ~/.omp/farm-add-worker.mjs <Name> claude --role "infra, deploys"`, and likewise with `codex` or `cursor`. Remove one with `node ~/.omp/farm-add-worker.mjs --remove <Name>`.
9. **Run the first manager session.**
   - Start `omp` in the main checkout and check that the agent-monitor panel lists the workers.
   - Give the manager a task. It spawns each worker once (task name = worker name) and talks to it afterwards with `write agent://<Name>`.
   - After each worker result it runs `compact-worker.mjs <Name>` in the background.

### farm.config.json

| Key | Default | Meaning |
|---|---|---|
| `owner` | `Owner` | Your name: the panel's "Needs <owner>" phase. The installer fills it in. |
| `repo` | (required) | The main checkout that worker worktrees branch from. |
| `worktreeRoot` | `~/.omp/wt` | Where worktrees and `_logs` live. |
| `baseRef` | `origin/main` | New worker branches start here. The remote name is taken from it. |
| `upstreamRef` | = `baseRef` | Upstream for `w/<Name>` branches; `""` sets none. The source farm used `origin/staging`. |
| `mergedRefs` | base + upstream | `--remove` deletes a branch only if it is merged into one of these. |
| `linkNodeModules` | `true` | Junction each worktree's `node_modules` to the main checkout's. |
| `setupCommands` | `[]` | Commands run in each new worktree, as argv arrays (`"node"` = the current Node). The source farm ran SvelteKit's `svelte-kit sync`. |
| `compactModel` | `anthropic/claude-opus-5-5` | Model a compacted worker must be resumed on. |
| `compactNoFallbackProviders` | `anthropic`, `openai-codex` | Fallback chains emptied during compaction. |
| `compactDisabledProviders` | `cursor` | Providers disabled during compaction (no paid fallback). |

Set `OMP_FARM_CONFIG` to use another file.

### Example roster

`farm-add-worker.mjs` writes the roster into `APPEND_SYSTEM.md` under the `- Roster.` line, like this:

```
  - These two are agent `claude-worker`:
    - Ada (extra, added 2026-01-05): infra, deploys, repo docs
    - Brook (extra, added 2026-01-05): data and integrations
  - This one is agent `codex-worker`:
    - Tess (extra, added 2026-01-05): front-end and design work only
```

Delete `(extra, …)` from a line to make that worker part of the default farm; `--remove` then needs `--core`.

## Cautions

- **Quota is per account.** All workers on one subscription share its 5-hour and weekly limits, and fallback chains move load onto other accounts, including paid pools. Check `omp usage` before adding workers, and keep paid providers last in the chains.
- **Use one farm per repo.** Don't point two machines' farms at the same remote with the same worker names: branches `w/<Name>`, lockless pushes and worklogs assume a single owner.
- **Junction safety.** A worktree's `node_modules` is a link to the main checkout's packages. Never `rm -rf` or `Remove-Item -Recurse` a worktree or its `node_modules`: on Windows that deletes the real packages. Retire workers with `farm-add-worker.mjs --remove`, which unlinks first. By hand, run `cmd /c rmdir node_modules` (Windows) or `rm node_modules` (no `-r`).
- **Approval mode.** The config runs tools in `yolo` mode with db-guard as the hard gate. Keep db-guard installed, or use a stricter approval mode.
- **Request budget.** `task.softRequestBudget: 600` gives long worker runs room (a notice at 600, a stop at 900). Follow-up turns sent with `write agent://` are unbudgeted.
