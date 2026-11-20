import { selectorOf } from './inspect.ts';

export type LookArgs = Record<string, unknown>;
export type LookHandler = (args: LookArgs, ctx: LookContext) => unknown | Promise<unknown>;
export type LookContext = {
	doc: Document;
	win: Window;
	root: HTMLElement;
	/** This document's subscriber id; a new page load gets a new one. */
	instance?: string;
	/** Runs `fn` once the result has been posted (to navigate away after answering). */
	after?: (fn: () => void) => void;
};

export type LookClientOptions = Omit<LookContext, 'instance' | 'after'> & {
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
const SEEN_MAX = 200;

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
	const seen = new Set<string>();

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
		if (seen.has(request.id)) return;
		seen.add(request.id);
		if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value as string);
		const afters: (() => void)[] = [];
		const args =
			typeof request.args === 'object' && request.args !== null ? (request.args as LookArgs) : {};
		let result: { ok: true; data: unknown } | { ok: false; error: string };
		if (!allowed) result = { ok: false, error: 'the user has turned looking off' };
		else {
			const handler = Object.hasOwn(handlers, request.kind) ? handlers[request.kind] : undefined;
			if (!handler) result = { ok: false, error: `unknown look kind "${request.kind}"` };
			else {
				try {
					const after = (fn: () => void) => void afters.push(fn);
					const ctx: LookContext = { doc, win, root, instance: id, after };
					result = { ok: true, data: await handler(args, ctx) };
					const selector = typeof args.selector === 'string' ? args.selector : undefined;
					options.onServed?.(request.kind, selector);
				} catch (err) {
					result = { ok: false, error: (err as Error).message || String(err) };
				}
			}
		}
		await post(`${RESULT}${request.id}`, result, request.kind === 'go');
		for (const fn of afters) fn();
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
	const onHide = () => void post(`${STATE}${id}`, { leaving: true }, true);
	const onShow = (e: PageTransitionEvent) => {
		if (!e.persisted) return;
		source?.close();
		source = null;
		connect();
		lastActive = 0;
		active();
	};
	win.addEventListener('focus', active);
	win.addEventListener('pointerdown', active, true);
	win.addEventListener('pagehide', onHide);
	win.addEventListener('pageshow', onShow);
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
			win.removeEventListener('pagehide', onHide);
			win.removeEventListener('pageshow', onShow);
			doc.removeEventListener('visibilitychange', onVisible);
		},
	};
}

export type PageInfo = {
	route: string;
	instance?: string;
	title: string;
	url: string;
	viewport: { width: number; height: number };
	scroll: { x: number; y: number };
	dpr: number;
	focus: string | null;
	readyState: DocumentReadyState;
};

export const lookPage: LookHandler = (_args, { doc, win, root, instance }): PageInfo => {
	const focused = doc.activeElement;
	const focus =
		focused && focused !== doc.body && focused !== doc.documentElement && !root.contains(focused)
			? selectorOf(focused)
			: null;
	return {
		route: win.location.pathname + win.location.search + win.location.hash,
		instance,
		title: doc.title,
		url: win.location.href,
		viewport: { width: win.innerWidth, height: win.innerHeight },
		scroll: { x: Math.round(win.scrollX), y: Math.round(win.scrollY) },
		dpr: win.devicePixelRatio,
		focus,
		readyState: doc.readyState,
	};
};
