import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Frame, type Page } from 'playwright';
import { createServer as createVite } from 'vite';
import { type DevHandle, startDev } from '../dist/dev.js';
import type { ChildMessage } from '../dist/picker/index.js';

const KIT_ROOT = fileURLToPath(new URL('./fixture-kit/', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const HARNESS = `<!doctype html><html><body style="margin:0">
	<script>
		window.messages = [];
		addEventListener('message', (e) => {
			if (e.source === document.getElementById('app')?.contentWindow) window.messages.push(e.data);
		});
		window.frameApp = (src) => {
			const f = document.createElement('iframe');
			f.id = 'app';
			f.src = src;
			f.style.cssText = 'display:block;width:1000px;height:700px;border:0';
			document.body.append(f);
		};
		window.send = (m) => document.getElementById('app').contentWindow.postMessage({ yubi: 1, ...m }, '*');
	</script></body></html>`;

type Run = { code: number; stdout: string; stderr: string };

const yubi = (cwd: string, ...args: string[]) =>
	new Promise<Run>((resolve) =>
		execFile(process.execPath, [CLI, 'look', ...args], { cwd }, (err, stdout, stderr) =>
			resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr }),
		),
	);

let harness: Server;
let harnessOrigin: string;
let kit: Awaited<ReturnType<typeof createVite>>;
let dev: DevHandle;
let origin: string;
let browser: Browser;
let page: Page;
let app: Frame;
let messages: () => Promise<ChildMessage[]>;
const cwd = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'yubi-look-'));

before(async () => {
	harness = createHttpServer((_req, res) =>
		res.writeHead(200, { 'content-type': 'text/html' }).end(HARNESS),
	);
	await new Promise<void>((r) => harness.listen(0, '127.0.0.1', r));
	harnessOrigin = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`;
	process.chdir(KIT_ROOT);
	const { sveltekit } = await import('@sveltejs/kit/vite');
	kit = await createVite({
		root: KIT_ROOT,
		configFile: false,
		logLevel: 'silent',
		plugins: [sveltekit()],
		server: { host: '127.0.0.1', port: 0 },
	});
	await kit.listen();
	const address = kit.httpServer?.address() as AddressInfo;
	dev = await startDev({
		target: `http://127.0.0.1:${address.port}`,
		origins: [harnessOrigin],
		host: '127.0.0.1',
		port: 0,
		https: false,
		childOutput: null,
		cwd: dir,
		lookTimeout: 5,
	});
	origin = `http://127.0.0.1:${dev.port}`;
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
	page.setDefaultTimeout(15000);
	messages = () => page.evaluate(() => (window as { messages?: ChildMessage[] }).messages ?? []);
});

after(async () => {
	await browser?.close();
	await dev?.close();
	await kit?.close();
	process.chdir(cwd);
	await new Promise((r) => harness.close(r));
});

const send = (m: Record<string, unknown>) =>
	page.evaluate((m) => (window as unknown as { send: (m: unknown) => void }).send(m), m);

const served = async () => (await messages()).filter((m) => m.type === 'look:served');

async function frameApp() {
	await page.goto(`${harnessOrigin}/`);
	await page.evaluate(
		(src) => (window as unknown as { frameApp: (s: string) => void }).frameApp(src),
		`${origin}/`,
	);
	const frame = page.frameLocator('#app');
	await frame.locator('[data-yubi="root"]').waitFor();
	app = page.frames().find((f) => f !== page.mainFrame()) as Frame;
	await app.waitForFunction(
		() =>
			!!(document.querySelector('button.retry') as { __svelte_meta?: unknown } | null)
				?.__svelte_meta,
	);
	await app.waitForFunction(() => document.readyState === 'complete');
}

describe('look transport', () => {
	test('yubi dev leaves a state file with the port and a token, excluded from git', () => {
		const state = JSON.parse(readFileSync(join(dir, '.yubisashi', 'dev.json'), 'utf8'));
		assert.equal(state.port, dev.port);
		assert.equal(state.scheme, 'http');
		assert.match(state.token, /^[\w-]{20,}$/);
		assert.equal(state.pid, process.pid);
	});

	test('POST /__yubi/look without the token is 401', async () => {
		const bare = await fetch(`${origin}/__yubi/look`, {
			method: 'POST',
			body: JSON.stringify({ kind: 'page', args: {} }),
		});
		assert.equal(bare.status, 401);
		const wrong = await fetch(`${origin}/__yubi/look`, {
			method: 'POST',
			headers: { authorization: 'Bearer nope' },
			body: JSON.stringify({ kind: 'page', args: {} }),
		});
		assert.equal(wrong.status, 401);
	});

	test('without a yubi dev in the directory the CLI says so', async () => {
		const empty = mkdtempSync(join(tmpdir(), 'yubi-nodev-'));
		const run = await yubi(empty, 'page');
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /no `yubi dev` running here/);
	});

	test('with nobody subscribed, look page exits non-zero with the no-browser message', async () => {
		const run = await yubi(dir, 'page');
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /no browser has the app open/);
	});

	test('framed by a parent page, look page returns the route and viewport', async () => {
		await frameApp();
		const run = await yubi(dir, 'page', '--json');
		assert.equal(run.code, 0, run.stderr);
		const info = JSON.parse(run.stdout);
		assert.equal(info.route, '/');
		assert.deepEqual(info.viewport, { width: 1000, height: 700 });
		assert.equal(info.title, 'Kit fixture');
		assert.equal(info.readyState, 'complete');
		assert.equal(info.focus, null);
		assert.equal(typeof info.dpr, 'number');

		const text = await yubi(dir, 'page');
		assert.equal(text.code, 0, text.stderr);
		assert.match(text.stdout, /^route {4}\/$/m);
		assert.match(text.stdout, /^viewport 1000x700 @1x$/m);
		assert.match(text.stdout, /^ready {4}complete$/m);
	});

	test('a focused input shows up as the focus selector', async () => {
		await app.locator('#note').focus();
		const run = await yubi(dir, 'page', '--json');
		assert.equal(run.code, 0, run.stderr);
		assert.equal(JSON.parse(run.stdout).focus, '#note');
		await app.locator('#note').blur();
	});

	test('an unknown kind is an error result from the picker', async () => {
		const state = JSON.parse(readFileSync(join(dir, '.yubisashi', 'dev.json'), 'utf8'));
		const res = await fetch(`${origin}/__yubi/look`, {
			method: 'POST',
			headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'nope', args: {} }),
		});
		assert.equal(res.status, 422);
		assert.match(((await res.json()) as { error: string }).error, /unknown look kind "nope"/);
	});

	test('a result is accepted once, only for a pending id', async () => {
		const res = await fetch(`${origin}/__yubi/look/result/not-pending`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ok: true, data: 1 }),
		});
		assert.equal(res.status, 404);
	});

	test('the most recently active subscriber gets the request; a silent one is a timeout', async () => {
		const silent = new AbortController();
		const stream = await fetch(`${origin}/__yubi/look/events?sub=silent`, {
			signal: silent.signal,
		});
		assert.equal(stream.headers.get('content-type'), 'text/event-stream');
		try {
			const run = await yubi(dir, 'page', '--timeout', '1');
			assert.notEqual(run.code, 0);
			assert.match(run.stderr, /did not answer: timed out after 1000ms/);
		} finally {
			silent.abort();
		}
		await app.locator('h1').click();
		const run = await yubi(dir, 'page', '--json');
		assert.equal(run.code, 0, run.stderr);
	});
});

describe('look consent', () => {
	test('with the switch off, look page exits non-zero with the refusal', async () => {
		await send({ type: 'look:allow', allowed: false });
		await new Promise((r) => setTimeout(r, 300));
		const run = await yubi(dir, 'page');
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /the user has turned looking off/);
	});

	test('with it on, the pane receives look:served once per request', async () => {
		await send({ type: 'look:allow', allowed: true });
		await new Promise((r) => setTimeout(r, 300));
		const before = (await served()).length;
		const first = await yubi(dir, 'page');
		assert.equal(first.code, 0, first.stderr);
		const second = await yubi(dir, 'page');
		assert.equal(second.code, 0, second.stderr);
		await page.waitForFunction(
			(n) =>
				((window as { messages?: { type: string }[] }).messages ?? []).filter(
					(m) => m.type === 'look:served',
				).length >= n,
			before + 2,
		);
		const events = (await served()).slice(before);
		assert.equal(events.length, 2);
		assert.deepEqual(events[0], { yubi: 1, type: 'look:served', kind: 'page' });
	});

	test('a plain tab on the preview URL never subscribes', async () => {
		const tab = await browser.newPage();
		await tab.goto(`${origin}/`);
		await tab.waitForLoadState('load');
		const subscribed = await tab.evaluate(() =>
			performance.getEntriesByType('resource').some((e) => e.name.includes('/__yubi/look/events')),
		);
		assert.equal(subscribed, false);
		await tab.close();
	});
});

describe('look teardown', () => {
	test('closing yubi dev removes the state file', async () => {
		const scratch = mkdtempSync(join(tmpdir(), 'yubi-state-'));
		const upstream = createHttpServer((_req, res) =>
			res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>x</body></html>'),
		);
		await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
		const handle = await startDev({
			target: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
			origins: [harnessOrigin],
			port: 0,
			https: false,
			childOutput: null,
			cwd: scratch,
		});
		assert.ok(existsSync(join(scratch, '.yubisashi', 'dev.json')));
		await handle.close();
		assert.equal(existsSync(join(scratch, '.yubisashi', 'dev.json')), false);
		upstream.close();
	});
});
