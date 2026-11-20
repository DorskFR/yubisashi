import type { LookContext, LookHandler } from './look.ts';
import { resolveOne } from './look-dom.ts';

export const RASTER_PATH = '/__yubi/raster.js';

/** Data URL length the proxy still accepts once wrapped in JSON (its cap is 10 MB). */
export const MAX_SHOT_CHARS = 9 * 1024 * 1024;
export const DEFAULT_SHOT_BUDGET_MS = 45_000;

export const RASTER_WARNING =
	'raster shot: cross-origin images without CORS, <video>, some filters/backdrop-filter and canvases tainted by cross-origin content render blank or wrong';

export type ShotResult =
	| {
			png: string;
			width: number;
			height: number;
			scale: number;
			dpr: number;
			selector?: string;
			warnings: string[];
	  }
	| { error: string; matches: { count: number; first: string[] } };

type Raster = {
	domToPng(node: Node, options?: Record<string, unknown>): Promise<string>;
};

let raster: Promise<Raster> | null = null;
let hidden = 0;

/** The DOM-to-canvas renderer, fetched from the proxy on the first shot only. */
const loadRaster = (win: Window) => {
	if (!raster) {
		const url = `${win.location.origin}${RASTER_PATH}`;
		raster = (import(url) as Promise<Raster>).catch((err) => {
			raster = null;
			throw new Error(`the raster renderer could not be loaded: ${(err as Error).message}`);
		});
	}
	return raster;
};

const mb = (chars: number) => `${(chars / 1024 / 1024).toFixed(1)} MB`;

/** Keeps the boxes of elements wholly below or right of the viewport but skips what is inside
 *  them, so the cost of a viewport shot follows what is visible rather than the page length. */
export function viewportFilter(win: Window, root: Element) {
	const offscreen = new WeakMap<Element, boolean>();
	const below = (el: Element) => {
		let known = offscreen.get(el);
		if (known === undefined) {
			const r = el.getBoundingClientRect();
			const sized = r.width > 0 || r.height > 0;
			known = sized && (r.top >= win.innerHeight || r.left >= win.innerWidth);
			offscreen.set(el, known);
		}
		return known;
	};
	return (node: Node) => {
		if (root.contains(node)) return false;
		const parent = node.parentElement;
		return !parent || !below(parent);
	};
}

const NARROW = 'shoot one element with a selector or lower --scale';

function withBudget<T>(job: Promise<T>, ms: number): Promise<T> {
	const message = `the shot did not finish within ${Math.round(ms / 1000)}s (time budget); ${NARROW}`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([job, late]).finally(() => clearTimeout(timer));
}

export const lookShot: LookHandler = async (args, { doc, win, root }: LookContext) => {
	const scale = typeof args.scale === 'number' && args.scale > 0 ? args.scale : 1;
	const selector = typeof args.selector === 'string' && args.selector ? args.selector : undefined;
	const budget =
		typeof args.budget === 'number' && args.budget > 0 ? args.budget : DEFAULT_SHOT_BUDGET_MS;
	let target: Element = doc.documentElement;
	if (selector) {
		const found = resolveOne(doc, selector, root);
		if ('error' in found) return found satisfies ShotResult;
		target = found.el;
	}
	const { domToPng } = await loadRaster(win);
	const filter = selector ? (node: Node) => !root.contains(node) : viewportFilter(win, root);
	const bg = win.getComputedStyle(doc.body).backgroundColor;
	const backgroundColor = !bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent' ? '#ffffff' : bg;
	const viewport = { width: win.innerWidth, height: win.innerHeight };
	const options: Record<string, unknown> = selector
		? { scale, filter, backgroundColor }
		: {
				scale,
				filter,
				backgroundColor,
				width: viewport.width,
				height: viewport.height,
				style: {
					overflow: 'hidden',
					transform: `translate(${-win.scrollX}px, ${-win.scrollY}px)`,
				},
			};
	hidden++;
	root.style.display = 'none';
	const job = domToPng(target, options).finally(() => {
		hidden--;
		if (!hidden) root.style.display = '';
	});
	const png = await withBudget(job, budget);
	if (png.length > MAX_SHOT_CHARS)
		throw new Error(
			`the shot is ${mb(png.length)}, over the ${mb(MAX_SHOT_CHARS)} budget; ${NARROW}`,
		);
	const rect = selector ? target.getBoundingClientRect() : viewport;
	return {
		png,
		width: Math.round(rect.width * scale),
		height: Math.round(rect.height * scale),
		scale,
		dpr: win.devicePixelRatio,
		selector,
		warnings: [RASTER_WARNING],
	} satisfies ShotResult;
};
