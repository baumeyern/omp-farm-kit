#!/usr/bin/env node
// Local stdio Gmail MCP server for omp.
// Credentials come from a dotenv-style file (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN) whose path is given by `--env-file <path>` or GMAIL_MCP_ENV_FILE.
// Secret values are never logged or returned; stdout is reserved for the MCP protocol.

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD_API = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;

// ---------- credentials ----------

function envFilePath() {
	const i = process.argv.indexOf("--env-file");
	if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
	return process.env.GMAIL_MCP_ENV_FILE;
}

function loadCredentials() {
	const path = envFilePath();
	if (!path) throw new Error("No credentials file: pass --env-file <path> or set GMAIL_MCP_ENV_FILE.");
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`Cannot read credentials file (${err.code ?? "error"}).`);
	}
	const values = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
		if (!key.startsWith("GMAIL_")) continue;
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
			value = value.slice(1, -1);
		}
		values[key] = value;
	}
	const missing = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"].filter((k) => !values[k]);
	if (missing.length) throw new Error(`Credentials file is missing: ${missing.join(", ")}.`);
	return {
		clientId: values.GMAIL_CLIENT_ID,
		clientSecret: values.GMAIL_CLIENT_SECRET,
		refreshToken: values.GMAIL_REFRESH_TOKEN,
	};
}

let creds;
try {
	creds = loadCredentials();
} catch (err) {
	process.stderr.write(`omp-gmail: ${err.message}\n`);
	process.exit(1);
}
let accessToken = null;
let accessTokenExpiresAt = 0;

/** Strip any credential material from text that might leave the process. */
function redact(text) {
	let out = String(text);
	for (const secret of [creds.clientSecret, creds.refreshToken, creds.clientId, accessToken]) {
		if (secret) out = out.split(secret).join("[redacted]");
	}
	return out.replace(/ya29\.[\w.-]+/g, "[redacted]").replace(/1\/\/[\w.-]{20,}/g, "[redacted]");
}

async function refreshAccessToken() {
	const res = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: creds.clientId,
			client_secret: creds.clientSecret,
			refresh_token: creds.refreshToken,
			grant_type: "refresh_token",
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || !data.access_token) {
		accessToken = null;
		throw new Error(`Token refresh failed (HTTP ${res.status}${data.error ? `: ${data.error}` : ""}).`);
	}
	accessToken = data.access_token;
	accessTokenExpiresAt = Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000;
}

async function getAccessToken() {
	if (!accessToken || Date.now() >= accessTokenExpiresAt) await refreshAccessToken();
	return accessToken;
}

// ---------- Gmail REST ----------

/**
 * Gmail REST call. With `upload` ({ metadata, mime }) the request goes to the media-upload endpoint
 * as multipart/related (JSON metadata + message/rfc822), which accepts messages up to 35 MB
 * instead of the JSON `raw` field's much lower limit.
 */
async function gmail(path, { method = "GET", query, body, upload } = {}) {
	const url = new URL((upload ? UPLOAD_API : API) + path);
	if (upload) url.searchParams.set("uploadType", "multipart");
	for (const [k, v] of Object.entries(query ?? {})) {
		if (v === undefined || v === null) continue;
		if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
		else url.searchParams.set(k, String(v));
	}
	let contentType;
	let payload;
	if (upload) {
		const boundary = `omp_upload_${randomBytes(12).toString("hex")}`;
		contentType = `multipart/related; boundary=${boundary}`;
		payload =
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(upload.metadata)}\r\n` +
			`--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n${upload.mime}\r\n--${boundary}--`;
	} else if (body !== undefined) {
		contentType = "application/json";
		payload = JSON.stringify(body);
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = await getAccessToken();
		const res = await fetch(url, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(contentType ? { "Content-Type": contentType } : {}),
			},
			body: payload,
			signal: AbortSignal.timeout(upload ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
		});
		if (res.status === 401 && attempt === 0) {
			accessToken = null;
			continue;
		}
		if (res.status === 204) return {};
		const text = await res.text();
		const data = text ? JSON.parse(text) : {};
		if (!res.ok) {
			const msg = data?.error?.message ?? res.statusText;
			throw new Error(`Gmail API ${method} ${path.split("?")[0]} failed (HTTP ${res.status}): ${msg}`);
		}
		return data;
	}
	throw new Error("Gmail API rejected the refreshed access token (HTTP 401).");
}

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

// ---------- message parsing ----------

const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"];

function headerMap(payload) {
	const map = {};
	for (const h of payload?.headers ?? []) map[h.name.toLowerCase()] = h.value;
	return map;
}

function decodeBase64Url(data) {
	return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function htmlToText(html) {
	return html
		.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function walkParts(part, acc) {
	if (!part) return acc;
	const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
	if (isAttachment) {
		acc.attachments.push({
			filename: part.filename || null,
			mimeType: part.mimeType,
			size: part.body?.size ?? 0,
			attachmentId: part.body?.attachmentId ?? null,
		});
	} else if (part.body?.data) {
		if (part.mimeType === "text/plain") acc.plain.push(decodeBase64Url(part.body.data));
		else if (part.mimeType === "text/html") acc.html.push(decodeBase64Url(part.body.data));
	}
	for (const child of part.parts ?? []) walkParts(child, acc);
	return acc;
}

function truncate(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function summarizeMessage(msg) {
	const h = headerMap(msg.payload);
	return {
		id: msg.id,
		threadId: msg.threadId,
		from: h.from ?? null,
		to: h.to ?? null,
		subject: h.subject ?? null,
		date: h.date ?? null,
		snippet: msg.snippet ?? "",
		labelIds: msg.labelIds ?? [],
	};
}

function fullMessage(msg, maxBodyChars) {
	const h = headerMap(msg.payload);
	const parts = walkParts(msg.payload, { plain: [], html: [], attachments: [] });
	const body = parts.plain.length ? parts.plain.join("\n") : htmlToText(parts.html.join("\n"));
	return {
		id: msg.id,
		threadId: msg.threadId,
		labelIds: msg.labelIds ?? [],
		from: h.from ?? null,
		to: h.to ?? null,
		cc: h.cc ?? null,
		replyTo: h["reply-to"] ?? null,
		subject: h.subject ?? null,
		date: h.date ?? null,
		messageIdHeader: h["message-id"] ?? null,
		body: truncate(body, maxBodyChars),
		attachments: parts.attachments,
	};
}

// ---------- MIME building ----------

function assertHeaderSafe(name, value) {
	if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks.`);
	return value;
}

function addressList(name, value) {
	if (value === undefined) return undefined;
	const list = (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean);
	for (const addr of list) {
		assertHeaderSafe(name, addr);
		if (!/@/.test(addr)) throw new Error(`${name} entry "${addr}" is not an email address.`);
	}
	return list.length ? list.join(", ") : undefined;
}

function encodeHeaderWord(value) {
	// RFC 2047 encoded-word for non-ASCII subjects.
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

const ATTACHMENT_TYPES = {
	".zip": "application/zip",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".md": "text/markdown",
	".csv": "text/csv",
	".json": "application/json",
	".html": "text/html",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function base64Lines(buf) {
	return buf.toString("base64").replace(/.{76}/g, "$&\r\n");
}

/** MIME part for a local file; read errors surface only the code and file name. */
function attachmentPart({ path, filename, mimeType }) {
	let data;
	try {
		data = readFileSync(path);
	} catch (err) {
		throw new Error(`Cannot read attachment ${basename(path)} (${err.code ?? "error"}).`);
	}
	const name = encodeHeaderWord(assertHeaderSafe("attachment filename", filename ?? basename(path))).replace(/["\\]/g, "\\$&");
	const type = assertHeaderSafe("attachment mimeType", mimeType ?? ATTACHMENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
	return [
		`Content-Type: ${type}; name="${name}"`,
		`Content-Disposition: attachment; filename="${name}"`,
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(data),
	].join("\r\n");
}

/** RFC 5322 message text: a single text part, or multipart/mixed when there are attachments. */
function buildMime({ to, cc, bcc, subject, body, html, inReplyTo, references, attachments }) {
	const headers = [];
	if (to) headers.push(`To: ${to}`);
	if (cc) headers.push(`Cc: ${cc}`);
	if (bcc) headers.push(`Bcc: ${bcc}`);
	headers.push(`Subject: ${encodeHeaderWord(assertHeaderSafe("subject", subject ?? ""))}`);
	if (inReplyTo) headers.push(`In-Reply-To: ${assertHeaderSafe("In-Reply-To", inReplyTo)}`);
	if (references) headers.push(`References: ${assertHeaderSafe("References", references)}`);
	headers.push("MIME-Version: 1.0");
	const textPart = [
		`Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
		"Content-Transfer-Encoding: base64",
		"",
		base64Lines(Buffer.from(body ?? "", "utf8")),
	].join("\r\n");
	if (!attachments?.length) return `${headers.join("\r\n")}\r\n${textPart}`;
	const boundary = `omp_mixed_${randomBytes(12).toString("hex")}`;
	headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
	const parts = [textPart, ...attachments.map(attachmentPart)];
	return `${headers.join("\r\n")}\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}

let profileEmail = null;
async function ownAddress() {
	if (!profileEmail) profileEmail = (await gmail("/profile")).emailAddress?.toLowerCase() ?? "";
	return profileEmail;
}

function splitAddresses(header) {
	if (!header) return [];
	return header
		.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function bareAddress(addr) {
	const m = addr.match(/<([^>]+)>/);
	return (m ? m[1] : addr).trim().toLowerCase();
}

/** Threading headers, recipients and subject for a reply to `messageId`. */
async function replyContext(messageId, replyAll) {
	const msg = await gmail(`/messages/${encodeURIComponent(messageId)}`, {
		query: { format: "metadata", metadataHeaders: ["From", "To", "Cc", "Reply-To", "Subject", "Message-ID", "References"] },
	});
	const h = headerMap(msg.payload);
	const me = await ownAddress();
	const original = h["message-id"];
	const subject = h.subject ?? "";
	const fromMe = bareAddress(h.from ?? "") === me;
	// Replying to your own message goes back to its recipients, like Gmail does.
	const primary = fromMe ? splitAddresses(h.to) : splitAddresses(h["reply-to"] || h.from);
	let cc = [];
	if (replyAll) {
		const seen = new Set([me, ...primary.map(bareAddress)]);
		for (const addr of [...(fromMe ? [] : splitAddresses(h.to)), ...splitAddresses(h.cc)]) {
			const bare = bareAddress(addr);
			if (!seen.has(bare)) {
				seen.add(bare);
				cc.push(addr);
			}
		}
	}
	return {
		threadId: msg.threadId,
		to: primary,
		cc,
		subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
		inReplyTo: original,
		references: [h.references, original].filter(Boolean).join(" ") || undefined,
	};
}

/**
 * Builds the upload payload for drafts/sends, optionally as a reply: `mime` is the message text,
 * `threadId` (when replying) belongs in the Gmail message metadata.
 */
async function composeMessage(args, { requireRecipient = true } = {}) {
	let threadId;
	let inReplyTo;
	let references;
	let subject = args.subject;
	let to = args.to;
	let cc = args.cc;
	if (args.replyToMessageId) {
		const ctx = await replyContext(args.replyToMessageId, args.replyAll ?? false);
		threadId = ctx.threadId;
		inReplyTo = ctx.inReplyTo;
		references = ctx.references;
		subject = subject ?? ctx.subject;
		to = to ?? ctx.to;
		cc = cc ?? (ctx.cc.length ? ctx.cc : undefined);
	}
	const toHeader = addressList("to", to);
	if (!toHeader && requireRecipient) throw new Error("At least one recipient (to) is required.");
	const mime = buildMime({
		to: toHeader,
		cc: addressList("cc", cc),
		bcc: addressList("bcc", args.bcc),
		subject: subject ?? "",
		body: args.body,
		html: args.html,
		inReplyTo,
		references,
		attachments: args.attachments,
	});
	return { mime, message: threadId ? { threadId } : {} };
}

// ---------- labels ----------

let labelCache = null;
async function listLabels(refresh = false) {
	if (!labelCache || refresh) labelCache = (await gmail("/labels")).labels ?? [];
	return labelCache;
}

async function resolveLabelIds(names) {
	if (!names?.length) return [];
	let labels = await listLabels();
	const resolve = (entry) =>
		labels.find((l) => l.id === entry) ?? labels.find((l) => l.name.toLowerCase() === entry.toLowerCase());
	if (names.some((n) => !resolve(n))) labels = await listLabels(true);
	return names.map((n) => {
		const label = resolve(n);
		if (!label) throw new Error(`Unknown label "${n}". Use list_labels to see ids and names.`);
		return label.id;
	});
}

// ---------- tool plumbing ----------

function ok(value) {
	return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function guarded(fn) {
	return async (args) => {
		try {
			return await fn(args);
		} catch (err) {
			const message = err?.name === "TimeoutError" ? "Request to Google timed out." : (err?.message ?? String(err));
			return { content: [{ type: "text", text: `Error: ${redact(message)}` }], isError: true };
		}
	};
}

const addressInput = z.union([z.string(), z.array(z.string())]);
const attachmentsInput = z
	.array(
		z.object({
			path: z.string().describe("Absolute path of a local file to attach."),
			filename: z.string().optional().describe("Name shown to the recipient (defaults to the file's name)."),
			mimeType: z.string().optional().describe("Content type (guessed from the extension when omitted)."),
		}),
	)
	.optional()
	.describe("Local files to attach (Gmail caps attachments at 25 MB total).");
const composeFields = {
	to: addressInput.optional().describe("Recipient address(es). Optional for replies (defaults to the original sender)."),
	cc: addressInput.optional(),
	bcc: addressInput.optional(),
	subject: z.string().optional().describe("Subject. Optional for replies (defaults to 'Re: <original>')."),
	body: z.string().describe("Message body."),
	html: z.boolean().optional().describe("Send body as text/html instead of text/plain."),
	replyToMessageId: z.string().optional().describe("Gmail message id to reply to; sets thread and In-Reply-To/References."),
	replyAll: z.boolean().optional().describe("With replyToMessageId: also copy the original To/Cc recipients."),
	attachments: attachmentsInput,
};

const server = new McpServer({ name: "omp-gmail", version: "1.0.0" });

server.registerTool(
	"search_threads",
	{
		description: "Search Gmail threads with Gmail query syntax (e.g. 'in:inbox is:unread from:x'). Returns subject/from/date/snippet per thread.",
		inputSchema: {
			query: z.string().optional().describe("Gmail search query; empty lists all threads."),
			maxResults: z.number().int().min(1).max(50).optional().describe("Default 10."),
			pageToken: z.string().optional(),
			includeSpamTrash: z.boolean().optional(),
		},
		annotations: { readOnlyHint: true },
	},
	guarded(async ({ query, maxResults = 10, pageToken, includeSpamTrash }) => {
		const list = await gmail("/threads", { query: { q: query, maxResults, pageToken, includeSpamTrash } });
		const threads = await mapLimit(list.threads ?? [], 8, async (t) => {
			const thread = await gmail(`/threads/${t.id}`, { query: { format: "metadata", metadataHeaders: SUMMARY_HEADERS } });
			const messages = thread.messages ?? [];
			const first = headerMap(messages[0]?.payload);
			const last = messages.at(-1);
			return {
				threadId: t.id,
				subject: first.subject ?? null,
				from: headerMap(last?.payload).from ?? null,
				date: headerMap(last?.payload).date ?? null,
				messageCount: messages.length,
				lastMessageId: last?.id ?? null,
				labelIds: [...new Set(messages.flatMap((m) => m.labelIds ?? []))],
				snippet: last?.snippet ?? t.snippet ?? "",
			};
		});
		return ok({ threads, nextPageToken: list.nextPageToken ?? null, resultSizeEstimate: list.resultSizeEstimate ?? 0 });
	}),
);

server.registerTool(
	"search_messages",
	{
		description: "Search individual Gmail messages with Gmail query syntax. Returns id/thread/subject/from/date/snippet/labels.",
		inputSchema: {
			query: z.string().optional(),
			maxResults: z.number().int().min(1).max(50).optional().describe("Default 10."),
			pageToken: z.string().optional(),
			includeSpamTrash: z.boolean().optional(),
		},
		annotations: { readOnlyHint: true },
	},
	guarded(async ({ query, maxResults = 10, pageToken, includeSpamTrash }) => {
		const list = await gmail("/messages", { query: { q: query, maxResults, pageToken, includeSpamTrash } });
		const messages = await mapLimit(list.messages ?? [], 8, async (m) =>
			summarizeMessage(await gmail(`/messages/${m.id}`, { query: { format: "metadata", metadataHeaders: SUMMARY_HEADERS } })),
		);
		return ok({ messages, nextPageToken: list.nextPageToken ?? null, resultSizeEstimate: list.resultSizeEstimate ?? 0 });
	}),
);

server.registerTool(
	"get_message",
	{
		description: "Read one message: headers, plain-text body (HTML converted), and attachment metadata.",
		inputSchema: {
			messageId: z.string(),
			maxBodyChars: z.number().int().min(100).max(200000).optional().describe("Default 20000."),
		},
		annotations: { readOnlyHint: true },
	},
	guarded(async ({ messageId, maxBodyChars = 20000 }) =>
		ok(fullMessage(await gmail(`/messages/${encodeURIComponent(messageId)}`, { query: { format: "full" } }), maxBodyChars)),
	),
);

server.registerTool(
	"get_thread",
	{
		description: "Read every message in a thread: headers, bodies, and attachment metadata.",
		inputSchema: {
			threadId: z.string(),
			maxBodyCharsPerMessage: z.number().int().min(100).max(100000).optional().describe("Default 8000."),
		},
		annotations: { readOnlyHint: true },
	},
	guarded(async ({ threadId, maxBodyCharsPerMessage = 8000 }) => {
		const thread = await gmail(`/threads/${encodeURIComponent(threadId)}`, { query: { format: "full" } });
		return ok({ threadId: thread.id, messages: (thread.messages ?? []).map((m) => fullMessage(m, maxBodyCharsPerMessage)) });
	}),
);

server.registerTool(
	"list_labels",
	{
		description: "List Gmail labels (id, name, type). Label names or ids are accepted by modify_labels.",
		inputSchema: {},
		annotations: { readOnlyHint: true },
	},
	guarded(async () => ok((await listLabels(true)).map(({ id, name, type }) => ({ id, name, type })))),
);

server.registerTool(
	"list_drafts",
	{
		description: "List drafts with their draft id, message id, subject and recipients.",
		inputSchema: {
			query: z.string().optional(),
			maxResults: z.number().int().min(1).max(50).optional().describe("Default 10."),
			pageToken: z.string().optional(),
		},
		annotations: { readOnlyHint: true },
	},
	guarded(async ({ query, maxResults = 10, pageToken }) => {
		const list = await gmail("/drafts", { query: { q: query, maxResults, pageToken } });
		const drafts = await mapLimit(list.drafts ?? [], 8, async (d) => {
			const draft = await gmail(`/drafts/${d.id}`, { query: { format: "metadata" } });
			return { draftId: d.id, ...summarizeMessage(draft.message) };
		});
		return ok({ drafts, nextPageToken: list.nextPageToken ?? null });
	}),
);

server.registerTool(
	"create_draft",
	{
		description: "Create a draft. With replyToMessageId it is threaded as a reply to that message.",
		inputSchema: composeFields,
	},
	guarded(async (args) => {
		const { mime, message } = await composeMessage(args, { requireRecipient: false });
		const draft = await gmail("/drafts", { method: "POST", upload: { metadata: { message }, mime } });
		return ok({ draftId: draft.id, messageId: draft.message?.id, threadId: draft.message?.threadId });
	}),
);

server.registerTool(
	"update_draft",
	{
		description: "Replace a draft's recipients, subject and body (all fields are rewritten).",
		inputSchema: { draftId: z.string(), ...composeFields },
	},
	guarded(async ({ draftId, ...args }) => {
		const { mime, message } = await composeMessage(args, { requireRecipient: false });
		const draft = await gmail(`/drafts/${encodeURIComponent(draftId)}`, { method: "PUT", upload: { metadata: { id: draftId, message }, mime } });
		return ok({ draftId: draft.id, messageId: draft.message?.id, threadId: draft.message?.threadId });
	}),
);

server.registerTool(
	"delete_draft",
	{
		description: "Permanently delete a draft by draft id (not message id).",
		inputSchema: { draftId: z.string() },
		annotations: { destructiveHint: true },
	},
	guarded(async ({ draftId }) => {
		await gmail(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
		return ok({ deleted: draftId });
	}),
);

server.registerTool(
	"send_message",
	{
		description: "Send a new email immediately. Prefer create_draft unless the user explicitly asked to send.",
		inputSchema: {
			to: addressInput,
			cc: addressInput.optional(),
			bcc: addressInput.optional(),
			subject: z.string(),
			body: z.string(),
			html: z.boolean().optional(),
			attachments: attachmentsInput,
		},
		annotations: { destructiveHint: true, openWorldHint: true },
	},
	guarded(async (args) => {
		const { mime, message } = await composeMessage(args);
		const sent = await gmail("/messages/send", { method: "POST", upload: { metadata: message, mime } });
		return ok({ messageId: sent.id, threadId: sent.threadId, labelIds: sent.labelIds ?? [] });
	}),
);

server.registerTool(
	"reply",
	{
		description: "Send a reply in the original thread (sets In-Reply-To/References and 'Re:' subject). Use create_draft with replyToMessageId to draft instead.",
		inputSchema: {
			messageId: z.string().describe("Gmail message id being replied to."),
			body: z.string(),
			replyAll: z.boolean().optional().describe("Also copy the original To/Cc recipients (excluding yourself)."),
			cc: addressInput.optional().describe("Override Cc."),
			bcc: addressInput.optional(),
			html: z.boolean().optional(),
		},
		annotations: { destructiveHint: true, openWorldHint: true },
	},
	guarded(async ({ messageId, ...rest }) => {
		const { mime, message } = await composeMessage({ ...rest, replyToMessageId: messageId });
		const sent = await gmail("/messages/send", { method: "POST", upload: { metadata: message, mime } });
		return ok({ messageId: sent.id, threadId: sent.threadId });
	}),
);

server.registerTool(
	"modify_labels",
	{
		description: "Add/remove labels on a message or whole thread. Shortcuts: archive (remove INBOX), markRead, markUnread.",
		inputSchema: {
			messageId: z.string().optional(),
			threadId: z.string().optional(),
			addLabels: z.array(z.string()).optional().describe("Label ids or names to add."),
			removeLabels: z.array(z.string()).optional().describe("Label ids or names to remove."),
			archive: z.boolean().optional(),
			markRead: z.boolean().optional(),
			markUnread: z.boolean().optional(),
		},
	},
	guarded(async ({ messageId, threadId, addLabels, removeLabels, archive, markRead, markUnread }) => {
		if (Boolean(messageId) === Boolean(threadId)) throw new Error("Pass exactly one of messageId or threadId.");
		if (markRead && markUnread) throw new Error("markRead and markUnread are mutually exclusive.");
		const add = new Set(await resolveLabelIds(addLabels));
		const remove = new Set(await resolveLabelIds(removeLabels));
		if (archive) remove.add("INBOX");
		if (markRead) remove.add("UNREAD");
		if (markUnread) add.add("UNREAD");
		for (const id of add) if (remove.has(id)) throw new Error(`Label ${id} is both added and removed.`);
		if (!add.size && !remove.size) throw new Error("Nothing to change.");
		const path = messageId ? `/messages/${encodeURIComponent(messageId)}/modify` : `/threads/${encodeURIComponent(threadId)}/modify`;
		const result = await gmail(path, { method: "POST", body: { addLabelIds: [...add], removeLabelIds: [...remove] } });
		const labelIds = messageId ? result.labelIds : [...new Set((result.messages ?? []).flatMap((m) => m.labelIds ?? []))];
		return ok({ id: result.id, labelIds: labelIds ?? [] });
	}),
);

process.on("uncaughtException", (err) => {
	process.stderr.write(`omp-gmail: ${redact(err?.message ?? err)}\n`);
});
process.on("unhandledRejection", (err) => {
	process.stderr.write(`omp-gmail: ${redact(err?.message ?? err)}\n`);
});

await server.connect(new StdioServerTransport());
