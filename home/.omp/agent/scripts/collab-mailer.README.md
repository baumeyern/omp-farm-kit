# omp phone control

`collab.autoStart: control` automatically publishes interactive omp sessions through the default encrypted relay. Control links are passwords: never copy them into logs, reports, source files, or screenshots.

## Installed pieces

- `collab-mailer.mjs`: dependency-free Node watcher, polling every 45 seconds.
- `install-collab-mailer.ps1`: registers the current user's **OMP Collab Link Mailer** Windows task at logon. Owns Node directly (no orphan-prone shell wrapper), ignores overlapping instances, has no time limit, and restarts failures after one minute. No stored Windows password or elevated privileges.
- OAuth is loaded from the same dotenv file as the gmail MCP server: `GMAIL_MCP_ENV_FILE`, default `~/.omp/secrets/gmail.env` (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN). The recipient is always the authenticated account's Gmail profile address.
- `~/.omp/agent/collab-mailer/state.json` holds only URL SHA-256 hashes, instance/generation numbers, Gmail message/draft IDs and the send log (times and session ids). It never stores a link or MIME message.

The watcher uses the documented `omp collab list --json` and `omp collab link <instanceId> --json` interfaces. `omp://extensions.md` documents session-start/switch hooks but no relay-room-start/rotation hook, so the CLI watcher also catches rooms replaced after relay failures.

Each email has subject **omp remote control link**, the full-control browser URL, directory, session title, generation and UTC time. Only the interactive main session's control room is eligible: `collab.autoStart: control` also publishes every throwaway omp instance the farm starts for testing; before this filter each of those produced an email. A room is skipped when its host process command line has `--no-session`, `--session-dir`, `-p`/`--print`, or is an `__omp_worker_*` helper. Subagents and helpers inside the main session never host their own room. View-only rooms are ignored. A room disappearing or rotating during discovery does not block other hosts.

Rate caps back this up, using a send log kept in the state file so they survive watcher restarts: at most one email per 30 minutes for the same session id, none within 2 minutes of the previous email, and at most 3 in any hour. A capped link is not dropped; it is sent on a later poll once the cap allows, if it is still current. A draft already committed for a link is always finished.

## Duplicate protection and failures

Sent links and generations are remembered across restarts. Delivery creates a Gmail draft, atomically saves its ID, and sends that same consumable draft. After an uncertain send response, the watcher searches Sent using an opaque delivery reference in the email body, and retries only the original draft ID, never a new email. Gmail rewrites supplied Message-ID headers, so reconciliation intentionally does not depend on them. Search indexing can lag; an already-consumed draft remains pending until Sent catches up. Do not delete unsent watcher drafts manually. Network/auth/relay failures are retried; logs contain only fixed event labels, not raw errors, URLs, titles or credentials.

An OS-owned named-pipe mutex prevents overlapping manual/scheduled invocations and is released automatically on process death. A replacement watcher waits through Task Scheduler's asynchronous stop/start race instead of silently exiting. Malformed delivery state fails closed rather than resending all links. Keep the state file when upgrading or reinstalling.

## Operation

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$HOME/.omp/agent/scripts/install-collab-mailer.ps1"
Start-ScheduledTask -TaskName 'OMP Collab Link Mailer'
Get-ScheduledTask -TaskName 'OMP Collab Link Mailer'
node "$HOME/.omp/agent/scripts/collab-mailer.test.mjs"
```

The watcher can also run with `--once` and optional `--instance <instanceId>` for isolated checks. Never print `omp collab link` output during diagnostics. Check delivery via Gmail metadata, not email bodies in logs.

## Limits

- The PC must be online, awake and logged in, and the omp session must remain open. The logon task does not start omp. Closing omp immediately invalidates its room. AC sleep was set to Never; the display timeout and battery sleep were left unchanged.
- A restart, `/new`, `/resume`, branch/fork, or permanently ended relay room creates a new link. Use the newest email. Typical notification latency is at most one poll plus relay/email latency.
- Guests can prompt, interrupt, inspect/steer subagents and answer replicated select/editor dialogs. Host-machine commands such as `/model`, `/compact`, `/resume`, `/branch`, `!` shell, `$` Python and skills remain host-only (see `omp://collab.md`).
- On installed omp 18.4.12, `ctx.ui.input` is not replicated. The DB guard currently uses confirm then input, so its typed APPROVE step cannot be answered from the phone. It must remain blocked until locally approved; this installation does not change or bypass that guard. A harmless input fixture remained only on the host while a harmless editor fixture was successfully answered from the phone.
- Gmail OAuth permits moving test emails to Trash but not permanent deletion. Both test-room links were invalidated by stopping their hosts; production notification emails are retained.
