---
name: ship
description: Ship a verified change to production without a lock, alongside other workers. Covers verifying on your branch, fast-forward pushes to the production branch (then syncing the integration branch), watching the CI deploy, probing the live build, smoke testing, and fix-forward or revert on failure.
---

# Ship a change

Fill in the project specifics in the project's CLAUDE.md (Deploy section). This skill uses:

| Placeholder | Meaning | Source farm |
|---|---|---|
| `PROD` | production branch; a push deploys it | `main` |
| `SYNC` | branch kept equal to `PROD` (or none) | `staging` |
| `WORKFLOW` | CI workflow file that deploys `PROD` | `deploy-cloudflare.yml` |
| `PROBE` | URL whose response changes when a new build is live | `https://<site>/<base>/_app/version.json` |

Many workers ship at the same time and never wait on each other: there is no ship lock. Pushes are fast-forward only, so every deploy run includes all earlier commits.

## Database changes: never ship one without approval

A database change is any write to a production datastore (CLAUDE.md lists them). Pushing code never authorizes one. Before any database change, stop and report four things to the manager: the exact command, the target, the impact, and a rollback plan. Run it only after {{OWNER}} approves, by re-running the exact command prefixed with `OMP_DB_APPROVED=1`. If the code you are shipping depends on a database change that isn't approved yet, don't ship it.

## 1. Verify on your branch

Do all of the heavy verification on your branch first:

1. **Rebase on `origin/PROD`.** Run `git fetch origin && git rebase origin/PROD`, and note the base you verified on: `BASE=$(git rev-parse origin/PROD)`.
2. **Typecheck is clean** (CLAUDE.md's Verify section).
3. **The test suite passes.** Every failure is real; never ship on a rerun.
4. **Local browser smoke test for UI changes.** Load the changed pages in a real browser, exercise the change, and confirm there are no console errors.
5. **Record the `PROBE` value** for every affected deployable, to compare after the deploy.

**CPU contention.** Several workers share the machine. Run typecheck and tests one after the other, never at the same time.

If anything fails, fix it before going further. Never push red.

## 2. Merge into `PROD` (fast-forward only), then sync `SYNC`

```sh
git fetch origin && git rebase origin/PROD
git log --oneline $BASE..origin/PROD     # commits the rebase brought in since you verified
git push origin HEAD:PROD
```

- **New commits came in.** If that log is non-empty, run a quick targeted check before pushing: the tests for what you touched and what the incoming commits touched, plus typecheck if either side changed types. If the rebase hit conflicts, resolve them and redo section 1.
- **Rejected as non-fast-forward.** Someone merged in between. Fetch, rebase, run the same quick targeted check if new commits came in, and push again. Loop until the push lands. Never force-push, and never use `--force-with-lease` on `PROD` or `SYNC`.
- **Sync `SYNC` to `PROD`** (skip if the project has no such branch) once your push has landed:

  ```sh
  SHA=$(git rev-parse HEAD)
  git fetch origin && git push origin origin/PROD:SYNC \
    || { git fetch origin && git merge-base --is-ancestor $SHA origin/SYNC && echo "SYNC already contains $SHA"; }
  ```

  A rejection is success if `SYNC` already contains your commit: a later shipper synced it past yours. If it doesn't and the push is still rejected, check `git log origin/PROD..origin/SYNC` and report the divergence instead of forcing.

## 3. Deploy

Set the CI workflow's concurrency to `cancel-in-progress: false` so an in-flight deploy always finishes; a newer push replaces only the pending run, and that run includes your commit.

1. **Find the run that deploys your commit.** `gh run list --workflow WORKFLOW --branch PROD --limit 5 --json databaseId,headSha,status,conclusion`. Your commit counts as deployed when a successful run's head SHA contains it (`git merge-base --is-ancestor <your-sha> <run-headSha>`). Never re-push or run `workflow_dispatch` just to retrigger a deploy.
2. **Watch it.** `gh run watch <run-id> --exit-status` (as a background command, give it a long timeout). On failure: `gh run view <run-id> --log-failed`.
3. **Probe.** Fetch `PROBE` again with a cache-busting query (`?t=<now>`). It must change to a newer build. If it didn't, the deploy did not land: investigate before reporting success.
4. **Prod smoke test for UI changes.** Load the changed pages live, hard-reloaded, and confirm the change works with no console errors.

## 4. Failure handling

- **Fix forward fast** when the cause is obvious and small; ship the fix as a new change (sections 1–3).
- **Otherwise revert.** `git revert <bad-commit>...` creates new commits and never rewrites history. Verify, ship it the same way, and probe again.
- Never leave prod broken while you investigate. Revert first and investigate on your branch.
- **CI outage** (every run fails before building, e.g. billing): still do sections 1–2, report "deploy pending <cause>", never retrigger or deploy by hand unless the manager approves a manual fallback. Each owner verifies their own change on the next successful deploy.

## 5. Report

- The shipped commit hash(es) and the push results.
- The deploy run id and its result.
- The before and after `PROBE` values.
- The smoke test results, local and prod.
- Anything you fixed forward or reverted, and anything you rebased onto at push time plus the targeted check you ran for it.
