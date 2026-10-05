// Local, dependency-free Collab link delivery. Never log or persist URLs, room keys,
// MIME bodies, OAuth values, subprocess output, or arbitrary error messages.
// Poll the supported CLI: no extension event is documented for relay-room rotation.
// Gmail drafts are persisted remotely as email, then consumed by drafts.send. Keep
// their IDs locally so a lost send response never causes a fresh duplicate send.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const home = homedir();
const root = join(home, '.omp', 'agent', 'collab-mailer');
const stateFile = join(root, 'state.json');
const exec = promisify(execFile);
const omp = join(home, 'AppData', 'Local', 'omp', 'omp.exe');
// Same dotenv file as the gmail MCP server (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN).
const secretFile = process.env.GMAIL_MCP_ENV_FILE || join(home, '.omp', 'secrets', 'gmail.env');
export const linkKey = url => createHash('sha256').update(url).digest('hex');
const safeError = (code, status) => Object.assign(new Error(code), { code, status });

// Rate caps (backstops; the main-session filter below is what normally limits mail):
// one email per 30 minutes for the same session, and never more than 3 in any hour or
// two within 2 minutes, whatever the session.
export const SAME_SESSION_GAP_MS = 30 * 60_000;
export const ANY_SESSION_GAP_MS = 2 * 60_000;
export const HOURLY_MAX = 3;

/**
 * Only the owner's interactive main session should mail its link. `collab.autoStart: control` also
 * publishes every throwaway test instance the farm starts (`omp --no-session`, harnesses with a
 * private `--session-dir`, print mode), and each of those used to produce an email.
 */
export function isMainSessionCommand(commandLine) {
	if (typeof commandLine !== 'string' || !commandLine) return false;
	const args = commandLine.split(/\s+/).map(a => a.replace(/^"|"$/g, '').toLowerCase());
	return !args.some(a => a === '--no-session' || a === '--session-dir' || a.startsWith('--session-dir=') || a === '-p' || a === '--print' || a.startsWith('__omp_worker'));
}

/** Command line of a live process (undefined when gone or unreadable). Never logged. */
export async function processCommandLine(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { windowsHide: true, timeout: 15_000 });
		return stdout.trim() || undefined;
	} catch { return undefined; }
}

/** Why a new email to `host` must wait, or undefined when it may go now. */
export function rateCapReason(state, host, now = Date.now()) {
	const log = (state.sendLog ?? []).filter(item => now - item.at < 60 * 60_000);
	if (log.length >= HOURLY_MAX) return 'hourly_cap';
	const last = log.at(-1);
	if (last && now - last.at < ANY_SESSION_GAP_MS) return 'burst_cap';
	if (last && last.sessionId === host.sessionId && now - last.at < SAME_SESSION_GAP_MS) return 'same_session_cap';
	return undefined;
}

export async function collab(args) {
	try {
		const { stdout } = await exec(omp, ['collab', ...args, '--json'], { windowsHide: true, timeout: 15_000, maxBuffer: 2_000_000 });
		return JSON.parse(stdout);
	} catch { throw safeError('collab_unavailable'); }
}

export async function createGmail() {
	const values = {};
	for (const raw of (await readFile(secretFile, 'utf8')).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) continue;
		const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
		if (!key.startsWith('GMAIL_')) continue;
		let value = line.slice(eq + 1).trim();
		if ((value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
		values[key] = value;
	}
	if (['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'].some(key => !values[key])) throw safeError('credentials_missing');
	let token, expires = 0;
	return async function gmail(path, { method = 'GET', body, query } = {}) {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (!token || Date.now() >= expires) {
				const response = await fetch('https://oauth2.googleapis.com/token', {
					method: 'POST', body: new URLSearchParams({ client_id: values.GMAIL_CLIENT_ID, client_secret: values.GMAIL_CLIENT_SECRET, refresh_token: values.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }),
					signal: AbortSignal.timeout(30_000),
				});
				const data = await response.json();
				if (!response.ok || typeof data.access_token !== 'string') throw safeError('oauth_failed', response.status);
				token = data.access_token;
				expires = Date.now() + Math.max(0, (data.expires_in ?? 3600) - 60) * 1000;
			}
			const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me' + path);
			for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
			const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
			if (response.status === 401 && attempt === 0) { token = undefined; continue; }
			if (!response.ok) throw safeError('gmail_failed', response.status);
			return response.status === 204 ? {} : await response.json();
		}
		throw safeError('oauth_rejected');
	};
}

export function compose(host, url, address, key, now = new Date()) {
	if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw safeError('profile_address_invalid');
	const body = [
		'Your current omp full-control browser link:', url, '',
		'WARNING: This link grants full control of this PC through omp. Keep it private.',
		`Directory: ${host.cwd ?? '(unknown)'}`, `Session: ${host.sessionName ?? host.title ?? '(untitled)'}`,
		`Generation: ${host.generation}`, `Time: ${now.toISOString()}`,
		'', 'A newer email replaces this link after a session switch or room restart.',
		'The PC must remain awake, online, logged in, and the omp session must stay open.',
		`Delivery reference: omp-delivery-${key}`,
	].join('\r\n');
	return Buffer.from([
		`From: ${address}`, `To: ${address}`, 'Subject: omp remote control link',
		`Date: ${now.toUTCString()}`,
		'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
		Buffer.from(body).toString('base64').match(/.{1,76}/g).join('\r\n'),
	].join('\r\n')).toString('base64url');
}

export async function deliver({ host, url, state, gmail, save, notify = () => {} }) {
	const key = linkKey(url);
	let record = state.deliveries[key];
	if (record?.status === 'sent') return false;
	// Gmail can replace Message-ID on send; reconcile using our opaque body reference.
	const found = await gmail('/messages', { query: { q: `in:sent "omp-delivery-${key}"`, maxResults: 2 } });
	if (found.messages?.length) {
		state.deliveries[key] = { instanceId: host.instanceId, generation: host.generation, status: 'sent', messageId: found.messages[0].id };
		await save();
		return false;
	}
	if (!record?.draftId) {
		const { emailAddress } = await gmail('/profile');
		const draft = await gmail('/drafts', { method: 'POST', body: { message: { raw: compose(host, url, emailAddress, key) } } });
		if (typeof draft.id !== 'string') throw safeError('draft_id_missing');
		record = state.deliveries[key] = { instanceId: host.instanceId, generation: host.generation, status: 'draft', draftId: draft.id };
		// Counted when committed, so a lost send response still counts toward the caps.
		state.sendLog = [...(state.sendLog ?? []).slice(-9), { at: Date.now(), sessionId: host.sessionId }];
	}
	await save(); // Also re-check durability after a previous poll's failed state write.
	try {
		const sent = await gmail('/drafts/send', { method: 'POST', body: { id: record.draftId } });
		record.status = 'sent';
		record.messageId = sent.id;
		delete record.draftId;
		await save();
		notify('delivered');
		return true;
	} catch (error) {
		// On 404 or an uncertain network outcome retain the same draft ID. The next
		// poll reconciles Sent first, then retries only this consumable draft, never
		// creates another email. Gmail search may lag behind successful delivery.
		notify(error?.status === 404 ? 'awaiting_sent_reconciliation' : 'delivery_retry');
		throw safeError('delivery_pending', error?.status);
	}
}

export async function poll({ state, gmail, save, cli = collab, notify, instanceId, commandLineOf = processCommandLine, mainCache = new Map(), now = () => Date.now() }) {
	const result = await cli(['list']);
	if (result.version !== 1 || !Array.isArray(result.hosts)) throw safeError('host_list_invalid');
	for (const host of result.hosts) {
		if (host.access !== 'control' || (instanceId && host.instanceId !== instanceId)) continue;
		if (Object.values(state.deliveries).some(item => item.instanceId === host.instanceId && item.generation === host.generation && item.status === 'sent')) continue;
		try {
			// Decided once per room; a test instance stays excluded for its whole life. An
			// unreadable command line (process gone, WMI hiccup) is retried on the next poll.
			if (!mainCache.has(host.instanceId)) {
				const commandLine = await commandLineOf(host.pid);
				if (commandLine === undefined) continue;
				mainCache.set(host.instanceId, isMainSessionCommand(commandLine));
			}
			if (!mainCache.get(host.instanceId)) continue;
			const link = await cli(['link', host.instanceId]);
			if (link.access !== 'control' || link.generation !== host.generation || link.instanceId !== host.instanceId || typeof link.url !== 'string') throw safeError('room_changed');
			const parsed = new URL(link.url);
			if (parsed.protocol !== 'https:' || !parsed.hash) throw safeError('link_invalid');
			// A draft already committed for this link is always finished; caps only gate new emails.
			const capped = state.deliveries[linkKey(link.url)] ? undefined : rateCapReason(state, host, now());
			if (capped) { notify?.(capped); continue; }
			await deliver({ host, url: link.url, state, gmail, save, notify });
		} catch { notify?.('host_delivery_pending'); } // One disappearing host cannot block the others.
	}
}

// An OS-owned named pipe is a mutex, not a command endpoint. It disappears even
// after a forced task stop; a PID file can race Stop/Start or survive a crash.
export async function acquireInstance(pipe, once = false) {
	for (;;) {
		const server = createServer(socket => socket.end());
		const acquired = await new Promise((resolve, reject) => {
			server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(safeError('mutex_failed')));
			server.listen(pipe, () => resolve(true));
		});
		if (acquired) return server;
		if (once) return undefined;
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
}

async function main() {
	const mutex = await acquireInstance(`\\\\.\\pipe\\omp-collab-mailer-${linkKey(home).slice(0, 16)}`, process.argv.includes('--once'));
	if (!mutex) return;
	let stopped = false;
	process.on('SIGTERM', () => { stopped = true; });
	process.on('SIGINT', () => { stopped = true; });
	try {
		await mkdir(root, { recursive: true });
		let state;
		try { state = JSON.parse(await readFile(stateFile, 'utf8')); }
		catch (error) { if (error.code !== 'ENOENT') throw safeError('state_unreadable'); state = { version: 1, deliveries: {} }; }
		if (state.version !== 1 || !state.deliveries || typeof state.deliveries !== 'object' || Array.isArray(state.deliveries)) throw safeError('state_invalid');
		const save = async () => {
			const temp = stateFile + '.tmp';
			await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
			await rename(temp, stateFile);
		};
		const notify = event => console.log(`${new Date().toISOString()} collab-mailer ${event}`);
		const gmail = await createGmail();
		const index = process.argv.indexOf('--instance');
		const instanceId = index < 0 ? undefined : process.argv[index + 1];
		const mainCache = new Map();
		do {
			try { await poll({ state, gmail, save, notify, instanceId, mainCache }); }
			catch { notify('poll_failed_retrying'); }
			if (process.argv.includes('--once')) break;
			for (let i = 0; i < 45 && !stopped; i++) await new Promise(resolve => setTimeout(resolve, 1000));
		} while (!stopped);
	} finally { await new Promise(resolve => mutex.close(resolve)); }
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === process.argv[1].toLowerCase()) {
	main().catch(() => { console.error('collab-mailer startup_failed (details suppressed for secret safety)'); process.exitCode = 1; });
}
