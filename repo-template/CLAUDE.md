# <PROJECT> repo brief

<One or two sentences: what this repo is, what it serves, where it runs.>
Read this before touching code. Follow it over habits from other repos.

<!--
How to use this skeleton: keep each section short and factual, and write it for an agent that has
never seen the repo. State rules as rules ("Never X"), give exact commands, and record gotchas
where they bite. Agents read this file on every task, so every line should earn its place.
-->

## Map

- `<dir>/` = <what lives there>. <Which dir owns which deployable / base path.>
- `<shared-lib dir>` = shared code; import it as `<alias>`. Put shared logic here; don't copy it.
- `<services dir>/`: <each service, how it is deployed>.
- `<migrations dir>/`: SQL migrations. <Numbering and idempotency rules.> **Writing a migration
  file is fine. Applying one is a database change** (see below).

## Deploy

- Production is `<PROD branch>`. A push to it triggers `<.github/workflows/WORKFLOW.yml>`, which
  <builds what> and deploys <where>.
  - Gotchas: <size limits, odd hostnames, manual-only services>.
- `<SYNC branch>`: <purpose, or "no live environment; keep it identical to PROD">.
- Deploy check: `curl <PROBE URL>` (e.g. a build-stamped `version.json`). The value changes when a
  new build is live.
- Ship by following the omp `ship` skill:
  1. Rebase on `origin/<PROD>`.
  2. Run `<typecheck>` and the tests. Add a smoke run for UI changes.
  3. Push `<PROD>`, then `<SYNC>`. Both must be fast-forward.
  4. Watch the deploy workflow.
  5. Probe `<PROBE>` for every affected deployable.

## Verify

- Typecheck: `<command>`.
- Tests: `<command>` (<duration>). Prefer targeted paths: `<command> <paths>`.
  - <Known deterministic/seeded suites: a failure there is real; never rerun hoping for a pass.>
- Local dev: `<command>`; served at `<URL>`.

## Workstation

- Install with `<install command>`. <Lockfile caveats.>
- Farm worktrees live in `~/.omp/wt/<Name>` (branch `w/<Name>`), created by
  `farm-add-worker.mjs`. Each has a `node_modules` **junction** (Windows) or symlink
  (macOS/Linux) to the main checkout's `node_modules`, so workers share one install:
  - Never install into it.
  - Never recurse-delete it (`rm -rf`, `Remove-Item -Recurse`): that deletes the main checkout's
    packages. Unlink it first (`cmd /c rmdir node_modules` on Windows, `rm node_modules` without
    `-r` elsewhere), or retire the worker with `farm-add-worker.mjs --remove <Name>`.
  - Tool caches that write into `node_modules/.cache` or `.vite` must be pointed at a per-checkout
    dir, or checkouts will clobber each other.
- Windows + Git Bash: prefix `cmd.exe` calls with `MSYS_NO_PATHCONV=1`, otherwise `/c`-style
  arguments get mangled into paths.
- Work in your own worktree, never the main checkout.

## Conventions

- Commit messages: `<style, e.g. area: lowercase summary>`.
- Owner decisions in code carry a dated comment, e.g. `(owner, YYYY-MM-DD: "...")`. Keep them, and
  update them when you change the decision they record.
- Never touch `<scratch dirs>`. They're gitignored scratch and private data.
- Never print, log or commit secrets: env values, API tokens, database keys. When checking env,
  report only key names and whether each one is present.

## Database changes: approval required

You can commit, push and deploy on your own once verification passes. **The one exception is
a database change.**

A database change is any write to a production datastore:
- <SQL DDL or DML, including applying migrations>
- <hosted-database REST/RPC writes>
- <Redis/KV writes or deletes>
- any script that mutates prod data
- deleting auth users

Reads are fine.

Before **any** database change:
1. Stop, and don't run it.
2. Report to the manager:
   - the exact command
   - the target (project, table or keys)
   - the expected impact (rows or keys affected)
   - the rollback plan
3. Wait for the owner's approval.
4. Once approved, re-run the exact same command prefixed with `OMP_DB_APPROVED=1`.

Never set `OMP_DB_APPROVED=1` on your own, and never reuse an approval for a different command.
