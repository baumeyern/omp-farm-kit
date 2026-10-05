/**
 * db-guard — hard safety net against accidental production-database changes by agents.
 *
 * Hook: `tool_call` (pre-execution; returning `{ block: true, reason }` stops the call). It fires for every
 * registry tool call (bash, eval, write proc://…, MCP/extension tools, nested dispatches) in the main
 * session AND in every subagent session (factories are rebound per child). The owner's own `!` shell commands
 * use the separate `user_bash` event and are deliberately not guarded.
 *
 * Policy (matcher.ts decides what "looks like a DB change"):
 *   - carries OMP_DB_APPROVED=1, or not a DB change  → allow silently
 *   - main session with a UI                        → (1) review dialog (confirm) showing tool, full command and
 *                                                     matched reasons; (2) input dialog where the owner must type exactly
 *                                                     APPROVE (trimmed, case-sensitive). Anything else blocks.
 *     The input dialog renders its title on one truncated line, so the full command is shown in step 1;
 *     choosing Yes there only advances to step 2 and never approves on its own.
 *   - subagent / headless                           → block with the approval-protocol reason
 *
 * Fail-safe: the handler never throws (a throwing tool_call handler blocks the call). The matcher blocks on
 * its own internal error only when the call mentions a database keyword.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { BLOCK_REASON, classifyToolCall, type Verdict } from "./matcher.ts";

export default function dbGuard(pi: ExtensionAPI): void {
	pi.setLabel("DB guard");

	pi.on("tool_call", async (event, ctx) => {
		let verdict: Verdict | undefined;
		try {
			const toolName = String(event.toolName ?? "");
			verdict = classifyToolCall(toolName, event.input, ctx.cwd);
			if (!verdict.db || verdict.approved) return undefined;

			const matched = `[db-guard] matched: ${verdict.reasons.join("; ")}`;
			const mainWithUi = ctx.agent?.kind === "main" && ctx.hasUI === true;
			if (!mainWithUi) return { block: true, reason: `${BLOCK_REASON}\n${matched}` };

			let approved = false;
			try {
				const reviewed = await ctx.ui.confirm(
					"db-guard: DATABASE CHANGE requested (review)",
					`Tool: ${toolName}\n\n${verdict.subject}\n\n${matched}\n\nYes only opens the typed approval step; you must then type APPROVE. No or Esc blocks.`,
				);
				if (reviewed === true) {
					const typed = await ctx.ui.input(
						"db-guard: type APPROVE to allow this database change (anything else, empty or Esc blocks)",
						"type APPROVE",
					);
					approved = typeof typed === "string" && typed.trim() === "APPROVE";
				}
			} catch {
				approved = false;
			}
			if (approved) return undefined;
			return {
				block: true,
				reason: `The owner denied or dismissed the database-change approval dialog; do not retry this change, ask the owner how to proceed.\n${matched}`,
			};
		} catch {
			// classifyToolCall never throws; a throw here is a host-shape surprise. Fail closed only for DB calls.
			return verdict?.db && !verdict.approved ? { block: true, reason: BLOCK_REASON } : undefined;
		}
	});
}
