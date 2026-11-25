import { describe, expect, it } from 'vitest';
import { isTrustedEvent, originOf, parseChildMessage, YUBI } from './protocol.ts';

const target = {
	tag: 'button',
	selector: 'main > button',
	text: 'Retry',
	html: '<button>Retry</button>',
	attrs: { class: 'retry', 'data-x': 1 },
	rect: { x: 1, y: 2, width: 3, height: 4 },
	source: { file: 'src/lib/EpisodeRow.svelte', line: 12, column: 4 },
	stack: [{ type: 'component', name: 'EpisodeRow', file: '+page.svelte', line: 30, column: 2 }],
};

describe('parseChildMessage', () => {
	it('rejects anything without the yubi marker or a known type', () => {
		expect(parseChildMessage(null)).toBeNull();
		expect(parseChildMessage('pick:cancel')).toBeNull();
		expect(parseChildMessage({ type: 'pick:cancel' })).toBeNull();
		expect(parseChildMessage({ yubi: 2, type: 'pick:cancel' })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'pick:start' })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'nope' })).toBeNull();
	});

	it('validates every field of a selection and drops unknown attrs values', () => {
		const msg = parseChildMessage({
			yubi: YUBI,
			type: 'pick:selected',
			targets: [target],
			route: '/shows',
			viewport: { width: 1280, height: 800 },
			extra: 'ignored',
		});
		expect(msg?.type).toBe('pick:selected');
		if (msg?.type !== 'pick:selected') throw new Error('unreachable');
		expect(msg.targets[0]?.attrs).toEqual({ class: 'retry' });
		expect(msg.targets[0]?.source).toEqual(target.source);
		expect(msg.targets[0]?.stack[0]?.name).toBe('EpisodeRow');
		expect('extra' in msg).toBe(false);
	});

	it('rejects a selection with a malformed target, route or viewport', () => {
		const base = {
			yubi: YUBI,
			type: 'pick:selected',
			route: '/',
			viewport: { width: 1, height: 1 },
		};
		expect(parseChildMessage({ ...base, targets: [{ ...target, rect: { x: 'a' } }] })).toBeNull();
		expect(
			parseChildMessage({ ...base, targets: [{ ...target, source: { file: 1 } }] }),
		).toBeNull();
		expect(parseChildMessage({ ...base, targets: [{ ...target, stack: [{}] }] })).toBeNull();
		expect(parseChildMessage({ ...base, targets: 'x' })).toBeNull();
		expect(parseChildMessage({ ...base, targets: [], route: 1 })).toBeNull();
		expect(parseChildMessage({ ...base, targets: [], viewport: {} })).toBeNull();
	});

	it('parses a served look, trimming the selector', () => {
		expect(parseChildMessage({ yubi: YUBI, type: 'look:served', kind: 'page' })).toEqual({
			yubi: YUBI,
			type: 'look:served',
			kind: 'page',
		});
		expect(
			parseChildMessage({
				yubi: YUBI,
				type: 'look:served',
				kind: 'dom',
				selector: 'x'.repeat(300),
			}),
		).toEqual({ yubi: YUBI, type: 'look:served', kind: 'dom', selector: 'x'.repeat(200) });
		expect(parseChildMessage({ yubi: YUBI, type: 'look:served' })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'look:served', kind: 1 })).toBeNull();
	});

	it('parses the small messages strictly', () => {
		expect(parseChildMessage({ yubi: YUBI, type: 'pick:state', picking: true })).toEqual({
			yubi: YUBI,
			type: 'pick:state',
			picking: true,
		});
		expect(parseChildMessage({ yubi: YUBI, type: 'pick:state', picking: 'yes' })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'pick:hover', target: null })?.type).toBe(
			'pick:hover',
		);
		expect(parseChildMessage({ yubi: YUBI, type: 'pick:hover', target: {} })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'pin:open', id: 3 })).toEqual({
			yubi: YUBI,
			type: 'pin:open',
			id: 3,
		});
		expect(parseChildMessage({ yubi: YUBI, type: 'pin:open', id: '3' })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'route', route: '/a' })?.type).toBe('route');
		expect(parseChildMessage({ yubi: YUBI, type: 'route' })).toBeNull();
	});

	it('parses agent navigation, highlights and the hot-reload state strictly', () => {
		expect(
			parseChildMessage({ yubi: YUBI, type: 'agent:navigated', from: '/a', to: '/b' }),
		).toEqual({ yubi: YUBI, type: 'agent:navigated', from: '/a', to: '/b' });
		expect(parseChildMessage({ yubi: YUBI, type: 'agent:navigated', from: '/a' })).toBeNull();
		const label = 'l'.repeat(500);
		expect(parseChildMessage({ yubi: YUBI, type: 'agent:showed', id: 1, label })).toEqual({
			yubi: YUBI,
			type: 'agent:showed',
			id: 1,
			label: 'l'.repeat(120),
		});
		expect(parseChildMessage({ yubi: YUBI, type: 'agent:showed', id: '1', label })).toBeNull();
		expect(parseChildMessage({ yubi: YUBI, type: 'hmr', status: 'lost' })).toEqual({
			yubi: YUBI,
			type: 'hmr',
			status: 'lost',
		});
		expect(parseChildMessage({ yubi: YUBI, type: 'hmr', status: 'gone' })).toBeNull();
	});
});

describe('origin gate', () => {
	it('derives the origin of an http(s) URL only', () => {
		expect(originOf('http://localhost:5173/shows?x=1')).toBe('http://localhost:5173');
		expect(originOf('https://app.example.com')).toBe('https://app.example.com');
		expect(originOf('javascript:alert(1)')).toBeNull();
		expect(originOf('not a url')).toBeNull();
		expect(originOf('')).toBeNull();
	});

	it('accepts only the frame window at the expected origin', () => {
		const win = {};
		const frame = { contentWindow: win };
		const origin = 'http://localhost:5173';
		expect(isTrustedEvent({ source: win, origin }, frame, origin)).toBe(true);
		expect(isTrustedEvent({ source: {}, origin }, frame, origin)).toBe(false);
		expect(isTrustedEvent({ source: win, origin: 'http://evil.test' }, frame, origin)).toBe(false);
		expect(isTrustedEvent({ source: win, origin }, null, origin)).toBe(false);
		expect(isTrustedEvent({ source: win, origin }, { contentWindow: null }, origin)).toBe(false);
		expect(isTrustedEvent({ source: win, origin }, frame, null)).toBe(false);
	});
});

describe('ruler messages', () => {
	const pair = { a: { x: 1, y: 2, width: 3, height: 4 }, b: { x: 5, y: 6, width: 7, height: 8 } };
	const selected = {
		yubi: YUBI,
		type: 'pick:selected',
		targets: [target, target],
		route: '/',
		viewport: { width: 1, height: 1 },
	};

	it('parses ruler:state and rejects a malformed one', () => {
		expect(parseChildMessage({ yubi: YUBI, type: 'ruler:state', on: true })).toEqual({
			yubi: YUBI,
			type: 'ruler:state',
			on: true,
		});
		expect(parseChildMessage({ yubi: YUBI, type: 'ruler:state', on: 'yes' })).toBeNull();
	});

	it('keeps a valid measurement on a two-target selection and rejects a broken one', () => {
		const msg = parseChildMessage({ ...selected, measure: { ...pair, extra: 1 } });
		expect(msg?.type === 'pick:selected' && msg.measure).toEqual(pair);
		expect(parseChildMessage({ ...selected, measure: { a: pair.a } })).toBeNull();
		expect(
			parseChildMessage({ ...selected, measure: { ...pair, b: { ...pair.b, x: 'a' } } }),
		).toBeNull();
		expect(parseChildMessage({ ...selected, targets: [target], measure: pair })).toBeNull();
		const plain = parseChildMessage(selected);
		expect(plain?.type === 'pick:selected' && 'measure' in plain).toBe(false);
	});
});
