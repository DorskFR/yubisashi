import { selectorOf } from './inspect.ts';
import { type LookContext, type LookHandler, lookPage, type PageInfo } from './look.ts';

export type GoAction = 'back' | 'forward' | 'reload';

export type GoResult =
	| { full: false; from: string; page: PageInfo; scrolled?: string; scrollError?: string }
	/** The document is being replaced: the caller waits for the next one to connect. */
	| { full: true; from: string; to: string; instance?: string }
	| { scrolled: string; page: PageInfo }
	| { error: string };

export const SETTLE_QUIET_MS = 300;
export const SETTLE_CAP_MS = 5_000;
const TYPING = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

type Navigation = {
	canGoBack: boolean;
	canGoForward: boolean;
	currentEntry: { index: number } | null;
	entries(): { url: string | null }[];
	back(): { committed: Promise<unknown>; finished: Promise<unknown> };
	forward(): { committed: Promise<unknown>; finished: Promise<unknown> };
};

const routeOf = (win: Window) => win.location.pathname + win.location.search + win.location.hash;
const routeOfUrl = (url: URL) => url.pathname + url.search + url.hash;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The field the user is typing into with unsaved text, as a selector; null when idle. */
export function busyField(doc: Document, root: Element): string | null {
	const el = doc.activeElement;
	if (!el || root.contains(el) || !el.matches(TYPING)) return null;
	const field = el as HTMLInputElement;
	const dirty =
		typeof field.value === 'string' && typeof field.defaultValue === 'string'
			? field.value !== field.defaultValue
			: (el.textContent ?? '').trim() !== '';
	return dirty ? selectorOf(el) : null;
}

async function waitFor(cond: () => boolean, cap: number) {
	const deadline = Date.now() + cap;
	while (!cond()) {
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
	return true;
}

/** Resolves once the app's DOM has been quiet for a moment, or after `cap`. */
export function settle(doc: Document, root: Element, cap = SETTLE_CAP_MS): Promise<void> {
	return new Promise((resolve) => {
		let quiet: ReturnType<typeof setTimeout>;
		const done = () => {
			observer.disconnect();
			clearTimeout(quiet);
			clearTimeout(limit);
			resolve();
		};
		const observer = new MutationObserver((records) => {
			if (records.every((r) => root.contains(r.target))) return;
			clearTimeout(quiet);
			quiet = setTimeout(done, SETTLE_QUIET_MS);
		});
		observer.observe(doc.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		quiet = setTimeout(done, SETTLE_QUIET_MS);
		const limit = setTimeout(done, cap);
	});
}

/** Clicks a link to `url` the way a user would, so a client router (SvelteKit and other
 *  link-intercepting routers) can take it; true when one did. The browser's own navigation
 *  is always cancelled. */
function clickThrough(doc: Document, win: Window, url: URL): boolean {
	const a = doc.createElement('a');
	a.href = url.href;
	a.setAttribute('data-yubi', 'go');
	a.style.display = 'none';
	(doc.body ?? doc.documentElement).append(a);
	let taken = false;
	const last = (e: Event) => {
		taken = e.defaultPrevented;
		e.preventDefault();
	};
	win.addEventListener('click', last);
	try {
		a.dispatchEvent(
			new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }),
		);
	} finally {
		win.removeEventListener('click', last);
		a.remove();
	}
	return taken;
}

/** Routers that keep their own object in `history.state` follow a pushState + popstate. */
function pushThrough(win: Window, url: URL): boolean {
	const state = win.history.state as unknown;
	if (typeof state !== 'object' || state === null) return false;
	if (Object.keys(state).some((k) => k.startsWith('sveltekit:'))) return false;
	win.history.pushState(null, '', url.href);
	win.dispatchEvent(new PopStateEvent('popstate', { state: null }));
	return true;
}

type Scrolled = { scrolled: string } | { scrollError: string };

function scrollToMatch(doc: Document, root: Element, selector: string): Scrolled {
	let el: Element | undefined;
	try {
		el = [...doc.querySelectorAll(selector)].find((e) => !root.contains(e));
	} catch {
		return { scrollError: `invalid selector "${selector}"` };
	}
	if (!el) return { scrollError: `no element matches "${selector}"` };
	el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
	return { scrolled: selectorOf(el) };
}

type Notify = (from: string, to: string) => void;

/** Resolves with the "document replaced" answer if the page unloads before `job` is done. */
function unlessLeaving(ctx: LookContext, from: string, to: () => string, notify: Notify) {
	let left = false;
	let onHide = () => {};
	const leaving = new Promise<GoResult>((resolve) => {
		onHide = () => {
			left = true;
			notify(from, to());
			resolve({ full: true, from, to: to(), instance: ctx.instance });
		};
		ctx.win.addEventListener('pagehide', onHide, { once: true });
	});
	const cancel = () => ctx.win.removeEventListener('pagehide', onHide);
	return {
		left: () => left,
		cancel,
		race: (job: Promise<GoResult>) => Promise.race([leaving, job]).finally(cancel),
	};
}

async function arrived(ctx: LookContext, from: string, scroll: string | undefined, cap: number) {
	await settle(ctx.doc, ctx.root, cap);
	const extra = scroll ? scrollToMatch(ctx.doc, ctx.root, scroll) : {};
	return { full: false as const, from, page: lookPage({}, ctx) as PageInfo, ...extra };
}

function traverse(
	ctx: LookContext,
	action: 'back' | 'forward',
	scroll: string | undefined,
	cap: number,
	notify: Notify,
): Promise<GoResult> {
	const { win } = ctx;
	const from = routeOf(win);
	const nav = (win as Window & { navigation?: Navigation }).navigation;
	let to = action === 'back' ? '(previous page)' : '(next page)';
	if (nav) {
		if (!(action === 'back' ? nav.canGoBack : nav.canGoForward))
			return Promise.resolve({
				error: `no ${action === 'back' ? 'earlier' : 'later'} page in the app's history`,
			});
		const index = nav.currentEntry?.index ?? 0;
		const url = nav.entries()[index + (action === 'back' ? -1 : 1)]?.url;
		if (url) to = routeOfUrl(new URL(url));
	}
	const guard = unlessLeaving(ctx, from, () => to, notify);
	if (nav) {
		const step = action === 'back' ? nav.back() : nav.forward();
		step.committed.catch(() => {});
		step.finished.catch(() => {});
	} else if (action === 'back') win.history.back();
	else win.history.forward();
	return guard.race(
		(async (): Promise<GoResult> => {
			const moved = await waitFor(() => guard.left() || routeOf(win) !== from, cap);
			if (guard.left()) return new Promise<never>(() => {});
			if (!moved) return { error: `the app did not go ${action}` };
			const result = await arrived(ctx, from, scroll, cap);
			notify(from, result.page.route);
			return result;
		})(),
	);
}

/** `yubi go`: moves the framed app to a same-origin route, through its client router when
 *  it has one, and reports where it landed. */
export function createGo(notify: Notify): LookHandler {
	return async (args, ctx): Promise<GoResult> => {
		const { doc, win, root } = ctx;
		const to = typeof args.to === 'string' && args.to ? args.to : undefined;
		const action =
			args.action === 'back' || args.action === 'forward' || args.action === 'reload'
				? (args.action as GoAction)
				: undefined;
		const scroll = typeof args.scroll === 'string' && args.scroll ? args.scroll : undefined;
		const cap = typeof args.cap === 'number' && args.cap > 0 ? args.cap : SETTLE_CAP_MS;
		if (!to && !action) {
			if (!scroll) return { error: 'nothing to do: give a path, back, forward or reload' };
			const done = scrollToMatch(doc, root, scroll);
			if ('scrollError' in done) return { error: done.scrollError };
			return { scrolled: done.scrolled, page: lookPage({}, ctx) as PageInfo };
		}
		const busy = busyField(doc, root);
		if (busy)
			return {
				error: `user is busy: typing in ${busy} with unsaved text; ask before navigating, or try again later`,
			};
		const from = routeOf(win);
		if (action === 'reload') {
			ctx.after?.(() => win.location.reload());
			notify(from, from);
			return { full: true, from, to: from, instance: ctx.instance };
		}
		if (action) return traverse(ctx, action, scroll, cap, notify);
		let url: URL;
		try {
			url = new URL(to as string, win.location.href);
		} catch {
			return { error: `"${to}" is not a URL or path` };
		}
		if (url.origin !== win.location.origin)
			return {
				error: `cross-origin URL refused: yubi go only navigates within ${win.location.origin}`,
			};
		const target = routeOfUrl(url);
		const guard = unlessLeaving(ctx, from, () => target, notify);
		if (clickThrough(doc, win, url) || pushThrough(win, url))
			return guard.race(
				(async (): Promise<GoResult> => {
					if (target !== from) await waitFor(() => guard.left() || routeOf(win) !== from, cap);
					if (guard.left()) return new Promise<never>(() => {});
					const result = await arrived(ctx, from, scroll, cap);
					notify(from, result.page.route);
					return result;
				})(),
			);
		guard.cancel();
		notify(from, target);
		ctx.after?.(() => win.location.assign(url.href));
		return { full: true, from, to: target, instance: ctx.instance };
	};
}
