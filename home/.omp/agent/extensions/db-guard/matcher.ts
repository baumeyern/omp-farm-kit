/**
 * db-guard matcher: pure classification of agent tool calls that could change a production datastore.
 *
 * No host imports, so it can be loaded by ../index.ts (omp/Bun) and by test/selftest.ts (Node type stripping).
 * Bias: false positives on the database side are acceptable; an obvious write must never pass.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

export const APPROVAL_MARKER = "OMP_DB_APPROVED=1";

export const BLOCK_REASON =
	"DB change needs the owner's approval: stop and report the exact command, target, impact and rollback plan to the manager; after approval re-run prefixed with OMP_DB_APPROVED=1";

export interface Verdict {
	/** The call looks like a database change. */
	db: boolean;
	/** The call carries the OMP_DB_APPROVED=1 marker. */
	approved: boolean;
	/** Why the call was classified as a database change. */
	reasons: string[];
	/** Full command/code shown in the main-session confirm dialog. */
	subject: string;
}

interface Ctx {
	cwd: string;
	depth: number;
	reasons: string[];
}

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 2_000_000;
const MAX_SCAN_CHARS = 1_000_000;

const APPROVED_RE = /(?<![\w$])OMP_DB_APPROVED=1(?!\w)/;

/** Fail-safe: when the matcher itself throws, block only if the call mentions one of these. */
const DB_HINT_RE =
	/psql|pg_restore|supabase|redis|upstash|wrangler|postgres|\bsql\b|\.sql\b|scripts[\/\\]admin|run-with-keys|\b(?:insert\s+into|delete\s+from|drop\s+\w+|truncate|alter\s+\w+|update\s+\S+\s+set|grant|revoke)\b/i;

// ------------------------------------------------------------------ helpers

function add(ctx: Ctx, reason: string): void {
	if (!ctx.reasons.includes(reason)) ctx.reasons.push(reason);
}

function deeper(ctx: Ctx): Ctx {
	return { cwd: ctx.cwd, depth: ctx.depth + 1, reasons: ctx.reasons };
}

function clip(s: string, n = 90): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Static membership table; look up with `TABLE[key] === true` (inherited Object members never equal `true`). */
function wordSet(words: readonly string[]): Record<string, true> {
	return Object.fromEntries(words.map(w => [w, true]));
}

function shQuote(s: string): string {
	return /[\s'"\\$`]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}

/** A string field, or an argv array joined as a shell command line. */
function asText(v: unknown): string | undefined {
	if (typeof v === "string") return v;
	if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) return v.map(shQuote).join(" ");
	return undefined;
}

/** Every string reachable from `v`, joined; tolerant of throwing getters. */
function allStrings(v: unknown): string {
	const out: string[] = [];
	let size = 0;
	const seen = new Set<unknown>();
	const walk = (x: unknown, depth: number): void => {
		if (size > MAX_SCAN_CHARS || depth > 8) return;
		if (typeof x === "string") {
			out.push(x);
			size += x.length;
			return;
		}
		if (typeof x !== "object" || x === null || seen.has(x)) return;
		seen.add(x);
		let keys: string[] = [];
		try {
			keys = Object.keys(x);
		} catch {
			return;
		}
		for (const k of keys) {
			try {
				walk(Reflect.get(x, k), depth + 1);
			} catch {
				// a throwing getter must not hide the other fields from the fail-safe
			}
		}
	};
	walk(v, 0);
	return out.join("\n");
}

function fsPath(raw: string, cwd: string): string {
	let p = raw.trim().replace(/^["']|["']$/g, "");
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = join(homedir(), p.slice(1));
	if (process.platform === "win32") {
		const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(p); // Git-bash /c/Users/... form
		if (m) p = `${m[1]}:/${m[2] ?? ""}`;
	}
	return isAbsolute(p) ? p : resolve(cwd, p);
}

type FileRead = { text: string } | { missing: true } | { unreadable: true };

function readFile(raw: string, cwd: string): FileRead {
	let p: string;
	try {
		p = fsPath(raw, cwd);
	} catch {
		return { unreadable: true };
	}
	try {
		const st = statSync(p);
		if (!st.isFile() || st.size > MAX_FILE_BYTES) return { unreadable: true };
		return { text: readFileSync(p, "utf8") };
	} catch (err) {
		const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
		return code === "ENOENT" || code === "ENOTDIR" ? { missing: true } : { unreadable: true };
	}
}

// ------------------------------------------------------------------ SQL

const SQL_WRITE: ReadonlyArray<readonly [string, RegExp]> = [
	["INSERT INTO", /\binsert\s+(?:ignore\s+)?into\b/i],
	["UPDATE … SET", /\bupdate\s+(?:only\s+)?[\w."`[\]]+(?:\s+(?:as\s+)?\w+)?\s+set\b/i],
	["DELETE FROM", /\bdelete\s+from\b/i],
	[
		"TRUNCATE",
		/\btruncate\s+(?:table\b|only\b|[a-z_"][\w."]*\s*(?:;|,|\)|["'`]|\bcascade\b|\brestart\b|\bcontinue\b|$))/im,
	],
	[
		"DROP",
		/\bdrop\s+(?:table|schema|database|index|view|materialized\s+view|function|procedure|trigger|policy|extension|type|role|user|sequence|column|constraint|publication|subscription|owned|rule|aggregate|domain|server|event\s+trigger|cast|operator|collation|statistics)\b/i,
	],
	[
		"ALTER",
		/\balter\s+(?:table|schema|database|index|view|materialized\s+view|function|procedure|trigger|policy|extension|type|role|user|sequence|publication|subscription|default\s+privileges|system|domain|aggregate)\b/i,
	],
	[
		"CREATE",
		/\bcreate\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?(?:table|index|function|procedure|policy|trigger|extension|view|materialized\s+view|schema|type|role|user|sequence|database|rule|publication|subscription|aggregate|domain|event\s+trigger)\b/i,
	],
	["GRANT", /\bgrant\s+[\w\s,()]+?\s+(?:on|to)\s/i],
	["REVOKE", /\brevoke\s+[\w\s,()]+?\s+(?:on|from)\s/i],
	["MERGE INTO", /\bmerge\s+into\b/i],
	["COPY … FROM", /(?:\\|\b)copy\s+[\w."]+(?:\s*\([^)]*\))?\s+from\b/i],
	["REFRESH MATERIALIZED VIEW", /\brefresh\s+materialized\s+view\b/i],
	["COMMENT ON", /\bcomment\s+on\s+(?:table|column|function|schema|view|policy|index)\b/i],
	["CALL procedure", /\bcall\s+[\w.]+\s*\(/i],
	["DO block", /\bdo\s+(?:language\s+\w+\s+)?\$\w*\$/i],
	["LOCK TABLE", /\block\s+table\b/i],
	["pg_cron job change", /\bcron\.(?:schedule|unschedule|alter_job)\s*\(/i],
	["setval", /\bsetval\s*\(/i],
	["pg_terminate/cancel_backend", /\bpg_(?:terminate|cancel)_backend\s*\(/i],
];

function sqlWrites(text: string): string[] {
	const t = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
	const hits: string[] = [];
	for (const [label, re] of SQL_WRITE) if (re.test(t)) hits.push(label);
	return hits;
}

function sqlScan(text: string, ctx: Ctx, where: string): void {
	const hits = sqlWrites(text);
	if (hits.length) add(ctx, `SQL write in ${where}: ${hits.join(", ")}`);
}

const READ_SQL_RE =
	/^(?:select|with|show|explain|table|values|set|reset|begin|start\s+transaction|commit|rollback|end|abort|fetch|declare|close|listen)\b/i;
const READ_META_RE =
	/^\\(?:d[a-zA-Z+]*|l\+?|x|timing|pset|echo|qecho|conninfo|encoding|set|unset|q|t|a|h|\?|gx?|watch|s|z|sf\+?|sv\+?|c|connect)(?=\s|$)/;

/** Statements (SQL or psql meta-commands) that are not plain reads. */
function nonReadStatements(sql: string): string[] {
	const out: string[] = [];
	const clean = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
	for (const piece of clean.split(";")) {
		const sqlLines: string[] = [];
		for (const line of piece.split("\n")) {
			const t = line.trim();
			if (!t) continue;
			if (t.startsWith("\\")) {
				for (const meta of t.split(/(?=\\)/)) {
					const m = meta.trim();
					if (m && !READ_META_RE.test(m)) out.push(m);
				}
			} else sqlLines.push(t);
		}
		const stmt = sqlLines.join(" ").trim();
		if (stmt && !READ_SQL_RE.test(stmt)) out.push(stmt);
	}
	return out;
}

const SQL_REF_RE = /(?:^|[\s'"=<(,])((?:~|\.{1,2}|[A-Za-z]:|\/)?[^\s'"<>|;&()=,]*\.sql)(?=$|[\s'"|;&)>,])/gim;

/** Scan the contents of every existing `.sql` file the text references (output redirects excluded). */
function sqlFileRefs(text: string, ctx: Ctx): void {
	for (const m of text.matchAll(SQL_REF_RE)) {
		const before = text.slice(0, m.index ?? 0).trimEnd();
		if (before.endsWith(">")) continue; // `... > out.sql` writes a file, it is not executed
		const file = readFile(m[1], ctx.cwd);
		if ("text" in file) sqlScan(file.text, ctx, `referenced file ${clip(m[1], 60)}`);
		else if ("unreadable" in file) add(ctx, `references a .sql file the guard cannot inspect (${clip(m[1], 60)})`);
	}
}

// ------------------------------------------------------------------ HTTP / Redis

const SUPA_TARGET_RE = /supabase\.(?:co|in)\b|\b(?:PUBLIC_|VITE_|NEXT_PUBLIC_)?SUPABASE_URL\b|\/rest\/v1\/|\/auth\/v1\/admin/i;
const WRITE_METHOD_CI_RE =
	/(?:-X|--request)\s*=?\s*['"]?(?:post|put|patch|delete)\b|--method[=\s]+['"]?(?:post|put|patch|delete)\b|-Method\s+['"]?(?:post|put|patch|delete)\b|\bmethod["']?\s*[:=]\s*["'`]?(?:post|put|patch|delete)\b|\b(?:requests|httpx|axios|session|ky|got|superagent|aiohttp)\.(?:post|put|patch|delete)\s*\(|\b(?:https?|httpie|xh)\s+(?:post|put|patch|delete)\b|--post-(?:data|file)\b|--body-(?:data|file)\b|\b(?:invoke-restmethod|invoke-webrequest|irm|iwr)\b[^\n]*\s-Body\b/i;
const WRITE_METHOD_CS_RE = /(?:^|\s)(?:-d|-F|-T|--data(?:-raw|-binary|-urlencode|-ascii)?|--json|--form|--upload-file)(?=[\s='"$]|$)/m;

function httpRules(text: string, ctx: Ctx): void {
	if (SUPA_TARGET_RE.test(text) && (WRITE_METHOD_CI_RE.test(text) || WRITE_METHOD_CS_RE.test(text)))
		add(ctx, "HTTP write (POST/PATCH/PUT/DELETE) to Supabase (rest/v1, rpc or auth admin)");
}

const REDIS_MUT_LIST = [
	"set", "setex", "setnx", "psetex", "mset", "msetnx", "setrange", "setbit", "getset", "getdel", "getex", "append",
	"del", "unlink", "rename", "renamenx", "move", "copy", "restore", "migrate", "expire", "pexpire", "expireat",
	"pexpireat", "persist", "flushall", "flushdb", "swapdb", "incr", "incrby", "incrbyfloat", "decr", "decrby",
	"hset", "hmset", "hsetnx", "hdel", "hincrby", "hincrbyfloat", "lpush", "rpush", "lpushx", "rpushx", "lpop", "rpop",
	"lrem", "lset", "ltrim", "linsert", "lmove", "rpoplpush", "blpop", "brpop", "sadd", "srem", "spop", "smove",
	"sinterstore", "sunionstore", "sdiffstore", "zadd", "zrem", "zincrby", "zpopmin", "zpopmax", "zremrangebyscore",
	"zremrangebyrank", "zremrangebylex", "zunionstore", "zinterstore", "pfadd", "pfmerge", "geoadd", "xadd", "xdel",
	"xtrim", "xgroup", "json.set", "json.del", "json.arrappend", "eval", "evalsha", "fcall", "function", "script",
	"config", "bitop", "publish",
];
const REDIS_MUT = wordSet(REDIS_MUT_LIST);
const REDIS_READ = wordSet([
	"get", "mget", "getrange", "strlen", "exists", "type", "ttl", "pttl", "keys", "scan", "randomkey", "dbsize", "info",
	"ping", "echo", "time", "lastsave", "role", "hget", "hmget", "hgetall", "hkeys", "hvals", "hlen", "hexists",
	"hscan", "hstrlen", "smembers", "sismember", "smismember", "scard", "sscan", "srandmember", "sinter", "sunion",
	"sdiff", "lrange", "llen", "lindex", "lpos", "zrange", "zrangebyscore", "zrevrange", "zrevrangebyscore",
	"zrangebylex", "zscore", "zmscore", "zcard", "zcount", "zrank", "zrevrank", "zscan", "xrange", "xrevrange", "xlen",
	"xinfo", "xread", "pfcount", "bitcount", "bitpos", "getbit", "geopos", "geodist", "json.get", "json.type",
	"memory", "object", "slowlog", "command", "monitor", "client", "debug", "lolwut", "dump",
]);
const REDIS_INFO_FLAGS = wordSet(["--version", "-v", "--help", "--scan", "--bigkeys", "--memkeys", "--hotkeys", "--stat", "--latency", "--latency-history", "--latency-dist", "--intrinsic-latency"]);
const REDIS_VALUE_FLAGS = wordSet(["-h", "-p", "-a", "-n", "-u", "-s", "-r", "-i", "-d", "-D", "-t", "--user", "--pass", "--cacert", "--cacertdir", "--cert", "--key", "--sni", "--tls-ciphers", "--tls-ciphersuites", "--pattern", "--count"]);

const REDIS_WORDS_RE_SRC = REDIS_MUT_LIST.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const REDIS_REST_TARGET_RE =
	/upstash\.io|\b(?:KV_REST_API_URL|KV_REST_API_TOKEN|UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|REDIS_REST_URL|SRH_URL|SRH_TOKEN)\b|\bsrh\b/i;
const REDIS_REST_MUT_RE = new RegExp(`/(?:${REDIS_WORDS_RE_SRC})(?:/|\\b(?![-.]))|\\[\\s*["'](?:${REDIS_WORDS_RE_SRC})["']`, "i");
const REDIS_LINE_RE = new RegExp(`^\\s*(?:${REDIS_WORDS_RE_SRC})\\s`, "im");

function redisRestRules(text: string, ctx: Ctx): void {
	if (REDIS_REST_TARGET_RE.test(text) && REDIS_REST_MUT_RE.test(text)) add(ctx, "Redis/SRH REST mutation");
}

// ------------------------------------------------------------------ shell parsing

interface Cmd {
	words: string[];
	pipedIn: boolean;
	/** Heredoc bodies fed to this command's stdin. */
	bodies: string[];
}

interface Stmt {
	/** Raw source of the statement, including heredoc bodies and command substitutions. */
	text: string;
	cmds: Cmd[];
	opaque: boolean;
}

interface Parsed {
	stmts: Stmt[];
	end: number;
	closed: boolean;
}

/**
 * Quote/heredoc/substitution-aware split of a POSIX command line into statements (`;` `&&` `||` `&` newline)
 * made of commands (`|`). Words inside `$(…)`/backticks are merged into the enclosing statement.
 */
function parseShell(src: string, start: number, term: "" | ")" | "`", depth: number): Parsed {
	const stmts: Stmt[] = [];
	const newStmt = (): Stmt => ({ text: "", cmds: [], opaque: false });
	let stmt = newStmt();
	let words: string[] = [];
	let bodies: string[] = [];
	let pipedIn = false;
	let tok = "";
	let inTok = false;
	let quote = "";
	let paren = 0;
	let stmtStart = start;
	const pending: Array<{ delim: string; strip: boolean; into: string[] }> = [];

	const endTok = (): void => {
		if (inTok) words.push(tok);
		tok = "";
		inTok = false;
	};
	const endCmd = (nextPiped: boolean): void => {
		endTok();
		if (words.length) stmt.cmds.push({ words, pipedIn, bodies });
		words = [];
		bodies = [];
		pipedIn = nextPiped;
	};
	const endStmt = (at: number): void => {
		endCmd(false);
		stmt.text = src.slice(stmtStart, at);
		if (stmt.cmds.length || stmt.text.trim()) stmts.push(stmt);
		stmt = newStmt();
		stmtStart = at;
	};
	const sub = (from: number, t: ")" | "`"): number => {
		if (depth >= 8) {
			stmt.opaque = true;
			return src.length;
		}
		const r = parseShell(src, from, t, depth + 1);
		for (const s of r.stmts) {
			stmt.cmds.push(...s.cmds);
			if (s.opaque) stmt.opaque = true;
		}
		if (!r.closed) stmt.opaque = true;
		tok += src.slice(from, r.end);
		inTok = true;
		return r.end;
	};
	const heredocs = (pos: number): number => {
		for (const h of pending) {
			const lines: string[] = [];
			while (pos < src.length) {
				const nl = src.indexOf("\n", pos);
				const end = nl === -1 ? src.length : nl;
				const line = src.slice(pos, end).replace(/\r$/, "");
				pos = nl === -1 ? src.length : nl + 1;
				if ((h.strip ? line.replace(/^\t+/, "") : line).trim() === h.delim) break;
				lines.push(line);
			}
			h.into.push(lines.join("\n"));
		}
		pending.length = 0;
		return pos;
	};

	let i = start;
	for (; i < src.length; i++) {
		const c = src[i];
		if (quote === "'") {
			if (c === "'") quote = "";
			else tok += c;
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = "";
			else if (c === "\\" && i + 1 < src.length) tok += src[++i];
			else if (c === "$" && src[i + 1] === "(") i = sub(i + 2, ")");
			else if (c === "`") i = sub(i + 1, "`");
			else tok += c;
			continue;
		}
		if (term === ")" && c === ")" && paren === 0) {
			endStmt(i);
			return { stmts, end: i, closed: true };
		}
		if (term === "`" && c === "`") {
			endStmt(i);
			return { stmts, end: i, closed: true };
		}
		if (c === "\\") {
			if (src[i + 1] === "\n") i++;
			else if (i + 1 < src.length) {
				tok += src[++i];
				inTok = true;
			}
			continue;
		}
		if (c === "'" || c === '"') {
			quote = c;
			inTok = true;
			continue;
		}
		if (c === "#" && !inTok) {
			while (i + 1 < src.length && src[i + 1] !== "\n") i++;
			continue;
		}
		if (c === " " || c === "\t" || c === "\r") {
			endTok();
			continue;
		}
		if (c === "\n") {
			endTok();
			const at = pending.length ? heredocs(i + 1) : i + 1;
			endStmt(at);
			i = at - 1;
			continue;
		}
		if (c === ";") {
			endStmt(i + 1);
			continue;
		}
		if (c === "&") {
			if (src[i + 1] === "&") {
				endStmt(i + 2);
				i++;
			} else if (src[i - 1] === ">" || src[i + 1] === ">") {
				tok += c;
				inTok = true;
			} else endStmt(i + 1);
			continue;
		}
		if (c === "|") {
			if (src[i + 1] === "|") {
				endStmt(i + 2);
				i++;
			} else {
				if (src[i + 1] === "&") i++;
				endCmd(true);
			}
			continue;
		}
		if (c === "$" && src[i + 1] === "(") {
			i = sub(i + 2, ")");
			continue;
		}
		if (c === "`") {
			i = sub(i + 1, "`");
			continue;
		}
		if (c === "(") {
			paren++;
			endCmd(false);
			continue;
		}
		if (c === ")") {
			if (paren > 0) paren--;
			endCmd(false);
			continue;
		}
		if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
			endTok();
			let j = i + 2;
			let strip = false;
			if (src[j] === "-") {
				strip = true;
				j++;
			}
			while (src[j] === " " || src[j] === "\t") j++;
			let delim = "";
			const q = src[j];
			if (q === "'" || q === '"') {
				const k = src.indexOf(q, j + 1);
				if (k === -1) j = src.length;
				else {
					delim = src.slice(j + 1, k);
					j = k + 1;
				}
			} else {
				while (j < src.length && !/[\s;&|<>()]/.test(src[j])) {
					if (src[j] !== "\\") delim += src[j];
					j++;
				}
				delim = delim.replace(/["']/g, "");
			}
			if (delim) {
				pending.push({ delim, strip, into: bodies });
				words.push(`<<${delim}`);
			}
			i = j - 1;
			continue;
		}
		tok += c;
		inTok = true;
	}
	if (quote) stmt.opaque = true;
	endStmt(src.length);
	return { stmts, end: src.length, closed: term === "" };
}

// ------------------------------------------------------------------ command vocabulary

const PREFIX_WORDS = wordSet(["sudo", "env", "time", "nohup", "exec", "command", "builtin", "nice", "ionice", "stdbuf", "winpty", "then", "do", "else", "elif", "if", "while", "until", "!", "{", "}"]);

/** Tools that cannot touch a database; statements made only of these skip the SQL keyword scan. */
const SAFE_TOOL_LIST = ["vitest", "svelte-check", "svelte-kit", "tsc", "eslint", "prettier", "biome", "playwright", "vite", "jest", "knip", "rimraf", "typescript", "sv"];
const SAFE_TOOLS = wordSet(SAFE_TOOL_LIST);
const SAFE_WORDS = wordSet([
	...SAFE_TOOL_LIST,
	"git", "gh", "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "ls", "dir", "cat", "bat", "head", "tail",
	"less", "more", "wc", "sort", "uniq", "diff", "cmp", "comm", "echo", "printf", "sed", "awk", "gawk", "cut", "tr",
	"tee", "cp", "mv", "mkdir", "rmdir", "touch", "rm", "ln", "chmod", "chown", "test", "[", "[[", "]]", "true", "false",
	"cd", "pushd", "popd", "pwd", "which", "where", "type", "file", "stat", "du", "df", "jq", "yq", "basename",
	"dirname", "realpath", "readlink", "date", "sleep", "tree", "column", "xxd", "od", "md5sum", "sha1sum",
	"sha256sum", "export", "unset", "set", "read", "exit", "return", ":", "tar", "zip", "unzip", "gzip", "gunzip",
	"code", "explorer", "start", "open", "clear", "history", "wait", "kill", "ps", "tasklist", "nl", "fold", "fmt",
	"paste", "join", "split", "rev", "tac", "seq", "iconv", "dos2unix", "unix2dos", "pg_dump", "hostname", "whoami",
	"uname", "id", "printenv", "fi", "done", "esac", "local", "declare", "shift", "trap", "break", "continue",
]);
const RUNTIMES = wordSet(["node", "nodejs", "bun", "deno", "tsx", "ts-node", "esno", "esrun", "vite-node", "npx", "bunx", "pnpx", "python", "python3", "py", "ruby", "perl"]);
const PKG_MANAGERS = wordSet(["npm", "pnpm", "yarn", "bun"]);
const PKG_SAFE_SUBS = wordSet(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "upgrade", "ls", "list", "outdated", "view", "info", "audit", "why", "--version", "-v", "help", "--help", "init", "pack", "link", "prune", "dedupe", "cache", "whoami", "pm", "fund", "doctor"]);
const SHELL_LIST = ["bash", "sh", "zsh", "dash", "ksh", "source", "."];
const SHELLS = wordSet(SHELL_LIST);
const WRAPPERS = wordSet([...SHELL_LIST, "ssh", "docker", "podman", "kubectl", "wsl", "pwsh", "powershell", "cmd", "xargs", "timeout", "watch", "script", "su", "eval", "parallel", "flock", "cross-env", "dotenv", "env-cmd", "op", "doppler", "infisical", "call"]);
const DB_CLIS = wordSet(["psql", "pg_restore", "redis-cli", "supabase", "wrangler", "dropdb", "createdb", "dropuser", "createuser", "pg_resetwal"]);
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?|py)$/i;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const ADMIN_SCRIPT_RE =
	/(?:^|\/)scripts\/admin\/|run-with-keys|(?:^|\/)mig-[^/]*$|(?:^|\/)[^/]*(?:backfill|restore|purge|delete)[^/]*\.(?:[cm]?[jt]s|py|sh|sql)$/i;

const SUPABASE_CLI_RE =
	/\bsupabase(?:\.exe)?\b[^\n;&|]*?\b(?:db\s+(?:push|reset|execute|query)|migration\s+(?:up|down|repair|squash)|seed\s+buckets|storage\s+(?:rm|mv|cp))\b/i;
const WRANGLER_RE =
	/\bwrangler(?:\.cmd)?\b[^\n;&|]*?\b(?:d1\s+(?:execute|migrations\s+apply|import|delete)|kv(?::|\s+)(?:key|bulk)\s+(?:put|delete)|r2\s+object\s+(?:put|delete))\b/i;

function norm(word: string): string {
	return basename(word.replace(/\\/g, "/"))
		.toLowerCase()
		.replace(/\.(?:exe|cmd|bat)$/, "");
}

/** Index of the real command word, skipping env assignments and prefixes like `sudo`/`env`. */
function cmdIndex(words: string[]): number {
	let k = 0;
	while (k < words.length) {
		const w = words[k];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			k++;
			continue;
		}
		const b = w.toLowerCase();
		if (PREFIX_WORDS[b] === true) {
			k++;
			if (b === "env") while (k < words.length && words[k].startsWith("-")) k++;
			continue;
		}
		break;
	}
	return k;
}

function firstNonFlag(args: string[]): string | undefined {
	return args.find(a => !a.startsWith("-"));
}

function pkgScript(name: string, cwd: string): string | undefined {
	const file = readFile("package.json", cwd);
	if (!("text" in file)) return undefined;
	try {
		const pkg: unknown = JSON.parse(file.text);
		const scripts = isObj(pkg) && isObj(pkg.scripts) ? pkg.scripts : undefined;
		const body = scripts?.[name];
		return typeof body === "string" ? body : undefined;
	} catch {
		return undefined;
	}
}

/** Script name a package-manager invocation runs, or undefined when it runs no package script. */
function pkgTarget(w: string, args: string[]): { kind: "safe" } | { kind: "exec"; rest: string[] } | { kind: "file"; rest: string[] } | { kind: "script"; name: string } | { kind: "unknown" } {
	const sub0 = args[0]?.toLowerCase();
	if (!sub0 || PKG_SAFE_SUBS[sub0] === true) return { kind: "safe" };
	if (w === "bun" && sub0 === "test") return { kind: "safe" };
	if (sub0 === "exec" || sub0 === "dlx" || sub0 === "x") return { kind: "exec", rest: args.slice(1) };
	let name: string | undefined;
	if (sub0 === "run" || sub0 === "run-script") name = firstNonFlag(args.slice(1));
	else if (sub0 === "test" || sub0 === "t") name = "test";
	else if (sub0 === "start") name = "start";
	else name = args[0];
	if (!name) return { kind: "unknown" };
	if (w === "bun" && (CODE_EXT_RE.test(name) || /[\/\\]/.test(name)))
		return { kind: "file", rest: sub0 === "run" ? args.slice(1) : args };
	return { kind: "script", name };
}

function cmdSafe(cmd: Cmd, ctx: Ctx): boolean {
	const k = cmdIndex(cmd.words);
	if (k >= cmd.words.length) return true;
	const w = norm(cmd.words[k]);
	const args = cmd.words.slice(k + 1);
	if (SAFE_WORDS[w] === true) return true;
	if (w === "npx" || w === "bunx" || w === "pnpx") {
		const t = firstNonFlag(args);
		return t !== undefined && SAFE_TOOLS[norm(t)] === true;
	}
	if (PKG_MANAGERS[w] === true) {
		const target = pkgTarget(w, args);
		if (target.kind === "safe") return true;
		if (target.kind === "exec") {
			const t = firstNonFlag(target.rest);
			return t !== undefined && SAFE_TOOLS[norm(t)] === true;
		}
		if (target.kind === "script" && ctx.depth < MAX_DEPTH) {
			const body = pkgScript(target.name, ctx.cwd);
			return (
				body !== undefined &&
				parseShell(body, 0, "", 0).stmts.every(s => !s.opaque && s.cmds.every(c => cmdSafe(c, deeper(ctx))))
			);
		}
	}
	return false;
}

// ------------------------------------------------------------------ per-command rules

function psqlRule(args: string[], stmt: Stmt, idx: number, cmd: Cmd, ctx: Ctx): void {
	const info = wordSet(["--version", "-V", "--help", "-?", "-l", "--list"]);
	if (args.length && args.every(a => info[a] === true)) return;
	const cArgs: string[] = [];
	const files: string[] = [];
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		if (a === "-c" || a === "--command" || /^-[AtqxXeabnsSwWzH01]+c$/.test(a)) {
			if (j + 1 < args.length) cArgs.push(args[++j]);
		} else if (a.startsWith("--command=")) cArgs.push(a.slice(10));
		else if (/^-c./.test(a)) cArgs.push(a.slice(2));
		else if (a === "-f" || a === "--file" || /^-[AtqxXeabnsSwWzH01]+f$/.test(a)) {
			if (j + 1 < args.length) files.push(args[++j]);
		} else if (a.startsWith("--file=")) files.push(a.slice(7));
		else if (/^-f./.test(a)) files.push(a.slice(2));
		else if (a === "<") {
			if (j + 1 < args.length) files.push(args[++j]);
		} else if (a.startsWith("<") && !a.startsWith("<<")) files.push(a.slice(1));
	}

	const sql: string[] = [...cArgs, ...cmd.bodies];
	for (const f of files) {
		const r = readFile(f, ctx.cwd);
		if ("text" in r) sql.push(r.text);
		else add(ctx, `psql runs SQL from a file the guard cannot inspect (${clip(f, 60)})`);
	}
	if (!cArgs.length && !files.length && !cmd.bodies.length) {
		const prev = cmd.pipedIn ? stmt.cmds[idx - 1] : undefined;
		if (!prev) add(ctx, "psql session without -c/-f (interactive or opaque input)");
		else {
			const pk = cmdIndex(prev.words);
			const pw = norm(prev.words[pk] ?? "");
			const pargs = prev.words.slice(pk + 1).filter(a => !a.startsWith("-"));
			if (pw === "echo" || pw === "printf") sql.push(pargs.join(" "), ...prev.bodies);
			else if (pw === "cat" || pw === "type") {
				sql.push(...prev.bodies);
				for (const f of pargs) {
					if (f.startsWith("<<")) continue;
					const r = readFile(f, ctx.cwd);
					if ("text" in r) sql.push(r.text);
					else add(ctx, `psql reads piped SQL from a file the guard cannot inspect (${clip(f, 60)})`);
				}
			} else add(ctx, `psql reads SQL from a pipe the guard cannot inspect (${pw || "?"})`);
		}
	}
	for (const s of sql) {
		const hits = sqlWrites(s);
		if (hits.length) add(ctx, `psql SQL write: ${hits.join(", ")}`);
		const nonRead = nonReadStatements(s);
		if (nonRead.length) add(ctx, `psql runs a non-read statement: ${clip(nonRead[0], 60)}`);
	}
}

function redisRule(args: string[], stmt: Stmt, idx: number, cmd: Cmd, ctx: Ctx): void {
	let command: string | undefined;
	const flags: string[] = [];
	for (let j = 0; j < args.length; j++) {
		const a = args[j];
		if (a.startsWith("-")) {
			flags.push(a.toLowerCase());
			if (REDIS_VALUE_FLAGS[a] === true) j++;
			continue;
		}
		command = a.toLowerCase();
		break;
	}
	if (command) {
		if (REDIS_MUT[command] === true) add(ctx, `redis-cli ${command.toUpperCase()} (mutation)`);
		else if (REDIS_READ[command] !== true) add(ctx, `redis-cli ${command.toUpperCase()} (unrecognised command)`);
		return;
	}
	if (flags.some(f => f === "--pipe" || f === "-x" || f === "--eval" || f === "--rdb" || f === "--replica")) {
		add(ctx, "redis-cli pipe/eval/replication mode");
		return;
	}
	if (flags.some(f => REDIS_INFO_FLAGS[f] === true)) return;
	const stdin: string[] = [...cmd.bodies];
	const prev = cmd.pipedIn ? stmt.cmds[idx - 1] : undefined;
	if (prev) {
		const pk = cmdIndex(prev.words);
		const pw = norm(prev.words[pk] ?? "");
		if (pw === "echo" || pw === "printf") stdin.push(prev.words.slice(pk + 1).join(" "), ...prev.bodies);
		else {
			add(ctx, `redis-cli reads commands from a pipe the guard cannot inspect (${pw || "?"})`);
			return;
		}
	}
	if (!stdin.length) {
		add(ctx, "redis-cli session without an inline command (interactive or stdin)");
		return;
	}
	for (const line of stdin.join("\n").split(/\n|\\n/)) {
		const word = line.trim().split(/\s+/)[0]?.toLowerCase().replace(/^["']/, "");
		if (word && REDIS_READ[word] !== true) add(ctx, `redis-cli stdin command ${word.toUpperCase()}`);
	}
}

function runtimeRule(w: string, args: string[], stmt: Stmt, ctx: Ctx): void {
	if (w === "npx" || w === "bunx" || w === "pnpx") {
		const t = firstNonFlag(args);
		if (t !== undefined && SAFE_TOOLS[norm(t)] === true) return;
	}
	for (const a of args) {
		if (a.startsWith("-") && !a.includes("=")) continue;
		const p = a.replace(/\\/g, "/").replace(/^--?[\w-]+=/, "");
		if (TEST_FILE_RE.test(p)) continue;
		if (ADMIN_SCRIPT_RE.test(p)) add(ctx, `runs a DB admin/mutation script (${clip(a, 70)})`);
	}
	// Inline code (-e/-c/heredoc) is part of the statement text.
	codeRules(stmt.text, ctx, `${w} inline code`);
	if (ctx.depth >= MAX_DEPTH) return;
	const file = args.find(a => !a.startsWith("-") && CODE_EXT_RE.test(a) && !TEST_FILE_RE.test(a));
	if (file) {
		const r = readFile(file, ctx.cwd);
		if ("text" in r) codeRules(r.text, deeper(ctx), `script ${clip(file, 60)}`);
	}
}

function pkgRule(w: string, args: string[], stmt: Stmt, ctx: Ctx): void {
	const target = pkgTarget(w, args);
	if (target.kind === "safe" || target.kind === "unknown") return;
	if (target.kind === "exec") return runtimeRule("npx", target.rest, stmt, ctx);
	if (target.kind === "file") return runtimeRule("bun", target.rest, stmt, ctx);
	const body = pkgScript(target.name, ctx.cwd);
	if (body !== undefined) {
		if (ctx.depth < MAX_DEPTH) shellClassify(body, deeper(ctx));
		return;
	}
	if (/(?:^|[:\-_])(?:db|migrat\w*|seed|backfill|purge|restore|reset|truncate|wipe)(?:$|[:\-_])/i.test(target.name))
		add(ctx, `package script "${target.name}" looks like a DB operation (not found in package.json)`);
}

function cmdRules(cmd: Cmd, stmt: Stmt, idx: number, ctx: Ctx): void {
	const k = cmdIndex(cmd.words);
	if (k >= cmd.words.length) return;
	const w = norm(cmd.words[k]);
	const args = cmd.words.slice(k + 1);
	const infoOnly = args.length > 0 && args.every(a => a === "--help" || a === "--version" || a === "-V");

	if (w === "psql") return psqlRule(args, stmt, idx, cmd, ctx);
	if (w === "redis-cli") return redisRule(args, stmt, idx, cmd, ctx);
	if (w === "pg_restore") {
		const list = args.includes("-l") || args.includes("--list");
		const db = args.some(a => a === "-d" || a.startsWith("--dbname") || /^-d./.test(a));
		if (!infoOnly && !(list && !db)) add(ctx, "pg_restore into a database");
		return;
	}
	if (w === "dropdb" || w === "createdb" || w === "dropuser" || w === "createuser" || w === "pg_resetwal") {
		if (!infoOnly) add(ctx, `${w} (database administration)`);
		return;
	}
	if (w === "supabase" || w === "wrangler") return; // statement-level regexes

	const supaq = cmd.words.findIndex(x => /^supaq(?:\.sh)?$/.test(norm(x)));
	if (supaq !== -1) {
		const sub0 = cmd.words[supaq + 1]?.toLowerCase();
		if (!sub0 || !["count", "get", "daily-winrates", "help", "-h", "--help"].includes(sub0))
			add(ctx, `supaq.sh ${sub0 ?? "(no subcommand)"} (only count/get/daily-winrates are reads)`);
		return;
	}

	if (PKG_MANAGERS[w] === true) pkgRule(w, args, stmt, ctx);
	else if (RUNTIMES[w] === true) runtimeRule(w, args, stmt, ctx);

	if (ctx.depth < MAX_DEPTH) {
		// Shell scripts: `bash x.sh`, `./x.sh`, `source x.sh`.
		const script = /\.(?:sh|bash)$/.test(w)
			? cmd.words[k]
			: SHELLS[w] === true && !args.includes("-c")
				? firstNonFlag(args)
				: undefined;
		if (script) {
			const r = readFile(script, ctx.cwd);
			if ("text" in r) shellClassify(r.text, deeper(ctx));
		}
		// Nested command lines: `bash -c "…"`, `ssh host "…"`, `pwsh -Command '…'`.
		if (WRAPPERS[w] === true) for (const a of args) if (/\s/.test(a)) shellClassify(a, deeper(ctx));
		// Embedded DB CLIs / runtimes after a wrapper: `timeout 60 psql …`, `docker exec db psql …`.
		const scanSet = WRAPPERS[w] === true || RUNTIMES[w] !== true;
		if (scanSet) {
			for (let j = k + 1; j < cmd.words.length; j++) {
				const e = norm(cmd.words[j]);
				if (DB_CLIS[e] === true || (WRAPPERS[w] === true && (RUNTIMES[e] === true || PKG_MANAGERS[e] === true))) {
					cmdRules({ words: cmd.words.slice(j), pipedIn: false, bodies: cmd.bodies }, stmt, idx, deeper(ctx));
					break;
				}
			}
		}
	}
}

// ------------------------------------------------------------------ shell / code classification

function shellClassify(text: string, ctx: Ctx): void {
	const { stmts } = parseShell(text, 0, "", 0);
	for (const stmt of stmts) {
		if (!stmt.opaque && stmt.cmds.every(c => cmdSafe(c, ctx))) continue;
		const t = stmt.text;
		if (SUPABASE_CLI_RE.test(t)) add(ctx, "supabase CLI database write (db push/reset/execute or migration up/repair)");
		if (WRANGLER_RE.test(t)) add(ctx, "wrangler D1/KV/R2 write");
		httpRules(t, ctx);
		redisRestRules(t, ctx);
		stmt.cmds.forEach((cmd, idx) => {
			if (!cmdSafe(cmd, ctx)) cmdRules(cmd, stmt, idx, ctx);
		});
		sqlScan(t, ctx, "command");
		sqlFileRefs(t, ctx);
	}
}

const DB_LIB_RE =
	/(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](?:@supabase\/[\w.-]+|pg|pg-promise|postgres|ioredis|redis|@redis\/client|@upstash\/redis|@neondatabase\/serverless|@vercel\/(?:postgres|kv)|mysql2?(?:\/promise)?|kysely|drizzle-orm(?:\/[\w-]+)*|knex|bun:sql|@libsql\/client|mongodb)["']/;
const PY_DB_RE = /^\s*(?:from|import)\s+(?:supabase|psycopg2?|psycopg|asyncpg|sqlalchemy|redis|upstash_redis|pg8000|postgrest|pymongo)\b/m;
const DB_CTOR_RE =
	/\bcreateClient\s*\(|\bnew\s+(?:pg\.)?(?:Pool|Client)\s*\(|\bBun\.sql\b|\bnew\s+(?:Bun\.)?SQL\s*\(|\bnew\s+(?:IO)?Redis\s*\(|\bRedis\.fromEnv\s*\(|\b(?:psycopg2?|psycopg|asyncpg)\.connect\s*\(|\bcreate_client\s*\(|\bcreate_engine\s*\(|\bredis\.(?:Redis|StrictRedis|from_url)\s*\(/;
const REDIS_LIB_RE = /ioredis|["']redis["']|@redis\/client|@upstash\/redis|upstash_redis|^\s*(?:import|from)\s+redis\b|\bRedis\b/m;
const CLIENT_WRITE_RE = /\.(insert|update|upsert|delete|rpc)\s*\(/;
const REDIS_CALL_RE = new RegExp(
	`\\.(${["set", "setex", "setnx", "psetex", "mset", "del", "unlink", "hset", "hmset", "hsetnx", "hdel", "hincrby", "expire", "pexpire", "expireat", "persist", "flushall", "flushdb", "incr", "incrby", "decr", "decrby", "lpush", "rpush", "lpop", "rpop", "lrem", "ltrim", "sadd", "srem", "spop", "zadd", "zrem", "zincrby", "rename", "getdel", "getset", "append", "xadd", "xdel", "xtrim", "json\\.set", "eval", "evalsha"].join("|")})\\s*\\(`,
	"i",
);
const AUTH_ADMIN_RE =
	/\.auth\.admin\.(?:deleteUser|delete_user|updateUserById|update_user_by_id|createUser|create_user|inviteUserByEmail|invite_user_by_email|generateLink|generate_link)\s*\(/;
const EXEC_RE =
	/\bsubprocess\b|\bos\.(?:system|popen|exec\w*|spawn\w*)\s*\(|\bBun\.\$|\bBun\.spawn(?:Sync)?\s*\(|(?:^|[^\w.])\$`|\bchild_process\b|(?<![\w.])exec(?:Sync|File|FileSync)?\s*\(|(?<![\w.])spawn(?:Sync)?\s*\(|\bexeca\b|\bzx\b|^\s*!|^\s*%%?(?:bash|sh|script|system|sx)\b|\btool\.bash\s*\(|\bpexpect\b|\bDeno\.Command\b|\bshell\s*=\s*True/m;
const SHELLISH_RE = /\b(?:psql|pg_restore|redis-cli|supabase|wrangler|dropdb|curl|wget|node|bun|npx|bunx|tsx|deno|python3?|bash|sh|pwsh)\b|scripts[\/\\]admin|run-with-keys|supaq/i;
const LITERAL_RE = /`((?:\\[\s\S]|[^`\\])*)`|"""([\s\S]*?)"""|'''([\s\S]*?)'''|"((?:\\.|[^"\\\n])*)"|'((?:\\.|[^'\\\n])*)'/g;
const ARGV_RE = /\[\s*(["'])(psql|pg_restore|redis-cli|supabase|wrangler|node|bun|npx|tsx|python3?|bash|sh)\1\s*,([^\]]*)\]/g;
const ADMIN_LOAD_RE = /(?:%load|%run|import\s*\(|require\s*\(|runpy\.run_path\s*\()\s*["']?[^"'\n)]*(?:scripts[\/\\]admin[\/\\]|run-with-keys)/;

/** Shell command lines embedded in code: `!cmd` lines, `%%bash` cells, string literals, argv arrays. */
function shellSnippets(code: string): string[] {
	const out: string[] = [];
	for (const m of code.matchAll(/^\s*!(.+)$/gm)) out.push(m[1]);
	const cell = /^\s*%%(?:bash|sh|script\s+\w+)[^\n]*\n([\s\S]*)$/m.exec(code);
	if (cell) out.push(cell[1]);
	let n = 0;
	for (const m of code.matchAll(LITERAL_RE)) {
		const s = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "";
		if (/\s/.test(s) && SHELLISH_RE.test(s)) {
			out.push(s);
			if (++n >= 200) break;
		}
	}
	for (const m of code.matchAll(ARGV_RE)) {
		const items = [...m[3].matchAll(/(["'])((?:\\.|(?!\1)[^\\])*)\1/g)].map(x => x[2]);
		out.push([m[2], ...items].map(shQuote).join(" "));
	}
	return out;
}

function codeRules(code: string, ctx: Ctx, where: string): void {
	const dbLib = DB_LIB_RE.test(code) || PY_DB_RE.test(code) || DB_CTOR_RE.test(code);
	const exec = EXEC_RE.test(code);
	httpRules(code, ctx);
	redisRestRules(code, ctx);
	if (AUTH_ADMIN_RE.test(code)) add(ctx, `${where}: Supabase auth admin write (create/update/delete user)`);
	if (ADMIN_LOAD_RE.test(code)) add(ctx, `${where}: loads a DB admin script`);
	if (dbLib) {
		const m = CLIENT_WRITE_RE.exec(code);
		if (m) add(ctx, `${where}: DB client .${m[1]}() call`);
		if (REDIS_LIB_RE.test(code)) {
			const r = REDIS_CALL_RE.exec(code);
			if (r) add(ctx, `${where}: Redis .${r[1]}() call`);
		}
	}
	if (dbLib || exec) {
		sqlScan(code, ctx, where);
		sqlFileRefs(code, ctx);
	}
	if (exec && ctx.depth < MAX_DEPTH) for (const s of shellSnippets(code)) shellClassify(s, deeper(ctx));
}

function evalCell(code: string, ctx: Ctx): void {
	for (const m of code.matchAll(/^\s*%(?:load|run)\s+(.+?)\s*$/gm)) {
		const p = m[1].replace(/^["']|["']$/g, "");
		if (ADMIN_SCRIPT_RE.test(p.replace(/\\/g, "/"))) add(ctx, `eval %load of a DB admin/mutation script (${clip(p, 60)})`);
		const r = readFile(p, ctx.cwd);
		if ("text" in r && ctx.depth < MAX_DEPTH) codeRules(r.text, deeper(ctx), `%load ${clip(p, 60)}`);
	}
	codeRules(code, ctx, "eval code");
}

/** Text typed into a running process (`write proc://…`): psql/redis-cli/shell sessions. */
function stdinRule(content: string, ctx: Ctx): void {
	shellClassify(content, ctx);
	sqlScan(content, ctx, "process stdin");
	if (REDIS_LINE_RE.test(content)) add(ctx, "Redis mutation typed into a running process");
	if (/^\s*\\(?:i|ir|include|copy|gexec|!)\b/m.test(content)) add(ctx, "psql meta-command typed into a running process");
}

// ------------------------------------------------------------------ tool dispatch

const SHELL_TOOLS = wordSet(["bash", "shell", "sh", "exec", "exec_command", "run_command", "run_shell_command", "run_terminal_cmd", "terminal", "ssh", "local_shell", "powershell", "cmd", "container.exec"]);
const CODE_TOOLS = wordSet(["eval", "python", "notebook", "js", "repl", "code_execution", "run_code", "ipython", "jupyter"]);
const SKIP_TOOLS = wordSet(["read", "grep", "glob", "find", "edit", "ast_grep", "ast_edit", "lsp", "web_search", "search", "todo", "todo_write", "task", "wait", "yield", "ask", "checkpoint", "rewind", "generate_image", "tts", "learn", "recall", "retain", "reflect", "memory_edit", "manage_skill", "github", "security_scan", "new_context", "context_notes", "resolve"]);
const SHELL_KEYS = wordSet(["command", "cmd", "script", "shell", "commandline", "command_line"]);
const CODE_KEYS = wordSet(["code", "source", "js", "python", "javascript", "snippet", "expression"]);
const SQL_KEYS = wordSet(["sql", "query", "statement", "statements"]);
const DBISH_TOOL_RE = /sql|postgres|supabase|redis|upstash|database|(?:^|[_\-.])db(?:$|[_\-.])|(?:^|[_\-.])d1(?:$|[_\-.])|migration|psql|neon/i;
const DBISH_WRITE_NAME_RE =
	/apply_migration|(?:^|[_\-.])(?:insert|update|upsert|delete|drop|truncate|reset|flush|flushall|flushdb|set|del|hset|hdel|expire|merge|restore|purge|create|alter|deploy|push|write|mutate|remove)(?:$|[_\-.])/i;
const DBISH_EXEC_NAME_RE = /(?:^|[_\-.])(?:query|execute|exec|run|sql)(?:$|[_\-.])|execute_sql|run_sql|exec_sql/i;

function classifyInto(toolName: string, input: unknown, ctx: Ctx): void {
	const n = toolName.toLowerCase();
	const o = isObj(input) ? input : {};
	if (SHELL_TOOLS[n] === true) {
		const c = asText(o.command ?? o.cmd ?? o.script ?? o.input);
		if (c) shellClassify(c, ctx);
		return;
	}
	if (CODE_TOOLS[n] === true) {
		const code = asText(o.code ?? o.source ?? o.input);
		if (code) evalCell(code, ctx);
		return;
	}
	if (n === "write") {
		const path = typeof o.path === "string" ? o.path : "";
		const content = typeof o.content === "string" ? o.content : "";
		if (path.startsWith("proc://") && !/\/(?:kill|mode)\/?$/.test(path)) stdinRule(content, ctx);
		else if (path.startsWith("xd://") && ctx.depth < MAX_DEPTH) {
			const device = path.slice(5).split(/[/?#]/)[0] ?? "";
			let args: unknown;
			try {
				args = JSON.parse(content);
			} catch {
				args = { content };
			}
			if (device && device !== "write") classifyInto(device, args, deeper(ctx));
		}
		return;
	}
	if (SKIP_TOOLS[n] === true) return;

	// Unknown / MCP / extension tools: inspect command-, code- and SQL-like fields.
	const sqlValues: string[] = [];
	for (const [key, value] of Object.entries(o)) {
		const s = asText(value);
		if (!s) continue;
		const lk = key.toLowerCase();
		if (SHELL_KEYS[lk] === true) shellClassify(s, ctx);
		else if (CODE_KEYS[lk] === true) codeRules(s, ctx, `${toolName}.${key}`);
		else if (SQL_KEYS[lk] === true) {
			sqlValues.push(s);
			sqlScan(s, ctx, `${toolName}.${key}`);
		}
	}
	const everything = allStrings(o);
	httpRules(everything, ctx);
	redisRestRules(everything, ctx);
	if (DBISH_TOOL_RE.test(n)) {
		sqlScan(everything, ctx, `tool ${toolName}`);
		if (DBISH_WRITE_NAME_RE.test(n)) add(ctx, `tool ${toolName} writes to a datastore`);
		else if (DBISH_EXEC_NAME_RE.test(n)) {
			for (const s of sqlValues) {
				const nonRead = nonReadStatements(s);
				if (nonRead.length) add(ctx, `tool ${toolName} runs a non-read statement: ${clip(nonRead[0], 60)}`);
			}
		}
	}
}

function describe(toolName: string, input: unknown): string {
	const o = isObj(input) ? input : {};
	const n = toolName.toLowerCase();
	if (SHELL_TOOLS[n] === true) return asText(o.command ?? o.cmd ?? o.script ?? o.input) ?? "";
	if (CODE_TOOLS[n] === true) return asText(o.code ?? o.source ?? o.input) ?? "";
	if (n === "write") return `write ${String(o.path ?? "")}\n${String(o.content ?? "")}`;
	try {
		return JSON.stringify(input, null, 2) ?? "";
	} catch {
		return allStrings(input);
	}
}

function inputCwd(input: unknown, cwd: string): string {
	const o = isObj(input) ? input : {};
	const c = o.cwd;
	if (typeof c !== "string" || !c.trim() || /^[a-z][\w+.-]*:\/\//i.test(c)) return cwd;
	return fsPath(c, cwd);
}

/**
 * Classify one tool call. Never throws: on an internal error the call is treated as a database change
 * only if its text mentions a database keyword.
 */
export function classifyToolCall(toolName: string, input: unknown, cwd: string): Verdict {
	let raw = "";
	try {
		raw = allStrings(input);
	} catch {
		raw = "";
	}
	const approved = APPROVED_RE.test(raw);
	const reasons: string[] = [];
	let subject = raw;
	try {
		subject = describe(toolName, input);
		classifyInto(toolName, input, { cwd: inputCwd(input, cwd), depth: 0, reasons });
	} catch (err) {
		if (DB_HINT_RE.test(raw) || DB_HINT_RE.test(toolName)) {
			const msg = err instanceof Error ? err.message : String(err);
			reasons.push(`db-guard matcher error (${clip(msg, 80)}) on a call that mentions a database keyword`);
		}
	}
	return { db: reasons.length > 0, approved, reasons, subject };
}
