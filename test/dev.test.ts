import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type Browser, chromium } from 'playwright';
import { createServer as createVite } from 'vite';
import { type DevHandle, detectUrl, startDev } from '../dist/dev.js';
import type { ChildMessage } from '../dist/picker/index.js';

const PARENT = 'https://review.example';
const PICKER_SCRIPT = /<script type="module" src="\/__yubi\/picker\.js"><\/script>/;
const CERT_DIR = fileURLToPath(new URL('../.qa/cert-cache/', import.meta.url));
const VITE_ROOT = fileURLToPath(new URL('./fixture-vite/', import.meta.url));
const PAGE = '<!doctype html><html><head><title>up</title></head><body><h1>up</h1></body></html>';

const listen = (server: Server) =>
	new Promise<string>((r) =>
		server.listen(0, '127.0.0.1', () =>
			r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
		),
	);

function upstreamServer() {
	const server = createHttpServer((req, res) => {
		const frameHeaders = {
			'x-frame-options': 'DENY',
			'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
		};
		switch (req.url) {
			case '/':
				return res
					.writeHead(200, {
						...frameHeaders,
						'content-type': 'text/html; charset=utf-8',
						'content-length': Buffer.byteLength(PAGE),
						'x-seen-encoding': req.headers['accept-encoding'] ?? 'none',
						'x-seen-origin': req.headers.origin ?? 'none',
						'x-seen-referer': req.headers.referer ?? 'none',
					})
					.end(PAGE);
			case '/gz': {
				const body = gzipSync(PAGE);
				return res
					.writeHead(200, {
						'content-type': 'text/html',
						'content-encoding': 'gzip',
						'content-length': body.length,
					})
					.end(body);
			}
			case '/main.js':
				return res
					.writeHead(200, { 'content-type': 'text/javascript', ...frameHeaders })
					.end('console.log("</head>")');
			case '/login':
				return res
					.writeHead(204, {
						'set-cookie': ['sid=1; Path=/; HttpOnly; SameSite=Lax', 'theme=dark; Secure'],
					})
					.end();
			case '/redir':
				return res.writeHead(302, { location: `http://${req.headers.host}/after` }).end();
			default:
				return res.writeHead(404).end();
		}
	});
	server.on('upgrade', (req, socket) => {
		const accept = createHash('sha1')
			.update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
			.digest('base64');
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);
		const payload = Buffer.from(`hello ${req.headers.host}`);
		socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
		socket.on('end', () => socket.end());
	});
	return server;
}

const proxied = (target: string, extra: Partial<Parameters<typeof startDev>[0]> = {}) =>
	startDev({
		target,
		origins: [PARENT, 'https://second.example'],
		host: '127.0.0.1',
		port: 0,
		https: false,
		childOutput: null,
		...extra,
	});

describe('http proxy', () => {
	let upstream: Server;
	let target: string;
	let dev: DevHandle;
	let origin: string;

	before(async () => {
		upstream = upstreamServer();
		target = await listen(upstream);
		dev = await proxied(target);
		origin = `http://127.0.0.1:${dev.port}`;
	});
	after(async () => {
		await dev.close();
		await new Promise((r) => upstream.close(r));
	});

	test('injects the picker once, fixes content-length, relaxes frame headers', async () => {
		const res = await fetch(`${origin}/`, {
			headers: { accept: 'text/html', origin, referer: `${origin}/from` },
		});
		const html = await res.text();
		assert.match(html, PICKER_SCRIPT);
		assert.equal(html.match(/__yubi\/picker\.js/g)?.length, 1);
		assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(html)));
		assert.equal(res.headers.get('x-frame-options'), null);
		assert.equal(
			res.headers.get('content-security-policy'),
			`default-src 'self'; frame-ancestors ${PARENT} https://second.example`,
		);
		assert.equal(res.headers.get('x-seen-encoding'), 'identity');
		assert.equal(res.headers.get('x-seen-origin'), target);
		assert.equal(res.headers.get('x-seen-referer'), `${target}/from`);
	});

	test('decompresses a gzip upstream that ignores accept-encoding', async () => {
		const res = await fetch(`${origin}/gz`);
		assert.equal(res.headers.get('content-encoding'), null);
		const html = await res.text();
		assert.match(html, /<h1>up<\/h1>/);
		assert.equal(html.match(/__yubi\/picker\.js/g)?.length, 1);
	});

	test('passes non-HTML through untouched', async () => {
		const res = await fetch(`${origin}/main.js`);
		assert.equal(await res.text(), 'console.log("</head>")');
		assert.equal(res.headers.get('x-frame-options'), null);
	});

	test('rewrites redirects back to the proxy', async () => {
		const res = await fetch(`${origin}/redir`, { redirect: 'manual' });
		assert.equal(res.status, 302);
		assert.equal(res.headers.get('location'), `${origin}/after`);
	});

	test('serves the picker bootstrap and its modules', async () => {
		const boot = await (await fetch(`${origin}/__yubi/picker.js`)).text();
		assert.match(boot, /window\.parent !== window/);
		assert.match(boot, new RegExp(`parentOrigin: \\["${PARENT}","https://second.example"\\]`));
		const mod = await fetch(`${origin}/__yubi/picker/index.js`);
		assert.equal(mod.status, 200);
		assert.match(await mod.text(), /createPicker/);
		assert.equal((await fetch(`${origin}/__yubi/picker/../cli.js`)).status, 404);
	});

	test('tunnels a WebSocket upgrade with a rewritten host', async () => {
		const ws = new WebSocket(`ws://127.0.0.1:${dev.port}/ws`);
		const message = await new Promise<string>((resolve, reject) => {
			ws.onmessage = (e) => resolve(String(e.data));
			ws.onerror = () => reject(new Error('ws failed'));
		});
		ws.close();
		assert.equal(message, `hello ${new URL(target).host}`);
	});
});

const sanOf = (host: string, port: number) =>
	new Promise<string>((resolve, reject) => {
		const socket = tlsConnect({ host, port, rejectUnauthorized: false }, () => {
			resolve(socket.getPeerCertificate().subjectaltname ?? '');
			socket.end();
		});
		socket.on('error', reject);
	});

describe('https', () => {
	test('each address gets a certificate naming only itself', async () => {
		const upstream = upstreamServer();
		const target = await listen(upstream);
		const dev = await proxied(target, { https: true, host: '0.0.0.0', certDir: CERT_DIR });
		try {
			const lan = Object.values(networkInterfaces())
				.flat()
				.filter((i) => i && i.family === 'IPv4' && !i.internal)
				.map((i) => (i as { address: string }).address);
			const local = await sanOf('127.0.0.1', dev.port);
			assert.match(local, /IP Address:127\.0\.0\.1/);
			for (const address of lan)
				assert.ok(!local.includes(address), `${address} leaked to loopback`);
			for (const address of lan)
				assert.equal(await sanOf(address, dev.port), `IP Address:${address}`);
		} finally {
			await dev.close();
			upstream.close();
		}
	});

	test('binds loopback only by default', async () => {
		const upstream = upstreamServer();
		const target = await listen(upstream);
		const dev = await startDev({
			target,
			origins: [PARENT],
			port: 0,
			https: false,
			childOutput: null,
		});
		try {
			assert.deepEqual(dev.urls, [`http://localhost:${dev.port}/`]);
		} finally {
			await dev.close();
			upstream.close();
		}
	});

	test('serves the caller certificate and advertised name', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'yubi-cert-'));
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=dev.example.test',
				'-addext',
				'subjectAltName=DNS:dev.example.test',
				'-keyout',
				join(dir, 'k.pem'),
				'-out',
				join(dir, 'c.pem'),
			],
			{ stdio: 'ignore' },
		);
		const upstream = upstreamServer();
		const target = await listen(upstream);
		const dev = await proxied(target, {
			https: true,
			advertise: 'dev.example.test',
			tls: { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) },
		});
		try {
			assert.deepEqual(dev.urls, [`https://dev.example.test:${dev.port}/`]);
			assert.equal(await sanOf('127.0.0.1', dev.port), 'DNS:dev.example.test');
		} finally {
			await dev.close();
			upstream.close();
		}
	});

	test('makes the app cookies usable inside the cross-site frame over TLS', async () => {
		const upstream = upstreamServer();
		const target = await listen(upstream);
		const dev = await proxied(target, { https: true, certDir: CERT_DIR });
		try {
			const cookies = await new Promise<string[]>((resolve, reject) =>
				httpsRequest(
					{ host: 'localhost', port: dev.port, path: '/login', rejectUnauthorized: false },
					(res) => {
						res.resume();
						resolve(res.headers['set-cookie'] ?? []);
					},
				)
					.on('error', reject)
					.end(),
			);
			assert.deepEqual(cookies, [
				'sid=1; Path=/; HttpOnly; SameSite=None; Secure; Partitioned',
				'theme=dark; SameSite=None; Secure; Partitioned',
			]);
		} finally {
			await dev.close();
			upstream.close();
		}
	});

	test('leaves cookies alone over plain HTTP', async () => {
		const upstream = upstreamServer();
		const target = await listen(upstream);
		const dev = await proxied(target);
		try {
			const res = await fetch(`http://127.0.0.1:${dev.port}/login`);
			assert.deepEqual(res.headers.getSetCookie(), [
				'sid=1; Path=/; HttpOnly; SameSite=Lax',
				'theme=dark; Secure',
			]);
		} finally {
			await dev.close();
			upstream.close();
		}
	});

	test('serves over TLS with a generated certificate', async () => {
		const upstream = upstreamServer();
		const target = await listen(upstream);
		const logs: string[] = [];
		const dev = await proxied(target, { https: true, certDir: CERT_DIR, log: (l) => logs.push(l) });
		try {
			assert.deepEqual(dev.urls, [`https://localhost:${dev.port}/`]);
			assert.ok(logs.some((l) => /certificate .*cert\.pem \((mkcert|openssl)\)/.test(l)));
			const html = await new Promise<string>((resolve, reject) =>
				httpsRequest(
					{ host: 'localhost', port: dev.port, path: '/', rejectUnauthorized: false },
					(res) => {
						let body = '';
						res.setEncoding('utf8');
						res.on('data', (c) => (body += c));
						res.on('end', () => resolve(body));
					},
				)
					.on('error', reject)
					.end(),
			);
			assert.match(html, PICKER_SCRIPT);
		} finally {
			await dev.close();
			await new Promise((r) => upstream.close(r));
		}
	});
});

describe('dev command', () => {
	test('detectUrl finds the first local URL in a line', () => {
		assert.equal(detectUrl('  ➜  Local:   http://localhost:5174/'), 'http://localhost:5174');
		assert.equal(
			detectUrl(
				'  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5199\x1b[22m/\x1b[39m',
			),
			'http://localhost:5199',
		);
		assert.equal(detectUrl('listening on http://0.0.0.0:3000'), 'http://localhost:3000');
		assert.equal(detectUrl('  ➜  Network: http://192.0.2.2:5174/'), null);
	});

	test('detects the target from the child output and kills the child on close', async () => {
		const script = `
const http = require('node:http');
const server = http.createServer((req, res) =>
	res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>child</body></html>'));
server.listen(0, '127.0.0.1', () => {
	console.log('  VITE v8  ready in 10 ms');
	console.log('  ➜  Local:   http://localhost:' + server.address().port + '/');
});
`;
		const dev = await startDev({
			command: [process.execPath, '-e', script],
			origins: [PARENT],
			host: '127.0.0.1',
			port: 0,
			https: false,
			childOutput: null,
		});
		const pid = dev.child?.pid;
		assert.ok(pid);
		assert.match(dev.target.origin, /^http:\/\/localhost:\d+$/);
		const html = await (await fetch(`http://127.0.0.1:${dev.port}/`)).text();
		assert.match(html, /child/);
		assert.match(html, PICKER_SCRIPT);
		await dev.close();
		await new Promise((r) => setTimeout(r, 200));
		assert.throws(() => process.kill(pid, 0), 'child still alive after close');
	});
});

describe('browser', () => {
	let harness: Server;
	let harnessOrigin: string;
	let vite: Awaited<ReturnType<typeof createVite>>;
	let dev: DevHandle;
	let browser: Browser;

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
		harnessOrigin = await listen(harness);
		vite = await createVite({
			root: VITE_ROOT,
			configFile: false,
			logLevel: 'silent',
			server: { host: '127.0.0.1', port: 0 },
		});
		await vite.listen();
		const address = vite.httpServer?.address() as AddressInfo;
		dev = await proxied(`http://127.0.0.1:${address.port}`, {
			https: true,
			certDir: CERT_DIR,
			origins: [harnessOrigin],
		});
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await dev?.close();
		await vite?.close();
		await new Promise((r) => harness.close(r));
	});

	test('a parent on another origin frames the https proxy and receives a pick', async () => {
		const page = await browser.newPage({
			viewport: { width: 1200, height: 800 },
			ignoreHTTPSErrors: true,
		});
		page.setDefaultTimeout(10000);
		await page.goto(`${harnessOrigin}/`);
		await page.evaluate(
			(src) => (window as unknown as { frameApp: (s: string) => void }).frameApp(src),
			`https://localhost:${dev.port}/`,
		);
		const frame = page.frameLocator('#app');
		await frame.locator('[data-yubi="root"]').waitFor();
		await page.waitForFunction(() =>
			(window as { messages?: { type: string }[] }).messages?.some((m) => m.type === 'route'),
		);
		await page.evaluate(() =>
			(window as unknown as { send: (m: unknown) => void }).send({ type: 'pick:start' }),
		);
		await frame.locator('[data-yubi="glass"]').waitFor({ state: 'visible' });
		const box = await frame.locator('#go').boundingBox();
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
		const selected = messages.find((m) => m.type === 'pick:selected');
		assert.ok(selected && selected.type === 'pick:selected');
		assert.equal(selected.targets[0]?.tag, 'button');
		assert.equal(selected.targets[0]?.text, 'Go');
		await page.close();
	});
});
