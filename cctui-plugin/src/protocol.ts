import {
	type ChildMessage,
	type Frame,
	type ParentMessage,
	type Target,
	type Unmarked,
	YUBI,
} from '../../src/picker/protocol.ts';

export type {
	ChildMessage,
	Frame,
	ParentMessage,
	Pin,
	Target,
	Viewport,
} from '../../src/picker/protocol.ts';
export { YUBI };

export type ParentPayload = Unmarked<ParentMessage>;
export type Selected = Extract<ChildMessage, { type: 'pick:selected' }>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseFrame(v: unknown): Frame | null {
	if (!isObj(v) || !isStr(v.type)) return null;
	const f: Frame = { type: v.type };
	if (isStr(v.file)) f.file = v.file;
	if (isNum(v.line)) f.line = v.line;
	if (isNum(v.column)) f.column = v.column;
	if (isStr(v.name)) f.name = v.name;
	return f;
}

function parseTarget(v: unknown): Target | null {
	if (!isObj(v) || !isStr(v.tag) || !isStr(v.selector) || !isStr(v.text) || !isStr(v.html))
		return null;
	if (!isObj(v.attrs) || !isObj(v.rect) || !Array.isArray(v.stack)) return null;
	const { x, y, width, height } = v.rect;
	if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height)) return null;
	const attrs: Record<string, string> = {};
	for (const [k, val] of Object.entries(v.attrs)) if (isStr(val)) attrs[k] = val;
	const stack: Frame[] = [];
	for (const f of v.stack) {
		const p = parseFrame(f);
		if (!p) return null;
		stack.push(p);
	}
	const t: Target = {
		tag: v.tag,
		selector: v.selector,
		text: v.text,
		html: v.html,
		attrs,
		rect: { x, y, width, height },
		stack,
	};
	if (v.source !== undefined) {
		const s = v.source;
		if (!isObj(s) || !isStr(s.file) || !isNum(s.line) || !isNum(s.column)) return null;
		t.source = { file: s.file, line: s.line, column: s.column };
	}
	return t;
}

/** A structurally valid child message, or `null`. The frame is another
 *  origin's document, so every field is checked and unknown ones dropped. */
export function parseChildMessage(data: unknown): ChildMessage | null {
	if (!isObj(data) || data.yubi !== YUBI || !isStr(data.type)) return null;
	switch (data.type) {
		case 'pick:state':
			return typeof data.picking === 'boolean'
				? { yubi: YUBI, type: 'pick:state', picking: data.picking }
				: null;
		case 'pick:hover': {
			if (data.target === null) return { yubi: YUBI, type: 'pick:hover', target: null };
			const target = parseTarget(data.target);
			return target ? { yubi: YUBI, type: 'pick:hover', target } : null;
		}
		case 'pick:selected': {
			if (!Array.isArray(data.targets) || !isStr(data.route) || !isObj(data.viewport)) return null;
			const { width, height } = data.viewport;
			if (!isNum(width) || !isNum(height)) return null;
			const targets: Target[] = [];
			for (const t of data.targets) {
				const p = parseTarget(t);
				if (!p) return null;
				targets.push(p);
			}
			return {
				yubi: YUBI,
				type: 'pick:selected',
				targets,
				route: data.route,
				viewport: { width, height },
			};
		}
		case 'pick:cancel':
			return { yubi: YUBI, type: 'pick:cancel' };
		case 'pin:open':
			return isNum(data.id) ? { yubi: YUBI, type: 'pin:open', id: data.id } : null;
		case 'route':
			return isStr(data.route) ? { yubi: YUBI, type: 'route', route: data.route } : null;
		case 'look:served': {
			if (!isStr(data.kind)) return null;
			const served: Extract<ChildMessage, { type: 'look:served' }> = {
				yubi: YUBI,
				type: 'look:served',
				kind: data.kind.slice(0, 40),
			};
			if (isStr(data.selector)) served.selector = data.selector.slice(0, 200);
			return served;
		}
		default:
			return null;
	}
}

/** The frame's origin, or `null` when the URL is not an absolute http(s) URL. */
export function originOf(url: string): string | null {
	try {
		const u = new URL(url);
		return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
	} catch {
		return null;
	}
}

/** Only the framed document at the expected origin gets to talk to the pane. */
export function isTrustedEvent(
	e: { source: unknown; origin: string },
	frame: { contentWindow: unknown } | null | undefined,
	expectedOrigin: string | null,
): boolean {
	if (!frame?.contentWindow || expectedOrigin === null) return false;
	return e.source === frame.contentWindow && e.origin === expectedOrigin;
}
