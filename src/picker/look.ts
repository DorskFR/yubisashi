import { selectorOf } from './inspect.ts';

export type LookArgs = Record<string, unknown>;
export type LookHandler = (args: LookArgs, ctx: LookContext) => unknown | Promise<unknown>;
export type LookContext = { doc: Document; win: Window; root: HTMLElement };

export type LookClientOptions = LookContext & {
	allowed?: boolean;
	handlers: Record<string, LookHandler>;
	onServed?: (kind: string, selector?: string) => void;
	/** Overrides for tests: the endpoint base and the EventSource implementation. */
	base?: string;
	EventSource?: typeof EventSource;
};

export type LookClient = {
	setAllowed(allowed: boolean): void;
	readonly allowed: boolean;
	readonly connected: boolean;
	destroy(): void;
};

const EVENTS = '/__yubi/look/events';
const RESULT = '/__yubi/look/result/';
const STATE = '/__yubi/look/state/';
const ACTIVE_EVERY_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

const randomId = () => {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/** Subscribes the framed document to the proxy's request stream and answers each
 *  request with the matching handler; the user's consent gates every request. */
export function createLookClient(options: LookClientOptions): LookClient {
	const { doc, win, root, handlers } = options;
	const base = options.base ?? '';
	const ES = options.EventSource ?? (win as Window & typeof globalThis).EventSource;
	const id = randomId();
	let allowed = options.allowed ?? true;
	let source: EventSource | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let backoff = 1000;
	let lastActive = 0;
	let destroyed = false;

	const post = (path: string, body: unknown, keepalive = false) =>
		win
			.fetch(`${base}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				keepalive,
			})
			.catch(() => undefined);

	const pushState = () => post(`${STATE}${id}`, { allowed }, true);

	const active = () => {
		const now = Date.now();
		if (now - lastActive < ACTIVE_EVERY_MS) return;
		lastActive = now;
		void pushState();
	};

	async function serve(event: MessageEvent) {
		let request: { id?: unknown; kind?: unknown; args?: unknown };
		try {
			request = JSON.parse(String(event.data));
		} catch {
			return;
		}
		if (typeof request.id !== 'string' || typeof request.kind !== 'string') return;
		const args =
			typeof request.args === 'object' && request.args !== null ? (request.args as LookArgs) : {};
		let result: { ok: true; data: unknown } | { ok: false; error: string };
		if (!allowed) result = { ok: false, error: 'the user has turned looking off' };
		else {
			const handler = Object.hasOwn(handlers, request.kind) ? handlers[request.kind] : undefined;
			if (!handler) result = { ok: false, error: `unknown look kind "${request.kind}"` };
			else {
				try {
					result = { ok: true, data: await handler(args, { doc, win, root }) };
					const selector = typeof args.selector === 'string' ? args.selector : undefined;
					options.onServed?.(request.kind, selector);
				} catch (err) {
					result = { ok: false, error: (err as Error).message || String(err) };
				}
			}
		}
		await post(`${RESULT}${request.id}`, result);
	}

	function connect() {
		if (destroyed || source) return;
		const es = new ES(`${base}${EVENTS}?sub=${id}&allowed=${allowed ? 1 : 0}`);
		source = es;
		es.onopen = () => {
			backoff = 1000;
		};
		es.onmessage = (e) => void serve(e);
		es.onerror = () => {
			if (es.readyState !== es.CLOSED || destroyed) return;
			es.close();
			if (source === es) source = null;
			retry = setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
		};
	}

	function setAllowed(next: boolean) {
		if (allowed === next) return;
		allowed = next;
		lastActive = Date.now();
		void pushState();
	}

	const onVisible = () => {
		if (doc.visibilityState === 'visible') active();
	};
	win.addEventListener('focus', active);
	win.addEventListener('pointerdown', active, true);
	doc.addEventListener('visibilitychange', onVisible);
	connect();

	return {
		setAllowed,
		get allowed() {
			return allowed;
		},
		get connected() {
			return source !== null && source.readyState === source.OPEN;
		},
		destroy() {
			destroyed = true;
			if (retry) clearTimeout(retry);
			source?.close();
			source = null;
			win.removeEventListener('focus', active);
			win.removeEventListener('pointerdown', active, true);
			doc.removeEventListener('visibilitychange', onVisible);
		},
	};
}

export type PageInfo = {
	route: string;
	title: string;
	url: string;
	viewport: { width: number; height: number };
	scroll: { x: number; y: number };
	dpr: number;
	focus: string | null;
	readyState: DocumentReadyState;
};

export const lookPage: LookHandler = (_args, { doc, win, root }): PageInfo => {
	const focused = doc.activeElement;
	const focus =
		focused && focused !== doc.body && focused !== doc.documentElement && !root.contains(focused)
			? selectorOf(focused)
			: null;
	return {
		route: win.location.pathname + win.location.search + win.location.hash,
		title: doc.title,
		url: win.location.href,
		viewport: { width: win.innerWidth, height: win.innerHeight },
		scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
		dpr: win.devicePixelRatio,
		focus,
		readyState: doc.readyState,
	};
};
