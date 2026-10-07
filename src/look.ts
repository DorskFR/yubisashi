import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const LOOK_PATH = '/__yubi/look';
export const LOOK_EVENTS_PATH = '/__yubi/look/events';
const RESULT_PREFIX = '/__yubi/look/result/';
const STATE_PREFIX = '/__yubi/look/state/';

export const DEFAULT_LOOK_TIMEOUT = 15_000;
export const MAX_RESULT_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

export type LookKind = 'page' | 'dom' | 'styles' | 'shot';
export const LOOK_KINDS: readonly LookKind[] = ['page', 'dom', 'styles', 'shot'];

export type LookArgs = Record<string, unknown>;
export type LookRequest = { id: string; kind: string; args: LookArgs };
export type LookResult = { ok: true; data: unknown } | { ok: false; error: string };

export type LookChannelOptions = { token: string; timeout?: number };

export type LookChannel = {
	/** Serves the request when it is a look endpoint; returns false otherwise. */
	handle: (req: IncomingMessage, res: ServerResponse) => boolean;
	/** The browsers currently subscribed. */
	readonly subscribers: number;
	close: () => void;
};

type Subscriber = {
	id: string;
	res: ServerResponse;
	active: number;
	allowed: boolean;
	seq: number;
};

type Pending = {
	subscriber: Subscriber;
	resolve: (result: LookResult) => void;
	timer: ReturnType<typeof setTimeout>;
};

export const newToken = () => randomBytes(24).toString('base64url');

const nonce = () => randomBytes(18).toString('base64url');

function bearerOk(header: string | undefined, token: string) {
	const given = header?.match(/^Bearer\s+(\S+)$/i)?.[1];
	if (!given) return false;
	const a = Buffer.from(given);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers['content-length']);
		if (declared > limit) {
			reject(new RangeError('too large'));
			req.resume();
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new RangeError('too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
			} catch {
				reject(new SyntaxError('invalid JSON'));
			}
		});
		req.on('error', reject);
	});
}

const json = (res: ServerResponse, status: number, body: unknown) =>
	res
		.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
		.end(JSON.stringify(body));

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/** Agent → browser request channel: the CLI posts a request, the most recently active
 *  framed picker receives it over SSE and posts the result back under the request's nonce. */
export function createLookChannel(options: LookChannelOptions): LookChannel {
	const { token, timeout = DEFAULT_LOOK_TIMEOUT } = options;
	const subscribers = new Map<string, Subscriber>();
	const pending = new Map<string, Pending>();
	let order = 0;

	const current = () => {
		let best: Subscriber | undefined;
		for (const s of subscribers.values())
			if (!best || s.active > best.active || (s.active === best.active && s.seq > best.seq))
				best = s;
		return best;
	};

	const settle = (id: string, result: LookResult) => {
		const p = pending.get(id);
		if (!p) return false;
		pending.delete(id);
		clearTimeout(p.timer);
		p.resolve(result);
		return true;
	};

	const drop = (sub: Subscriber) => {
		if (subscribers.get(sub.id) !== sub) return;
		subscribers.delete(sub.id);
		for (const [id, p] of pending)
			if (p.subscriber === sub) settle(id, { ok: false, error: 'browser gone' });
	};

	function subscribe(req: IncomingMessage, res: ServerResponse) {
		const query = new URL(req.url ?? '/', 'http://x').searchParams;
		const id = query.get('sub') ?? nonce();
		const allowed = query.get('allowed') !== '0';
		const previous = subscribers.get(id);
		if (previous) drop(previous);
		res.writeHead(200, {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			connection: 'keep-alive',
			'x-accel-buffering': 'no',
		});
		res.write(`retry: 1000\n\n`);
		const sub: Subscriber = { id, res, active: Date.now(), allowed, seq: ++order };
		subscribers.set(id, sub);
		const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
		const gone = () => {
			clearInterval(ping);
			drop(sub);
		};
		res.on('close', gone);
		res.on('error', gone);
	}

	async function request(req: IncomingMessage, res: ServerResponse) {
		if (!bearerOk(req.headers.authorization, token)) return json(res, 401, { error: 'bad token' });
		let body: unknown;
		try {
			body = await readJson(req, MAX_REQUEST_BYTES);
		} catch (err) {
			return json(res, 400, { error: (err as Error).message });
		}
		if (!isRecord(body) || typeof body.kind !== 'string')
			return json(res, 400, { error: 'body must be { kind, args }' });
		const args = isRecord(body.args) ? body.args : {};
		const wait = typeof body.timeout === 'number' && body.timeout > 0 ? body.timeout : timeout;
		const sub = current();
		if (!sub) return json(res, 503, { error: 'no browser has the app open' });
		if (!sub.allowed) return json(res, 403, { error: 'the user has turned looking off' });
		const id = nonce();
		const result = await new Promise<LookResult>((resolve) => {
			const timer = setTimeout(() => {
				settle(id, { ok: false, error: `timed out after ${wait}ms` });
			}, wait);
			pending.set(id, { subscriber: sub, resolve, timer });
			const event: LookRequest = { id, kind: body.kind as string, args };
			sub.res.write(`data: ${JSON.stringify(event)}\n\n`);
		});
		if (result.ok) return json(res, 200, result);
		if (result.error.startsWith('timed out')) return json(res, 504, result);
		if (result.error === 'browser gone') return json(res, 503, result);
		return json(res, 422, result);
	}

	async function result(id: string, req: IncomingMessage, res: ServerResponse) {
		if (!pending.has(id)) return json(res, 404, { error: 'no such request' });
		let body: unknown;
		try {
			body = await readJson(req, MAX_RESULT_BYTES);
		} catch (err) {
			const message = (err as Error).message;
			settle(id, { ok: false, error: message === 'too large' ? 'result too large' : message });
			return json(res, err instanceof RangeError ? 413 : 400, { error: message });
		}
		const parsed: LookResult =
			isRecord(body) && body.ok === true
				? { ok: true, data: body.data }
				: {
						ok: false,
						error:
							isRecord(body) && typeof body.error === 'string' ? body.error : 'malformed result',
					};
		if (settle(id, parsed)) return res.writeHead(204).end();
		return json(res, 409, { error: 'already answered' });
	}

	async function state(id: string, req: IncomingMessage, res: ServerResponse) {
		const sub = subscribers.get(id);
		if (!sub) return json(res, 404, { error: 'not subscribed' });
		let body: unknown;
		try {
			body = await readJson(req, 1024);
		} catch (err) {
			return json(res, 400, { error: (err as Error).message });
		}
		sub.active = Date.now();
		sub.seq = ++order;
		if (isRecord(body) && typeof body.allowed === 'boolean') sub.allowed = body.allowed;
		return res.writeHead(204).end();
	}

	const handle = (req: IncomingMessage, res: ServerResponse) => {
		const pathname = (req.url ?? '/').split('?')[0] ?? '/';
		if (!pathname.startsWith(LOOK_PATH)) return false;
		const method = req.method ?? 'GET';
		if (pathname === LOOK_PATH && method === 'POST') void request(req, res);
		else if (pathname === LOOK_EVENTS_PATH && method === 'GET') subscribe(req, res);
		else if (pathname.startsWith(RESULT_PREFIX) && method === 'POST')
			void result(pathname.slice(RESULT_PREFIX.length), req, res);
		else if (pathname.startsWith(STATE_PREFIX) && method === 'POST')
			void state(pathname.slice(STATE_PREFIX.length), req, res);
		else res.writeHead(405).end();
		return true;
	};

	return {
		handle,
		get subscribers() {
			return subscribers.size;
		},
		close: () => {
			for (const [id] of pending) settle(id, { ok: false, error: 'proxy closing' });
			for (const sub of subscribers.values()) sub.res.end();
			subscribers.clear();
		},
	};
}
