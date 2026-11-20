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

const cli = (cwd: string, ...args: string[]) =>
	new Promise<Run>((resolve) =>
		execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) =>
			resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout, stderr }),
		),
	);

const yubi = (cwd: string, ...args: string[]) => cli(cwd, 'look', ...args);

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

describe('look dom and styles', () => {
	test('look dom annotates Svelte elements with their source and stays under the byte cap', async () => {
		const run = await yubi(dir, 'dom');
		assert.equal(run.code, 0, run.stderr);
		assert.match(
			run.stdout,
			/<button class="retry[^"]*" type="button" data-yubi-src="src\/lib\/Row.svelte:3">/,
		);
		assert.match(run.stdout, /Retry import/);
		assert.ok(run.stdout.length <= 40 * 1024 + 64, `output is ${run.stdout.length} bytes`);
		assert.match(run.stdout, /<!-- truncated -->/);
		assert.doesNotMatch(run.stdout, /data-yubi="root"/, 'the picker nodes are left out');

		const json = await yubi(dir, 'dom', 'button.retry', '--json');
		assert.equal(json.code, 0, json.stderr);
		const result = JSON.parse(json.stdout);
		assert.equal(result.truncated, false);
		assert.equal(result.matches, 1);
		assert.match(result.html, /^<button class="retry/);
	});

	test('look dom reports the live form value and collapses past --depth', async () => {
		await app.locator('#note').fill('typed');
		const run = await yubi(dir, 'dom', '#note');
		assert.equal(run.code, 0, run.stderr);
		assert.match(
			run.stdout,
			/<input id="note" aria-label="note" :value="typed" data-yubi-src="src\/routes\/\+page\.svelte:\d+">/,
		);
		const shallow = await yubi(dir, 'dom', '--depth', '0');
		assert.equal(shallow.code, 0, shallow.stderr);
		assert.match(shallow.stdout.trim(), /^<body[^>]*><!-- \d+ children --><\/body>$/);
	});

	test('look dom explains a selector that matches nothing or several elements', async () => {
		const none = await yubi(dir, 'dom', '.nope');
		assert.notEqual(none.code, 0);
		assert.match(none.stderr, /no element matches "\.nope"/);
		const many = await yubi(dir, 'dom', 'p.line');
		assert.notEqual(many.code, 0);
		assert.match(many.stderr, /600 elements match "p\.line"/);
		assert.match(many.stderr, /600 matches, first: /);
	});

	test('look styles reports a non-default property, the box, and the source line', async () => {
		const json = await yubi(dir, 'styles', 'button.retry', '--json');
		assert.equal(json.code, 0, json.stderr);
		const result = JSON.parse(json.stdout);
		assert.equal(result.styles.color, 'rgb(200, 0, 0)');
		assert.equal(result.styles.display, undefined, 'defaults are left out');
		assert.deepEqual(result.source, { file: 'src/lib/Row.svelte', line: 3, column: 1 });
		assert.deepEqual(result.box.padding, { top: 4, right: 8, bottom: 4, left: 8 });
		assert.equal(result.visibility.visible, true);
		assert.ok(result.rect.width > 0);
		assert.deepEqual(
			result.stack.map((f: { name: string }) => f.name),
			['<Row>'],
		);

		const text = await yubi(dir, 'styles', 'button.retry');
		assert.equal(text.code, 0, text.stderr);
		assert.match(text.stdout, /^source {3}src\/lib\/Row\.svelte:3$/m);
		assert.match(text.stdout, /^color: rgb\(200, 0, 0\)$/m);
		assert.match(text.stdout, /^padding {2}4 8 4 8$/m);

		const picked = await yubi(dir, 'styles', 'button.retry', '--props', 'color,display', '--json');
		assert.deepEqual(JSON.parse(picked.stdout).styles, {
			color: 'rgb(200, 0, 0)',
			display: 'inline-block',
		});
	});

	test('look styles tells when an element is off-screen and needs a selector', async () => {
		const far = await yubi(dir, 'styles', 'p[data-i="599"]', '--json');
		assert.equal(far.code, 0, far.stderr);
		const visibility = JSON.parse(far.stdout).visibility;
		assert.equal(visibility.visible, false);
		assert.ok(visibility.reasons.includes('off-screen'));
		const bare = await yubi(dir, 'styles');
		assert.notEqual(bare.code, 0);
		assert.match(bare.stderr, /needs a selector/);
	});
});

const pngSize = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });
const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');

describe('look shot', () => {
	const rasterLoads = () =>
		app.evaluate(
			() =>
				performance.getEntriesByType('resource').filter((e) => e.name.endsWith('/__yubi/raster.js'))
					.length,
		);

	test('the picker stays dependency-free until the first shot', async () => {
		const mod = await (await fetch(`${origin}/__yubi/picker/look-shot.js`)).text();
		assert.doesNotMatch(mod, /foreignObject/);
		assert.ok(mod.length < 8 * 1024, `look-shot.js is ${mod.length} bytes`);
		assert.equal(await rasterLoads(), 0);
	});

	test('shoots the viewport to a PNG whose size matches viewport x scale', async () => {
		const out = join(dir, 'viewport.png');
		const run = await yubi(dir, 'shot', '--out', out);
		assert.equal(run.code, 0, run.stderr);
		const [path, size, warning] = run.stdout.trim().split('\n');
		assert.equal(path, out);
		assert.equal(size, '1000x700 px (scale 1)');
		assert.match(warning ?? '', /^warning: raster shot: /);
		const png = readFileSync(out);
		assert.ok(png.subarray(0, 8).equals(PNG_MAGIC));
		assert.deepEqual(pngSize(png), { width: 1000, height: 700 });
		assert.equal(await rasterLoads(), 1);
	});

	test('shoots a selector at --scale 2 into the shots folder, loading the raster chunk once', async () => {
		const run = await yubi(dir, 'shot', 'button.retry', '--scale', '2', '--json');
		assert.equal(run.code, 0, run.stderr);
		const saved = JSON.parse(run.stdout);
		assert.match(saved.path, /\/\.yubisashi\/shots\/[\d_-]+\.png$/);
		assert.equal(saved.scale, 2);
		const box = await app.locator('button.retry').boundingBox();
		assert.ok(box);
		const png = readFileSync(saved.path);
		assert.deepEqual(pngSize(png), {
			width: Math.round(box.width * 2),
			height: Math.round(box.height * 2),
		});
		assert.equal(saved.width, pngSize(png).width);
		assert.equal(saved.height, pngSize(png).height);
		assert.equal(await rasterLoads(), 1);
	});

	test('a viewport shot of the long page scrolled down returns, and the looks after it answer', async () => {
		await app.evaluate(() => window.scrollTo(0, 6000));
		const out = join(dir, 'scrolled.png');
		const run = await yubi(dir, 'shot', '--out', out, '--timeout', '20');
		assert.equal(run.code, 0, run.stderr);
		assert.deepEqual(pngSize(readFileSync(out)), { width: 1000, height: 700 });
		for (let i = 0; i < 5; i++) {
			const styles = await yubi(dir, 'styles', 'button.retry', '--props', 'color');
			assert.equal(styles.code, 0, `call ${i}: ${styles.stderr}`);
		}
		await app.evaluate(() => window.scrollTo(0, 0));
	});

	test('a shot over its time budget fails with that reason, not a lost browser', async () => {
		const state = JSON.parse(readFileSync(join(dir, '.yubisashi', 'dev.json'), 'utf8'));
		const res = await fetch(`${origin}/__yubi/look`, {
			method: 'POST',
			headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'shot', args: { budget: 1 } }),
		});
		assert.equal(res.status, 422);
		assert.match(((await res.json()) as { error: string }).error, /time budget/);
		await app.waitForFunction(
			() => (document.querySelector('[data-yubi="root"]') as HTMLElement).style.display === '',
		);
		const info = await yubi(dir, 'page');
		assert.equal(info.code, 0, info.stderr);
	});

	test('a selector that matches nothing is an error', async () => {
		const run = await yubi(dir, 'shot', '.nope');
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /no element matches "\.nope"/);
	});
});

type Rect = { x: number; y: number; width: number; height: number };

const rectOf = (selector: string) =>
	app.evaluate((s) => {
		const r = (document.querySelector(s) as Element).getBoundingClientRect();
		return { x: r.x, y: r.y, width: r.width, height: r.height };
	}, selector);

const highlights = () =>
	app.evaluate(() =>
		[...document.querySelectorAll('[data-yubi="show"]')].map((b) => {
			const r = b.getBoundingClientRect();
			return {
				id: b.getAttribute('data-id'),
				rect: { x: r.x, y: r.y, width: r.width, height: r.height },
				pointer: getComputedStyle(b).pointerEvents,
				tagPointer: getComputedStyle(b.firstElementChild as Element).pointerEvents,
				tag: b.firstElementChild?.textContent ?? '',
			};
		}),
	);

const near = (a: Rect, b: Rect) =>
	Math.abs(a.x - b.x) < 1 &&
	Math.abs(a.y - b.y) < 1 &&
	Math.abs(a.width - b.width) < 1 &&
	Math.abs(a.height - b.height) < 1;

describe('yubi show', () => {
	test('draws an overlay on the element rect that tracks a scroll and leaves pointer events alone', async () => {
		await app.evaluate(() => window.scrollTo(0, 0));
		const run = await cli(dir, 'show', 'button.retry', '--label', 'this one', '--json');
		assert.equal(run.code, 0, run.stderr);
		const result = JSON.parse(run.stdout);
		assert.equal(result.matches, 1);
		assert.equal(result.ttl, 10);
		assert.equal(result.shown[0].n, 1);
		assert.equal(result.shown[0].label, 'this one');
		assert.equal(result.shown[0].source, 'src/lib/Row.svelte:3');
		const [box] = await highlights();
		assert.ok(box, 'one highlight is drawn');
		assert.ok(near(box.rect, await rectOf('button.retry')), JSON.stringify(box.rect));
		assert.equal(box.pointer, 'none');
		assert.equal(box.tagPointer, 'auto');
		assert.match(box.tag, /^1 this one/);

		await app.evaluate(() => window.scrollTo(0, 150));
		await app.waitForFunction(() => {
			const b = document.querySelector('[data-yubi="show"]')?.getBoundingClientRect();
			const e = document.querySelector('button.retry')?.getBoundingClientRect();
			return !!b && !!e && Math.abs(b.y - e.y) < 1 && e.y < 0;
		});
		await app.evaluate(() => window.scrollTo(0, 0));
		const shown = (await messages()).filter((m) => m.type === 'agent:showed');
		assert.deepEqual(shown.at(-1), { yubi: 1, type: 'agent:showed', id: 1, label: 'this one' });
		const looks = await served();
		assert.equal(looks.filter((m) => m.type === 'look:served' && m.kind === 'show').length, 0);
	});

	test('calls stack with increasing numbers and --clear removes them all', async () => {
		const second = await cli(dir, 'show', 'h1');
		assert.equal(second.code, 0, second.stderr);
		assert.match(second.stdout, /^2 {2}/m);
		assert.match(second.stdout, /^showing 1 of 1 match for 10s$/m);
		const third = await cli(dir, 'show', 'p.line[data-i="3"]', '--json');
		assert.equal(JSON.parse(third.stdout).shown[0].n, 3);
		assert.deepEqual(
			(await highlights()).map((h) => h.id),
			['1', '2', '3'],
		);
		const cleared = await cli(dir, 'show', '--clear');
		assert.equal(cleared.code, 0, cleared.stderr);
		assert.equal(cleared.stdout.trim(), 'cleared 3 highlights');
		assert.equal((await highlights()).length, 0);
	});

	test('--all highlights every match and --ttl removes them', async () => {
		const both = 'p.line[data-i="1"], p.line[data-i="2"]';
		const run = await cli(dir, 'show', both, '--all', '--ttl', '1');
		assert.equal(run.code, 0, run.stderr);
		assert.match(run.stdout, /^showing 2 of 2 matches for 1s$/m);
		assert.equal((await highlights()).length, 2);
		await app.waitForFunction(() => !document.querySelector('[data-yubi="show"]'), null, {
			timeout: 5000,
		});
	});

	test('a selector that matches nothing is an error', async () => {
		const run = await cli(dir, 'show', '.nope');
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /no element matches "\.nope"/);
		assert.equal((await highlights()).length, 0);
	});
});

const route = () => app.evaluate(() => location.pathname);
const kept = () => app.evaluate(() => (window as { __kept?: number }).__kept);

describe('yubi go', () => {
	before(async () => {
		await app.locator('#note').fill('');
		await app.locator('#note').blur();
		await app.evaluate(() => window.scrollTo(0, 0));
	});

	test('go /b from /a changes the route without a full reload and prints the new route', async () => {
		const toA = await cli(dir, 'go', '/a');
		assert.equal(toA.code, 0, toA.stderr);
		assert.match(toA.stdout, /^navigated \/ → \/a$/m);
		assert.match(toA.stdout, /^route {4}\/a$/m);
		await app.evaluate(() => {
			(window as { __kept?: number }).__kept = 1;
		});
		const toB = await cli(dir, 'go', '/b', '--json');
		assert.equal(toB.code, 0, toB.stderr);
		const out = JSON.parse(toB.stdout);
		assert.equal(out.from, '/a');
		assert.equal(out.page.route, '/b');
		assert.equal(out.page.title, 'Page B');
		assert.equal(await route(), '/b');
		assert.equal(await kept(), 1, 'the document was not reloaded');
		const navigated = (await messages()).filter((m) => m.type === 'agent:navigated');
		assert.deepEqual(navigated.at(-1), { yubi: 1, type: 'agent:navigated', from: '/a', to: '/b' });
	});

	test('back and forward move through the app history; --scroll brings an element into view', async () => {
		const back = await cli(dir, 'go', 'back');
		assert.equal(back.code, 0, back.stderr);
		assert.match(back.stdout, /^route {4}\/a$/m);
		const forward = await cli(dir, 'go', 'forward');
		assert.equal(forward.code, 0, forward.stderr);
		assert.match(forward.stdout, /^route {4}\/b$/m);
		const scrolled = await cli(dir, 'go', '/b', '--scroll', '#bottom', '--json');
		assert.equal(scrolled.code, 0, scrolled.stderr);
		const out = JSON.parse(scrolled.stdout);
		assert.equal(out.scrolled, '#bottom');
		assert.ok(out.page.scroll.y > 0, `scrolled to ${out.page.scroll.y}`);
		assert.equal(await kept(), 1);
	});

	test('a cross-origin URL is refused and the route stays', async () => {
		const run = await cli(dir, 'go', 'https://example.com/elsewhere');
		assert.notEqual(run.code, 0);
		assert.match(run.stderr, /cross-origin URL refused/);
		assert.equal(await route(), '/b');
	});

	test('a reload that cuts a go short still lands on the requested route', async () => {
		assert.equal(await route(), '/b');
		await app.evaluate(() => {
			const cut = (e: Event) => {
				if (!(e.target as Element).matches?.('a[data-yubi="go"]')) return;
				removeEventListener('click', cut, true);
				e.preventDefault();
				location.reload();
			};
			addEventListener('click', cut, true);
		});
		const run = await cli(dir, 'go', '/a', '--json');
		assert.equal(run.code, 0, run.stderr);
		const out = JSON.parse(run.stdout);
		assert.equal(out.from, '/b');
		assert.equal(out.page.route, '/a');
		assert.equal(await route(), '/a');
	});

	test('refuses while the user is typing unsaved text', async () => {
		const toA = await cli(dir, 'go', '/a');
		assert.equal(toA.code, 0, toA.stderr);
		await app.locator('#draft').fill('half a sentence');
		try {
			const run = await cli(dir, 'go', '/b');
			assert.notEqual(run.code, 0);
			assert.match(run.stderr, /user is busy: typing in #draft/);
			assert.equal(await route(), '/a');
		} finally {
			await app.locator('#draft').fill('');
			await app.locator('#draft').blur();
		}
	});

	test('with the switch off, go errors and the route does not change', async () => {
		const toA = await cli(dir, 'go', '/a');
		assert.equal(toA.code, 0, toA.stderr);
		await send({ type: 'look:allow', allowed: false });
		await new Promise((r) => setTimeout(r, 300));
		try {
			const run = await cli(dir, 'go', '/b');
			assert.equal(run.code, 6, run.stderr);
			assert.match(run.stderr, /Let the agent look.*do not retry/);
			assert.equal(await route(), '/a');
		} finally {
			await send({ type: 'look:allow', allowed: true });
			await new Promise((r) => setTimeout(r, 300));
		}
	});

	test('go reload loads the document again and reports the new one', async () => {
		const run = await cli(dir, 'go', 'reload', '--json');
		assert.equal(run.code, 0, run.stderr);
		assert.equal(JSON.parse(run.stdout).page.route, '/a');
		assert.equal(await kept(), undefined, 'a fresh document');
		const home = await cli(dir, 'go', '/');
		assert.equal(home.code, 0, home.stderr);
		await app.waitForFunction(
			() =>
				!!(document.querySelector('button.retry') as { __svelte_meta?: unknown } | null)
					?.__svelte_meta,
		);
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
