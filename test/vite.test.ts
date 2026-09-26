import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, createServer, type ViteDevServer } from 'vite';
import type { ChildMessage } from '../dist/picker/index.js';
import { injectScript, parentOrigins, relaxCsp, yubisashi } from '../dist/vite/index.js';

const VITE_ROOT = fileURLToPath(new URL('./fixture-vite/', import.meta.url));
const KIT_ROOT = fileURLToPath(new URL('./fixture-kit/', import.meta.url));
const PICKER_SCRIPT = /<script type="module" src="\/@id\/__x00__virtual:yubisashi"><\/script>/;
const PARENT = 'https://review.example';

const serve = async (server: ViteDevServer) => {
	await server.listen();
	const address = server.httpServer?.address() as AddressInfo;
	return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() };
};

const plain = (plugin = yubisashi()) =>
	createServer({
		root: VITE_ROOT,
		configFile: false,
		logLevel: 'silent',
		plugins: [plugin],
		server: {
			host: '127.0.0.1',
			port: 0,
			headers: { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
		},
	});

describe('helpers', () => {
	test('parentOrigins reads the option, then the env, comma-separated, normalised to origins', () => {
		assert.deepEqual(parentOrigins(undefined, {}), []);
		assert.deepEqual(
			parentOrigins(undefined, { YUBI_PARENT_ORIGIN: 'https://a.test/x, http://b:1' }),
			['https://a.test', 'http://b:1'],
		);
		assert.deepEqual(
			parentOrigins(['https://a.test', 'https://b.test'], { YUBI_PARENT_ORIGIN: 'x' }),
			['https://a.test', 'https://b.test'],
		);
	});

	test('relaxCsp swaps only frame-ancestors', () => {
		assert.equal(
			relaxCsp("default-src 'self'; frame-ancestors 'none'; img-src *", ['https://a.test']),
			"default-src 'self'; img-src *; frame-ancestors https://a.test",
		);
	});

	test('injectScript prefers </head>, reuses a page nonce, and never leaves the page untouched', () => {
		assert.match(
			injectScript('<html><head></head><body></body></html>'),
			/<script[^>]+><\/script><\/head>/,
		);
		assert.match(injectScript('<body></body>'), /<script[^>]+><\/script><\/body>/);
		assert.match(injectScript('hello'), /^hello<script/);
		assert.match(
			injectScript('<head><script nonce="abc">1</script></head>'),
			/<script type="module" nonce="abc" src=/,
		);
	});
});

describe('plain vite', () => {
	test('does nothing without a parent origin', async () => {
		delete process.env.YUBI_PARENT_ORIGIN;
		const { origin, close } = await serve(await plain());
		try {
			const res = await fetch(`${origin}/`);
			const html = await res.text();
			assert.doesNotMatch(html, PICKER_SCRIPT);
			assert.equal(res.headers.get('x-frame-options'), 'DENY');
			assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'none'");
		} finally {
			await close();
		}
	});

	test('with YUBI_PARENT_ORIGIN set it injects the picker and relaxes frame headers', async () => {
		process.env.YUBI_PARENT_ORIGIN = `${PARENT}, https://second.example`;
		try {
			const { origin, close } = await serve(await plain());
			try {
				const res = await fetch(`${origin}/`);
				const html = await res.text();
				assert.match(html, PICKER_SCRIPT);
				assert.equal(html.match(/virtual:yubisashi/g)?.length, 1);
				assert.equal(res.headers.get('x-frame-options'), null);
				assert.equal(
					res.headers.get('content-security-policy'),
					`frame-ancestors ${PARENT} https://second.example`,
				);
				const length = res.headers.get('content-length');
				assert.ok(
					length === null || length === String(Buffer.byteLength(html)),
					'a stale content-length never truncates the injected page',
				);

				const js = await (await fetch(`${origin}/main.js`)).text();
				assert.doesNotMatch(js, /yubisashi/, 'non-HTML responses are left alone');

				const virtual = await (await fetch(`${origin}/@id/__x00__virtual:yubisashi`)).text();
				assert.match(virtual, /window\.parent !== window/);
				assert.match(
					virtual,
					new RegExp(`parentOrigin: \\["${PARENT}","https://second.example"\\]`),
				);
				const imported = virtual.match(/from "([^"]+)"/)?.[1];
				assert.ok(imported, 'the virtual module imports the picker');
				const picker = await fetch(`${origin}${imported}`);
				assert.equal(picker.status, 200, 'the picker is inside server.fs.allow');
				assert.match(await picker.text(), /createPicker/);
			} finally {
				await close();
			}
		} finally {
			delete process.env.YUBI_PARENT_ORIGIN;
		}
	});

	test('vite build output never carries the picker', async () => {
		process.env.YUBI_PARENT_ORIGIN = PARENT;
		try {
			const out = await build({
				root: VITE_ROOT,
				configFile: false,
				logLevel: 'silent',
				plugins: [yubisashi()],
				build: { write: false },
			});
			const outputs = Array.isArray(out) ? out : [out];
			const files = outputs.flatMap((o) => ('output' in o ? o.output : []));
			const html = files.find((f) => f.fileName.endsWith('.html'));
			assert.ok(html && 'source' in html);
			assert.doesNotMatch(String(html.source), /yubisashi/);
		} finally {
			delete process.env.YUBI_PARENT_ORIGIN;
		}
	});
});

describe('sveltekit', () => {
	let harness: Server;
	let harnessOrigin: string;
	let kit: { origin: string; close: () => Promise<void> };
	let browser: Browser;
	const cwd = process.cwd();

	before(async () => {
		harness = createHttpServer((_req, res) =>
			res
				.writeHead(200, { 'content-type': 'text/html' })
				.end(`<!doctype html><html><body style="margin:0">
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
	</script></body></html>`),
		);
		await new Promise<void>((r) => harness.listen(0, '127.0.0.1', r));
		harnessOrigin = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`;

		process.chdir(KIT_ROOT);
		const { sveltekit } = await import('@sveltejs/kit/vite');
		kit = await serve(
			await createServer({
				root: KIT_ROOT,
				configFile: false,
				logLevel: 'silent',
				plugins: [sveltekit(), yubisashi({ parentOrigin: harnessOrigin })],
				server: { host: '127.0.0.1', port: 0 },
			}),
		);
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await kit?.close();
		process.chdir(cwd);
		await new Promise((r) => harness.close(r));
	});

	test('the rendered page carries the picker once and allows the parent to frame it', async () => {
		const res = await fetch(`${kit.origin}/`);
		const html = await res.text();
		assert.match(html, /Kit fixture/);
		assert.match(html, PICKER_SCRIPT);
		assert.equal(html.match(/virtual:yubisashi/g)?.length, 1);
		assert.equal(res.headers.get('x-frame-options'), null);
	});

	test('framed from the parent origin, a click reports the svelte source of the element', async () => {
		const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
		page.setDefaultTimeout(10000);
		await page.goto(`${harnessOrigin}/`);
		await page.evaluate(
			(src) => (window as unknown as { frameApp: (s: string) => void }).frameApp(src),
			`${kit.origin}/`,
		);
		const frame = page.frameLocator('#app');
		await frame.locator('button.retry').waitFor();
		await frame.locator('[data-yubi="root"]').waitFor();
		const app = page.frames().find((f) => f !== page.mainFrame());
		assert.ok(app);
		await app.waitForFunction(
			() =>
				!!(document.querySelector('button.retry') as { __svelte_meta?: unknown } | null)
					?.__svelte_meta,
		);
		await page.waitForFunction(() =>
			(window as { messages?: { type: string }[] }).messages?.some((m) => m.type === 'route'),
		);

		await page.evaluate(() =>
			(window as unknown as { send: (m: unknown) => void }).send({ type: 'pick:start' }),
		);
		await frame.locator('[data-yubi="glass"]').waitFor({ state: 'visible' });
		const box = await frame.locator('button.retry').boundingBox();
		assert.ok(box);
		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
		await page.waitForFunction(() =>
			(window as { messages?: { type: string }[] }).messages?.some(
				(m) => m.type === 'pick:selected',
			),
		);
		const messages = await page.evaluate(
			() => (window as { messages?: ChildMessage[] }).messages ?? [],
		);
		assert.ok(messages.every((m) => m.yubi === 1));
		const selected = messages.find((m) => m.type === 'pick:selected');
		assert.ok(selected && selected.type === 'pick:selected');
		const [target] = selected.targets;
		assert.ok(target);
		assert.equal(target.tag, 'button');
		assert.equal(target.text, 'Retry import');
		assert.deepEqual(target.source, { file: 'src/lib/Row.svelte', line: 3, column: 1 });
		assert.deepEqual(
			target.stack.map((f) => `${f.name} ${f.file}:${f.line}`),
			['<Row> src/routes/+page.svelte:6'],
		);
		await page.close();
	});
});
