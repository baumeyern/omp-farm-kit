#!/usr/bin/env node
// farm-add-worker.mjs: provision or retire a persistent omp farm worker.
//
//   node farm-add-worker.mjs <Name> <claude|codex|cursor> [--role "text"]
//   node farm-add-worker.mjs --remove <Name> [--core]
//
// Settings come from ~/.omp/farm.config.json (override the path with OMP_FARM_CONFIG). See the
// kit README for every key. Only "repo" is required.
//
// Add:
//   - worktree <worktreeRoot>/<Name> (default ~/.omp/wt/<Name>) on a new branch w/<Name> from
//     <baseRef> (default origin/main), upstream <upstreamRef> (default = baseRef; "" = none)
//   - with linkNodeModules (default true): ONE node_modules junction (a dir symlink on
//     macOS/Linux) at the worktree root -> the main checkout's node_modules. Nested
//     node_modules dirs are not linked; packages resolve upward to the root link.
//   - setupCommands (default none): argv arrays run inside the new worktree, e.g.
//     [["node", "node_modules/@sveltejs/kit/svelte-kit.js", "sync"]]; "node" means this Node.
//   - worklog _logs/<Name>.md, an entry in agent-monitor's farm.json, and a roster line in
//     APPEND_SYSTEM.md marked "(extra, added <date>)"; the first worker of a type with no roster
//     group yet gets a new group after the existing ones (or after the "- Roster." line)
// Any failure rolls back the steps already done.
//
// --remove unlinks every junction/symlink in the worktree FIRST (link only, never the target),
// then `git worktree remove` (no --force: a dirty worktree is refused), deletes the
// branch only if it is merged into one of mergedRefs (default baseRef + upstreamRef), keeps the
// worklog (adds a "retired" entry), and drops the name from farm.json and the roster (and a group
// left empty). Only roster lines marked "(extra" can be removed unless --core is given.
//
// farm.json is read when the agent-monitor extension loads: reload/restart omp to see the change.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir().replaceAll("\\", "/");
const CONFIG_FILE = process.env.OMP_FARM_CONFIG || `${HOME}/.omp/farm.config.json`;
const CFG = loadConfig();
const REPO = CFG.repo.replaceAll("\\", "/");
const MAIN_NM = `${REPO}/node_modules`;
const WT_ROOT = (CFG.worktreeRoot || `${HOME}/.omp/wt`).replaceAll("\\", "/");
const LOG_DIR = `${WT_ROOT}/_logs`;
const AGENT_DIR = `${HOME}/.omp/agent`;
const APPEND = `${AGENT_DIR}/APPEND_SYSTEM.md`;
const FARM_JSON = `${AGENT_DIR}/extensions/agent-monitor/farm.json`;
const BASE_REF = CFG.baseRef || "origin/main";
const REMOTE = BASE_REF.split("/")[0];
const UPSTREAM_REF = CFG.upstreamRef ?? BASE_REF;
const MERGED_REFS = CFG.mergedRefs ?? [...new Set([BASE_REF, UPSTREAM_REF].filter(Boolean))];
const LINK_NM = CFG.linkNodeModules ?? true;
const SETUP_COMMANDS = CFG.setupCommands ?? [];
const TYPES = { claude: "claude-worker", codex: "codex-worker", cursor: "cursor-worker" };
const RESERVED = new Set(["main", "sub", "task", "sonic", "scout", "reviewer", "security-reviewer", ...Object.values(TYPES)]);
const NUM_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

function loadConfig() {
	let cfg;
	try {
		cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
	} catch (e) {
		die(`cannot read ${CONFIG_FILE} (${e.code ?? e.message}). Copy farm.config.example.json there and set "repo".`);
	}
	if (typeof cfg?.repo !== "string" || !cfg.repo.trim()) die(`${CONFIG_FILE}: set "repo" to your project's main checkout`);
	if (cfg.setupCommands !== undefined && !(Array.isArray(cfg.setupCommands) && cfg.setupCommands.every((c) => Array.isArray(c) && c.length && c.every((a) => typeof a === "string")))) {
		die(`${CONFIG_FILE}: "setupCommands" must be an array of argv arrays`);
	}
	if (cfg.mergedRefs !== undefined && !(Array.isArray(cfg.mergedRefs) && cfg.mergedRefs.every((r) => typeof r === "string"))) die(`${CONFIG_FILE}: "mergedRefs" must be an array of refs`);
	return cfg;
}

const USAGE = `usage: node farm-add-worker.mjs <Name> <${Object.keys(TYPES).join("|")}> [--role "text"]
       node farm-add-worker.mjs --remove <Name> [--core]`;

// ------------------------------------------------------------------ helpers
function die(msg) {
	console.error(`ERROR: ${msg}`);
	process.exit(1);
}
function git(args, cwd = REPO) {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function gitOk(args, cwd = REPO) {
	try {
		git(args, cwd);
		return true;
	} catch {
		return false;
	}
}
const exists = (p) => {
	try {
		fs.lstatSync(p);
		return true;
	} catch {
		return false;
	}
};
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function localDate() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const nmCount = () => (LINK_NM ? fs.readdirSync(MAIN_NM).length : 0);

function worktreeAt(dir) {
	return git(["worktree", "list", "--porcelain"])
		.split(/\r?\n\r?\n/)
		.map((block) => Object.fromEntries(block.split(/\r?\n/).map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)])))
		.find((r) => r.worktree && samePath(r.worktree, dir));
}

// Every junction/symlink under root, without descending into any of them.
function findLinks(root) {
	const links = [];
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const p = path.join(dir, name);
			let st;
			try {
				st = fs.lstatSync(p);
			} catch {
				continue;
			}
			if (st.isSymbolicLink()) links.push(p);
			else if (st.isDirectory() && !(dir === root && name === ".git")) stack.push(p);
		}
	}
	return links;
}
// Remove a junction/symlink itself, never its target. On Windows, rmdir without /s on a reparse
// point deletes only the link; elsewhere unlink(2) on a symlink removes only the link.
function unlinkJunction(p) {
	if (process.platform === "win32") {
		const win = path.resolve(p).replace(/\//g, "\\");
		execFileSync("cmd.exe", ["/d", "/s", "/c", `rmdir "${win}"`], { stdio: ["ignore", "pipe", "pipe"], windowsVerbatimArguments: true });
	} else {
		if (!fs.lstatSync(p).isSymbolicLink()) throw new Error(`${p} is not a symlink; refusing to remove it`);
		fs.unlinkSync(p);
	}
	if (exists(p)) throw new Error(`junction ${p} still exists after removal`);
}

// Steps with rollback.
const undo = [];
function step(desc, run) {
	console.log(`- ${desc}`);
	const u = run();
	if (typeof u === "function") undo.push({ desc, u });
}
function rollback(err) {
	console.error(`\nFAILED: ${err.message}\nrolling back:`);
	for (const { desc, u } of undo.reverse()) {
		try {
			u();
			console.error(`  undone: ${desc}`);
		} catch (e) {
			console.error(`  UNDO FAILED (${desc}): ${e.message}`);
		}
	}
	process.exit(1);
}
function rewriteFile(file, next) {
	const before = fs.readFileSync(file, "utf8");
	fs.writeFileSync(file, next);
	return () => fs.writeFileSync(file, before);
}

// ------------------------------------------------------------------ farm.json
function readFarm() {
	const text = fs.readFileSync(FARM_JSON, "utf8");
	const ids = JSON.parse(text).farm;
	if (!Array.isArray(ids)) throw new Error(`${FARM_JSON}: "farm" is not an array`);
	return { text, ids };
}
// Same rules agent-monitor applies (0-32 unique ids); an invalid file shows no farm rows.
function farmText(text, ids) {
	if (ids.length > 32) throw new Error(`farm.json can list at most 32 workers (would be ${ids.length})`);
	if (!ids.every((id) => /^[A-Za-z0-9_-]{1,32}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error("farm.json ids invalid or duplicated");
	const next = text.replace(/("farm"\s*:\s*)\[[^\]]*\]/, (_, key) => `${key}[${ids.map((id) => JSON.stringify(id)).join(", ")}]`);
	if (JSON.stringify(JSON.parse(next).farm) !== JSON.stringify(ids)) throw new Error("farm.json rewrite did not round-trip");
	return next;
}

// ------------------------------------------------------------------ roster (APPEND_SYSTEM.md)
const headerRe = (type) => new RegExp(`^  - (?:These \\w+ are|This one is) agent \`${type}\`:$`);
const header = (type, n) => (n === 1 ? `  - This one is agent \`${type}\`:` : `  - These ${NUM_WORDS[n] ?? n} are agent \`${type}\`:`);
const memberRe = (name) => new RegExp(`^    - ${name}(?=[ :(])`);

// The type's roster group, or null when APPEND_SYSTEM.md has no header for it yet.
function rosterGroup(lines, type) {
	const h = lines.findIndex((l) => headerRe(type).test(l));
	if (h < 0) return null;
	let end = h + 1;
	while (end < lines.length && lines[end].startsWith("    - ")) end++;
	return { h, start: h + 1, end };
}
function rosterFind(lines, name) {
	const i = lines.findIndex((l) => memberRe(name).test(l));
	if (i < 0) return null;
	const type = Object.values(TYPES).find((t) => {
		const g = rosterGroup(lines, t);
		return g && i >= g.start && i < g.end;
	});
	return { i, type, line: lines[i] };
}
function rosterAdd(text, name, type, role, date) {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	let g = rosterGroup(lines, type);
	if (!g) {
		// First worker of this type: open its group after the last existing one, or right after
		// the "- Roster." line when the roster is still empty.
		const groups = Object.values(TYPES).map((t) => rosterGroup(lines, t)).filter(Boolean);
		const anchor = lines.findIndex((l) => /^- Roster\b/.test(l));
		if (!groups.length && anchor < 0) throw new Error(`no roster group and no "- Roster." line found in ${APPEND}`);
		const at = groups.length ? Math.max(...groups.map((x) => x.end)) : anchor + 1;
		lines.splice(at, 0, header(type, 1));
		g = { h: at, start: at + 1, end: at + 1 };
	}
	lines.splice(g.end, 0, `    - ${name} (extra, added ${date}): ${role}`);
	lines[g.h] = header(type, g.end + 1 - g.start);
	return lines.join(eol);
}
function rosterRemove(text, name) {
	const eol = eolOf(text);
	const lines = text.split(/\r?\n/);
	const hit = rosterFind(lines, name);
	if (!hit) return text;
	lines.splice(hit.i, 1);
	const g = rosterGroup(lines, hit.type);
	if (g.end === g.start) lines.splice(g.h, 1);
	else lines[g.h] = header(hit.type, g.end - g.start);
	return lines.join(eol);
}

// ------------------------------------------------------------------ add
function add(name, kind, role) {
	const type = TYPES[kind];
	if (!type) die(`type must be one of ${Object.keys(TYPES).join(", ")}, got "${kind}"\n${USAGE}`);
	const wt = `${WT_ROOT}/${name}`;
	const branch = `w/${name}`;
	const log = `${LOG_DIR}/${name}.md`;
	const date = localDate();

	// Preflight: refuse before touching anything.
	const { ids } = readFarm();
	const appendText = fs.readFileSync(APPEND, "utf8");
	const problems = [];
	if (ids.some((id) => id.toLowerCase() === name.toLowerCase())) problems.push(`${name} is already in farm.json`);
	if (rosterFind(appendText.split(/\r?\n/), name)) problems.push(`${name} is already on the roster in APPEND_SYSTEM.md`);
	if (exists(wt)) problems.push(`${wt} already exists`);
	if (gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) problems.push(`branch ${branch} already exists`);
	if (LINK_NM && !fs.statSync(MAIN_NM, { throwIfNoEntry: false })?.isDirectory()) problems.push(`${MAIN_NM} missing (install the project's dependencies in the main checkout, or set "linkNodeModules": false)`);
	if (ids.length >= 32) problems.push("farm.json already lists 32 workers (agent-monitor's limit)");
	if (problems.length) die(problems.join("\n       "));
	const nmBefore = nmCount();

	console.log(`provisioning ${name} (${type})`);
	try {
		step(`git fetch ${REMOTE}`, () => void git(["fetch", REMOTE, "--quiet"]));
		const base = git(["rev-parse", "--short", BASE_REF]);
		step(`git worktree add ${wt} -b ${branch} ${BASE_REF} (${base})`, () => {
			git(["worktree", "add", "--no-track", "-b", branch, wt, BASE_REF]);
			return () => {
				if (findLinks(wt).length) throw new Error(`refusing to remove ${wt}: it still contains a junction`);
				git(["worktree", "remove", "--force", wt]);
				git(["branch", "-D", branch]);
			};
		});
		if (UPSTREAM_REF) step(`${branch} upstream -> ${UPSTREAM_REF}`, () => void git(["branch", `--set-upstream-to=${UPSTREAM_REF}`, branch]));
		if (LINK_NM) {
			step(`junction ${wt}/node_modules -> ${MAIN_NM}`, () => void fs.symlinkSync(MAIN_NM, `${wt}/node_modules`, "junction"));
			undo.push({ desc: "junction", u: () => exists(`${wt}/node_modules`) && unlinkJunction(`${wt}/node_modules`) });
			step("check the junction lists the main checkout's node_modules", () => {
				const link = `${wt}/node_modules`;
				if (!fs.lstatSync(link).isSymbolicLink()) throw new Error(`${link} is not a junction`);
				if (fs.readdirSync(link).length !== nmBefore) throw new Error(`${link} does not list the main checkout's node_modules`);
			});
		}
		for (const [cmd, ...args] of SETUP_COMMANDS) {
			step(`setup: ${[cmd, ...args].join(" ")}`, () => {
				const bin = cmd === "node" ? process.execPath : cmd;
				execFileSync(bin, args, { cwd: wt, stdio: ["ignore", "pipe", "pipe"], shell: bin !== process.execPath && process.platform === "win32" });
			});
		}
		step(`worklog ${log}`, () => {
			fs.mkdirSync(LOG_DIR, { recursive: true });
			const entry = `## ${date} — provisioned\n- Extra ${type} added by farm-add-worker.mjs: worktree ${wt}, branch ${branch} from ${BASE_REF} @ ${base}${LINK_NM ? ", node_modules junction to the main checkout" : ""}.\n`;
			if (exists(log)) {
				const before = fs.readFileSync(log, "utf8");
				fs.writeFileSync(log, `${before}${before.endsWith("\n") ? "" : "\n"}\n${entry}`);
				return () => fs.writeFileSync(log, before);
			}
			fs.writeFileSync(log, `# ${name} worklog\n\n${entry}`);
			return () => fs.unlinkSync(log);
		});
		step(`farm.json: append ${name}`, () => {
			const cur = readFarm();
			return rewriteFile(FARM_JSON, farmText(cur.text, [...cur.ids, name]));
		});
		step(`APPEND_SYSTEM.md roster: add ${name} under \`${type}\``, () => rewriteFile(APPEND, rosterAdd(fs.readFileSync(APPEND, "utf8"), name, type, role, date)));
	} catch (e) {
		rollback(e);
	}
	if (nmCount() !== nmBefore) die(`main node_modules entry count changed (${nmBefore} -> ${nmCount()})`);
	console.log(`\nOK: ${name} is ready. Spawn it as agent \`${type}\` with task name "${name}" and worktree ${wt}.`);
	console.log("Reload or restart omp for the agent-monitor panel to pick up farm.json.");
}

// ------------------------------------------------------------------ remove
function remove(name, allowCore) {
	const wt = `${WT_ROOT}/${name}`;
	const branch = `w/${name}`;
	const log = `${LOG_DIR}/${name}.md`;
	const date = localDate();

	const lines = fs.readFileSync(APPEND, "utf8").split(/\r?\n/);
	const hit = rosterFind(lines, name);
	if (hit && !hit.line.includes("(extra") && !allowCore) die(`${name} is a default worker (roster line not marked "(extra"); pass --core to remove it anyway`);
	const rec = exists(wt) ? worktreeAt(wt) : null;
	if (exists(wt) && !rec) die(`${wt} exists but is not a registered git worktree; not touching it`);
	if (rec && rec.branch !== `refs/heads/${branch}`) die(`${wt} is on ${rec.branch}, expected refs/heads/${branch}`);
	if (rec) {
		const dirty = git(["status", "--porcelain"], wt);
		if (dirty) die(`${wt} has uncommitted or untracked changes; commit or discard them first:\n${dirty}`);
	}
	const nmBefore = nmCount();

	console.log(`retiring ${name}`);
	let branchNote = "branch not found";
	try {
		if (rec) {
			const links = findLinks(wt);
			const relink = [];
			for (const link of links) {
				const target = fs.readlinkSync(link);
				step(`unlink junction ${link} (-> ${target})`, () => {
					unlinkJunction(link);
					relink.push([target, link]);
				});
			}
			if (findLinks(wt).length) throw new Error(`junctions remain in ${wt}`);
			if (nmCount() !== nmBefore) throw new Error(`main node_modules changed while unlinking (${nmBefore} -> ${nmCount()})`);
			step(`git worktree remove ${wt}`, () => {
				try {
					git(["worktree", "remove", wt]);
				} catch (e) {
					for (const [target, link] of relink) fs.symlinkSync(target, link, "junction");
					throw new Error(`git worktree remove failed (junctions restored): ${e.stderr?.toString().trim() || e.message}`);
				}
			});
			if (exists(wt)) console.log(`  WARN: ${wt} still exists after removal (leftover files); delete it by hand after checking it holds no junction`);
		}
		if (gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
			git(["fetch", REMOTE, "--quiet"]);
			const merged = MERGED_REFS.find((r) => gitOk(["merge-base", "--is-ancestor", branch, r]));
			if (merged) {
				const sha = git(["rev-parse", "--short", branch]);
				step(`delete branch ${branch} (@ ${sha}, merged into ${merged})`, () => void git(["branch", "-D", branch]));
				branchNote = `branch ${branch} deleted (was ${sha}, merged into ${merged})`;
			} else {
				branchNote = `branch ${branch} KEPT: not merged into ${MERGED_REFS.join(" or ")}`;
				console.log(`- ${branchNote}`);
			}
		}
		step(`farm.json: drop ${name}`, () => {
			const cur = readFarm();
			if (!cur.ids.includes(name)) return;
			return rewriteFile(FARM_JSON, farmText(cur.text, cur.ids.filter((id) => id !== name)));
		});
		step(`APPEND_SYSTEM.md roster: drop ${name}`, () => {
			const text = fs.readFileSync(APPEND, "utf8");
			const next = rosterRemove(text, name);
			if (next !== text) return rewriteFile(APPEND, next);
		});
		if (exists(log)) {
			step(`worklog ${log}: kept, retirement noted`, () => {
				const before = fs.readFileSync(log, "utf8");
				fs.writeFileSync(log, `${before}${before.endsWith("\n") ? "" : "\n"}\n## ${date} — retired\n- Removed by farm-add-worker.mjs --remove: worktree deleted; ${branchNote}. Worklog kept.\n`);
			});
		}
	} catch (e) {
		// Junction/worktree/branch removal cannot be undone; config edits after a failure are not made.
		console.error(`\nFAILED: ${e.message}`);
		process.exit(1);
	}
	if (nmCount() !== nmBefore) die(`main node_modules entry count changed (${nmBefore} -> ${nmCount()})`);
	console.log(`\nOK: ${name} retired.${LINK_NM ? ` Main node_modules unchanged (${nmBefore} entries, dot entries included).` : ""}`);
	console.log("Reload or restart omp for the agent-monitor panel to pick up farm.json.");
}

// ------------------------------------------------------------------ main
const argv = process.argv.slice(2);
const takeOpt = (flag) => {
	const i = argv.indexOf(flag);
	if (i < 0) return undefined;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};
const takeFlag = (flag) => {
	const i = argv.indexOf(flag);
	if (i >= 0) argv.splice(i, 1);
	return i >= 0;
};
const removeName = takeOpt("--remove");
const core = takeFlag("--core");
const role = takeOpt("--role") ?? "overflow worker; retire when the burst is over";
const checkName = (n) => {
	if (!n || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(n)) die(`invalid worker name "${n ?? ""}" (letters, digits, _ or -, starting with a letter, max 32)\n${USAGE}`);
	if (RESERVED.has(n.toLowerCase())) die(`"${n}" is a reserved agent name`);
	return n;
};

if (removeName !== undefined) {
	if (argv.length) die(`unexpected arguments: ${argv.join(" ")}\n${USAGE}`);
	remove(checkName(removeName), core);
} else {
	if (argv.length !== 2) die(USAGE);
	add(checkName(argv[0]), argv[1].toLowerCase(), role);
}
