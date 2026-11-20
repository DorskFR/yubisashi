import { describe, selectorOf } from './inspect.ts';
import type { LookHandler } from './look.ts';
import type { DomMatch } from './look-dom.ts';

export const DEFAULT_SHOW_TTL_S = 10;
export const MAX_SHOWN = 50;
const ACCENT = '#f0883e';
const INK = '#111';
const MONO = 'ui-monospace, "JetBrains Mono", "SF Mono", monospace';
const MAX_LABEL = 80;

export type ShownItem = {
	n: number;
	selector: string;
	label: string;
	source?: string;
	rect: { x: number; y: number; width: number; height: number };
};

export type ShowResult =
	| { shown: ShownItem[]; matches: number; ttl: number }
	| { cleared: number }
	| { error: string; matches: DomMatch };

type Mark = {
	id: number;
	el: Element;
	label: string;
	box: HTMLElement;
	timer: ReturnType<typeof setTimeout> | null;
};

export type ShowOptions = {
	doc: Document;
	win: Window;
	root: HTMLElement;
	onShown?: (id: number, label: string) => void;
};

export type Show = {
	handler: LookHandler;
	/** Scrolls highlight #id into view again, re-drawing it when it already went away. */
	focus(id: number): void;
	clear(): number;
	readonly count: number;
	destroy(): void;
};

const cut = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL)}…` : s);

const inside = (r: DOMRect, x: number, y: number) =>
	x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

const offscreen = (r: DOMRect, win: Window) =>
	r.bottom < 0 || r.right < 0 || r.top > win.innerHeight || r.left > win.innerWidth;

/** The agent's highlights in the user's tab: outlined, numbered boxes that follow their
 *  element, expire, and leave every pointer event to the app except their own tag. */
export function createShow({ doc, win, root, onShown }: ShowOptions): Show {
	const layer = doc.createElement('div');
	layer.setAttribute('data-yubi', 'show-layer');
	layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;';
	root.append(layer);
	const marks = new Map<number, Mark>();
	const past = new Map<number, { el: Element; label: string }>();
	let next = 1;
	let raf = 0;

	function remove(id: number) {
		const mark = marks.get(id);
		if (!mark) return;
		if (mark.timer) clearTimeout(mark.timer);
		mark.box.remove();
		marks.delete(id);
		if (!marks.size) {
			win.cancelAnimationFrame(raf);
			raf = 0;
		}
	}

	function place(mark: Mark) {
		const r = mark.el.getBoundingClientRect();
		const s = mark.box.style;
		s.left = `${r.x}px`;
		s.top = `${r.y}px`;
		s.width = `${r.width}px`;
		s.height = `${r.height}px`;
		(mark.box.firstChild as HTMLElement).style.top = r.y < 20 ? '0' : '-20px';
	}

	function track() {
		for (const mark of [...marks.values()]) {
			if (mark.el.isConnected) place(mark);
			else remove(mark.id);
		}
		raf = marks.size ? win.requestAnimationFrame(track) : 0;
	}

	function draw(id: number, el: Element, label: string, ttl: number) {
		remove(id);
		const box = doc.createElement('div');
		box.setAttribute('data-yubi', 'show');
		box.setAttribute('data-id', String(id));
		box.style.cssText = `position:absolute;border:2px solid ${ACCENT};border-radius:3px;background:rgb(240 136 62 / 0.12);box-sizing:border-box;pointer-events:none;`;
		const tag = doc.createElement('button');
		tag.type = 'button';
		tag.setAttribute('data-yubi', 'show-tag');
		tag.title = 'Dismiss';
		tag.textContent = `${id} ${label} ×`;
		tag.style.cssText = `position:absolute;left:-2px;padding:1px 6px;border:0;border-radius:3px 3px 3px 0;background:${ACCENT};color:${INK};font:11px/18px ${MONO};white-space:nowrap;pointer-events:auto;cursor:pointer;`;
		tag.onclick = () => remove(id);
		box.append(tag);
		layer.append(box);
		const mark: Mark = { id, el, label, box, timer: null };
		if (ttl > 0) mark.timer = setTimeout(() => remove(id), ttl * 1000);
		marks.set(id, mark);
		past.set(id, { el, label });
		if (past.size > MAX_SHOWN * 4) past.delete(past.keys().next().value as number);
		place(mark);
		if (!raf) raf = win.requestAnimationFrame(track);
		return mark;
	}

	function clear() {
		const n = marks.size;
		for (const id of [...marks.keys()]) remove(id);
		next = 1;
		return n;
	}

	const onPointer = (e: PointerEvent) => {
		for (const mark of [...marks.values()])
			if (inside(mark.el.getBoundingClientRect(), e.clientX, e.clientY)) remove(mark.id);
	};
	win.addEventListener('pointerdown', onPointer, true);

	const handler: LookHandler = (args): ShowResult => {
		if (args.clear === true) return { cleared: clear() };
		const selector = typeof args.selector === 'string' ? args.selector : '';
		if (!selector) return { error: 'show needs a selector', matches: { count: 0, first: [] } };
		const ttl = typeof args.ttl === 'number' && args.ttl >= 0 ? args.ttl : DEFAULT_SHOW_TTL_S;
		const text = typeof args.label === 'string' && args.label ? cut(args.label) : '';
		let all: Element[];
		try {
			all = [...doc.querySelectorAll(selector)].filter((el) => !root.contains(el));
		} catch {
			return { error: `invalid selector "${selector}"`, matches: { count: 0, first: [] } };
		}
		if (!all.length)
			return { error: `no element matches "${selector}"`, matches: { count: 0, first: [] } };
		if (!marks.size) next = 1;
		const chosen = args.all === true ? all.slice(0, MAX_SHOWN) : all.slice(0, 1);
		const first = chosen[0] as Element;
		if (offscreen(first.getBoundingClientRect(), win))
			first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
		const shown = chosen.map((el): ShownItem => {
			const id = next++;
			const info = describe(el);
			const label = text || cut(selectorOf(el));
			draw(id, el, label, ttl);
			onShown?.(id, label);
			const r = el.getBoundingClientRect();
			return {
				n: id,
				selector: info.selector,
				label,
				source: info.source ? `${info.source.file}:${info.source.line}` : undefined,
				rect: {
					x: Math.round(r.x),
					y: Math.round(r.y),
					width: Math.round(r.width),
					height: Math.round(r.height),
				},
			};
		});
		return { shown, matches: all.length, ttl };
	};

	return {
		handler,
		focus(id) {
			const known = marks.get(id) ?? past.get(id);
			if (!known?.el.isConnected) return;
			known.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
			if (!marks.has(id)) draw(id, known.el, known.label, DEFAULT_SHOW_TTL_S);
		},
		clear,
		get count() {
			return marks.size;
		},
		destroy() {
			clear();
			win.cancelAnimationFrame(raf);
			win.removeEventListener('pointerdown', onPointer, true);
			layer.remove();
		},
	};
}
