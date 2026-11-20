/** Every message in both directions carries this marker; anything without it is ignored. */
export const YUBI = 1 as const;

export type Frame = { type: string; file?: string; line?: number; column?: number; name?: string };

export type Target = {
	tag: string;
	selector: string;
	text: string;
	html: string;
	attrs: Record<string, string>;
	rect: { x: number; y: number; width: number; height: number };
	source?: { file: string; line: number; column: number };
	stack: Frame[];
};

export type Pin = { id: number; selector: string };

export type Viewport = { width: number; height: number };

type Marked<T> = T & { yubi: typeof YUBI };
/** A message before the marker is stamped on. */
export type Unmarked<T> = T extends unknown ? Omit<T, 'yubi'> : never;

/** Parent window → app document. */
export type ParentMessage = Marked<
	| { type: 'pick:start' }
	| { type: 'pick:stop' }
	/** Drops the selection; `id` records it as the targets of comment #id so its pin sticks to the picked elements. */
	| { type: 'pick:clear'; id?: number }
	| { type: 'pins:set'; pins: Pin[] }
	/** The user's consent to `yubi look`, `go` and `show`; off by the pane's switch. */
	| { type: 'look:allow'; allowed: boolean }
	/** Scroll to the agent's highlight #id again, re-drawing it if it expired. */
	| { type: 'show:focus'; id: number }
>;

/** App document → parent window. */
export type ChildMessage = Marked<
	| { type: 'pick:state'; picking: boolean }
	| { type: 'pick:hover'; target: Target | null }
	| { type: 'pick:selected'; targets: Target[]; route: string; viewport: Viewport }
	| { type: 'pick:cancel' }
	| { type: 'pin:open'; id: number }
	| { type: 'route'; route: string }
	/** One `yubi look` request was answered. */
	| { type: 'look:served'; kind: string; selector?: string }
	/** `yubi go` moved the app from one route to another. */
	| { type: 'agent:navigated'; from: string; to: string }
	/** `yubi show` drew highlight #id. */
	| { type: 'agent:showed'; id: number; label: string }
	/** The dev server's hot-reload socket opened or dropped. */
	| { type: 'hmr'; status: 'connected' | 'lost' }
>;

const PARENT_TYPES: ReadonlySet<string> = new Set([
	'pick:start',
	'pick:stop',
	'pick:clear',
	'pins:set',
	'look:allow',
	'show:focus',
]);
const CHILD_TYPES: ReadonlySet<string> = new Set([
	'pick:state',
	'pick:hover',
	'pick:selected',
	'pick:cancel',
	'pin:open',
	'route',
	'look:served',
	'agent:navigated',
	'agent:showed',
	'hmr',
]);

const isMarked = (data: unknown): data is { yubi: typeof YUBI; type: string } =>
	typeof data === 'object' &&
	data !== null &&
	(data as { yubi?: unknown }).yubi === YUBI &&
	typeof (data as { type?: unknown }).type === 'string';

export const isParentMessage = (data: unknown): data is ParentMessage =>
	isMarked(data) && PARENT_TYPES.has(data.type);

export const isChildMessage = (data: unknown): data is ChildMessage =>
	isMarked(data) && CHILD_TYPES.has(data.type);
