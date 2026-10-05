/**
 * agent-monitor — always-visible status panels over the top of the omp TUI.
 *
 *   ┌ task board (top-left overlay) ───────────────┐ ┌ agent box ┐ ┐
 *   │ every column the right column does not use   │ │           │ │ right column
 *   └──────────────────────────────────────────────┘ └───────────┘ │ (top-right overlay,
 *                                                     ┌ subagents ┐ │  agent-box width)
 *                                                     └───────────┘ │
 *                                                     ┌ todo      ┐ │
 *                                                     └───────────┘ ┘
 *
 * Data:   agents — AgentRegistry.global() (exported by "@oh-my-pi/pi-coding-agent"); the same
 *         process-wide registry that feeds Agent Hub (Alt+A) and the pinned Subagents block.
 *         tasks  — the MAIN session's todo phases. Seeded on session_start by replaying
 *         ctx.sessionManager.getBranch() (successful `todo` toolResult `details.phases` and
 *         `user_todo_edit` custom entries, the same snapshots TodoTracker restores from;
 *         omp://tools/todo.md "Side Effects", omp://session.md `user_todo_edit`), kept live by the
 *         `tool_result` hook (omp://extensions.md §Tool events) and an incremental branch rescan
 *         on each tick (catches /todo edits, which produce no tool result).
 * Render: two ctx.ui.custom(factory, { overlay: true, overlayOptions }) overlays, because an
 *         overlay is one painted rectangle and this layout is L-shaped. Both share one set of
 *         the focus/hasOverlay workarounds below. The right column stops above the bottom chrome
 *         (editor, status line, widgets), measured from the root TUI's children every second.
 *
 * The TUI focuses every overlay it shows and reports it through tui.hasOverlay(), which
 * the interactive controller uses to suppress global shortcuts (Ctrl+O, Ctrl+R, ...).
 * Passive panels must do neither, so after showing each one this module
 *   1. marks its overlay-stack entry `released` and hands focus back (the state the TUI
 *      itself uses for pointer-released overlays), and
 *   2. shadows tui.hasOverlay() on the instance so these panels are not counted.
 * Both are undone when the panels are hidden or the session shuts down.
 *
 * Command: /agent-monitor [on|off|toggle]
 * Roster: registered farm workers (farm.json next to this file, panel order) stay first;
 *         other agents appear only while running or for two minutes after finishing.
 *         Parked helpers stay hidden.
 * Meaning: omp's todo tool allows one in_progress item, so the manager parks the rest as
 *         `blocked` with a typed reason; items are shown by that meaning (classifyTask), never
 *         as "blocked".
 * Board:  NEEDS YOU ("Needs <owner>" phase, or a blocker naming the owner; the action text stays loud),
 *         RUNNING (in_progress → Main; "running on <Agent>" → that agent, joined with its live
 *         registry activity), WAITING ("waiting on <X>"), QUEUED (pending, or any other reason
 *         such as "queued: …"), ✓ (done, for two minutes). Dropped tasks are hidden.
 * Column: agent box; "subagents" (every running agent with its current activity and run time);
 *         "todo" (Needs <owner> first; open items as "content · running · Bolt" / "· waiting · X" /
 *         "· queued · reason" / "NEEDS YOU · content · action"; done/dropped as counts).
 * HUD:    omp's own todo HUD (shown when the board is not) gets the same labels by rewriting
 *         its Text node before render (relabelTodoHud).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent";

const TICK_MS = 500;
const STATS_TTL_MS = 2_000;
const MAX_ROWS = 12; // farm of 11 + one running helper
const BUILTIN_FARM: string[] = [];
const FARM_FILE = join(import.meta.dir, "farm.json");

/** farm.json: { "farm": ["Ada", ...] } — worker ids in panel order (0-32). Invalid/missing → no farm rows. */
function loadFarm(): string[] {
	try {
		const parsed = JSON.parse(readFileSync(FARM_FILE, "utf8")) as { farm?: unknown };
		const ids = parsed?.farm;
		if (
			Array.isArray(ids) &&
			ids.length <= 32 &&
			ids.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(id)) &&
			new Set(ids).size === ids.length
		) {
			return ids as string[];
		}
	} catch {}
	return BUILTIN_FARM;
}

const FARM_ORDER: Readonly<Record<string, number | undefined>> = Object.fromEntries(loadFarm().map((id, i) => [id, i + 1]));
const FINISHED_TTL_MS = 2 * 60_000;
const MIN_COLS_COMPACT = 70; // below: hidden
const MIN_COLS_FULL = 100; // below: one-line badge
const BOTTOM_SCAN_MS = 1_000;
const BOTTOM_FALLBACK_ROWS = 8; // editor + status line + a widget, when the layout can't be measured

// ---------------------------------------------------------------- host shapes (structural)

type Status = "running" | "idle" | "parked" | "aborted" | "done";

interface SessionStats {
	tokens?: { input?: number; output?: number; cacheWrite?: number };
}

interface AgentSessionLike {
	model?: { provider?: string; id?: string };
	servingModel?: { selector?: string };
	getSessionStats?: () => SessionStats;
}

interface AgentRef {
	id: string;
	displayName?: string;
	kind?: string;
	status: "running" | "idle" | "parked" | "aborted";
	session?: AgentSessionLike | null;
	lastActivity?: number;
	activity?: string;
	history?: { resolvedModel?: string; modelRole?: string; metrics?: { tokens?: number } };
	lifecycle?: { acceptedAt?: number; terminalAt?: number };
}

interface Focusable {
	handleInput?: (data: string) => void;
}

interface OverlayOptionsLike {
	visible?: (columns: number, rows: number) => boolean;
}

interface OverlayEntry {
	component: unknown;
	options?: OverlayOptionsLike;
	preFocus?: Focusable;
	hidden?: boolean;
	released?: boolean;
}

interface RenderableLike {
	render?: (width: number) => string[];
	invalidate?: () => void;
}

interface TuiLike {
	overlayStack?: OverlayEntry[];
	terminal?: { columns?: number; rows?: number };
	/** Root layout: [header, transcript, ...pending, status, widgets, editor, footer]. */
	children?: RenderableLike[];
	hasOverlay?: () => boolean;
	getFocused?: () => unknown;
	setFocus?: (component: unknown) => void;
	requestRender?: () => void;
	/** Painted viewport rows ({ top: 0, length: 0 } while a fullscreen surface or resize owns it). */
	getMutableViewport?: () => { top: number; length: number };
	/** Called after every paint with the composited frame (overlays included); returns an unsubscribe. */
	addPaintListener?: (listener: (frame: PaintedFrame) => void) => () => void;
}

interface PaintedFrame {
	viewport?: string[];
	alt?: boolean;
	columns?: number;
}

interface ThemeLike {
	fg?: (color: string, text: string) => string;
	bg?: (color: string, text: string) => string;
}

interface OverlayHandle {
	hide(): void;
}

interface UiLike {
	custom?: (
		factory: (tui: TuiLike, theme: ThemeLike) => LinesComponent,
		options: { overlay: true; overlayOptions: object; onHandle: (handle: OverlayHandle) => void },
	) => Promise<unknown>;
	notify?: (message: string, level: "info" | "warning" | "error") => void;
}

/** One persisted session entry (omp://session.md §Entry Taxonomy); only the fields read here. */
interface BranchEntry {
	id?: string;
	type?: string;
	timestamp?: string;
	customType?: string;
	data?: { phases?: unknown };
	message?: { role?: string; toolName?: string; isError?: boolean; details?: { phases?: unknown } };
}

interface HostContext {
	hasUI?: boolean;
	mode?: string;
	agent?: { kind?: string };
	ui?: UiLike;
	sessionManager?: { getBranch?: () => BranchEntry[] };
	setInterval?: (fn: () => void, ms: number) => unknown;
}

interface Row {
	name: string;
	status: Status;
	model: string;
	activity: string;
	lastActivity: number;
	tokens?: number;
}

/** Registry view of one agent, keyed by lowercased id (main session under MAIN_KEY). */
interface LiveAgent {
	id: string;
	kind?: string;
	status: AgentRef["status"];
	activity: string;
	runningSince?: number;
}

const MAIN_KEY = "\0main";

interface Snapshot {
	rows: Row[];
	counts: Record<Status, number>;
	live: Map<string, LiveAgent>;
	error?: string;
}

interface Line {
	text: string;
	styled: string;
}

/** A styled run inside a box row: [theme color or undefined, plain text]. */
type Cell = [string | undefined, string];

/** One todo task as last seen, with the time its status/blocker last changed. */
interface TaskRecord {
	phase: string;
	content: string;
	status: string;
	blocker: string;
	since: number;
}

interface TodoState {
	tasks: TaskRecord[];
	/** Last branch entry folded in; absent → the next scan replays the whole branch. */
	lastEntryId?: string;
	lastScanAt: number;
}

type SlotName = "board" | "column";
const SLOT_NAMES: readonly SlotName[] = ["board", "column"];

interface PanelSlot {
	component?: LinesComponent;
	handle?: OverlayHandle;
	shown: boolean;
	pending: boolean;
}

interface MonitorState {
	enabled: boolean;
	ctx?: HostContext;
	tui?: TuiLike;
	renderer?: Renderer;
	slots: Record<SlotName, PanelSlot>;
	unpatch?: () => void;
	statsCache: Map<string, { at: number; tokens?: number }>;
	todo: TodoState;
	/** First time each agent id was seen running (cleared when it stops). */
	runningSince: Map<string, number>;
	/**
	 * Bottom chrome rows (re-measured each second), the last real viewport height, and the rows
	 * actually holding content in the last painted frame (the viewport is padded with blank rows
	 * to the terminal height when the frame is shorter, e.g. right after a restart).
	 */
	layout: { at: number; bottomRows: number; viewRows?: number; contentRows?: number };
	/** Transcript shaping: columns kept free on the right, blank rows kept on top; `restore` undoes the patch. */
	narrow: { reserve: number; top: number; restore?: () => void };
	/** Unsubscribes the paint listener that measures contentRows. */
	unpaint?: () => void;
	/**
	 * omp's built-in todo HUD above the editor: hidden while the board is shown (the board and
	 * the todo box carry the same list), relabelled by meaning otherwise. `kid` is the claimed
	 * root child; `restore` undoes the render shadow.
	 */
	hud: { hide: boolean; kid?: RenderableLike; restore?: () => void };
}

// Module state is shared by every session that rebinds this factory (main + subagents).
const STATE_KEY = Symbol.for("omp.user.agent-monitor");
const globalSlots = globalThis as unknown as Record<symbol, MonitorState | undefined>;
// Fields are filled in just below, which also upgrades a state object left by an older build.
const state: MonitorState = (globalSlots[STATE_KEY] ??= { enabled: true } as MonitorState);
state.slots ??= { board: { shown: false, pending: false }, column: { shown: false, pending: false } };
state.statsCache ??= new Map();
state.todo ??= { tasks: [], lastScanAt: 0 };
state.runningSince ??= new Map();
state.layout ??= { at: 0, bottomRows: BOTTOM_FALLBACK_ROWS };
state.narrow ??= { reserve: 0, top: 0 };
state.hud ??= { hide: false };

// ---------------------------------------------------------------- formatting

function cellWidth(s: string): number {
	try {
		return Bun.stringWidth(s);
	} catch {
		return s.length;
	}
}

/** Truncate to `w` cells (ellipsis) and pad to exactly `w`. Plain text only. */
function fit(text: string, w: number, align: "left" | "right" = "left"): string {
	if (w <= 0) return "";
	const clean = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
	let out = clean;
	if (cellWidth(clean) > w) {
		out = "";
		let used = 0;
		for (const ch of clean) {
			const cw = cellWidth(ch);
			if (used + cw > w - 1) break;
			out += ch;
			used += cw;
		}
		out += "…";
	}
	const pad = " ".repeat(Math.max(0, w - cellWidth(out)));
	return align === "right" ? pad + out : out + pad;
}

function ago(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

function formatTokens(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "—";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

const MODEL_FAMILIES = ["opus", "sonnet", "haiku", "codex", "gemini", "grok", "kimi", "glm", "deepseek", "qwen"];

function shortModel(ref: AgentRef): string {
	const s = ref.session;
	const live = s?.model ? `${s.model.provider ?? ""}/${s.model.id ?? ""}` : undefined;
	const raw = s?.servingModel?.selector ?? ref.history?.resolvedModel ?? live;
	if (!raw) return ref.history?.modelRole ?? "—";
	const sel = raw.toLowerCase();
	const slash = sel.indexOf("/");
	const provider = slash >= 0 ? sel.slice(0, slash) : "";
	const id = (slash >= 0 ? sel.slice(slash + 1) : sel).split(/[:@]/)[0];
	if (provider.includes("cursor")) return "cursor";
	const family = MODEL_FAMILIES.find(f => id.includes(f));
	if (family) return family;
	if (provider.includes("codex")) return "codex";
	if (id.startsWith("gpt-")) return id.slice(4);
	return id.replace(/^claude-/, "");
}

const STATUS_LABEL: Record<Status, string> = { running: "run", idle: "idle", parked: "park", aborted: "abrt", done: "done" };
const STATUS_COLOR: Record<Status, string> = { running: "accent", idle: "warning", parked: "dim", aborted: "error", done: "success" };
const STATUS_ORDER: Record<Status, number> = { running: 0, idle: 1, done: 2, parked: 3, aborted: 4 };
const IDLE_ACTIVITY: Record<Exclude<Status, "running">, string> = {
	idle: "waiting",
	done: "result delivered",
	parked: "on disk",
	aborted: "killed",
};

function tokensOf(ref: AgentRef, now: number): number | undefined {
	const cached = state.statsCache.get(ref.id);
	if (cached && now - cached.at < STATS_TTL_MS) return cached.tokens;
	let tokens: number | undefined;
	try {
		const stats = ref.session?.getSessionStats?.();
		if (stats) {
			tokens = (stats.tokens?.input ?? 0) + (stats.tokens?.output ?? 0) + (stats.tokens?.cacheWrite ?? 0);
		} else if (typeof ref.history?.metrics?.tokens === "number") {
			tokens = ref.history.metrics.tokens;
		}
	} catch {
		tokens = cached?.tokens;
	}
	state.statsCache.set(ref.id, { at: now, tokens });
	return tokens;
}

function snapshot(wantTokens: boolean): Snapshot {
	const counts: Record<Status, number> = { running: 0, idle: 0, parked: 0, aborted: 0, done: 0 };
	const live = new Map<string, LiveAgent>();
	let refs: AgentRef[];
	const now = Date.now();
	try {
		// Registry refs are host objects; AgentRef lists only the fields read here.
		const all = AgentRegistry.global().list() as unknown as AgentRef[];
		const seenRunning = new Set<string>();
		for (const r of all) {
			if (!r?.id) continue;
			if (r.status === "running") {
				seenRunning.add(r.id);
				if (!state.runningSince.has(r.id)) state.runningSince.set(r.id, now);
			}
			const main = r.kind === "main" || r.id === "Main";
			live.set(main ? MAIN_KEY : r.id.toLowerCase(), {
				id: r.id,
				kind: r.kind,
				status: r.status,
				activity: r.activity ?? "",
				runningSince: state.runningSince.get(r.id),
			});
		}
		for (const id of state.runningSince.keys()) if (!seenRunning.has(id)) state.runningSince.delete(id);
		refs = all.filter(r => r && r.kind !== "main" && r.kind !== "advisor" && r.id !== "Main");
	} catch (err) {
		return { rows: [], counts, live, error: `registry unavailable: ${err instanceof Error ? err.message : String(err)}` };
	}
	const rows: Row[] = [];
	for (const ref of refs) {
		if (!Object.hasOwn(FARM_ORDER, ref.id) && ref.status !== "running") {
			const finishedAt = ref.lifecycle?.terminalAt ?? ref.lifecycle?.acceptedAt;
			if (ref.status === "parked" || finishedAt === undefined || now - finishedAt >= FINISHED_TTL_MS) continue;
		}
		const status: Status = ref.status === "idle" && ref.lifecycle?.acceptedAt !== undefined ? "done" : ref.status;
		counts[status]++;
		let model = "—";
		try {
			model = shortModel(ref);
		} catch {}
		rows.push({
			// The id is the task `name` (Claude1, Codex2, ...); displayName is often the agent type.
			name: ref.id || ref.displayName || "?",
			status,
			model,
			activity: status === "running" ? ref.activity || "working" : IDLE_ACTIVITY[status],
			lastActivity: ref.lastActivity ?? now,
			tokens: wantTokens ? tokensOf(ref, now) : undefined,
		});
	}
	rows.sort((a, b) => (Object.hasOwn(FARM_ORDER, a.name) ? FARM_ORDER[a.name]! : 9) - (Object.hasOwn(FARM_ORDER, b.name) ? FARM_ORDER[b.name]! : 9)
		|| STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity);
	return { rows, counts, live };
}

// ---------------------------------------------------------------- todo source (main session)

const TODO_SCAN_MS = 1_000;

interface TodoItemLike {
	content?: unknown;
	status?: unknown;
	blocker?: unknown;
}

interface TodoPhaseLike {
	name?: unknown;
	tasks?: unknown;
}

/** Phases carried by a todo snapshot entry: a successful `todo` tool result or a `/todo` edit. */
function phasesOf(entry: BranchEntry): unknown[] | undefined {
	if (entry.type === "custom" && entry.customType === "user_todo_edit") {
		return Array.isArray(entry.data?.phases) ? entry.data.phases : undefined;
	}
	const msg = entry.type === "message" ? entry.message : undefined;
	if (msg?.role !== "toolResult" || msg.toolName !== "todo" || msg.isError) return undefined;
	return Array.isArray(msg.details?.phases) ? msg.details.phases : undefined;
}

/** Replace the task list with `phases`; a task keeps its `since` while its status and blocker are unchanged. */
function applyPhases(phases: unknown[], at: number): void {
	// Task content is unique across phases (the todo tool rejects duplicates), so it is the key.
	const prev = new Map(state.todo.tasks.map(t => [t.content, t]));
	const next: TaskRecord[] = [];
	for (const p of phases as TodoPhaseLike[]) {
		if (!Array.isArray(p?.tasks)) continue;
		const phase = typeof p.name === "string" ? p.name : "";
		for (const t of p.tasks as TodoItemLike[]) {
			if (typeof t?.content !== "string" || typeof t.status !== "string") continue;
			const blocker = typeof t.blocker === "string" ? t.blocker : "";
			const old = prev.get(t.content);
			const since = old !== undefined && old.status === t.status && old.blocker === blocker ? old.since : at;
			next.push({ phase, content: t.content, status: t.status, blocker, since });
		}
	}
	state.todo.tasks = next;
}

/**
 * Fold branch entries appended since the last scan into the task list. When the last folded
 * entry is no longer on the branch (start, /branch, /tree, session switch) replay it all.
 */
function scanTodos(force: boolean): void {
	const manager = state.ctx?.sessionManager;
	if (typeof manager?.getBranch !== "function") return;
	const now = Date.now();
	if (!force && now - state.todo.lastScanAt < TODO_SCAN_MS) return;
	state.todo.lastScanAt = now;
	const branch = manager.getBranch();
	if (!Array.isArray(branch)) return;
	let start = 0;
	const last = force ? undefined : state.todo.lastEntryId;
	if (last !== undefined) {
		let i = branch.length - 1;
		while (i >= 0 && branch[i]?.id !== last) i--;
		start = i + 1;
	}
	if (start === 0) state.todo.tasks = [];
	for (let i = start; i < branch.length; i++) {
		const entry = branch[i];
		const phases = entry ? phasesOf(entry) : undefined;
		if (phases) applyPhases(phases, Date.parse(entry!.timestamp ?? "") || now);
	}
	state.todo.lastEntryId = branch.at(-1)?.id;
}

// ---------------------------------------------------------------- task board model

type BoardKind = "needs" | "working" | "waiting" | "queued" | "done";

interface BoardRow {
	kind: BoardKind;
	owner: string;
	task: string;
	detail: string;
	since: number;
}

/**
 * What an open todo item means, read from its phase and blocker note rather than its raw status.
 * omp's todo tool allows one in_progress item, so the manager parks everything else as `blocked`
 * with a typed reason (~/.omp/agent/APPEND_SYSTEM.md "Todo conventions"):
 *   "Needs <owner>" phase, or a blocker naming the owner → needs (who: owner, note: the action)
 *   "running on <Name>"                            → running (who: Name)
 *   "waiting on <X>"                               → waiting (who: X)
 *   any other reason ("queued: …", "starts when …") → queued  (note: reason, "queued:" stripped)
 * The word "blocked" is never shown for any of them.
 */
type TodoMeaning = "needs" | "active" | "running" | "waiting" | "queued" | "pending" | "done" | "dropped";

interface TodoView {
	meaning: TodoMeaning;
	who: string;
	note: string;
}

const DONE_TTL_MS = 2 * 60_000;
/** The human the manager reports to: "owner" in ~/.omp/farm.config.json (OMP_FARM_CONFIG overrides the path). */
function loadOwner(): string {
	try {
		const file = process.env.OMP_FARM_CONFIG || join(homedir(), ".omp", "farm.config.json");
		const owner = (JSON.parse(readFileSync(file, "utf8")) as { owner?: unknown })?.owner;
		if (typeof owner === "string" && /^[\p{L}\p{N} ._-]{1,40}$/u.test(owner.trim())) return owner.trim();
	} catch {}
	return "Owner";
}
const OWNER = loadOwner();
const OWNER_RE_SRC = OWNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const NEEDS_OWNER_PHASE = new RegExp(`^needs ${OWNER_RE_SRC}$`, "i");
const OWNER_WORD = new RegExp(`\\b${OWNER_RE_SRC}\\b`, "i");
const OWNER_LEAD = new RegExp(`^${OWNER_RE_SRC}\\b[\\s:·—-]*`, "i");
const RUNNING_ON = /^running on\s+([A-Za-z0-9_-]+)[\s:·—-]*(.*)$/i;
const WAITING_ON = /^waiting (?:on|for)\s+(.+)$/i;
const QUEUED_PREFIX = /^queued\s*[:·—-]?\s*/i;

function classifyTask(t: TaskRecord): TodoView {
	if (t.status === "completed") return { meaning: "done", who: "", note: "" };
	if (t.status === "abandoned") return { meaning: "dropped", who: "", note: "" };
	const blocked = t.status === "blocked";
	const reason = blocked ? t.blocker.trim() : "";
	const running = blocked ? RUNNING_ON.exec(reason) : null;
	if (running) return { meaning: "running", who: running[1]!, note: running[2]!.trim() };
	const waiting = blocked ? WAITING_ON.exec(reason) : null;
	if (NEEDS_OWNER_PHASE.test(t.phase.trim()) || (blocked && OWNER_WORD.test(reason))) {
		return { meaning: "needs", who: OWNER, note: waiting && OWNER_LEAD.test(waiting[1]!) ? waiting[1]!.replace(OWNER_LEAD, "") : reason };
	}
	if (waiting) return { meaning: "waiting", who: waiting[1]!.trim(), note: "" };
	if (blocked) return { meaning: "queued", who: "", note: reason.replace(QUEUED_PREFIX, "") };
	if (t.status === "in_progress") return { meaning: "active", who: "Main", note: "" };
	return { meaning: "pending", who: "", note: "" };
}

/** "content · running · Bolt" style text for one item, as shown in the todo box and the HUD. */
function meaningLabel(t: TaskRecord, v: TodoView): string {
	switch (v.meaning) {
		case "needs":
			return v.note ? `NEEDS YOU · ${t.content} · ${v.note}` : `NEEDS YOU · ${t.content}`;
		case "running":
			return `${t.content} · running · ${v.who}`;
		case "waiting":
			return `${t.content} · waiting · ${v.who}`;
		case "queued":
			return v.note ? `${t.content} · queued · ${v.note}` : `${t.content} · queued`;
		default:
			return t.content;
	}
}

/** Theme colour for each meaning: needs loud, running live, waiting/queued muted. */
const MEANING_COLOR: Record<TodoMeaning, string> = {
	needs: "error",
	active: "accent",
	running: "accent",
	waiting: "muted",
	queued: "muted",
	pending: "dim",
	done: "success",
	dropped: "error",
};

const BOARD_ORDER: Record<BoardKind, number> = { needs: 0, working: 1, waiting: 2, queued: 3, done: 4 };
const BOARD_BADGE: Record<BoardKind, string> = { needs: "NEEDS YOU", working: "RUNNING", waiting: "WAITING", queued: "QUEUED", done: "✓" };
const BOARD_BADGE_COLOR: Record<BoardKind, string> = { needs: "error", working: "accent", waiting: "muted", queued: "muted", done: "success" };
const BOARD_COUNT_LABEL: Record<BoardKind, string> = { needs: "needs you", working: "running", waiting: "waiting", queued: "queued", done: "done" };
const BOARD_BORDER = "borderAccent";
const BOX_BG = "customMessageBg";
const BOARD_MIN_LINES = 6;

function boardRows(live: Map<string, LiveAgent>, now: number): BoardRow[] {
	const rows: BoardRow[] = [];
	for (const t of state.todo.tasks) {
		const v = classifyTask(t);
		switch (v.meaning) {
			case "dropped":
				break;
			case "done":
				if (now - t.since < DONE_TTL_MS) rows.push({ kind: "done", owner: "", task: t.content, detail: "", since: t.since });
				break;
			case "needs":
				rows.push({ kind: "needs", owner: OWNER, task: t.content, detail: v.note, since: t.since });
				break;
			case "running": {
				const agent = live.get(v.who.toLowerCase());
				const running = agent?.status === "running";
				rows.push({
					kind: "working",
					owner: agent?.id ?? v.who,
					task: t.content,
					detail: agent === undefined ? "not in registry" : running ? agent.activity || "working" : agent.status,
					since: running && agent.runningSince !== undefined ? agent.runningSince : t.since,
				});
				break;
			}
			case "active":
				rows.push({ kind: "working", owner: "Main", task: t.content, detail: live.get(MAIN_KEY)?.activity ?? "", since: t.since });
				break;
			case "waiting":
				rows.push({ kind: "waiting", owner: "", task: t.content, detail: `waiting · ${v.who}`, since: t.since });
				break;
			case "queued":
				rows.push({ kind: "queued", owner: "", task: t.content, detail: v.note ? `queued · ${v.note}` : "queued", since: t.since });
				break;
			default:
				rows.push({ kind: "queued", owner: "", task: t.content, detail: t.phase, since: t.since });
		}
	}
	// Stable sort: todo order is kept within each group.
	return rows.sort((a, b) => BOARD_ORDER[a.kind] - BOARD_ORDER[b.kind]);
}

function boardCounts(rows: BoardRow[]): Record<BoardKind, number> {
	const counts: Record<BoardKind, number> = { needs: 0, working: 0, waiting: 0, queued: 0, done: 0 };
	for (const r of rows) counts[r.kind]++;
	return counts;
}

// ---------------------------------------------------------------- right column model

const SUBAGENTS_MAX_LINES = MAX_ROWS + 2;
/** Todo box icon per open meaning; done/dropped are folded into per-phase counts instead. */
const TODO_ICON: Partial<Record<TodoMeaning, string>> = {
	needs: "!",
	active: "▶",
	running: "●",
	waiting: "◷",
	queued: "○",
	pending: "○",
};

// ---------------------------------------------------------------- layout

type Layout = { mode: "hidden" } | { mode: "badge" } | { mode: "full"; width: number; tokens: boolean };

function layoutFor(cols: number): Layout {
	if (cols < MIN_COLS_COMPACT) return { mode: "hidden" };
	if (cols < MIN_COLS_FULL) return { mode: "badge" };
	if (cols >= 150) return { mode: "full", width: 62, tokens: true };
	if (cols >= 120) return { mode: "full", width: 54, tokens: false };
	return { mode: "full", width: 46, tokens: false };
}

function countsText(c: Record<Status, number>): string {
	const parts = [`${c.running} run`, `${c.idle} idle`, `${c.parked} park`];
	if (c.done) parts.push(`${c.done} done`);
	if (c.aborted) parts.push(`${c.aborted} abrt`);
	return parts.join(" · ");
}

/** Root children before the bottom chrome: header and transcript (TranscriptContainer). */
const NARROWED_CHILDREN = 2;

/**
 * Rows the panels may use from the top: the frame's real content height minus the bottom chrome,
 * i.e. every root child after the header and transcript (pending messages, status, widgets, usage
 * rows, editor, footer). The content height comes from the last painted frame (onPaint); before
 * the first paint it falls back to tui.getMutableViewport(), which counts blank padding rows.
 * The transcript itself is never rendered here: the TranscriptContainer tracks frame and
 * history-emission state through its render paths, so only the frame provider may drive it.
 */
function usableRows(cols: number, termRows: number): number {
	const now = Date.now();
	if (now - state.layout.at >= BOTTOM_SCAN_MS) {
		let bottomRows = BOTTOM_FALLBACK_ROWS;
		try {
			const kids = state.tui?.children;
			if (Array.isArray(kids) && kids.length > NARROWED_CHILDREN) {
				let sum = 0;
				for (const k of kids.slice(NARROWED_CHILDREN)) {
					if (typeof k?.render !== "function") continue;
					const lines = k.render(cols);
					// Still visible means not yet patched: claim it the first time it shows a todo tree.
					if (state.hud.restore === undefined && looksLikeTodoHud(lines)) {
						patchTodoHud(k);
						if (state.hud.hide) continue;
					}
					sum += lines.length;
				}
				bottomRows = Math.max(3, sum);
			}
		} catch {
			bottomRows = BOTTOM_FALLBACK_ROWS;
		}
		state.layout = { ...state.layout, at: now, bottomRows };
	}
	try {
		// { length: 0 } while a fullscreen view, resize settle or anchor recovery owns the screen:
		// keep the last real height rather than assuming the whole terminal.
		const viewport = state.tui?.getMutableViewport?.();
		if (viewport && viewport.length > 0) state.layout.viewRows = viewport.length;
	} catch {}
	const frameRows = Math.min(termRows, state.layout.viewRows ?? termRows, state.layout.contentRows ?? termRows);
	return frameRows - state.layout.bottomRows;
}

/**
 * The built-in todo HUD (a bottom-chrome root child) renders a blank row, a lone "TODO" row,
 * then a tree whose rows start with ├─ / └─. No setting hides it while tasks are open
 * (omp://tools/todo.md: only tasks.todoClearDelay, after every task is closed), and its class
 * names are minified, so it is recognised by that output.
 */
function looksLikeTodoHud(lines: string[]): boolean {
	const text = lines.map(l => l.replace(ANSI, "").trim()).filter(Boolean);
	return text.length >= 2 && text[0] === "TODO" && /^[├└]─/.test(text[1]!);
}

/** Shadow the HUD's render on the instance: nothing while `state.hud.hide`, otherwise unchanged. */
function patchTodoHud(kid: RenderableLike): void {
	const original = kid.render;
	if (typeof original !== "function") return;
	const hadOwn = Object.hasOwn(kid, "render");
	const patched = (width: number): string[] => (state.hud.hide ? [] : original.call(kid, width));
	kid.render = patched;
	state.hud.kid = kid;
	state.hud.restore = () => {
		if (kid.render !== patched) return;
		if (hadOwn) kid.render = original;
		else delete kid.render;
		try {
			kid.invalidate?.();
		} catch {}
	};
}

/**
 * Per HUD Text node: omp's original text, what this extension wrote, and the task list it was
 * written from (applyPhases swaps the array, so identity marks a todo change). A node whose
 * text is no longer `written` was rebuilt by omp.
 */
const hudWritten = new WeakMap<object, { original: string; written: string; tasks: TaskRecord[] }>();

/**
 * The HUD is a container holding one Text node, rebuilt by omp whenever the todo list changes;
 * each item is `fg(color, "<checkbox> <content>[ (blocked)]")` (no blocker note is shown). Each
 * parked or Needs <owner> item is rewritten to its meaning: "☐ content · running · Bolt" in accent,
 * "waiting · X" / "queued · reason" muted, "NEEDS YOU · content · action" in error. Items are
 * matched by exact content (unique across the list), so an unmatched shape is left unchanged.
 *
 * Relabels every Text node under `node`; true when one changed. Driven by update() (each tick
 * and every todo result), not by render(): below MIN_COLS_COMPACT nothing calls this child's
 * render() between todo changes, so a render-time rewrite never ran there.
 */
function relabelTodoHud(node: unknown, depth: number): boolean {
	if (!node || typeof node !== "object" || depth > 4) return false;
	let changed = false;
	if ("getText" in node && "setText" in node && typeof node.getText === "function" && typeof node.setText === "function") {
		const text: unknown = node.getText();
		if (typeof text === "string") {
			const seen = hudWritten.get(node);
			const original = seen !== undefined && seen.written === text ? seen.original : text;
			if (seen === undefined || seen.written !== text || seen.tasks !== state.todo.tasks) {
				const next = relabelHudText(original);
				if (next !== text) {
					node.setText(next);
					changed = true;
				}
				hudWritten.set(node, { original, written: next, tasks: state.todo.tasks });
			}
		}
	}
	if ("children" in node && Array.isArray(node.children)) for (const k of node.children) if (relabelTodoHud(k, depth + 1)) changed = true;
	return changed;
}

const SGR = "\\x1b\\[[0-9;]*m";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function relabelHudText(text: string): string {
	const r = state.renderer;
	if (!r) return text;
	let out = text;
	const needs: TaskRecord[] = [];
	let needsShown = false;
	for (const task of state.todo.tasks) {
		const v = classifyTask(task);
		if (v.meaning === "needs") needs.push(task);
		if (v.meaning !== "needs" && v.meaning !== "running" && v.meaning !== "waiting" && v.meaning !== "queued") continue;
		const item = new RegExp(`${SGR}([^\\x1b\\n]*?) ${escapeRegExp(task.content)}(?: \\(blocked\\))?${SGR}`);
		out = out.replace(item, (_m, box: string) => {
			if (v.meaning === "needs") needsShown = true;
			return r.fg(MEANING_COLOR[v.meaning], `${box} ${meaningLabel(task, v)}`);
		});
	}
	// The Needs <owner> heading. Collapsed (not the active phase, not /todo expand) it hides its
	// items, so it carries the first action; with its items listed it just says NEEDS YOU.
	const phase = needs.find(t => NEEDS_OWNER_PHASE.test(t.phase.trim()))?.phase;
	if (phase !== undefined) {
		const heading = new RegExp(`(\\x1b\\[1m)?${SGR}((?:[IVXLCDM]+\\. )?)${escapeRegExp(phase)}${SGR}`);
		out = out.replace(heading, (_m, bold: string | undefined, num: string) => {
			if (needsShown) return `${bold ?? ""}${r.fg("error", `${num}NEEDS YOU`)}`;
			const first = needs[0]!;
			const more = needs.length > 1 ? ` +${needs.length - 1} more` : "";
			return r.fg("error", `${num}NEEDS YOU · ${meaningLabel(first, classifyTask(first)).replace(/^NEEDS YOU · /, "")}${more}`);
		});
	}
	return out;
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]_P^][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Paint listener: the last row whose left part (outside the right column) has any visible text
 * is the bottom of the editor/status chrome. The overlays only cover the right column there,
 * and the board only covers top rows, so they never move this measurement.
 */
function onPaint(frame: PaintedFrame): void {
	try {
		const rows = frame.viewport;
		if (frame.alt || !Array.isArray(rows) || rows.length === 0) return;
		const left = Math.max(1, (frame.columns ?? state.tui?.terminal?.columns ?? 0) - state.narrow.reserve);
		for (let i = rows.length - 1; i >= 0; i--) {
			const row = rows[i];
			if (!row) continue;
			let used = 0;
			for (const ch of row.replace(ANSI, "")) {
				if (used >= left) break;
				if (ch.trim() !== "") {
					state.layout.contentRows = i + 1;
					return;
				}
				used += cellWidth(ch);
			}
		}
	} catch {
		// a paint must never throw out of the listener
	}
}

class Renderer {
	readonly #theme: ThemeLike;

	constructor(theme: ThemeLike) {
		this.#theme = theme;
	}

	/** Theme foreground for text outside the boxes (the HUD relabel). */
	fg(color: string, text: string): string {
		return this.#fg(color, text);
	}

	#fg(color: string, text: string): string {
		try {
			return this.#theme.fg ? this.#theme.fg(color, text) : text;
		} catch {
			return text;
		}
	}

	/** Box cells: every segment carries the box background so nothing behind shows through. */
	#paint(color: string | undefined, text: string): string {
		const fg = color === undefined ? text : this.#fg(color, text);
		try {
			return this.#theme.bg ? this.#theme.bg(BOX_BG, fg) : fg;
		} catch {
			return fg;
		}
	}

	/**
	 * A rounded, fully painted box. `body` rows must already be exactly `width - 4` cells;
	 * blank rows pad it to `height` when given.
	 */
	#box(width: number, label: string, labelColor: string, border: string, body: Cell[][], height?: number): Line[] {
		const inner = width - 4; // "│ " + content + " │"
		const title = `${fit(` ${label}`, width - 4).trimEnd()} `;
		const fill = "─".repeat(Math.max(0, width - 3 - cellWidth(title)));
		const out: Line[] = [
			{
				text: `╭─${title}${fill}╮`,
				styled: this.#paint(border, "╭─") + this.#paint(labelColor, title) + this.#paint(border, `${fill}╮`),
			},
		];
		const rows = [...body];
		while (height !== undefined && rows.length < height - 2) rows.push([[undefined, " ".repeat(inner)]]);
		for (const cells of rows) {
			out.push({
				text: `│ ${cells.map(c => c[1]).join("")} │`,
				styled:
					this.#paint(border, "│") +
					this.#paint(undefined, " ") +
					cells.map(([color, t]) => this.#paint(color, t)).join("") +
					this.#paint(undefined, " ") +
					this.#paint(border, "│"),
			});
		}
		const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
		out.push({ text: bottom, styled: this.#paint(border, bottom) });
		return out;
	}

	/** Narrow terminals: "[ tasks … ] [ agents … ]" on one line; the task part drops first. */
	badge(snap: Snapshot, tasks: BoardRow[], cols: number): Line[] {
		const c = snap.counts;
		const body = snap.error ? "agents n/a" : `agents ${c.running} run · ${c.idle + c.done} idle · ${c.parked} park`;
		const agents: Line = { text: `[ ${body} ]`, styled: this.#fg("dim", "[ ") + this.#fg("accent", body) + this.#fg("dim", " ]") };
		const room = cols - cellWidth(agents.text) - 1 - 4; // gap + "[ " + " ]"
		const t = boardCounts(tasks);
		const parts = [`${t.needs} you`, `${t.working} run`, `${t.queued} queue`];
		if (t.waiting) parts.push(`${t.waiting} wait`);
		const taskBody = `tasks ${parts.join(" · ")}`;
		if (room < 12) return [agents];
		const fitted = fit(taskBody, Math.min(room, cellWidth(taskBody)));
		return [
			{
				text: `[ ${fitted} ] ${agents.text}`,
				styled: `${this.#fg("dim", "[ ")}${this.#fg(t.needs ? "error" : "accent", fitted)}${this.#fg("dim", " ]")} ${agents.styled}`,
			},
		];
	}

	/** The agent box (unchanged look): dim border, one row per agent. */
	agents(snap: Snapshot, width: number, showTokens: boolean): Line[] {
		const inner = width - 4; // "│ " + content + " │"
		const out: Line[] = [];
		const border = (s: string) => this.#fg("dim", s);
		const push = (text: string, styled: string) => out.push({ text: `│ ${text} │`, styled: `${border("│")} ${styled} ${border("│")}` });

		const label = `${fit(` agents ${countsText(snap.counts)}`, width - 4).trimEnd()} `;
		const fill = "─".repeat(Math.max(0, width - 3 - cellWidth(label)));
		out.push({ text: `╭─${label}${fill}╮`, styled: border("╭─") + this.#fg("accent", label) + border(`${fill}╮`) });

		if (snap.error) {
			const t = fit(snap.error, inner);
			push(t, this.#fg("error", t));
		} else if (snap.rows.length === 0) {
			const t = fit("no agents", inner);
			push(t, this.#fg("dim", t));
		} else {
			const statW = 4;
			const nameW = 9;
			const modelW = 6;
			const tokW = 6;
			const ageW = 4;
			const fixed = statW + 1 + nameW + 1 + modelW + 1 + ageW + 1 + (showTokens ? tokW + 1 : 0);
			const actW = Math.max(4, inner - fixed);
			const now = Date.now();
			const visible = snap.rows.slice(0, MAX_ROWS);
			for (const r of visible) {
				const stat = fit(STATUS_LABEL[r.status], statW);
				const name = fit(r.name, nameW);
				const model = fit(r.model, modelW);
				const act = fit(r.activity, actW);
				const tokens = showTokens ? [fit(formatTokens(r.tokens), tokW, "right")] : [];
				const age = fit(ago(now - r.lastActivity), ageW, "right");
				push(
					[stat, name, model, act, ...tokens, age].join(" "),
					[
						this.#fg(STATUS_COLOR[r.status], stat),
						name,
						this.#fg("muted", model),
						r.status === "running" ? act : this.#fg("dim", act),
						...tokens.map(t => this.#fg("dim", t)),
						this.#fg("dim", age),
					].join(" "),
				);
			}
			const more = snap.rows.slice(visible.length).filter(r => Object.hasOwn(FARM_ORDER, r.name) || r.status === "running").length;
			if (more > 0) {
				const t = fit(`+${more} more`, inner);
				push(t, this.#fg("dim", t));
			}
		}

		const bottom = `╰${"─".repeat(Math.max(0, width - 2))}╯`;
		out.push({ text: bottom, styled: border(bottom) });
		return out;
	}

	/** Pad the agent box body with blank rows so it is `height` lines tall. */
	padAgents(lines: Line[], width: number, height: number): Line[] {
		if (lines.length >= height) return lines;
		const blank = " ".repeat(width - 4);
		const row = { text: `│ ${blank} │`, styled: `${this.#fg("dim", "│")} ${blank} ${this.#fg("dim", "│")}` };
		return [...lines.slice(0, -1), ...Array.from({ length: height - lines.length }, () => row), lines.at(-1)!];
	}

	board(rows: BoardRow[], width: number, height: number, now: number): Line[] {
		const inner = width - 4;
		const counts = boardCounts(rows);
		const kinds = Object.keys(BOARD_ORDER) as BoardKind[];
		const summary = kinds.filter(k => counts[k] > 0).map(k => `${counts[k]} ${BOARD_COUNT_LABEL[k]}`).join(" · ");
		const body: Cell[][] = [];
		const capacity = height - 2;
		if (rows.length === 0) {
			body.push([["dim", fit("nothing on the todo list", inner)]]);
		} else {
			const visible = rows.length > capacity ? rows.slice(0, capacity - 1) : rows;
			const badgeW = 9;
			const ownerW = inner >= 70 ? 10 : 7;
			const ageW = 4;
			const textW = Math.max(4, inner - badgeW - ownerW - ageW - 3);
			for (const r of visible) {
				const cells: Cell[] = [
					[BOARD_BADGE_COLOR[r.kind], fit(BOARD_BADGE[r.kind], badgeW)],
					[undefined, " "],
					[r.kind === "needs" ? "warning" : undefined, fit(r.owner, ownerW)],
					[undefined, " "],
				];
				const taskColor = r.kind === "needs" ? "warning" : r.kind === "done" || r.kind === "waiting" ? "muted" : undefined;
				// A Needs <owner> row's detail is the action the owner has to take, so it stays loud.
				const detailColor = r.kind === "needs" ? "warning" : "dim";
				if (r.detail && textW >= 40) {
					const taskW = Math.ceil((textW - 1) * 0.55);
					cells.push([taskColor, fit(r.task, taskW)], [undefined, " "], [detailColor, fit(r.detail, textW - 1 - taskW)]);
				} else {
					cells.push([taskColor, fit(r.detail ? `${r.task} · ${r.detail}` : r.task, textW)]);
				}
				cells.push([undefined, " "], ["dim", fit(ago(now - r.since), ageW, "right")]);
				body.push(cells);
			}
			if (visible.length < rows.length) body.push([["dim", fit(`+${rows.length - visible.length} more`, inner)]]);
		}
		return this.#box(width, `tasks ${summary || "none open"}`, counts.needs ? "error" : "accent", BOARD_BORDER, body, height);
	}

	/** Every running agent (helpers included) with its current activity and time running; [] when none. */
	subagents(snap: Snapshot, width: number, maxLines: number, now: number): Line[] {
		const running = [...snap.live.entries()].filter(([key, a]) => key !== MAIN_KEY && a.kind !== "advisor" && a.status === "running").map(e => e[1]);
		if (running.length === 0 || maxLines < 3) return [];
		const inner = width - 4;
		const nameW = 9;
		const ageW = 4;
		const actW = Math.max(4, inner - 2 - nameW - 1 - ageW - 1);
		const visible = running.length > maxLines - 2 ? running.slice(0, maxLines - 3) : running;
		const body: Cell[][] = visible.map(a => [
			["accent", "● "],
			[undefined, fit(a.id, nameW)],
			[undefined, " "],
			[undefined, fit(a.activity || "working", actW)],
			[undefined, " "],
			["dim", fit(a.runningSince === undefined ? "" : ago(now - a.runningSince), ageW, "right")],
		]);
		if (visible.length < running.length) body.push([["dim", fit(`+${running.length - visible.length} more`, inner)]]);
		return this.#box(width, `subagents ${running.length} running`, "accent", "dim", body);
	}

	/**
	 * Main-session todo list by phase: open and blocked items listed, done and dropped folded
	 * into a per-phase count. [] when nothing is open and nothing finished in the last 2 minutes.
	 */
	todo(width: number, maxLines: number, now: number): Line[] {
		const tasks = state.todo.tasks;
		const open = tasks.filter(t => t.status !== "completed" && t.status !== "abandoned").length;
		const recent = tasks.some(t => t.status === "completed" && now - t.since < DONE_TTL_MS);
		if ((open === 0 && !recent) || maxLines < 3) return [];
		const inner = width - 4;
		// Needs <owner> goes first, as on the board.
		const phases = new Map<string, TaskRecord[]>();
		for (const t of tasks) if (NEEDS_OWNER_PHASE.test(t.phase.trim())) phases.set(t.phase, []);
		for (const t of tasks) {
			const list = phases.get(t.phase);
			if (list) list.push(t);
			else phases.set(t.phase, [t]);
		}
		// Rows tagged with whether they are a task item (counted by "+N more").
		const rows: Array<{ item: boolean; cells: Cell[] }> = [];
		for (const [phase, list] of phases) {
			const done = list.filter(t => t.status === "completed").length;
			const dropped = list.filter(t => t.status === "abandoned").length;
			const closed = [done ? `✓${done}` : "", dropped ? `✗${dropped}` : ""].filter(Boolean).join(" ");
			const closedW = closed ? cellWidth(closed) + 1 : 0;
			rows.push({
				item: false,
				cells: [["accent", fit(phase || "Tasks", inner - closedW)], ...(closed ? ([["dim", fit(closed, closedW, "right")]] as Cell[]) : [])],
			});
			for (const t of list) {
				const v = classifyTask(t);
				const icon = TODO_ICON[v.meaning];
				if (!icon) continue;
				const color = MEANING_COLOR[v.meaning];
				const textColor = v.meaning === "needs" ? "warning" : v.meaning === "waiting" || v.meaning === "queued" ? "dim" : undefined;
				rows.push({ item: true, cells: [[undefined, "  "], [color, icon], [undefined, " "], [textColor, fit(meaningLabel(t, v), inner - 4)]] });
			}
		}
		const capacity = maxLines - 2;
		let body = rows;
		if (rows.length > capacity) {
			body = rows.slice(0, capacity - 1);
			const hidden = rows.slice(capacity - 1).filter(r => r.item).length;
			body.push({ item: false, cells: [["dim", fit(`+${hidden} more`, inner)]] });
		}
		const done = tasks.filter(t => t.status === "completed").length;
		return this.#box(width, `todo ${open} open · ${done}/${tasks.length} done`, "accent", "dim", body.map(r => r.cells));
	}
}

interface Frame {
	board: Line[];
	column: Line[];
	/** Columns the transcript must leave free on the right (right column + gap); 0 when none. */
	reserve: number;
	/** Blank rows to keep above the transcript; defaults to the board's height. */
	top?: number;
}

function buildFrame(r: Renderer, cols: number, termRows: number): Frame {
	const layout = layoutFor(cols);
	scanTodos(false);
	if (layout.mode === "hidden") {
		// No panels, but the built-in HUD still shows the todo list: claim it for the relabel.
		if (state.hud.restore === undefined && termRows > 0) usableRows(cols, termRows);
		return { board: [], column: [], reserve: 0 };
	}
	const now = Date.now();
	const snap = snapshot(layout.mode === "full" && layout.tokens);
	const tasks = boardRows(snap.live, now);
	const usable = termRows > 0 ? usableRows(cols, termRows) : Number.POSITIVE_INFINITY;
	// Badge mode: one line in the top-right corner; narrowing a 70-99 column transcript for it costs too much.
	if (layout.mode === "badge") return { board: [], column: usable >= 1 ? r.badge(snap, tasks, cols) : [], reserve: 0 };

	const agents = r.agents(snap, layout.width, layout.tokens);
	const height = Math.max(agents.length, Math.min(2 + Math.max(1, tasks.length), BOARD_MIN_LINES));
	if (height > usable) {
		// A short frame (just after a restart or /new) would never grow past the boxes on its own:
		// hidden boxes add no top margin, so the transcript stays short and the boxes stay hidden.
		// When the terminal itself has room, still reserve the margin and columns; the frame then
		// grows by `height` rows and the boxes appear on the next tick.
		const fits = termRows - state.layout.bottomRows >= height;
		return { board: [], column: [], reserve: fits ? layout.width + 1 : 0, top: fits ? height : 0 };
	}
	// The board's trailing space is the one-column gap before the agent box.
	const board = r.board(tasks, cols - layout.width - 1, height, now).map(l => ({ text: `${l.text} `, styled: `${l.styled} ` }));
	const column = r.padAgents(agents, layout.width, height);
	const gap: Line = { text: " ".repeat(layout.width), styled: " ".repeat(layout.width) };
	const sub = r.subagents(snap, layout.width, Math.min(SUBAGENTS_MAX_LINES, usable - column.length - 1), now);
	if (sub.length > 0) column.push(gap, ...sub);
	const todo = r.todo(layout.width, usable - column.length - 1, now);
	if (todo.length > 0) column.push(gap, ...todo);
	return { board, column, reserve: layout.width + 1 };
}

// ---------------------------------------------------------------- overlay components

class LinesComponent {
	#lines: string[] = [];
	#key = "";
	#width = 0;

	/** True when the visible text changed. */
	setLines(lines: Line[]): boolean {
		const key = lines.map(l => l.text).join("\n");
		if (key === this.#key) return false;
		this.#key = key;
		this.#width = lines.reduce((w, l) => Math.max(w, cellWidth(l.text)), 0);
		this.#lines = lines.map(l => l.styled);
		return true;
	}

	get width(): number {
		return this.#width;
	}

	get height(): number {
		return this.#lines.length;
	}

	render(_width: number): string[] {
		// The compositor clips lines wider than the overlay box itself.
		return this.#lines;
	}

	invalidate(): void {}

	/** Safety net: if focus ever lands here, hand it back and forward the keystroke. */
	handleInput(data: string): void {
		try {
			const entry = findEntry(this);
			if (entry) entry.released = true;
			const target = entry ? focusTarget(entry) : undefined;
			if (target) {
				state.tui?.setFocus?.(target);
				target.handleInput?.(data);
				state.tui?.requestRender?.();
			}
		} catch {
			// a keystroke must never throw out of the panel
		}
	}
}

// ---------------------------------------------------------------- overlay plumbing

function isOwn(component: unknown): boolean {
	return component !== undefined && SLOT_NAMES.some(n => state.slots[n].component === component);
}

function findEntry(component: unknown): OverlayEntry | undefined {
	const stack = state.tui?.overlayStack;
	if (!Array.isArray(stack) || component === undefined) return undefined;
	return stack.find(o => o.component === component);
}

/** The component focus belonged to before our panels: follows preFocus through our own overlays. */
function focusTarget(entry: OverlayEntry): Focusable | undefined {
	let target = entry.preFocus;
	for (let hops = 0; target !== undefined && isOwn(target) && hops < SLOT_NAMES.length; hops++) target = findEntry(target)?.preFocus;
	return target !== undefined && !isOwn(target) ? target : undefined;
}

/** Make tui.hasOverlay() ignore these panels so global shortcuts keep working. */
function patchHasOverlay(tui: TuiLike): () => void {
	const previous = tui.hasOverlay;
	if (typeof previous !== "function" || !Array.isArray(tui.overlayStack)) return () => {};
	const hadOwn = Object.hasOwn(tui, "hasOverlay");
	const patched = (): boolean => {
		try {
			const cols = tui.terminal?.columns ?? 0;
			const rows = tui.terminal?.rows ?? 0;
			return (tui.overlayStack ?? []).some(o => {
				if (isOwn(o.component) || o.hidden) return false;
				return typeof o.options?.visible === "function" ? Boolean(o.options.visible(cols, rows)) : true;
			});
		} catch {
			return previous.call(tui);
		}
	};
	tui.hasOverlay = patched;
	return () => {
		if (tui.hasOverlay !== patched) return;
		if (hadOwn) tui.hasOverlay = previous;
		else delete tui.hasOverlay;
	};
}

function releaseFocus(slot: PanelSlot): void {
	const entry = findEntry(slot.component);
	if (!entry) return;
	entry.released = true;
	if (state.tui?.getFocused?.() !== slot.component) return;
	const target = focusTarget(entry);
	if (target) state.tui?.setFocus?.(target);
}

function resetSlot(slot: PanelSlot): void {
	slot.handle = undefined;
	slot.component = undefined;
	slot.shown = false;
	slot.pending = false;
	if (SLOT_NAMES.every(n => state.slots[n].component === undefined)) {
		try {
			state.unpatch?.();
		} catch {}
		state.unpatch = undefined;
	}
}

function dropPanels(hide: boolean): void {
	for (const name of SLOT_NAMES) {
		const slot = state.slots[name];
		if (hide) {
			try {
				slot.handle?.hide();
			} catch {}
		}
		resetSlot(slot);
	}
	setTranscriptShape(0, 0);
	try {
		state.unpaint?.();
	} catch {}
	state.unpaint = undefined;
	state.layout.contentRows = undefined;
	try {
		state.hud.restore?.();
	} catch {}
	state.hud = { hide: false };
}

const MIN_TRANSCRIPT_COLS = 40;
/**
 * Width-first methods of the root header and the TranscriptContainer. The frame provider
 * (omp://tui-runtime-internals.md: Composer → TranscriptContainer) lays out the live viewport
 * and the history batches through these, not through render() alone.
 */
const NARROWED_METHODS = [
	"render",
	"liveRowCount",
	"renderViewport",
	"renderTail",
	"peekFinalizedBatch",
	"peekReplayBatch",
	"peekFlushBatch",
	"rerenderOfferedBatch",
];

/**
 * No setting narrows the transcript (`omp config list`: only tools.outputMaxColumns and image
 * caps), so the header and transcript components get their width-first methods shadowed on the
 * instance to lay out `reserve` columns narrower: text, tool cards and their output wrap left of
 * the right column. The TranscriptContainer also keeps its top `top` viewport rows blank (the
 * board's height): liveRowCount reports `top` extra rows, so the composer retires settled rows
 * into terminal history that much earlier, and renderViewport draws the live rows below `top`
 * blank ones. Nothing is measured per frame beyond what omp already measures. Feature-detected
 * per method; undone by setTranscriptShape(0, 0). Rows already written to terminal history keep
 * the width they had. True when the transcript must be re-rendered.
 */
function setTranscriptShape(reserve: number, top: number): boolean {
	if (reserve === state.narrow.reserve && top === state.narrow.top) return false;
	const root = state.tui?.children;
	const kids = Array.isArray(root) && root.length > NARROWED_CHILDREN ? root.slice(0, NARROWED_CHILDREN) : [];
	if (reserve > 0 || top > 0) {
		if (kids.length === 0) return false;
		if (state.narrow.restore === undefined) {
			const transcript = kids[NARROWED_CHILDREN - 1];
			const undo: Array<() => void> = [];
			for (const kid of kids) {
				// Host components: only own/inherited function slots named above are touched.
				const slots = kid as unknown as Record<string, unknown>;
				// A patched method calling another one (renderViewport → liveRowCount) must not shape twice.
				let depth = 0;
				for (const name of NARROWED_METHODS) {
					const original = slots[name];
					if (typeof original !== "function") continue;
					const hadOwn = Object.hasOwn(slots, name);
					// Reads the live reserve/top, so a change needs no re-patch.
					const patched = (...args: unknown[]): unknown => {
						if (depth > 0) return original.apply(kid, args);
						const width = args[0];
						if (typeof width === "number" && state.narrow.reserve > 0) {
							args[0] = Math.max(Math.min(width, MIN_TRANSCRIPT_COLS), width - state.narrow.reserve);
						}
						const margin = kid === transcript ? state.narrow.top : 0;
						depth++;
						try {
							if (margin > 0 && name === "renderViewport" && typeof args[1] === "number" && args[1] > margin) {
								args[1] -= margin;
								const rows = original.apply(kid, args);
								return Array.isArray(rows) ? [...Array.from({ length: margin }, () => ""), ...rows] : rows;
							}
							const result = original.apply(kid, args);
							return margin > 0 && name === "liveRowCount" && typeof result === "number" ? result + margin : result;
						} finally {
							depth--;
						}
					};
					slots[name] = patched;
					undo.push(() => {
						if (slots[name] !== patched) return;
						if (hadOwn) slots[name] = original;
						else delete slots[name];
					});
				}
			}
			state.narrow.restore = () => {
				for (const u of undo) u();
			};
		}
		state.narrow.reserve = reserve;
		state.narrow.top = top;
	} else {
		try {
			state.narrow.restore?.();
		} catch {}
		state.narrow = { reserve: 0, top: 0 };
	}
	for (const kid of kids) {
		try {
			kid?.invalidate?.();
		} catch {}
	}
	state.layout.at = 0; // the transcript's height changes with its shape
	return true;
}

/** Push a freshly built frame into both components; true when either changed. */
function update(): boolean {
	const tui = state.tui;
	const renderer = state.renderer;
	if (!tui || !renderer) return false;
	if (!state.unpaint && typeof tui.addPaintListener === "function") {
		try {
			state.unpaint = tui.addPaintListener(onPaint);
		} catch {}
	}
	const frame = buildFrame(renderer, tui.terminal?.columns ?? 0, tui.terminal?.rows ?? 0);
	let changed = false;
	for (const name of SLOT_NAMES) {
		if (state.slots[name].component?.setLines(frame[name])) changed = true;
	}
	if (setTranscriptShape(state.enabled ? frame.reserve : 0, state.enabled ? (frame.top ?? frame.board.length) : 0)) changed = true;
	const hideHud = state.enabled && frame.board.length > 0;
	if (hideHud !== state.hud.hide) {
		state.hud.hide = hideHud;
		state.layout.at = 0; // the bottom chrome just grew or shrank
		changed = true;
	}
	try {
		if (state.hud.kid !== undefined && !state.hud.hide && relabelTodoHud(state.hud.kid, 0)) changed = true;
	} catch {}
	return changed;
}

function overlayOptionsFor(name: SlotName): object {
	const slot = state.slots[name];
	const board = name === "board";
	return {
		anchor: board ? "top-left" : "top-right",
		margin: board ? { top: 0, left: 0 } : { top: 0, right: 0 },
		// The column's height is bounded by usableRows(); this only keeps the compositor from clipping it.
		maxHeight: board ? MAX_ROWS + 3 : 1_000,
		// Read by the compositor every frame, so each box tracks its content width.
		get width(): number {
			return Math.max(1, slot.component?.width ?? 1);
		},
		visible: (cols: number): boolean =>
			state.enabled && cols >= (board ? MIN_COLS_FULL : MIN_COLS_COMPACT) && (slot.component?.width ?? 0) > 0,
	};
}

function showSlot(name: SlotName, ctx: HostContext | undefined): void {
	const slot = state.slots[name];
	if (!ctx || slot.shown || slot.pending || !state.enabled) return;
	const ui = ctx.ui;
	if (!ctx.hasUI || ctx.mode !== "tui" || typeof ui?.custom !== "function") return;
	slot.pending = true;
	let own: LinesComponent | undefined;
	const result = ui.custom(
		(tui, theme) => {
			const component = new LinesComponent();
			own = component;
			state.tui = tui;
			state.renderer ??= new Renderer(theme ?? {});
			slot.component = component;
			try {
				update();
			} catch {}
			return component;
		},
		{
			overlay: true,
			overlayOptions: overlayOptionsFor(name),
			onHandle: handle => {
				try {
					slot.handle = handle;
					slot.shown = true;
					slot.pending = false;
					if (state.tui && !state.unpatch) state.unpatch = patchHasOverlay(state.tui);
					releaseFocus(slot);
					state.tui?.requestRender?.();
				} catch {
					try {
						handle.hide();
					} catch {}
					resetSlot(slot);
				}
			},
		},
	);
	// The custom() promise settles only if the host tears the overlay down itself.
	const settle = () => {
		if (slot.component === own) resetSlot(slot);
	};
	Promise.resolve(result).then(settle, settle);
}

function tick(): void {
	if (!state.enabled) return;
	for (const name of SLOT_NAMES) {
		const slot = state.slots[name];
		if (!slot.shown) {
			// One overlay at a time: the next one mounts once this one has released focus.
			showSlot(name, state.ctx);
			break;
		}
		const entry = findEntry(slot.component);
		if (!entry) {
			// Our entry was popped by someone else (e.g. tui.hideOverlay() on the wrong entry): re-show.
			resetSlot(slot);
			showSlot(name, state.ctx);
			break;
		}
		if (!entry.released) releaseFocus(slot);
	}
	// Still runs while a slot is mounting: below MIN_COLS_COMPACT the overlays never become
	// visible, and the frame update is what claims and relabels omp's todo HUD there.
	if (update()) state.tui?.requestRender?.();
}

// ---------------------------------------------------------------- extension

export default function agentMonitor(pi: ExtensionAPI): void {
	pi.setLabel("Agent Monitor");

	pi.on("session_start", async (_event, rawCtx) => {
		try {
			// Host context: HostContext lists the members used here (see omp://extensions.md §2).
			const ctx = rawCtx as unknown as HostContext;
			if (ctx.agent?.kind === "sub" || !ctx.hasUI || ctx.mode !== "tui") return;
			dropPanels(true);
			state.ctx = ctx;
			try {
				scanTodos(true);
			} catch {}
			showSlot("board", ctx);
			ctx.setInterval?.(() => {
				try {
					tick();
				} catch {}
			}, TICK_MS);
		} catch {
			// never break startup
		}
	});

	pi.on("session_shutdown", async (_event, rawCtx) => {
		try {
			const ctx = rawCtx as unknown as HostContext;
			if (ctx.agent?.kind === "sub" || (state.ctx && state.ctx !== ctx)) return;
			dropPanels(true);
			state.ctx = undefined;
			state.tui = undefined;
			state.statsCache.clear();
			state.todo = { tasks: [], lastScanAt: 0 };
			state.runningSince.clear();
			state.layout = { at: 0, bottomRows: BOTTOM_FALLBACK_ROWS };
		} catch {}
	});

	// Live todo updates from the main session (subagents have no todo tool of their own).
	pi.on("tool_result", async (rawEvent, rawCtx) => {
		try {
			const ctx = rawCtx as unknown as HostContext;
			const event = rawEvent as unknown as { toolName?: string; isError?: boolean; details?: { phases?: unknown } };
			if (ctx.agent?.kind === "sub" || event.toolName !== "todo" || event.isError) return;
			if (!Array.isArray(event.details?.phases)) return;
			applyPhases(event.details.phases, Date.now());
			if (update()) state.tui?.requestRender?.();
		} catch {}
	});

	// The branch changed under us: replay it on the next tick.
	for (const name of ["session_switch", "session_branch", "session_tree"] as const) {
		pi.on(name, async (_event, rawCtx) => {
			try {
				if ((rawCtx as unknown as HostContext).agent?.kind === "sub") return;
				state.todo.lastEntryId = undefined;
				state.todo.lastScanAt = 0;
			} catch {}
		});
	}

	pi.registerCommand("agent-monitor", {
		description: "Toggle the status panels (task board, agents, subagents, todo): /agent-monitor [on|off|toggle]",
		handler: async (args, rawCtx) => {
			const ctx = rawCtx as unknown as HostContext;
			try {
				const arg = String(args ?? "").trim().toLowerCase();
				state.enabled = arg === "on" ? true : arg === "off" ? false : !state.enabled;
				if (state.enabled) {
					state.ctx ??= ctx;
					showSlot("board", state.ctx);
				} else {
					dropPanels(true);
				}
				state.tui?.requestRender?.();
				ctx.ui?.notify?.(`agent-monitor ${state.enabled ? "on" : "off"}`, "info");
			} catch (err) {
				ctx.ui?.notify?.(`agent-monitor: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
