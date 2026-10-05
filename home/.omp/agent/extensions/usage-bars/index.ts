/**
 * usage-bars — compact provider quota status immediately above the main editor.
 *
 * Data source: `omp usage --json --no-extensions`, the documented machine-readable
 * form of the same live usage path as `/usage`. The command owns provider fetching
 * and its cache TTL; this extension neither reads credentials nor calls provider APIs.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WIDGET_ID = "usage-bars";
const REFRESH_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const FULL_WIDTH = 100;
const PROVIDERS = [
	{ id: "anthropic", name: "Claude" },
	{ id: "openai-codex", name: "Codex" },
	{ id: "cursor", name: "Cursor" },
] as const;

interface UsageLimit {
	scope?: { windowId?: string };
	window?: { id?: string; resetsAt?: number };
	amount?: { usedFraction?: number };
	status?: string;
}

interface UsageReport {
	provider?: string;
	limits?: UsageLimit[];
}

interface UsagePayload {
	reports?: UsageReport[];
}

interface Quota {
	name: string;
	fraction?: number;
	window?: string;
	resetsAt?: number;
}

interface ThemeLike {
	fg?: (color: string, text: string) => string;
}

interface TuiLike {
	terminal?: { columns?: number };
	requestRender?: () => void;
}

interface WidgetComponent {
	render(width: number): string[];
	invalidate(): void;
}

interface UiLike {
	setWidget?: (
		id: string,
		content: ((tui: TuiLike, theme: ThemeLike) => WidgetComponent) | undefined,
		options?: { placement: "aboveEditor" | "belowEditor" },
	) => void;
}

interface HostContext {
	hasUI?: boolean;
	mode?: string;
	agent?: { kind?: string };
	ui?: UiLike;
	setInterval?: (callback: () => void, ms: number) => unknown;
}

function parseReports(raw: string): UsageReport[] | undefined {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || !("reports" in parsed)) return undefined;
		const reports = (parsed as UsagePayload).reports;
		return Array.isArray(reports) ? reports : undefined;
	} catch {
		return undefined;
	}
}

function quotasFromReports(reports: UsageReport[]): Quota[] {
	const candidates = new Map<string, UsageLimit[]>();
	for (const report of reports) {
		if (!report?.provider || !Array.isArray(report.limits)) continue;
		const limits = candidates.get(report.provider) ?? [];
		limits.push(...report.limits);
		candidates.set(report.provider, limits);
	}

	return PROVIDERS.map(provider => {
		const valid = (candidates.get(provider.id) ?? []).filter(limit => {
			const fraction = limit.amount?.usedFraction;
			return limit.status !== "error" && typeof fraction === "number" && Number.isFinite(fraction);
		});
		const mostConstrained = valid.reduce<UsageLimit | undefined>((best, limit) => {
			if (!best) return limit;
			return (limit.amount?.usedFraction ?? -1) > (best.amount?.usedFraction ?? -1) ? limit : best;
		}, undefined);
		if (!mostConstrained) return { name: provider.name };
		return {
			name: provider.name,
			fraction: Math.max(0, Math.min(1, mostConstrained.amount?.usedFraction ?? 0)),
			window: mostConstrained.scope?.windowId ?? mostConstrained.window?.id,
			resetsAt: mostConstrained.window?.resetsAt,
		};
	});
}

/**
 * Ask omp's supported usage command for normalized reports. Its own cache determines
 * whether providers need refreshing, so a five-minute widget tick cannot bypass or
 * outpace omp's normal fetch policy.
 */
async function readLiveQuotas(): Promise<Quota[] | undefined> {
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		child = Bun.spawn(["omp", "usage", "--json", "--no-extensions"], {
			stdout: "pipe",
			stderr: "ignore",
			windowsHide: true,
		});
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout = setTimeout(() => reject(new Error("usage refresh timed out")), FETCH_TIMEOUT_MS);
		});
		const output = await Promise.race([new Response(child.stdout).text(), timedOut]);
		const exitCode = await Promise.race([child.exited, timedOut]);
		if (exitCode !== 0) return undefined;
		const reports = parseReports(output);
		return reports ? quotasFromReports(reports) : undefined;
	} catch {
		try {
			child?.kill();
		} catch {}
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

function windowTag(window: string | undefined): string {
	if (!window) return "—";
	const normalized = window.toLowerCase();
	if (normalized === "monthly") return "mo";
	if (normalized.includes("5") && normalized.includes("h")) return "5h";
	if (normalized.includes("7") && normalized.includes("d")) return "7d";
	return normalized.slice(0, 3);
}

function resetLabel(timestamp: number | undefined, now = new Date()): string {
	if (!timestamp || !Number.isFinite(timestamp)) return "—";
	const reset = new Date(timestamp);
	if (Number.isNaN(reset.getTime())) return "—";
	if (
		reset.getFullYear() === now.getFullYear() &&
		reset.getMonth() === now.getMonth() &&
		reset.getDate() === now.getDate()
	) {
		return reset
			.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
			.replace(/\s/g, "")
			.toLowerCase();
	}
	return reset.toLocaleDateString([], { month: "short", day: "numeric" });
}

function percent(quota: Quota): string {
	return quota.fraction === undefined ? "—" : `${Math.round(quota.fraction * 100)}%`;
}

function colorFor(quota: Quota): string {
	const used = quota.fraction ?? 0;
	if (used > 0.85) return "error";
	if (used >= 0.6) return "warning";
	return "success";
}

function plainRows(quotas: Quota[], width: number): string[] {
	const compact = width < FULL_WIDTH;
	const chunks = quotas.map(quota => {
		if (quota.fraction === undefined) return `${quota.name} —`;
		const usage = percent(quota);
		const tag = windowTag(quota.window);
		const reset = resetLabel(quota.resetsAt);
		if (compact) return `${quota.name} ${usage} ${tag} ${reset}`;
		const filled = Math.round(quota.fraction * 10);
		return `${quota.name} ${"▰".repeat(filled)}${"▱".repeat(10 - filled)} ${usage} ${tag} · ${reset}`;
	});
	const one = chunks.join("  ");
	if (one.length <= width) return [one];
	const first = `${chunks[0]}  ${chunks[1]}`;
	if (first.length <= width) {
		const second = chunks[2].length <= width ? chunks[2] : `${chunks[2].slice(0, Math.max(0, width - 1))}…`;
		return [first, second];
	}
	const firstOnly = chunks[0].length <= width ? chunks[0] : `${chunks[0].slice(0, Math.max(0, width - 1))}…`;
	const rest = `${chunks[1]}  ${chunks[2]}`;
	const second = rest.length <= width ? rest : `${rest.slice(0, Math.max(0, width - 1))}…`;
	return [firstOnly, second];
}

function paintQuota(theme: ThemeLike, quota: Quota, compact: boolean): string {
	const fg = (color: string, text: string): string => {
		try {
			return theme.fg?.(color, text) ?? text;
		} catch {
			return text;
		}
	};
	if (quota.fraction === undefined) return `${quota.name} ${fg("dim", "—")}`;
	const usage = percent(quota);
	const tag = fg("dim", windowTag(quota.window));
	const reset = resetLabel(quota.resetsAt);
	if (compact) return `${quota.name} ${fg(colorFor(quota), usage)} ${tag} ${fg("dim", reset)}`;
	const filled = Math.round(quota.fraction * 10);
	const bar = fg(colorFor(quota), "▰".repeat(filled)) + fg("dim", "▱".repeat(10 - filled));
	return `${quota.name} ${bar} ${fg(colorFor(quota), usage)} ${tag} ${fg("dim", `· ${reset}`)}`;
}

class UsageBarsComponent implements WidgetComponent {
	#quotas: Quota[] = PROVIDERS.map(provider => ({ name: provider.name }));
	#lastWidth = 160;
	#lastPlain = "";

	constructor(
		private readonly tui: TuiLike,
		private readonly theme: ThemeLike,
	) {}

	refresh(next: Quota[]): boolean {
		const width = this.tui.terminal?.columns ?? this.#lastWidth;
		const nextPlain = plainRows(next, width).join("\n");
		this.#quotas = next;
		if (nextPlain === this.#lastPlain) return false;
		this.#lastPlain = nextPlain;
		return true;
	}

	requestRender(): void {
		try {
			this.tui.requestRender?.();
		} catch {}
	}

	render(width: number): string[] {
		try {
			this.#lastWidth = Math.max(1, width);
			const compact = width < FULL_WIDTH;
			const styledChunks = this.#quotas.map(quota => paintQuota(this.theme, quota, compact));
			const plain = plainRows(this.#quotas, width);
			this.#lastPlain = plain.join("\n");
			// At extremely small widths, ANSI-aware truncation would risk terminal wrapping.
			if (width < 50) return plain;
			if (plain.length === 1) return [styledChunks.join("  ")];
			if (plain[0].startsWith(`${this.#quotas[0]?.name} `) && plain[0].includes(this.#quotas[1]?.name ?? "\0")) {
				return [styledChunks.slice(0, 2).join("  "), styledChunks[2]];
			}
			return [styledChunks[0], styledChunks.slice(1).join("  ")];
		} catch {
			return ["Claude —   Codex —   Cursor —"];
		}
	}

	invalidate(): void {}
}

export default function usageBars(pi: ExtensionAPI): void {
	pi.setLabel("Usage bars");
	let active: { ctx: HostContext; component: UsageBarsComponent } | undefined;
	let refreshing = false;

	pi.on("session_start", async (_event, rawContext) => {
		try {
			const ctx = rawContext as unknown as HostContext;
			if (ctx.agent?.kind !== "main" || !ctx.hasUI || ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function") return;
			let component: UsageBarsComponent | undefined;
			ctx.ui.setWidget(
				WIDGET_ID,
				(tui, theme) => {
					component = new UsageBarsComponent(tui, theme);
					active = { ctx, component };
					return component;
				},
				{ placement: "aboveEditor" },
			);
			const refresh = async (): Promise<void> => {
				if (refreshing || !component || active?.ctx !== ctx) return;
				refreshing = true;
				try {
					const quotas = await readLiveQuotas();
					if (quotas && component.refresh(quotas)) component.requestRender();
				} catch {
					// A refresh must never affect typing or the host event loop.
				} finally {
					refreshing = false;
				}
			};
			void refresh();
			ctx.setInterval?.(() => void refresh(), REFRESH_MS);
		} catch {
			// Extension startup is strictly best-effort.
		}
	});

	pi.on("session_shutdown", async (_event, rawContext) => {
		try {
			const ctx = rawContext as unknown as HostContext;
			if (active?.ctx !== ctx) return;
			try {
				ctx.ui?.setWidget?.(WIDGET_ID, undefined, { placement: "aboveEditor" });
			} catch {}
			active = undefined;
		} catch {}
	});
}
