import type { LookContext, LookHandler } from './look.ts';
import { resolveOne } from './look-dom.ts';

export const RASTER_PATH = '/__yubi/raster.js';

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

export const lookShot: LookHandler = async (args, { doc, win, root }: LookContext) => {
	const scale = typeof args.scale === 'number' && args.scale > 0 ? args.scale : 1;
	const selector = typeof args.selector === 'string' && args.selector ? args.selector : undefined;
	let target: Element = doc.documentElement;
	if (selector) {
		const found = resolveOne(doc, selector, root);
		if ('error' in found) return found satisfies ShotResult;
		target = found.el;
	}
	const { domToPng } = await loadRaster(win);
	const filter = (node: Node) => !root.contains(node);
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
	const previous = root.style.display;
	root.style.display = 'none';
	let png: string;
	try {
		png = await domToPng(target, options);
	} finally {
		root.style.display = previous;
	}
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
