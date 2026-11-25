import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { createLookChannel, type LookChannel } from '../dist/look.js';

const TOKEN = 'test-token-0123456789abcdef';

let server: Server;
let channel: LookChannel;
let base: string;

before(async () => {
	channel = createLookChannel({ token: TOKEN, timeout: 5000, grace: 1500 });
	server = createServer((req, res) => {
		if (!channel.handle(req, res)) res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	channel.close();
	server.closeAllConnections();
	await new Promise((r) => server.close(r));
});

type Event = { id: string; kind: string; args: Record<string, unknown> };

/** An event stream like the picker's, read with fetch so the test can cut it. */
function subscribe(sub: string) {
	const abort = new AbortController();
	const events: Event[] = [];
	const waiters: (() => void)[] = [];
	const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
		const decoder = new TextDecoder();
		let buffer = '';
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split('\n\n');
				buffer = blocks.pop() ?? '';
				for (const block of blocks) {
					const data = block.match(/^data: (.*)$/m)?.[1];
					if (data) events.push(JSON.parse(data));
				}
				for (const w of waiters.splice(0)) w();
			}
		} catch {}
	};
	const open = async () => {
		const res = await fetch(`${base}/__yubi/look/events?sub=${sub}`, { signal: abort.signal });
		void pump((res.body as ReadableStream<Uint8Array>).getReader());
	};
	const ready = open();
	const next = async (count: number) => {
		const deadline = Date.now() + 5000;
		while (events.length < count) {
			if (Date.now() > deadline) throw new Error(`only ${events.length} events`);
			await new Promise<void>((r) => {
				waiters.push(r);
				setTimeout(r, 100);
			});
		}
		return events[count - 1] as Event;
	};
	return { ready, events, next, cut: () => abort.abort() };
}

async function ask(kind: string, args: Record<string, unknown> = {}) {
	const res = await fetch(`${base}/__yubi/look`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
		body: JSON.stringify({ kind, args }),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const answer = (id: string, data: unknown) =>
	fetch(`${base}/__yubi/look/result/${id}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ ok: true, data }),
	});

const state = (sub: string, body: unknown) =>
	fetch(`${base}/__yubi/look/state/${sub}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('look channel liveness', () => {
	test('a request in flight survives its event stream being cut and reconnected', async () => {
		const first = subscribe('tab-a');
		await first.ready;
		const reply = ask('shot');
		const event = await first.next(1);
		assert.equal(event.kind, 'shot');
		first.cut();
		await tick(200);
		const second = subscribe('tab-a');
		await second.ready;
		const again = await second.next(1);
		assert.equal(again.id, event.id, 'the pending request is delivered again');
		assert.equal((await answer(event.id, { png: 'x' })).status, 204);
		const { status, body } = await reply;
		assert.equal(status, 200);
		assert.deepEqual(body, { ok: true, data: { png: 'x' } });
		second.cut();
		await tick(1700);
	});

	test('a request sent while the stream reconnects waits for it instead of failing', async () => {
		const first = subscribe('tab-b');
		await first.ready;
		await tick(50);
		first.cut();
		await tick(200);
		const reply = ask('page');
		await tick(300);
		const second = subscribe('tab-b');
		await second.ready;
		const event = await second.next(1);
		assert.equal(event.kind, 'page');
		await answer(event.id, { route: '/' });
		assert.equal((await reply).status, 200);

		for (let i = 0; i < 5; i++) {
			const r = ask('styles', { selector: 'h1' });
			const e = await second.next(i + 2);
			await answer(e.id, { i });
			const { status, body } = await r;
			assert.equal(status, 200, `call ${i}: ${JSON.stringify(body)}`);
		}
		second.cut();
		await tick(1700);
	});

	test('a request left unanswered by a tab that reloads is answered by the next tab', async () => {
		const old = subscribe('tab-reloading');
		await old.ready;
		const reply = ask('go', { to: '/b' });
		await old.next(1);
		assert.equal((await state('tab-reloading', { leaving: true })).status, 204);
		old.cut();
		await tick(1300);
		const fresh = subscribe('tab-reloaded');
		await fresh.ready;
		const event = await fresh.next(1);
		assert.equal(event.kind, 'go');
		await answer(event.id, { route: '/b' });
		const { status, body } = await reply;
		assert.equal(status, 200, JSON.stringify(body));
		fresh.cut();
		await tick(1700);
	});

	test('a tab that does not come back within the grace period is gone', async () => {
		const tab = subscribe('tab-c');
		await tab.ready;
		const reply = ask('shot');
		await tab.next(1);
		tab.cut();
		const { status, body } = await reply;
		assert.equal(status, 503);
		assert.equal(body.error, 'browser gone');
		assert.equal(channel.subscribers, 0);
	});

	test('a tab that says it is leaving stops receiving requests at once', async () => {
		const tab = subscribe('tab-d');
		await tab.ready;
		await tick(50);
		assert.equal((await state('tab-d', { leaving: true })).status, 204);
		const reply = ask('page');
		await tick(300);
		assert.equal(tab.events.length, 0, 'the leaving tab is not asked');
		tab.cut();
		const { status, body } = await reply;
		assert.equal(status, 503);
		assert.equal(body.error, 'no browser has the app open');
	});

	test('a request that arrives while a tab reloads waits for the reloaded tab', async () => {
		const old = subscribe('tab-e');
		await old.ready;
		await tick(50);
		assert.equal((await state('tab-e', { leaving: true })).status, 204);
		old.cut();
		const started = Date.now();
		const reply = ask('page');
		await tick(400);
		const fresh = subscribe('tab-e-reloaded');
		await fresh.ready;
		const event = await fresh.next(1);
		assert.equal(event.kind, 'page');
		await answer(event.id, { route: '/' });
		const { status, body } = await reply;
		assert.equal(status, 200, JSON.stringify(body));
		assert.ok(Date.now() - started < 3000, 'answered by the next tab, not after the wait');
		fresh.cut();
		await tick(1700);
	});

	test('a request that arrives just after a tab dropped waits for the next tab', async () => {
		const tab = subscribe('tab-f');
		await tab.ready;
		await tick(50);
		tab.cut();
		await tick(1700);
		assert.equal(channel.subscribers, 0, 'the tab outlasted its reconnect grace');
		const reply = ask('dom', { selector: 'h1' });
		await tick(300);
		const next = subscribe('tab-f-next');
		await next.ready;
		const event = await next.next(1);
		assert.equal(event.kind, 'dom');
		await answer(event.id, { html: '<h1>' });
		const { status, body } = await reply;
		assert.equal(status, 200, JSON.stringify(body));
		next.cut();
		await tick(1700);
	});

	test('a request in the gap is refused when the next tab has looking off', async () => {
		await tick(3100);
		const old = subscribe('tab-g');
		await old.ready;
		await tick(50);
		assert.equal((await state('tab-g', { leaving: true })).status, 204);
		old.cut();
		const reply = ask('page');
		await tick(300);
		const abort = new AbortController();
		try {
			await fetch(`${base}/__yubi/look/events?sub=tab-g-off&allowed=0`, { signal: abort.signal });
			const { status, body } = await reply;
			assert.equal(status, 403);
			assert.equal(body.error, 'the user has turned looking off');
		} finally {
			abort.abort();
			await tick(1700);
		}
	});

	test('with no tab seen recently, a request fails at once', async () => {
		await tick(3100);
		const started = Date.now();
		const { status, body } = await ask('page');
		assert.equal(status, 503);
		assert.equal(body.error, 'no browser has the app open');
		assert.ok(Date.now() - started < 500, `took ${Date.now() - started}ms`);
	});
});
