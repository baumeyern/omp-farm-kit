/**
 * Offline db-guard matcher test. Never touches a database: it only classifies tool-call inputs.
 * Run: node ~/.omp/agent/extensions/db-guard/test/selftest.ts  (or: bun …/selftest.ts)
 * Prints a markdown table; exits 1 on any mismatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyToolCall } from "../matcher.ts";

const dir = mkdtempSync(join(tmpdir(), "db-guard-"));
const fixtures: Record<string, string> = {
	"read.sql": "-- report\nselect count(*) from profiles;\nselect id from runs limit 5;\n",
	"write.sql": "begin;\ndelete from sessions where created_at < now() - interval '30 days';\ncommit;\n",
	"package.json": JSON.stringify({
		scripts: {
			check: "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
			build: "vite build",
			"db:push": "supabase db push",
		},
	}),
	"writer.mjs": "import { createClient } from '@supabase/supabase-js';\nconst sb = createClient(process.env.SUPABASE_URL, process.env.KEY);\nawait sb.from('profiles').insert({ handle: 'x' });\n",
	"reader.mjs": "import { createClient } from '@supabase/supabase-js';\nconst sb = createClient(process.env.SUPABASE_URL, process.env.KEY);\nconsole.log(await sb.from('profiles').select('id').limit(1));\n",
	"wipe.sh": "#!/usr/bin/env bash\nset -e\npsql \"$DATABASE_URL\" -c 'TRUNCATE sessions'\n",
};
for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), body);
mkdirSync(join(dir, "scripts", "admin"), { recursive: true });

type Case = [label: string, tool: string, input: Record<string, unknown>, expectBlock: boolean];
const bash = (command: string): Record<string, unknown> => ({ command });
const js = (code: string): Record<string, unknown> => ({ language: "js", code });
const py = (code: string): Record<string, unknown> => ({ language: "py", code });

const throwingCwd = (command: string): Record<string, unknown> =>
	Object.defineProperty({ command }, "cwd", {
		enumerable: true,
		get() {
			throw new Error("boom");
		},
	});

const cases: Case[] = [
	// ---- must block
	["supabase db push", "bash", bash("supabase db push"), true],
	["npx supabase db reset --linked", "bash", bash("npx supabase db reset --linked"), true],
	["supabase migration repair", "bash", bash("supabase migration repair --status applied 0091"), true],
	["supabase migration up", "bash", bash("supabase migration up"), true],
	["supabase db execute", "bash", bash("supabase db execute --file x.sql"), true],
	["psql -c DELETE", "bash", bash(`psql "$DATABASE_URL" -c "DELETE FROM nonexistent_table_xyz"`), true],
	["psql -f write.sql", "bash", bash("psql -f write.sql"), true],
	["psql -Atc UPDATE … SET", "bash", bash(`psql $DB -Atc "update profiles set handle='x' where id=1"`), true],
	["heredoc INSERT | psql", "bash", bash(`cat <<'SQL' | psql "$DB"\nINSERT INTO t VALUES (1);\nSQL`), true],
	["echo DROP | psql", "bash", bash(`echo "DROP TABLE users;" | psql $DB`), true],
	["psql interactive", "bash", bash(`psql "$DATABASE_URL"`), true],
	["psql -c GRANT", "bash", bash(`psql -c "GRANT ALL ON TABLE x TO anon"`), true],
	["psql -c VACUUM (non-read)", "bash", bash(`psql -c "VACUUM FULL profiles"`), true],
	["timeout psql -f missing.sql", "bash", bash(`timeout 60 psql "$DB" -f does-not-exist.sql`), true],
	["pg_restore --clean", "bash", bash(`pg_restore -d "$DB" --clean dump.backup`), true],
	["node -e pg ALTER", "bash", bash(`node -e "const {Client}=require('pg');const c=new Client();await c.query('ALTER TABLE x ADD COLUMN y int')"`), true],
	["curl -X POST rest/v1", "bash", bash(`curl -X POST "https://abc.supabase.co/rest/v1/profiles" -H "apikey: $K" -d '{"a":1}'`), true],
	["curl -X DELETE auth admin", "bash", bash(`curl -s -X DELETE "$SUPABASE_URL/auth/v1/admin/users/123" -H "Authorization: Bearer $K"`), true],
	["curl -d rpc (implicit POST)", "bash", bash(`curl https://abc.supabase.co/rest/v1/rpc/refresh_totals -H "apikey: $K" -d '{}'`), true],
	["pwsh Invoke-RestMethod PATCH", "bash", bash(`pwsh -Command 'Invoke-RestMethod -Method Patch -Uri https://abc.supabase.co/rest/v1/x -Body $b'`), true],
	["redis-cli DEL", "bash", bash("redis-cli -h cache.local DEL leaderboard:nfl"), true],
	["redis-cli FLUSHALL", "bash", bash("redis-cli FLUSHALL"), true],
	["Upstash REST /set", "bash", bash(`curl "$UPSTASH_REDIS_REST_URL/set/foo/bar" -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN"`), true],
	["wrangler d1 execute", "bash", bash(`npx wrangler d1 execute prod-db --command "SELECT 1"`), true],
	["node scripts/admin/*", "bash", bash("node scripts/admin/grant-supporter.mjs --user 5"), true],
	["run-with-keys.mjs", "bash", bash("node scripts/admin/run-with-keys.mjs scripts/admin/kpi-cohorts.mjs"), true],
	["bun mig-*", "bash", bash("bun tmp/mig-0091-fix.ts"), true],
	["npx tsx *purge*", "bash", bash("npx tsx scripts/handle-purge.ts"), true],
	["npm run db:push → supabase db push", "bash", bash("npm run db:push"), true],
	["bash -c nested TRUNCATE", "bash", bash(`bash -c "psql \\$DB -c 'TRUNCATE sessions'"`), true],
	["supaq.sh rpc", "bash", bash(`~/.claude/supaq.sh rpc refresh_run_board_totals '{"p_game":"nfl"}'`), true],
	["node writer.mjs (supabase .insert)", "bash", bash("node writer.mjs"), true],
	["bash wipe.sh (psql TRUNCATE inside)", "bash", bash("bash wipe.sh"), true],
	["eval js supabase .update(", "eval", js(`import { createClient } from "@supabase/supabase-js";\nconst sb = createClient(url, key);\nawait sb.from("profiles").update({ x: 1 }).eq("id", 1);`), true],
	["eval py psycopg2 DELETE", "eval", py(`import psycopg2\nconn = psycopg2.connect(dsn)\ncur = conn.cursor()\ncur.execute("DELETE FROM x WHERE id = 1")`), true],
	["eval js ioredis .del(", "eval", js(`const Redis = require("ioredis");\nconst r = new Redis(process.env.REDIS_URL);\nawait r.del("k");`), true],
	["eval py subprocess psql DROP", "eval", py(`import subprocess\nsubprocess.run("psql -c 'DROP TABLE x'", shell=True)`), true],
	["eval js auth.admin.deleteUser", "eval", js(`await supabase.auth.admin.deleteUser(id)`), true],
	["write proc:// DELETE into psql", "write", { path: "proc://psql-1", content: "DELETE FROM x;" }, true],
	["MCP execute_sql INSERT", "mcp_supabase_execute_sql", { project_id: "p", query: "insert into x values (1)" }, true],
	["MCP apply_migration", "mcp_supabase_apply_migration", { name: "m", query: "create table t (id int)" }, true],
	["fail-safe: matcher throws on DB text", "bash", throwingCwd(`psql -c "DELETE FROM x"`), true],
	// ---- marker passes
	["OMP_DB_APPROVED=1 psql DELETE", "bash", bash(`OMP_DB_APPROVED=1 psql "$DATABASE_URL" -c "DELETE FROM nonexistent_table_xyz"`), false],
	["OMP_DB_APPROVED=1 in eval comment", "eval", js(`// OMP_DB_APPROVED=1\nimport { createClient } from "@supabase/supabase-js";\nawait createClient(u, k).from("t").insert({})`), false],
	// ---- must pass
	["psql -c SELECT 1", "bash", bash(`psql "$DATABASE_URL" -c "SELECT 1"`), false],
	["psql -Atc select count(*)", "bash", bash(`psql $DB -Atc "select count(*) from profiles"`), false],
	["psql -f read.sql", "bash", bash("psql -f read.sql"), false],
	["git status", "bash", bash("git status"), false],
	["git commit msg mentions DROP TABLE", "bash", bash(`git commit -m "fix: DROP TABLE handling in migration docs"`), false],
	["git add .sql + heredoc commit msg", "bash", bash(`git add supabase/migrations/0091_x.sql && git commit -m "$(cat <<'EOF'\nfeat: create table leagues\n\nDELETE FROM legacy rows is handled in 0092\nEOF\n)"`), false],
	["npm run check", "bash", bash("npm run check"), false],
	["npm run build", "bash", bash("npm run build"), false],
	["npm test / npm install", "bash", bash("npm install && npx vitest run src/lib/delete-account.test.ts"), false],
	["npx svelte-check", "bash", bash("npx svelte-check --tsconfig ./tsconfig.json"), false],
	["curl GET rest/v1", "bash", bash(`curl -s "https://abc.supabase.co/rest/v1/profiles?select=id&limit=1" -H "apikey: $KEY"`), false],
	["supaq.sh count", "bash", bash(`~/.claude/supaq.sh count 'profiles?handle=is.null'`), false],
	["supaq.sh get", "bash", bash(`bash ~/.claude/supaq.sh get 'runs?select=id&limit=5'`), false],
	["redis-cli GET", "bash", bash("redis-cli GET leaderboard:nfl"), false],
	["rg for DELETE FROM", "bash", bash(`rg -n "DELETE FROM" supabase/migrations`), false],
	["cat write.sql", "bash", bash("cat write.sql"), false],
	["supabase migration list / db diff", "bash", bash("supabase migration list && supabase db diff --schema public"), false],
	["pg_dump > backup.sql", "bash", bash(`pg_dump "$DB" --schema-only > backup.sql`), false],
	["node reader.mjs (supabase select only)", "bash", bash("node reader.mjs"), false],
	["eval js supabase select only", "eval", js(`import { createClient } from "@supabase/supabase-js";\nconst { data } = await createClient(u, k).from("runs").select("id").limit(5);\ndisplay(data);`), false],
	["eval py pandas csv", "eval", py(`import pandas as pd\ndf = pd.read_csv("x.csv")\ndf.head()`), false],
	["write a migration file", "write", { path: "supabase/migrations/0092_x.sql", content: "DROP TABLE legacy;" }, false],
	["edit tool with SQL text", "edit", { input: "PUT 1:\n+DELETE FROM x;" }, false],
	["read tool", "read", { path: "supabase/migrations/0091_x.sql" }, false],
	["MCP list_tables", "mcp_supabase_list_tables", { project_id: "p" }, false],
	["fail-safe: matcher throws on plain text", "bash", throwingCwd("git status"), false],
];

let failures = 0;
const rows: string[] = [
	"| # | tool | input | expected | got | matched |",
	"|---|------|-------|----------|-----|---------|",
];
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, "⏎").slice(0, 110);
cases.forEach(([label, tool, input, expectBlock], i) => {
	const v = classifyToolCall(tool, input, dir);
	const blocked = v.db && !v.approved;
	const ok = blocked === expectBlock;
	if (!ok) failures++;
	const shown = typeof input.command === "string" ? input.command : typeof input.code === "string" ? input.code : JSON.stringify(input);
	const got = v.db && v.approved ? "ALLOW (marker)" : blocked ? "BLOCK" : "ALLOW";
	rows.push(
		`| ${i + 1} | ${tool} | \`${cell(shown)}\` | ${expectBlock ? "BLOCK" : "ALLOW"} | ${ok ? "" : "❌ "}${got} | ${cell(v.reasons.join("; ") || label)} |`,
	);
});
rmSync(dir, { recursive: true, force: true });
console.log(rows.join("\n"));
console.log(`\n${cases.length} cases, ${cases.length - failures} pass, ${failures} fail`);
process.exitCode = failures ? 1 : 0;
