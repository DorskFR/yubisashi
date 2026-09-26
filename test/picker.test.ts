import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { type Browser, chromium, type Frame, type Page } from 'playwright';
import type { ChildMessage, ParentMessage, Unmarked } from '../src/picker/protocol.ts';

const DIST = new URL('../dist/picker/', import.meta.url);
const FIXTURE = readFileSync(new URL('./fixture/index.html', import.meta.url), 'utf8');

const APP = FIXTURE.replace(
	'</body>',
	`<input id="note" />
	<script type="module">
		import { createPicker } from '/picker/index.js';
		window.picker = createPicker({ parentOrigin: ['https://other.example', location.origin] });
	</script></body>`,
);
const HARNESS = `<!doctype html><html><body style="margin:0">
	<iframe id="app" src="/app.html" style="display:block;width:1000px;height:700px;border:0"></iframe>
	<script>
		window.messages = [];
		addEventListener('message', (e) => {
			if (e.source === document.getElementById('app').contentWindow) window.messages.push(e.data);
		});
		window.send = (m) => document.getElementById('app').contentWindow.postMessage({ yubi: 1, ...m }, location.origin);
	</script></body></html>`;

const SHOTS = process.env.YUBI_SHOTS;
const shot = (name: string) =>
	SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve();

let server: Server;
let browser: Browser;
let page: Page;
let app: Frame;
let origin: string;

before(async () => {
	server = createServer((req, res) => {
		const path = req.url ?? '/';
		if (path === '/harness.html')
			return res.writeHead(200, { 'content-type': 'text/html' }).end(HARNESS);
		if (path === '/app.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(APP);
		const mod = path.match(/^\/picker\/([\w-]+\.js)$/);
		if (mod)
			return res
				.writeHead(200, { 'content-type': 'text/javascript' })
				.end(readFileSync(new URL(mod[1] ?? '', DIST)));
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
	page.setDefaultTimeout(5000);
	await page.goto(`${origin}/harness.html`);
	await page.frameLocator('#app').locator('button.retry').waitFor();
	app = page.frames().find((f) => f !== page.mainFrame()) as Frame;
});

after(async () => {
	await browser?.close();
	await new Promise((r) => server.close(r));
});

const messages = () =>
	page.evaluate(() => (window as { messages?: ChildMessage[] }).messages ?? []);
const last = async <T extends ChildMessage['type']>(type: T) =>
	(await messages()).filter((m): m is Extract<ChildMessage, { type: T }> => m.type === type).at(-1);
/** Waits for the next message of `type` (posted after `since` messages had arrived) and returns it. */
const next = async <T extends ChildMessage['type']>(type: T, since: number) => {
	await page.waitForFunction(
		([type, since]) =>
			((window as { messages?: { type: string }[] }).messages ?? [])
				.slice(since)
				.some((m) => m.type === type),
		[type, since] as const,
	);
	return last(type);
};
const count = async () => (await messages()).length;
const send = (m: Unmarked<ParentMessage>) =>
	page.evaluate((m) => (window as unknown as { send: (m: unknown) => void }).send(m), m);
const glass = () => app.locator('[data-yubi="glass"]');
const picking = () =>
	app.evaluate(() => (window as unknown as { picker: { picking: boolean } }).picker.picking);
const center = async (selector: string) => {
	const box = await page.frameLocator('#app').locator(selector).boundingBox();
	assert.ok(box, `${selector} is visible`);
	return [box.x + box.width / 2, box.y + box.height / 2] as const;
};

test('announces its route with the yubi marker and ignores messages from other origins, sources, or without the marker', async () => {
	assert.deepEqual(await last('route'), { yubi: 1, type: 'route', route: '/app.html' });
	assert.ok(
		(await messages()).every((m) => m.yubi === 1),
		'every message carries yubi: 1',
	);
	const fake = (data: unknown, origin: string, fromParent: boolean) =>
		app.evaluate(
			([data, origin, fromParent]) =>
				window.dispatchEvent(
					new MessageEvent('message', {
						data,
						origin,
						source: fromParent ? window.parent : window,
					}),
				),
			[data, origin, fromParent] as const,
		);
	await fake({ yubi: 1, type: 'pick:start' }, 'http://evil.test', true);
	assert.equal(await picking(), false, 'an origin outside the allowlist cannot start picking');
	await fake({ yubi: 1, type: 'pick:start' }, 'https://other.example', false);
	assert.equal(await picking(), false, 'a listed origin from the wrong source cannot either');
	await page.evaluate(() =>
		(document.getElementById('app') as HTMLIFrameElement).contentWindow?.postMessage(
			{ type: 'pick:start' },
			location.origin,
		),
	);
	assert.equal(await picking(), false, 'the real parent without yubi: 1 is ignored');
	await expectHidden();
	await send({ type: 'pick:start' });
	await glass().waitFor({ state: 'visible' });
	assert.equal(await picking(), true, 'the framing origin, being on the allowlist, is accepted');
	await send({ type: 'pick:stop' });
	await expectHidden();
});

async function expectHidden() {
	await glass().waitFor({ state: 'hidden' });
}

test('hovering shows the source label; a click selects and reports source, stack and selector', async () => {
	await send({ type: 'pick:start' });
	await glass().waitFor({ state: 'visible' });
	assert.deepEqual(await last('pick:state'), { yubi: 1, type: 'pick:state', picking: true });

	await page.mouse.move(...(await center('button.retry')));
	await app
		.locator('[data-yubi="hover"] [data-yubi="label"]', {
			hasText: '<button> EpisodeRow.svelte:12',
		})
		.waitFor();
	assert.equal((await last('pick:hover'))?.target?.tag, 'button');
	await shot('hover');

	const before = await count();
	await page.mouse.click(...(await center('button.retry')));
	await expectHidden();
	assert.deepEqual(await next('pick:state', before), {
		yubi: 1,
		type: 'pick:state',
		picking: false,
	});
	assert.equal(
		await app.evaluate(() => (window as { appClicks?: number }).appClicks ?? 0),
		0,
		'the app never saw the click',
	);

	const selected = await last('pick:selected');
	assert.ok(selected);
	assert.equal(selected.route, '/app.html');
	assert.deepEqual(selected.viewport, { width: 1000, height: 700 });
	assert.equal(selected.targets.length, 1);
	const [target] = selected.targets;
	assert.ok(target);
	assert.equal(target.tag, 'button');
	assert.equal(target.text, 'Retry import');
	assert.deepEqual(target.source, { file: 'src/lib/EpisodeRow.svelte', line: 12, column: 4 });
	assert.deepEqual(
		target.stack.map((f) => [f.name, `${f.file}:${f.line}:${f.column}`]),
		[
			['<EpisodeRow>', 'src/routes/+page.svelte:30:2'],
			['<Page>', 'src/routes/+layout.svelte:5:1'],
		],
	);
	assert.match(target.selector, /button\.retry$/);
	assert.doesNotMatch(target.selector, /s-BUJU|svelte-1x2/);
	assert.equal(target.attrs.type, 'button');
	assert.match(target.html, /^<button class="retry/);
	assert.ok(target.rect.width > 0 && target.rect.height > 0);
	await app
		.locator('[data-yubi="selected"] [data-yubi="label"]', {
			hasText: '<button> EpisodeRow.svelte:12',
		})
		.waitFor();
});

test('C toggles picking, shift-click adds disabled controls, the wheel scrolls the app', async () => {
	await page.mouse.move(...(await center('h1')));
	await page.keyboard.press('c');
	await glass().waitFor({ state: 'visible' });

	let before = await count();
	await page.keyboard.down('Shift');
	await page.mouse.click(...(await center('button.grab')));
	await page.keyboard.up('Shift');
	const selected = await next('pick:selected', before);
	assert.equal(selected?.targets.length, 2, 'shift-click adds to the selection');
	assert.match(selected?.targets[1]?.selector ?? '', /button\.grab$/);
	assert.equal(selected?.targets[1]?.text, 'Grab');
	assert.equal(await picking(), true, 'additive picks keep pick mode on');
	await shot('multi-select');

	await page.mouse.wheel(0, 400);
	await app.waitForFunction(() => window.scrollY > 0);
	await page.mouse.wheel(0, -400);
	await app.waitForFunction(() => window.scrollY === 0);

	before = await count();
	await page.keyboard.down('Shift');
	await page.mouse.click(...(await center('button.grab')));
	await page.keyboard.up('Shift');
	assert.equal(
		(await next('pick:selected', before))?.targets.length,
		1,
		'shift-click again removes it',
	);
});

test('Escape backs out: picking, then the selection, then the parent', async () => {
	let before = await count();
	await page.keyboard.press('Escape');
	await expectHidden();
	assert.deepEqual(await next('pick:state', before), {
		yubi: 1,
		type: 'pick:state',
		picking: false,
	});
	assert.equal((await last('pick:selected'))?.targets.length, 1);
	before = await count();
	await page.keyboard.press('Escape');
	assert.deepEqual((await next('pick:selected', before))?.targets, []);
	assert.equal(await last('pick:cancel'), undefined);
	before = await count();
	await page.keyboard.press('Escape');
	assert.deepEqual(await next('pick:cancel', before), { yubi: 1, type: 'pick:cancel' });
});

test('C while typing in the app is left alone', async () => {
	await page.frameLocator('#app').locator('#note').click();
	await page.keyboard.type('c');
	assert.equal(await picking(), false);
	assert.equal(await page.frameLocator('#app').locator('#note').inputValue(), 'c');
	await page.frameLocator('#app').locator('#note').blur();
});

test('pins follow the given selectors, open their thread on click, and stick to picked elements', async () => {
	await app.evaluate(() => window.scrollTo(0, 0));
	await send({ type: 'pins:set', pins: [{ id: 1, selector: 'button.retry' }] });
	const pin = app.locator('[data-yubi="pin"][data-id="1"]');
	await pin.waitFor();
	const [retry, pinBox] = [
		await page.frameLocator('#app').locator('button.retry').boundingBox(),
		await pin.boundingBox(),
	];
	assert.ok(retry && pinBox);
	assert.ok(
		Math.abs(pinBox.x + 11 - (retry.x + retry.width)) < 2,
		'pin sits at the top-right corner',
	);
	await shot('pin');
	const before = await count();
	await pin.click();
	assert.deepEqual(await next('pin:open', before), { yubi: 1, type: 'pin:open', id: 1 });

	await send({ type: 'pick:start' });
	await glass().waitFor({ state: 'visible' });
	await page.mouse.click(...(await center('button.grab')));
	await send({ type: 'pick:clear', id: 2 });
	await app.waitForFunction(() => !document.querySelector('[data-yubi="selected"]'));
	await send({ type: 'pins:set', pins: [{ id: 2, selector: '[data-gone]' }] });
	await app.locator('[data-yubi="pin"][data-id="2"]').waitFor();

	await send({ type: 'pins:set', pins: [] });
	await app.waitForFunction(() => !document.querySelector('[data-yubi="pin"]'));
});
