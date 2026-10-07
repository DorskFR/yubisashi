import { describe, label } from './inspect.ts';
import { createLookClient, type LookClient, type LookHandler, lookPage } from './look.ts';
import { lookDom } from './look-dom.ts';
import { lookShot } from './look-shot.ts';
import { lookStyles } from './look-styles.ts';
import {
	type ChildMessage,
	type Frame,
	isParentMessage,
	type ParentMessage,
	type Pin,
	type Target,
	type Unmarked,
	type Viewport,
	YUBI,
} from './protocol.ts';

export { isChildMessage, isParentMessage, YUBI } from './protocol.ts';
export type { ChildMessage, Frame, ParentMessage, Pin, Target, Unmarked, Viewport };

export type PickerOptions = {
	/**
	 * Origin(s) allowed to host the review panel; messages from anywhere else are ignored.
	 * With several, the one framing the document (ancestorOrigins / referrer) is used; when that
	 * is unknown, messages go to every allowed origin until one has sent a valid message.
	 */
	parentOrigin: string | string[];
	parent?: Window;
	doc?: Document;
	/** Milliseconds between route checks. */
	routeEveryMs?: number;
	/** Serve `yubi look` requests from the proxy's request stream (set by the `yubi dev` bootstrap). */
	look?: boolean;
	/** Extra look handlers by kind, on top of the built-in ones. */
	lookHandlers?: Record<string, LookHandler>;
};

export type PickerHandle = {
	start(): void;
	stop(): void;
	clear(id?: number): void;
	setPins(pins: Pin[]): void;
	readonly picking: boolean;
	readonly lookAllowed: boolean;
	readonly selection: readonly Target[];
	destroy(): void;
};

type Picked = { el: Element; info: Target };

const TYPING = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
const ACCENT = '#f0883e';
const INK = '#111';
const MONO = 'ui-monospace, "JetBrains Mono", "SF Mono", monospace';
const SANS = 'ui-sans-serif, system-ui, sans-serif';

const routeOf = (win: Window) => win.location.pathname + win.location.search + win.location.hash;

function framingOrigin(doc: Document): string | undefined {
	const ancestors = doc.location.ancestorOrigins;
	if (ancestors?.length) return ancestors[0];
	try {
		return doc.referrer ? new URL(doc.referrer).origin : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Runs inside the app document: covers it with a glass pane while picking, draws hover/selection
 * boxes and comment pins, and talks to the review panel through `postMessage` only.
 */
export function createPicker(options: PickerOptions): PickerHandle {
	const doc = options.doc ?? document;
	const win = doc.defaultView as Window;
	const parent = options.parent ?? win.parent;
	const allowed = [options.parentOrigin].flat().map((o) => new URL(o).origin);
	let origin: string | undefined = allowed.find((o) => o === framingOrigin(doc));

	const root = doc.createElement('div');
	root.setAttribute('data-yubi', 'root');
	root.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
	const overlay = doc.createElement('div');
	overlay.setAttribute('data-yubi', 'overlay');
	overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
	const glass = doc.createElement('div');
	glass.setAttribute('data-yubi', 'glass');
	glass.style.cssText =
		'position:absolute;inset:0;cursor:crosshair;pointer-events:auto;display:none;';
	root.append(overlay, glass);
	doc.documentElement.append(root);

	let picking = false;
	let hover: Picked | null = null;
	let selection: Picked[] = [];
	let pins: Pin[] = [];
	const refs = new Map<number, Element[]>();
	let route = routeOf(win);
	let raf = 0;
	let look: LookClient | null = null;

	const send = (message: Unmarked<ChildMessage>) => {
		const data = { ...message, yubi: YUBI };
		for (const o of origin ? [origin] : allowed) parent.postMessage(data, o);
	};
	if (options.look && parent !== win)
		look = createLookClient({
			doc,
			win,
			root,
			handlers: {
				page: lookPage,
				dom: lookDom,
				styles: lookStyles,
				shot: lookShot,
				...options.lookHandlers,
			},
			onServed: (kind, selector) =>
				send(selector ? { type: 'look:served', kind, selector } : { type: 'look:served', kind }),
		});
	const viewport = () => ({ width: win.innerWidth, height: win.innerHeight });

	const elementAt = (x: number, y: number): Element | null =>
		doc.elementsFromPoint(x, y).find((el) => !root.contains(el)) ?? null;

	function setPicking(on: boolean) {
		if (picking === on) return;
		picking = on;
		glass.style.display = on ? 'block' : 'none';
		if (!on) setHover(null);
		send({ type: 'pick:state', picking });
	}

	function setHover(el: Element | null) {
		if ((hover?.el ?? null) === el) return;
		hover = el ? { el, info: describe(el) } : null;
		send({ type: 'pick:hover', target: hover?.info ?? null });
	}

	function setSelection(next: Picked[]) {
		selection = next;
		send({
			type: 'pick:selected',
			targets: selection.map((s) => s.info),
			route: routeOf(win),
			viewport: viewport(),
		});
	}

	function pick(el: Element, additive: boolean) {
		const i = selection.findIndex((s) => s.el === el);
		if (additive) {
			setSelection(
				i >= 0 ? selection.filter((_, j) => j !== i) : [...selection, { el, info: describe(el) }],
			);
		} else {
			setSelection([{ el, info: describe(el) }]);
			setPicking(false);
		}
	}

	function back() {
		if (picking) setPicking(false);
		else if (selection.length) setSelection([]);
		else send({ type: 'pick:cancel' });
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') return back();
		const typing = (e.target as Element | null)?.closest?.(TYPING);
		if (!typing && (e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			setPicking(!picking);
		}
	}

	function onWheel(e: WheelEvent) {
		for (let node = elementAt(e.clientX, e.clientY); node; node = node.parentElement) {
			const style = win.getComputedStyle(node);
			if (/(auto|scroll)/.test(style.overflowY + style.overflowX)) {
				const before = node.scrollTop + node.scrollLeft;
				node.scrollBy(e.deltaX, e.deltaY);
				if (node.scrollTop + node.scrollLeft !== before) return;
			}
		}
		win.scrollBy(e.deltaX, e.deltaY);
	}

	function onMessage(e: MessageEvent) {
		if (e.source !== parent || !isParentMessage(e.data)) return;
		if (origin ? e.origin !== origin : !allowed.includes(e.origin)) return;
		origin = e.origin;
		const msg: ParentMessage = e.data;
		if (msg.type === 'pick:start') setPicking(true);
		else if (msg.type === 'pick:stop') setPicking(false);
		else if (msg.type === 'pick:clear') clear(msg.id);
		else if (msg.type === 'look:allow') look?.setAllowed(msg.allowed);
		else setPins(msg.pins);
	}

	function clear(id?: number) {
		if (id !== undefined && selection.length)
			refs.set(
				id,
				selection.map((s) => s.el),
			);
		if (selection.length) setSelection([]);
	}

	function setPins(next: Pin[]) {
		pins = next;
	}

	function locatePin(pin: Pin): Element | undefined {
		const kept = refs.get(pin.id)?.find((el) => el.isConnected);
		if (kept) return kept;
		try {
			return doc.querySelector(pin.selector) ?? undefined;
		} catch {
			return undefined;
		}
	}

	const nodes = new Map<string, HTMLElement>();

	function place(el: HTMLElement, x: number, y: number, width?: number, height?: number) {
		el.style.left = `${x}px`;
		el.style.top = `${y}px`;
		if (width !== undefined) el.style.width = `${width}px`;
		if (height !== undefined) el.style.height = `${height}px`;
	}

	function box(key: string, rect: DOMRect, kind: 'hover' | 'selected', text: string) {
		let el = nodes.get(key);
		if (!el) {
			el = doc.createElement('div');
			el.setAttribute('data-yubi', kind);
			el.style.cssText = `position:absolute;border:2px ${kind === 'hover' ? 'dashed' : 'solid'} ${ACCENT};border-radius:3px;background:rgb(240 136 62 / ${kind === 'hover' ? 0.05 : 0.08});box-sizing:border-box;`;
			const tag = doc.createElement('span');
			tag.setAttribute('data-yubi', 'label');
			tag.style.cssText = `position:absolute;top:-20px;left:-2px;padding:1px 6px;border-radius:3px 3px 3px 0;background:${ACCENT};color:${INK};font:11px/18px ${MONO};white-space:nowrap;`;
			el.append(tag);
			nodes.set(key, el);
		}
		place(el, rect.x, rect.y, rect.width, rect.height);
		const tag = el.firstChild as HTMLElement;
		if (tag.textContent !== text) tag.textContent = text;
		return el;
	}

	function pinNode(pin: Pin, rect: DOMRect) {
		const key = `pin:${pin.id}`;
		let el = nodes.get(key);
		if (!el) {
			el = doc.createElement('button');
			(el as HTMLButtonElement).type = 'button';
			el.setAttribute('data-yubi', 'pin');
			el.setAttribute('data-id', String(pin.id));
			el.textContent = String(pin.id);
			el.title = `Open comment #${pin.id}`;
			el.style.cssText = `position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;padding:0;border:0;border-radius:11px 11px 11px 2px;background:${ACCENT};color:${INK};font:600 11px/22px ${SANS};text-align:center;pointer-events:auto;cursor:pointer;box-shadow:0 1px 4px rgb(0 0 0 / 0.4);`;
			el.onclick = () => send({ type: 'pin:open', id: pin.id });
			nodes.set(key, el);
		}
		place(el, rect.x + rect.width, rect.y);
		return el;
	}

	function draw() {
		const layers: HTMLElement[] = [];
		if (picking && hover?.el.isConnected && !selection.some((s) => s.el === hover?.el)) {
			layers.push(box('hover', hover.el.getBoundingClientRect(), 'hover', label(hover.info)));
		}
		selection.forEach((s, i) => {
			if (s.el.isConnected)
				layers.push(box(`sel:${i}`, s.el.getBoundingClientRect(), 'selected', label(s.info)));
		});
		for (const pin of pins) {
			const el = locatePin(pin);
			if (el) layers.push(pinNode(pin, el.getBoundingClientRect()));
		}
		for (const [key, el] of nodes) if (!layers.includes(el)) nodes.delete(key);
		if (
			layers.length !== overlay.childNodes.length ||
			layers.some((el, i) => overlay.childNodes[i] !== el)
		)
			overlay.replaceChildren(...layers);
		raf = win.requestAnimationFrame(draw);
	}

	const onMove = (e: MouseEvent) => setHover(elementAt(e.clientX, e.clientY));
	const onLeave = () => setHover(null);
	const onClick = (e: MouseEvent) => {
		const el = elementAt(e.clientX, e.clientY);
		if (el) pick(el, e.shiftKey || e.metaKey || e.ctrlKey);
	};
	const syncRoute = () => {
		const next = routeOf(win);
		if (next === route) return;
		route = next;
		send({ type: 'route', route });
	};

	glass.addEventListener('mousemove', onMove);
	glass.addEventListener('mouseleave', onLeave);
	glass.addEventListener('click', onClick);
	glass.addEventListener('wheel', onWheel, { passive: true });
	win.addEventListener('keydown', onKey, true);
	win.addEventListener('message', onMessage);
	const routeTimer = win.setInterval(syncRoute, options.routeEveryMs ?? 400);
	raf = win.requestAnimationFrame(draw);
	send({ type: 'route', route });

	return {
		start: () => setPicking(true),
		stop: () => setPicking(false),
		clear,
		setPins,
		get picking() {
			return picking;
		},
		get lookAllowed() {
			return look?.allowed ?? false;
		},
		get selection() {
			return selection.map((s) => s.info);
		},
		destroy() {
			look?.destroy();
			win.cancelAnimationFrame(raf);
			win.clearInterval(routeTimer);
			win.removeEventListener('keydown', onKey, true);
			win.removeEventListener('message', onMessage);
			root.remove();
		},
	};
}
