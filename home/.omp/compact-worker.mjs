#!/usr/bin/env node
// compact-worker.mjs: compact one parked farm worker's session once, so its next task starts small.
//
//   node ~/.omp/compact-worker.mjs <Name> [--min-tokens 200000] [--wait-min 15] [--session <file.jsonl>]
//
// Settings (optional) come from ~/.omp/farm.config.json (override the path with OMP_FARM_CONFIG):
//   compactModel                 model the worker runs on and that compacts it (default
//                                anthropic/claude-opus-5-5); a worker resumed on another model is refused
//   compactNoFallbackProviders   providers whose retry fallback chains are emptied for the run
//                                (default ["anthropic", "openai-codex"])
//   compactDisabledProviders     providers disabled for the run, e.g. a paid fallback (default ["cursor"])
//   worktreeRoot                 default ~/.omp/wt
// OMP_BIN overrides the omp binary (default: %LOCALAPPDATA%/omp/omp.exe on Windows if present, else `omp`).
//
// Steps:
//   1. Find the worker's session file: the newest sessions/<cwd>/<main-session>/<Name>.jsonl
//      (dirs starting with "_" are skipped), unless --session is given.
//   2. Wait until the worker is parked: the last entry is a `session_exit` (written when the session
//      is disposed) and the file stays unchanged for 5 s. If that takes longer than --wait-min, exit 2
//      without touching anything.
//   3. Skip (exit 0, untouched) if the context the next call would load is under --min-tokens. That is
//      the last assistant call's totalTokens, or tokensAfter if a compaction came after it.
//   4. Back up the file to <worktreeRoot>/_compact/backup/<Name>.jsonl.<ts>.bak, check it by
//      sha256, and keep only the newest 2 backups per worker.
//   5. Re-check that the worker is parked and the file is unchanged since the backup, then run omp's own
//      compaction over RPC:
//        omp --mode rpc --no-ui --resume <file> --config <overlay> --no-extensions --no-lsp --no-skills
//            --no-rules --no-title --model <compactModel> --cwd <worktree>
//      The overlay disables compactDisabledProviders (no paid fallback), empties the fallback chains
//      of compactNoFallbackProviders, and turns off collab autostart, cache warming and idle
//      compaction. If a disabled provider shows up anyway, it aborts before compacting.
//   6. Verify append-only: the file's first <backup size> bytes equal the backup, and the new lines are
//      exactly one `compaction` entry plus `session_exit`. Print before -> after and the backup path.
//
// Live sessions are safe by construction: omp holds a per-process lease on a session file it writes, so if
// the worker is live in another process, this run's writes go to a sibling file and the original is left
// alone. That case is reported as an error (exit 1). Don't message the worker while this runs (about a minute).
// Exit codes: 0 compacted or skipped, 1 error, 2 timed out waiting for park.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const HOME = os.homedir().replaceAll("\\", "/");
const CFG = loadConfig();
const SESSIONS = `${HOME}/.omp/agent/sessions`;
const WT_ROOT = (CFG.worktreeRoot || `${HOME}/.omp/wt`).replaceAll("\\", "/");
const BACKUP_DIR = `${WT_ROOT}/_compact/backup`;
const WIN_OMP = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "omp", "omp.exe") : "";
const OMP_BIN = process.env.OMP_BIN || (WIN_OMP && fs.existsSync(WIN_OMP) ? WIN_OMP : "omp");
const MODEL = CFG.compactModel || "anthropic/claude-opus-5-5";
const MODEL_PROVIDER = MODEL.split("/")[0];
const NO_FALLBACK = CFG.compactNoFallbackProviders ?? ["anthropic", "openai-codex"];
const DISABLED = CFG.compactDisabledProviders ?? ["cursor"];
const KEEP_BACKUPS = 2;
const POLL_MS = 10_000;
const STABLE_MS = 5_000;
const OVERLAY = `collab:
  autoStart: "off"
retry:
  usageAwareFallback: false
  fallbackChains:
${NO_FALLBACK.map((p) => `    ${p}/*: []\n`).join("")}providers:
  cacheWarming: "off"
compaction:
  idleEnabled: false
${DISABLED.length ? `disabledProviders:\n${DISABLED.map((p) => `  - ${p}\n`).join("")}` : ""}`;

// farm.config.json is optional here; a missing file means defaults.
function loadConfig() {
	const file = process.env.OMP_FARM_CONFIG || `${HOME}/.omp/farm.config.json`;
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		console.error(`ERROR: cannot parse ${file}: ${e.message}`);
		process.exit(1);
	}
}

const USAGE = "usage: node compact-worker.mjs <Name> [--min-tokens 200000] [--wait-min 15] [--session <file.jsonl>]";

// ------------------------------------------------------------------ helpers
const log = (msg) => console.log(`[compact-worker ${new Date().toISOString()}] ${msg}`);
function die(msg, code = 1) {
	console.error(`ERROR: ${msg}`);
	process.exit(code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => path.resolve(p).replaceAll("\\", "/").toLowerCase();
const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : String(n));

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
	const opts = { name: undefined, minTokens: 200_000, waitMin: 15, session: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const val = () => {
			const v = argv[++i];
			if (v === undefined) die(`${a} needs a value\n${USAGE}`);
			return v;
		};
		if (a === "--min-tokens") opts.minTokens = Number(val());
		else if (a === "--wait-min") opts.waitMin = Number(val());
		else if (a === "--session") opts.session = val();
		else if (a === "-h" || a === "--help") {
			console.log(USAGE);
			process.exit(0);
		} else if (a.startsWith("-")) die(`unknown flag ${a}\n${USAGE}`);
		else if (!opts.name) opts.name = a;
		else die(`unexpected argument ${a}\n${USAGE}`);
	}
	if (!opts.name || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(opts.name)) die(USAGE);
	if (!Number.isFinite(opts.minTokens) || opts.minTokens < 0) die("--min-tokens must be a non-negative number");
	if (!Number.isFinite(opts.waitMin) || opts.waitMin <= 0) die("--wait-min must be a positive number");
	return opts;
}

// Newest sessions/<cwd>/<main-session>/<Name>.jsonl, skipping "_"-prefixed dirs (archives).
function findSession(name) {
	let best;
	for (const cwdDir of fs.readdirSync(SESSIONS, { withFileTypes: true })) {
		if (!cwdDir.isDirectory() || cwdDir.name.startsWith("_")) continue;
		const cwdPath = `${SESSIONS}/${cwdDir.name}`;
		for (const sessDir of fs.readdirSync(cwdPath, { withFileTypes: true })) {
			if (!sessDir.isDirectory() || sessDir.name.startsWith("_")) continue;
			const file = `${cwdPath}/${sessDir.name}/${name}.jsonl`;
			let st;
			try {
				st = fs.statSync(file);
			} catch {
				continue;
			}
			if (!best || st.mtimeMs > best.mtimeMs) best = { file, mtimeMs: st.mtimeMs };
		}
	}
	return best?.file;
}

function readEntries(file) {
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return { type: "<unparseable>" };
			}
		});
}

function lastEntry(file) {
	const st = fs.statSync(file);
	const len = Math.min(st.size, 256 * 1024);
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, st.size - len);
		const lines = buf.toString("utf8").split("\n").filter((l) => l.trim());
		return JSON.parse(lines.at(-1));
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}

const isExit = (e) => e?.type === "custom" && e.customType === "session_exit";
const fileSig = (file) => {
	const st = fs.statSync(file);
	return `${st.size}:${st.mtimeMs}`;
};

// Parked = disposed: last entry is session_exit and the file is quiet for STABLE_MS.
async function isParked(file) {
	if (!isExit(lastEntry(file))) return false;
	const sig = fileSig(file);
	await sleep(STABLE_MS);
	return fileSig(file) === sig && isExit(lastEntry(file));
}

// Context the next call would load: last assistant usage, or tokensAfter of a later compaction.
function currentTokens(entries) {
	let tokens;
	for (const e of entries) {
		if (e.type === "compaction" && typeof e.tokensAfter === "number") tokens = e.tokensAfter;
		const m = e.type === "message" ? e.message : undefined;
		if (m?.role === "assistant" && m.usage) {
			const u = m.usage;
			const t = u.totalTokens || (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
			if (t > 0) tokens = t;
		}
	}
	return tokens;
}

function backup(name, file) {
	fs.mkdirSync(BACKUP_DIR, { recursive: true });
	const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const bak = `${BACKUP_DIR}/${name}.jsonl.${ts}.bak`;
	fs.copyFileSync(file, bak);
	if (sha256(bak) !== sha256(file)) die(`backup ${bak} does not match ${file}`);
	const mine = fs
		.readdirSync(BACKUP_DIR)
		.filter((f) => f.startsWith(`${name}.jsonl.`) && f.endsWith(".bak"))
		.map((f) => ({ f, mtimeMs: fs.statSync(`${BACKUP_DIR}/${f}`).mtimeMs }))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);
	for (const { f } of mine.slice(KEEP_BACKUPS)) {
		fs.rmSync(`${BACKUP_DIR}/${f}`);
		log(`pruned old backup ${f}`);
	}
	return bak;
}

// ------------------------------------------------------------------ RPC
class Rpc {
	constructor(sessionFile, cwd, overlayFile) {
		const args = ["--mode", "rpc", "--no-ui", "--resume", sessionFile, "--config", overlayFile, "--no-extensions", "--no-lsp", "--no-skills", "--no-rules", "--no-title", "--model", MODEL, "--cwd", cwd];
		this.proc = spawn(OMP_BIN, args, { cwd, env: { ...process.env, PI_NO_TITLE: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		this.waiters = [];
		this.events = [];
		this.stderr = "";
		this.exited = new Promise((resolve) => this.proc.on("exit", (code) => resolve(code)));
		this.proc.stderr.on("data", (d) => {
			this.stderr = (this.stderr + d).slice(-4000);
		});
		readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				return;
			}
			if (frame.type !== "message_update") this.events.push(frame.type);
			this.waiters = this.waiters.filter((w) => !w.match(frame) || (w.resolve(frame), false));
		});
	}
	waitFor(match, timeoutMs, what) {
		return new Promise((resolve, reject) => {
			const w = { match, resolve: (f) => (clearTimeout(t), resolve(f)) };
			const t = setTimeout(() => {
				this.waiters = this.waiters.filter((x) => x !== w);
				reject(new Error(`timed out waiting for ${what}; stderr: ${this.stderr.slice(-500)}`));
			}, timeoutMs);
			this.waiters.push(w);
		});
	}
	async send(cmd, timeoutMs) {
		const p = this.waitFor((f) => f.type === "response" && f.id === cmd.id, timeoutMs, cmd.type);
		this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
		const res = await p;
		if (res.success === false) throw new Error(`${cmd.type} failed: ${res.error}`);
		return res.data;
	}
	async close() {
		this.proc.stdin.end();
		const timer = setTimeout(() => this.proc.kill(), 60_000);
		const code = await this.exited;
		clearTimeout(timer);
		return code;
	}
}

// ------------------------------------------------------------------ main
async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const { name } = opts;
	const file = opts.session ? path.resolve(opts.session).replaceAll("\\", "/") : findSession(name);
	if (!file || !fs.existsSync(file)) die(`no session file found for ${name}`);
	log(`${name}: session ${file}`);

	// 1. wait for park
	const deadline = Date.now() + opts.waitMin * 60_000;
	while (!(await isParked(file))) {
		if (Date.now() > deadline) {
			log(`${name}: not parked after ${opts.waitMin} min; nothing touched`);
			process.exit(2);
		}
		await sleep(POLL_MS);
	}

	// 2. size gate (read-only)
	const tokens = currentTokens(readEntries(file));
	if (tokens === undefined || tokens < opts.minTokens) {
		log(`${name}: SKIP, context ${fmt(tokens ?? "unknown")} tokens < min ${fmt(opts.minTokens)}; nothing touched`);
		return;
	}
	log(`${name}: parked, context ${fmt(tokens)} tokens >= min ${fmt(opts.minTokens)}; compacting`);

	// 3. backup + re-check park right before compacting
	const bak = backup(name, file);
	const bakSize = fs.statSync(bak).size;
	if (fs.statSync(file).size !== bakSize || !isExit(lastEntry(file))) die(`${name} changed or woke up after the backup; not compacting (backup ${bak})`);

	// 4. RPC compact
	const overlay = path.join(os.tmpdir(), `compact-worker-${name}-${process.pid}.yml`);
	fs.writeFileSync(overlay, OVERLAY);
	const wt = `${WT_ROOT}/${name}`;
	const rpc = new Rpc(file, fs.existsSync(wt) ? wt : HOME, overlay);
	let before, after, sessionAfter, rc;
	try {
		await rpc.waitFor((f) => f.type === "ready", 120_000, "ready");
		const s1 = await rpc.send({ id: "s1", type: "get_state" }, 300_000);
		before = s1.contextUsage?.tokens;
		const model = `${s1.model?.provider}/${s1.model?.id}`;
		if (model !== MODEL) throw new Error(`resumed on ${model}, expected ${MODEL}`);
		const models = await rpc.send({ id: "m1", type: "get_available_models" }, 300_000);
		const list = Array.isArray(models) ? models : (models?.models ?? []);
		const providers = new Set(list.map((m) => m.provider));
		if (!providers.has(MODEL_PROVIDER)) throw new Error(`${MODEL_PROVIDER} provider is unavailable; refusing to compact`);
		const leaked = DISABLED.find((p) => providers.has(p));
		if (leaked) throw new Error(`${leaked} provider is still available; refusing to compact`);
		if (!isExit(lastEntry(file)) || fs.statSync(file).size !== bakSize) throw new Error("session changed while starting up");
		await rpc.send({ id: "c1", type: "compact" }, 25 * 60_000);
		const s2 = await rpc.send({ id: "s2", type: "get_state" }, 300_000);
		after = s2.contextUsage?.tokens;
		sessionAfter = s2.sessionFile;
	} catch (err) {
		rc = await rpc.close();
		fs.rmSync(overlay, { force: true });
		die(`${name}: ${err.message} (omp exit ${rc}; backup ${bak})`);
	}
	rc = await rpc.close();
	fs.rmSync(overlay, { force: true });

	// 5. verify append-only
	if (sessionAfter && norm(sessionAfter) !== norm(file)) {
		die(`${name}: omp wrote to a sibling file ${sessionAfter}, so a live process holds ${file}; original untouched (backup ${bak})`);
	}
	const now = fs.readFileSync(file);
	const orig = fs.readFileSync(bak);
	if (now.length < orig.length || !now.subarray(0, orig.length).equals(orig)) {
		die(`${name}: session file was not append-only! Restore from ${bak} after checking.`);
	}
	const tail = now
		.subarray(orig.length)
		.toString("utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
	const comps = tail.filter((e) => e.type === "compaction");
	const foreign = tail.filter((e) => e.type !== "compaction" && !isExit(e));
	if (comps.length !== 1 || foreign.length) {
		die(`${name}: unexpected appended entries [${tail.map((e) => e.customType ?? e.type).join(", ")}]; check ${file} (backup ${bak})`);
	}
	const c = comps[0];
	log(`${name}: DONE (omp exit ${rc}) context ${fmt(before)} -> ${fmt(after)} tokens; entry ${c.id} method ${c.method}, tokensBefore ${fmt(c.tokensBefore)} -> tokensAfter ${fmt(c.tokensAfter)}`);
	log(`${name}: backup ${bak}`);
}

main().catch((err) => die(err.stack ?? String(err)));
