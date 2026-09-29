import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { delimiter, join } from 'node:path';
import { createSecureContext, type SecureContext, TLSSocket } from 'node:tls';
import { cacheDir, ensureCert, namesFor } from './cert.ts';
import { createProxy } from './proxy.ts';

export type DevOptions = {
	command?: string[];
	cwd?: string;
	target?: string;
	port?: number;
	host?: string;
	origins: string[];
	https?: boolean;
	/** Certificate + key to serve instead of a generated self-signed one. */
	tls?: TlsFiles;
	/** Host name or address printed in URLs (and added to a generated certificate). */
	advertise?: string;
	certDir?: string;
	log?: (line: string) => void;
	childOutput?: NodeJS.WritableStream | null;
	detectTimeout?: number;
	readyTimeout?: number;
	/** Publish the proxy as a cctui preview of this session instead of printing local URLs. */
	cctui?: CctuiOptions;
};

export type CctuiOptions = { sessionId: string; bin?: string };

export const CCTUI_BIN = 'cctui-daemon';

/** Path of `cctui-daemon` when it is on PATH, else null. */
export function findCctui(env: NodeJS.ProcessEnv = process.env): string | null {
	for (const dir of (env.PATH ?? '').split(delimiter)) {
		if (!dir) continue;
		const file = join(dir, CCTUI_BIN);
		try {
			accessSync(file, constants.X_OK);
			return file;
		} catch {}
	}
	return null;
}

/** The cctui session this run publishes a preview of. `--session` wins over
 *  `CCTUI_SESSION_ID`, which adapters other than claude-code do not always set. */
export function resolveCctui(input: {
	session?: string;
	noCctui?: boolean;
	env?: NodeJS.ProcessEnv;
}): CctuiOptions | undefined {
	if (input.noCctui) return undefined;
	const env = input.env ?? process.env;
	const sessionId = input.session?.trim() || env.CCTUI_SESSION_ID;
	if (!sessionId) return undefined;
	const bin = findCctui(env);
	return bin ? { bin, sessionId } : undefined;
}

function cctuiPreview(bin: string, action: 'open' | 'close', port: number, sessionId: string) {
	return new Promise<string>((resolve, reject) => {
		execFile(
			bin,
			['preview', action, '--port', String(port), '--session', sessionId],
			{ timeout: 30000 },
			(err, stdout, stderr) => {
				if (err)
					reject(
						new Error(
							`yubisashi: ${CCTUI_BIN} preview ${action} failed: ${stderr.trim() || err.message}`,
						),
					);
				else resolve(stdout.trim());
			},
		);
	});
}

export type DevHandle = {
	target: URL;
	urls: string[];
	port: number;
	child: ChildProcess | null;
	close: () => Promise<void>;
};

export const FALLBACK_TARGET = 'http://localhost:5173';
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+\/?/;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g');

export const detectUrl = (line: string) => {
	const found = line.replace(ANSI, '').match(LOCAL_URL)?.[0];
	if (!found) return null;
	const url = new URL(found);
	if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = 'localhost';
	return url.origin;
};

export const killTree = (child: ChildProcess | null, signal: NodeJS.Signals = 'SIGTERM') => {
	if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitReachable(target: URL, timeout: number) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		try {
			await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
			return;
		} catch {
			await sleep(250);
		}
	}
	throw new Error(`yubisashi: ${target.origin} did not answer within ${timeout}ms`);
}

function startChild(command: string[], cwd: string, out: NodeJS.WritableStream | null) {
	const [cmd, ...args] = command;
	if (!cmd) return { child: null, detected: Promise.resolve<string | null>(null) };
	const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], detached: true });
	const detected = new Promise<string | null>((resolve) => {
		let rest = '';
		child.stdout?.on('data', (chunk: Buffer) => {
			out?.write(chunk);
			rest += chunk.toString('utf8');
			const lines = rest.split('\n');
			rest = lines.pop() ?? '';
			for (const line of lines) {
				const url = detectUrl(line);
				if (url) resolve(url);
			}
		});
		child.on('exit', () => resolve(null));
	});
	return { child, detected };
}

const WILDCARD = new Set(['0.0.0.0', '::']);
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** URLs to print: the advertised name if given, else the bound address; never a scan of the machine's interfaces. */
export function reachableUrls(host: string, port: number, scheme: string, advertise?: string) {
	const name = advertise || (WILDCARD.has(host) || LOOPBACK.has(host) ? 'localhost' : host);
	return [`${scheme}://${name}:${port}/`];
}

export type TlsFiles = { key: Buffer; cert: Buffer };

/** TLS in front of `app`: the caller's certificate, else a generated one per local address naming only that address. */
function tlsListener(
	app: Server,
	options: {
		host: string;
		tls?: TlsFiles;
		advertise?: string;
		certDir: string;
		log: (line: string) => void;
	},
) {
	const { host, tls, advertise, certDir, log } = options;
	const fixed = tls && createSecureContext(tls);
	const contexts = new Map<string, SecureContext>();
	const contextFor = (address: string) => {
		if (fixed) return fixed;
		const names = [...namesFor(address), ...(advertise ? [advertise] : [])];
		const id = names.join(',');
		let ctx = contexts.get(id);
		if (!ctx) {
			const cert = ensureCert(names, certDir);
			ctx = createSecureContext({ key: cert.key, cert: cert.cert });
			contexts.set(id, ctx);
			log(`yubisashi: self-signed certificate ${cert.file} (${cert.tool}) for ${names.join(', ')}`);
		}
		return ctx;
	};
	contextFor(WILDCARD.has(host) ? '127.0.0.1' : host);
	return createNetServer((socket) => {
		const secure = new TLSSocket(socket, {
			isServer: true,
			secureContext: contextFor(socket.localAddress ?? '127.0.0.1'),
		});
		secure.on('error', () => socket.destroy());
		app.emit('connection', secure);
	});
}

export async function startDev(options: DevOptions): Promise<DevHandle> {
	const {
		command = [],
		cwd = process.cwd(),
		port = 4780,
		host = '127.0.0.1',
		origins,
		https = true,
		log = () => {},
		childOutput = process.stdout,
		detectTimeout = 15000,
		readyTimeout = 120000,
	} = options;
	if (!origins.length)
		throw new Error('yubisashi: --parent-origin (or YUBI_PARENT_ORIGIN) is required');

	const { child, detected } = startChild(command, cwd, childOutput);
	const exited = new Promise<never>((_, reject) =>
		child?.on('exit', (code) => reject(new Error(`yubisashi: dev command exited with ${code}`))),
	);
	let targetUrl = options.target;
	if (!targetUrl) {
		const found = child
			? await Promise.race([detected, sleep(detectTimeout).then(() => null)])
			: null;
		targetUrl = found ?? FALLBACK_TARGET;
		log(
			found
				? `yubisashi: target ${found} (from dev server output)`
				: `yubisashi: target ${targetUrl}`,
		);
	}
	const target = new URL(targetUrl);

	try {
		await Promise.race([waitReachable(target, readyTimeout), ...(child ? [exited] : [])]);
	} catch (err) {
		killTree(child);
		throw err;
	}

	const proxy = createProxy({ target, origins });
	const app = createHttpServer(proxy.request);
	app.on('upgrade', proxy.upgrade);
	const server = https
		? tlsListener(app, {
				host,
				tls: options.tls,
				advertise: options.advertise,
				certDir: options.certDir ?? cacheDir(),
				log,
			})
		: app;
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, resolve);
	});
	const bound = (server.address() as AddressInfo).port;
	const cctui = options.cctui && {
		bin: options.cctui.bin ?? CCTUI_BIN,
		sessionId: options.cctui.sessionId,
	};
	let urls: string[];
	if (cctui) {
		try {
			urls = [await cctuiPreview(cctui.bin, 'open', bound, cctui.sessionId)];
		} catch (err) {
			killTree(child);
			server.close();
			throw err;
		}
	} else urls = reachableUrls(host, bound, https ? 'https' : 'http', options.advertise);

	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		if (cctui) await cctuiPreview(cctui.bin, 'close', bound, cctui.sessionId).catch(() => {});
		killTree(child);
		proxy.close();
		app.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		if (child && child.exitCode === null && child.signalCode === null)
			await new Promise<void>((r) => {
				const t = setTimeout(() => {
					killTree(child, 'SIGKILL');
					r();
				}, 3000);
				child.once('exit', () => {
					clearTimeout(t);
					r();
				});
			});
	};
	child?.on('exit', () => void close());
	return { target, urls, port: bound, child, close };
}
