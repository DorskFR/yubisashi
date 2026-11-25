import { type Alignment, type Line, measure, type Rect, rectOf, round } from './measure.ts';

const RED = '#f24822';
const GUIDE = '#ff00d4';
const NEAR = '#ffb000';
const OUTLINE = '#0d99ff';
const PADDING = 'rgb(147 196 125 / 0.45)';
const MARGIN = 'rgb(246 178 107 / 0.45)';
const MONO = 'ui-monospace, "JetBrains Mono", "SF Mono", monospace';
const RULER = 16;
const TAG = `position:absolute;padding:0 4px;border-radius:2px;font:10px/14px ${MONO};white-space:nowrap;color:#fff;`;

type Spec = {
	kind: string;
	x: number;
	y: number;
	w: number;
	h: number;
	css: string;
	data?: Record<string, string>;
	label?: { text: string; css: string };
};

export type RulerOptions = { doc: Document; win: Window };

export type Ruler = {
	readonly layer: HTMLElement;
	readonly on: boolean;
	readonly grid: number;
	readonly anchor: Element | null;
	set(on: boolean, grid?: number): void;
	move(x: number, y: number, el: Element | null): void;
	leave(): void;
	/** Selects A, drops it again, or completes a measurement from A to another element. */
	click(el: Element): { a: Element; b: Element } | null;
	/** Drops A; false when there was none. */
	drop(): boolean;
	render(): void;
};

type Sides = { top: number; right: number; bottom: number; left: number };

const sides = (cs: CSSStyleDeclaration, prefix: string, suffix = ''): Sides => ({
	top: round(parseFloat(cs.getPropertyValue(`${prefix}-top${suffix}`)) || 0),
	right: round(parseFloat(cs.getPropertyValue(`${prefix}-right${suffix}`)) || 0),
	bottom: round(parseFloat(cs.getPropertyValue(`${prefix}-bottom${suffix}`)) || 0),
	left: round(parseFloat(cs.getPropertyValue(`${prefix}-left${suffix}`)) || 0),
});

/** Ruler mode: element sizes, box model bands, distances from a selected element, alignment
 *  guides, an optional grid and rulers with the cursor position, all drawn in its own layer. */
export function createRuler({ doc, win }: RulerOptions): Ruler {
	const layer = doc.createElement('div');
	layer.setAttribute('data-yubi', 'ruler');
	layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
	let on = false;
	let grid = 0;
	let anchor: Element | null = null;
	let hover: Element | null = null;
	let cursor: { x: number; y: number } | null = null;
	let drawn = '';

	const rect = (el: Element): Rect => rectOf(el.getBoundingClientRect());

	function bands(el: Element, r: Rect): Spec[] {
		const cs = win.getComputedStyle(el);
		const margin = sides(cs, 'margin');
		const padding = sides(cs, 'padding');
		const border = sides(cs, 'border', '-width');
		const out: Spec[] = [];
		const band = (
			kind: string,
			side: string,
			value: number,
			x: number,
			y: number,
			w: number,
			h: number,
		) => {
			if (value <= 0) return;
			out.push({
				kind,
				x,
				y,
				w,
				h,
				css: `background:${kind === 'ruler-margin' ? MARGIN : PADDING};display:flex;align-items:center;justify-content:center;font:10px/1 ${MONO};color:#111;overflow:visible;`,
				data: { side, value: String(value) },
				label: { text: String(value), css: 'position:static;' },
			});
		};
		const right = r.x + r.width;
		const bottom = r.y + r.height;
		const wide = r.width + margin.left + margin.right;
		band('ruler-margin', 'top', margin.top, r.x - margin.left, r.y - margin.top, wide, margin.top);
		band('ruler-margin', 'bottom', margin.bottom, r.x - margin.left, bottom, wide, margin.bottom);
		band('ruler-margin', 'left', margin.left, r.x - margin.left, r.y, margin.left, r.height);
		band('ruler-margin', 'right', margin.right, right, r.y, margin.right, r.height);
		const ix = r.x + border.left;
		const iy = r.y + border.top;
		const iw = r.width - border.left - border.right;
		const ih = r.height - border.top - border.bottom;
		const mid = ih - padding.top - padding.bottom;
		band('ruler-padding', 'top', padding.top, ix, iy, iw, padding.top);
		band(
			'ruler-padding',
			'bottom',
			padding.bottom,
			ix,
			iy + ih - padding.bottom,
			iw,
			padding.bottom,
		);
		band('ruler-padding', 'left', padding.left, ix, iy + padding.top, padding.left, mid);
		band(
			'ruler-padding',
			'right',
			padding.right,
			ix + iw - padding.right,
			iy + padding.top,
			padding.right,
			mid,
		);
		return out;
	}

	const outline = (kind: string, r: Rect, style: string): Spec => ({
		kind,
		x: r.x,
		y: r.y,
		w: r.width,
		h: r.height,
		css: `box-sizing:border-box;border:1px ${style} ${OUTLINE};`,
	});

	const size = (r: Rect): Spec => ({
		kind: 'ruler-size',
		x: r.x,
		y: r.y + r.height + 4,
		w: r.width,
		h: 0,
		css: 'display:flex;align-items:flex-start;justify-content:center;overflow:visible;',
		label: {
			text: `${r.width} × ${r.height}`,
			css: `${TAG}position:static;background:${OUTLINE};`,
		},
	});

	const distance = (l: Line): Spec =>
		l.axis === 'x'
			? {
					kind: 'ruler-distance',
					x: l.from,
					y: l.at,
					w: l.length,
					h: 1,
					css: `background:${RED};`,
					data: { axis: 'x', value: String(l.length) },
					label: {
						text: String(l.length),
						css: `${TAG}left:50%;top:-18px;transform:translateX(-50%);background:${RED};`,
					},
				}
			: {
					kind: 'ruler-distance',
					x: l.at,
					y: l.from,
					w: 1,
					h: l.length,
					css: `background:${RED};`,
					data: { axis: 'y', value: String(l.length) },
					label: {
						text: String(l.length),
						css: `${TAG}top:50%;left:4px;transform:translateY(-50%);background:${RED};`,
					},
				};

	function guide(al: Alignment, a: Rect, b: Rect): Spec {
		const lo = al.axis === 'x' ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
		const hi =
			al.axis === 'x'
				? Math.max(a.y + a.height, b.y + b.height)
				: Math.max(a.x + a.width, b.x + b.width);
		const from = Math.min(al.a, al.b);
		const span = Math.abs(al.delta);
		const data = { edge: al.edge, value: String(span) };
		if (al.status === 'aligned')
			return al.axis === 'x'
				? {
						kind: 'ruler-guide',
						x: al.a,
						y: lo,
						w: 1,
						h: hi - lo,
						css: `background:${GUIDE};`,
						data,
					}
				: {
						kind: 'ruler-guide',
						x: lo,
						y: al.a,
						w: hi - lo,
						h: 1,
						css: `background:${GUIDE};`,
						data,
					};
		const label = { text: `${span}px off`, css: `${TAG}background:${NEAR};color:#111;` };
		return al.axis === 'x'
			? {
					kind: 'ruler-near',
					x: from,
					y: lo,
					w: span,
					h: hi - lo,
					css: `box-sizing:border-box;border-left:1px dashed ${NEAR};border-right:1px dashed ${NEAR};background:rgb(255 176 0 / 0.2);`,
					data,
					label: { ...label, css: `${label.css}top:-16px;left:0;` },
				}
			: {
					kind: 'ruler-near',
					x: lo,
					y: from,
					w: hi - lo,
					h: span,
					css: `box-sizing:border-box;border-top:1px dashed ${NEAR};border-bottom:1px dashed ${NEAR};background:rgb(255 176 0 / 0.2);`,
					data,
					label: { ...label, css: `${label.css}left:-${RULER + 40}px;top:-7px;` },
				};
	}

	function rulers(): Spec[] {
		const width = win.innerWidth;
		const height = win.innerHeight;
		const strip = `background-color:rgb(24 24 24 / 0.85);color:#bbb;font:9px/1 ${MONO};`;
		const out: Spec[] = [
			{
				kind: 'ruler-top',
				x: 0,
				y: 0,
				w: width,
				h: RULER,
				css: `${strip}background-image:repeating-linear-gradient(to right,#777 0 1px,transparent 1px 10px);background-size:100% 4px;background-position:bottom;background-repeat:no-repeat;`,
			},
			{
				kind: 'ruler-left',
				x: 0,
				y: 0,
				w: RULER,
				h: height,
				css: `${strip}background-image:repeating-linear-gradient(to bottom,#777 0 1px,transparent 1px 10px);background-size:4px 100%;background-position:right;background-repeat:no-repeat;`,
			},
		];
		for (let x = 100; x < width; x += 100)
			out.push({
				kind: 'ruler-tick',
				x,
				y: 0,
				w: 1,
				h: RULER,
				css: 'background:#777;',
				label: {
					text: String(x),
					css: `position:absolute;left:3px;top:2px;color:#bbb;font:9px/1 ${MONO};`,
				},
			});
		for (let y = 100; y < height; y += 100)
			out.push({
				kind: 'ruler-tick',
				x: 0,
				y,
				w: RULER,
				h: 1,
				css: 'background:#777;',
				label: {
					text: String(y),
					css: `position:absolute;left:2px;top:3px;color:#bbb;font:9px/1 ${MONO};writing-mode:vertical-rl;`,
				},
			});
		if (cursor) {
			out.push(
				{ kind: 'ruler-mark', x: cursor.x, y: 0, w: 1, h: RULER, css: `background:${RED};` },
				{ kind: 'ruler-mark', x: 0, y: cursor.y, w: RULER, h: 1, css: `background:${RED};` },
				{
					kind: 'ruler-cursor',
					x: cursor.x + 6,
					y: RULER + 4,
					w: 0,
					h: 0,
					css: 'overflow:visible;',
					data: { x: String(cursor.x), y: String(cursor.y) },
					label: { text: `${cursor.x}, ${cursor.y}`, css: `${TAG}background:${RED};` },
				},
			);
		}
		return out;
	}

	function specs(): Spec[] {
		const out: Spec[] = [];
		if (grid > 0)
			out.push({
				kind: 'ruler-grid',
				x: 0,
				y: 0,
				w: win.innerWidth,
				h: win.innerHeight,
				css: `background-image:linear-gradient(to right,rgb(255 0 80 / 0.14) 1px,transparent 1px),linear-gradient(to bottom,rgb(255 0 80 / 0.14) 1px,transparent 1px);background-size:${grid}px ${grid}px;`,
				data: { size: String(grid) },
			});
		const a = anchor?.isConnected ? rect(anchor) : null;
		const h = hover?.isConnected ? hover : null;
		if (a) out.push(outline('ruler-anchor', a, 'solid'), size(a));
		if (h && h !== anchor) {
			const b = rect(h);
			out.push(outline('ruler-hover', b, 'dashed'), size(b));
			if (a) {
				const m = measure(a, b);
				for (const al of m.alignments) out.push(guide(al, a, b));
				for (const l of [...m.horizontal.lines, ...m.vertical.lines]) out.push(distance(l));
			} else out.push(...bands(h, b));
		} else if (h && a) out.push(...bands(h, a));
		out.push(...rulers());
		return out;
	}

	function build(spec: Spec): HTMLElement {
		const el = doc.createElement('div');
		el.setAttribute('data-yubi', spec.kind);
		for (const [k, v] of Object.entries(spec.data ?? {})) el.setAttribute(`data-${k}`, v);
		el.style.cssText = `position:absolute;left:${spec.x}px;top:${spec.y}px;width:${spec.w}px;height:${spec.h}px;${spec.css}`;
		if (spec.label) {
			const tag = doc.createElement('span');
			tag.setAttribute('data-yubi', 'ruler-label');
			tag.style.cssText = spec.label.css;
			tag.textContent = spec.label.text;
			el.append(tag);
		}
		return el;
	}

	function render() {
		if (!on) return;
		const next = specs();
		const key = JSON.stringify(next);
		if (key === drawn) return;
		drawn = key;
		layer.replaceChildren(...next.map(build));
	}

	function reset() {
		anchor = null;
		hover = null;
		cursor = null;
		drawn = '';
		layer.replaceChildren();
	}

	return {
		layer,
		get on() {
			return on;
		},
		get grid() {
			return grid;
		},
		get anchor() {
			return anchor;
		},
		set(next, nextGrid) {
			if (nextGrid !== undefined) grid = nextGrid > 0 ? Math.round(nextGrid) : 0;
			if (on === next) return;
			on = next;
			reset();
		},
		move(x, y, el) {
			cursor = { x: Math.round(x), y: Math.round(y) };
			hover = el;
		},
		leave() {
			cursor = null;
			hover = null;
		},
		click(el) {
			if (!anchor?.isConnected) {
				anchor = el;
				return null;
			}
			if (anchor === el) {
				anchor = null;
				return null;
			}
			const pair = { a: anchor, b: el };
			anchor = null;
			return pair;
		},
		drop() {
			if (!anchor) return false;
			anchor = null;
			return true;
		},
		render,
	};
}
