import { readFile } from 'node:fs/promises';
import { type IncomingMessage, request, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { bootstrap, CSP_HEADERS, injectScript, relaxCsp } from './frame.ts';

export const PICKER_PATH = '/__yubi/picker.js';
const PICKER_DIR = new URL('./picker/', import.meta.url);
const MODULE_PREFIX = '/__yubi/picker/';

export type ProxyOptions = { target: URL; origins: string[] };

export type Proxy = {
	request: (req: IncomingMessage, res: ServerResponse) => void;
	upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
	close: () => void;
};

const selfOrigin = (req: IncomingMessage) => {
	const secure = 'encrypted' in req.socket && req.socket.encrypted;
	return `${secure ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
};

const acceptsHtml = (req: IncomingMessage) => (req.headers.accept ?? '').includes('text/html');

function requestHeaders(req: IncomingMessage, target: URL, self: string) {
	const headers: Record<string, string | string[] | undefined> = {
		...req.headers,
		host: target.host,
	};
	if (headers.origin === self) headers.origin = target.origin;
	if (typeof headers.referer === 'string' && headers.referer.startsWith(self))
		headers.referer = target.origin + headers.referer.slice(self.length);
	if (acceptsHtml(req)) headers['accept-encoding'] = 'identity';
	return headers;
}

/** The review panel is another site, so a framed app's cookies must be allowed cross-site (partitioned per panel). */
export function frameCookie(cookie: string): string {
	const kept = cookie
		.split(';')
		.map((part) => part.trim())
		.filter((part) => part && !/^(samesite|secure|partitioned)\b/i.test(part));
	return [...kept, 'SameSite=None', 'Secure', 'Partitioned'].join('; ');
}

function responseHeaders(
	headers: IncomingMessage['headers'],
	target: URL,
	self: string,
	origins: string[],
) {
	const out = { ...headers };
	delete out['x-frame-options'];
	for (const name of CSP_HEADERS) {
		const value = out[name];
		if (typeof value === 'string') out[name] = relaxCsp(value, origins);
	}
	if (typeof out.location === 'string' && out.location.startsWith(target.origin))
		out.location = out.location.slice(target.origin.length) || '/';
	if (self.startsWith('https:') && out['set-cookie'])
		out['set-cookie'] = out['set-cookie'].map(frameCookie);
	return out;
}

const decode = (body: Buffer, encoding: string) => {
	switch (encoding) {
		case 'gzip':
		case 'x-gzip':
			return gunzipSync(body);
		case 'deflate':
			return inflateSync(body);
		case 'br':
			return brotliDecompressSync(body);
		case '':
		case 'identity':
			return body;
		default:
			return null;
	}
};

const readAll = (stream: IncomingMessage) =>
	new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (c: Buffer) => chunks.push(c));
		stream.on('end', () => resolve(Buffer.concat(chunks)));
		stream.on('error', reject);
	});

async function servePicker(pathname: string, res: ServerResponse, origins: string[]) {
	res.setHeader('content-type', 'text/javascript; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	if (pathname === PICKER_PATH) return res.end(bootstrap(`${MODULE_PREFIX}index.js`, origins));
	const file = pathname.slice(MODULE_PREFIX.length);
	if (!/^[\w-]+\.js$/.test(file)) return res.writeHead(404).end();
	try {
		res.end(await readFile(fileURLToPath(new URL(file, PICKER_DIR))));
	} catch {
		res.writeHead(404).end();
	}
}

export function createProxy({ target, origins }: ProxyOptions): Proxy {
	const send = target.protocol === 'https:' ? httpsRequest : request;
	const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
	const tunnels = new Set<Duplex>();

	const proxyRequest = (req: IncomingMessage, res: ServerResponse) => {
		const pathname = (req.url ?? '/').split('?')[0] ?? '/';
		if (pathname === PICKER_PATH || pathname.startsWith(MODULE_PREFIX)) {
			void servePicker(pathname, res, origins);
			return;
		}
		const self = selfOrigin(req);
		const upstream = send(
			{
				protocol: target.protocol,
				hostname: target.hostname,
				port,
				method: req.method,
				path: req.url,
				headers: requestHeaders(req, target, self),
				rejectUnauthorized: false,
			},
			(up) => {
				const headers = responseHeaders(up.headers, target, self, origins);
				const status = up.statusCode ?? 502;
				if (!(headers['content-type'] ?? '').includes('text/html')) {
					res.writeHead(status, headers);
					up.pipe(res);
					return;
				}
				void readAll(up).then((raw) => {
					const body = decode(raw, (headers['content-encoding'] ?? '').toLowerCase());
					if (body === null) {
						res.writeHead(status, headers);
						return res.end(raw);
					}
					const html = injectScript(body.toString('utf8'), PICKER_PATH);
					delete headers['content-encoding'];
					delete headers['transfer-encoding'];
					headers['content-length'] = String(Buffer.byteLength(html));
					res.writeHead(status, headers);
					res.end(html);
				});
			},
		);
		upstream.on('error', (err) => {
			if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
			res.end(`yubisashi: ${target.origin} is not reachable (${err.message})`);
		});
		req.pipe(upstream);
	};

	const proxyUpgrade = (req: IncomingMessage, client: Duplex, head: Buffer) => {
		const upstream: Socket =
			target.protocol === 'https:'
				? tlsConnect({ host: target.hostname, port, rejectUnauthorized: false })
				: connect(port, target.hostname);
		upstream.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
			const lines = [`${req.method} ${req.url} HTTP/1.1`];
			for (const [key, value] of Object.entries(requestHeaders(req, target, selfOrigin(req))))
				for (const v of Array.isArray(value) ? value : [value])
					if (v !== undefined) lines.push(`${key}: ${v}`);
			upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
			if (head.length) upstream.write(head);
			upstream.pipe(client).pipe(upstream);
		});
		tunnels.add(client);
		const close = () => {
			tunnels.delete(client);
			upstream.destroy();
			client.destroy();
		};
		for (const socket of [upstream, client]) {
			socket.on('error', close);
			socket.on('close', close);
		}
	};

	return {
		request: proxyRequest,
		upgrade: proxyUpgrade,
		close: () => {
			for (const socket of tunnels) socket.destroy();
		},
	};
}
