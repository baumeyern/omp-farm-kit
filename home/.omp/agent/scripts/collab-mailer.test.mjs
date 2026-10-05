import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireInstance, compose, deliver, poll, isMainSessionCommand, rateCapReason, SAME_SESSION_GAP_MS } from './collab-mailer.mjs';
const host = { instanceId: 'fixture', generation: 1, access: 'control', cwd: 'C:/fixture', sessionName: 'Phone fixture', pid: 100, sessionId: 'session-a' };
const MAIN = 'C:\\Users\\me\\AppData\\Local\\omp\\omp.exe --resume session-a';
const mainOnly = async () => MAIN;
const url = 'https://example.invalid/#test-only';

test('sends once, persists only metadata, and skips delivered generations', async () => {
	const state = { version: 1, deliveries: {} };
	let sends = 0, saves = 0;
	const gmail = async (path, options) => {
		if (path === '/messages') return {};
		if (path === '/profile') return { emailAddress: 'fixture@example.invalid' };
		if (path === '/drafts') return { id: 'draft1' };
		if (path === '/drafts/send') { assert.equal(options.body.id, 'draft1'); assert(saves > 0); sends++; return { id: 'message1' }; }
		throw Error('Unexpected request');
	};
	const save = async () => { saves++; assert(!JSON.stringify(state).includes(url)); };
	assert.equal(await deliver({ host, url, state, gmail, save }), true);
	assert.equal(await deliver({ host, url, state, gmail, save }), false);
	await poll({ state, gmail, save, commandLineOf: mainOnly, cli: async args => { assert.deepEqual(args, ['list']); return { version: 1, hosts: [host] }; } });
	assert.equal(sends, 1);
});

test('lost send response reconciles Sent after restart without resending', async () => {
	let state = { version: 1, deliveries: {} }, stored, sent = false, sends = 0;
	const gmail = async path => {
		if (path === '/messages') return sent ? { messages: [{ id: 'sent1' }] } : {};
		if (path === '/profile') return { emailAddress: 'fixture@example.invalid' };
		if (path === '/drafts') return { id: 'draft1' };
		if (path === '/drafts/send') { sends++; sent = true; throw Error('Lost response'); }
	};
	const save = async () => { stored = JSON.stringify(state); };
	await assert.rejects(deliver({ host, url, state, gmail, save }));
	state = JSON.parse(stored);
	assert.equal(await deliver({ host, url, state, gmail, save }), false);
	assert.equal(sends, 1);
});

test('transient failure retries the same draft without creating another email', async () => {
	const state = { version: 1, deliveries: {} };
	let drafts = 0, sends = 0;
	const gmail = async (path, options) => {
		if (path === '/messages') return {};
		if (path === '/profile') return { emailAddress: 'fixture@example.invalid' };
		if (path === '/drafts') { drafts++; return { id: 'draft1' }; }
		if (path === '/drafts/send') { assert.equal(options.body.id, 'draft1'); if (++sends === 1) throw Error('Offline'); return { id: 'sent1' }; }
	};
	await assert.rejects(deliver({ host, url, state, gmail, save: async () => {} }));
	await deliver({ host, url, state, gmail, save: async () => {} });
	assert.equal(drafts, 1);
});

test('rotating generation gets a new email once the same-session cap allows it; mismatched and view rooms are ignored', async () => {
	const state = { version: 1, deliveries: {} };
	let sends = 0, generation = 1, clock = 0;
	const now = () => clock;
	const gmail = async path => path === '/messages' ? {} : path === '/profile' ? { emailAddress: 'fixture@example.invalid' } : path === '/drafts' ? { id: 'draft' + generation } : { id: 'sent' + ++sends };
	const cli = async args => args[0] === 'list' ? { version: 1, hosts: [{ ...host, generation }, { ...host, instanceId: 'view', access: 'view' }] } : { ...host, generation, url: url + generation };
	await poll({ state, gmail, save: async () => {}, cli, commandLineOf: mainOnly, now });
	state.sendLog[0].at = 0;
	generation++;
	clock = 60_000;
	await poll({ state, gmail, save: async () => {}, cli, commandLineOf: mainOnly, now });
	assert.equal(sends, 1, 'same session inside 30 minutes is held');
	clock = SAME_SESSION_GAP_MS + 1;
	await poll({ state, gmail, save: async () => {}, cli, commandLineOf: mainOnly, now });
	assert.equal(sends, 2);
	await poll({ state, gmail, save: async () => {}, cli: async args => args[0] === 'list' ? { version: 1, hosts: [{ ...host, generation: 3 }] } : { ...host, generation: 4, url }, commandLineOf: mainOnly, now });
	assert.equal(sends, 2);
});

test('test and helper omp instances never send; only the interactive main session does', async () => {
	for (const line of [
		'"C:\\omp.exe" --no-session --cwd "C:\\Users\\me\\code\\project"',
		'C:\\omp.exe --cwd x --session-dir C:\\tmp\\sess -c',
		'C:\\omp.exe -p hello',
		'C:\\omp.exe __omp_worker_daemon_broker',
	]) assert.equal(isMainSessionCommand(line), false, line);
	for (const line of ['"C:\\omp.exe"', MAIN]) assert.equal(isMainSessionCommand(line), true, line);
	const state = { version: 1, deliveries: {} };
	let links = 0, lookups = 0;
	const hosts = Array.from({ length: 5 }, (_, i) => ({ ...host, instanceId: 'test' + i, pid: 200 + i, sessionId: 's' + i }));
	const cli = async args => { if (args[0] === 'link') links++; return { version: 1, hosts }; };
	const commandLineOf = async () => { lookups++; return 'C:\\omp.exe --no-session'; };
	const mainCache = new Map();
	for (let i = 0; i < 3; i++) await poll({ state, gmail: async () => { throw Error('no mail expected'); }, save: async () => {}, cli, commandLineOf, mainCache });
	assert.equal(links, 0);
	assert.equal(lookups, 5, 'each room is classified once');
});

test('rate caps: burst and hourly limits hold across sessions and survive a restart', () => {
	const t = 10 * 60 * 60_000;
	let state = { version: 1, deliveries: {}, sendLog: [{ at: t, sessionId: 'a' }] };
	assert.equal(rateCapReason(state, { sessionId: 'b' }, t + 60_000), 'burst_cap');
	assert.equal(rateCapReason(state, { sessionId: 'b' }, t + 3 * 60_000), undefined, 'a new session may send after 2 minutes');
	assert.equal(rateCapReason(state, { sessionId: 'a' }, t + 10 * 60_000), 'same_session_cap');
	state.sendLog.push({ at: t + 5 * 60_000, sessionId: 'b' }, { at: t + 10 * 60_000, sessionId: 'c' });
	state = JSON.parse(JSON.stringify(state)); // what a restarted watcher reads back from disk
	assert.equal(rateCapReason(state, { sessionId: 'd' }, t + 20 * 60_000), 'hourly_cap');
	assert.equal(rateCapReason(state, { sessionId: 'd' }, t + 61 * 60_000), undefined);
});

test('email includes required context and rejects header injection', () => {
	const mime = Buffer.from(compose(host, url, 'fixture@example.invalid', 'hash'), 'base64url').toString();
	assert(mime.includes('Subject: omp remote control link'));
	const body = Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString();
	for (const value of [url, host.cwd, host.sessionName, 'Generation: 1', 'Time:']) assert(body.includes(value));
	assert.throws(() => compose(host, url, 'bad\r\nBcc: other@example.invalid', 'hash'));
});

test('a failed state write never allows an unrecorded draft to send on retry', async () => {
	const state = { version: 1, deliveries: {} };
	let sends = 0, writesFail = true;
	const gmail = async path => path === '/messages' ? {} : path === '/profile' ? { emailAddress: 'fixture@example.invalid' } : path === '/drafts' ? { id: 'draft1' } : { id: 'sent' + ++sends };
	const save = async () => { if (writesFail) throw Error('Disk unavailable'); };
	await assert.rejects(deliver({ host, url, state, gmail, save }));
	await assert.rejects(deliver({ host, url, state, gmail, save }));
	assert.equal(sends, 0);
	writesFail = false;
	await deliver({ host, url, state, gmail, save });
	assert.equal(sends, 1);
});

test('OS mutex rejects overlap and allows restart without stale PID files', async () => {
	const pipe = `\\\\.\\pipe\\omp-collab-mailer-test-${process.pid}`;
	const first = await acquireInstance(pipe, true);
	assert(first);
	try { assert.equal(await acquireInstance(pipe, true), undefined); }
	finally { await new Promise(resolve => first.close(resolve)); }
	const restarted = await acquireInstance(pipe, true);
	assert(restarted);
	await new Promise(resolve => restarted.close(resolve));
});
