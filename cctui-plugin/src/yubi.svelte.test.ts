// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREVIEWS_DISABLED, type Preview } from './previews.ts';
import {
	relativePath,
	START_POLL_MS,
	START_PROMPT,
	START_TIMEOUT_MS,
	shouldAutoStart,
	YubiController,
} from './yubi.svelte.ts';

const PREVIEW: Preview = {
	id: 'abc123',
	port: 4780,
	url: 'https://cctui-pv-abc123.example.com/',
	opened_at: '2026-09-26T10:00:00Z',
};
const OLDER: Preview = {
	id: 'old000',
	port: 3000,
	url: 'https://cctui-pv-old000.example.com/',
	opened_at: '2026-09-25T10:00:00Z',
};

function mockApi(previews: Preview[]) {
	const calls: string[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string, init?: RequestInit) => {
			calls.push(`${init?.method ?? 'GET'} ${input}`);
			if (input.endsWith('/ticket')) return Response.json({ ticket: `t-${calls.length}` });
			return Response.json(previews);
		}),
	);
	return calls;
}

function mockDisabled() {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ error: PREVIEWS_DISABLED }, { status: 503 })),
	);
}

afterEach(() => vi.unstubAllGlobals());

const TARGET = {
	tag: 'h1',
	selector: 'body > h1',
	text: 'Kit fixture',
	html: '<h1>Kit fixture</h1>',
	attrs: {},
	rect: { x: 0, y: 0, width: 10, height: 10 },
	source: { file: 'src/routes/+page.svelte', line: 5, column: 0 },
	stack: [],
};

async function connected() {
	mockApi([PREVIEW]);
	const composer = { insertText: vi.fn(), addFiles: vi.fn(), focus: vi.fn() };
	const ctl = new YubiController({ id: 's', machine_id: 'm', working_dir: '/w' }, composer);
	await ctl.refresh();
	const contentWindow = { postMessage: vi.fn() };
	ctl.frame = { contentWindow } as unknown as HTMLIFrameElement;
	const deliver = (data: unknown) =>
		ctl.onMessage({
			source: contentWindow,
			origin: 'https://cctui-pv-abc123.example.com',
			data,
		} as unknown as MessageEvent);
	return { ctl, composer, contentWindow, deliver };
}

describe('YubiController.refresh', () => {
	it('frames the newest preview through a fresh ticket', async () => {
		const calls = mockApi([OLDER, PREVIEW]);
		const ctl = new YubiController(
			{ id: 's', machine_id: 'm', working_dir: '/w' },
			{ insertText: vi.fn(), addFiles: vi.fn(), focus: vi.fn() },
		);
		await ctl.refresh();
		expect(ctl.selected?.id).toBe('abc123');
		expect(ctl.url).toBe('https://cctui-pv-abc123.example.com/__cctui/auth?ticket=t-2');
		expect(ctl.origin).toBe('https://cctui-pv-abc123.example.com');
		expect(ctl.status).toBe('loading');
		expect(calls).toEqual([
			'GET /api/v1/sessions/s/previews',
			'POST /api/v1/sessions/s/previews/abc123/ticket',
		]);

		await ctl.refresh('https://cctui-pv-abc123.example.com/');
		expect(calls).toHaveLength(3);
		await ctl.select('old000');
		expect(ctl.selected?.id).toBe('old000');
		expect(ctl.url).toMatch(/ticket=t-4$/);
		await ctl.reload();
		expect(calls.at(-2)).toBe('GET /api/v1/sessions/s/previews');
		expect(ctl.url).toMatch(/ticket=t-6$/);
	});

	it('clears the frame when no preview is left and surfaces API errors', async () => {
		const ctl = new YubiController(
			{ id: 's', machine_id: 'm', working_dir: '/w' },
			{ insertText: vi.fn(), addFiles: vi.fn(), focus: vi.fn() },
		);
		mockApi([]);
		await ctl.refresh();
		expect(ctl.selected).toBeNull();
		expect(ctl.url).toBe('');
		expect(ctl.status).toBe('idle');
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 401 })),
		);
		await ctl.refresh();
		expect(ctl.error).toBe('previews: 401');
	});
});

describe('relativePath', () => {
	it('keeps typed addresses relative to the framed origin', () => {
		expect(relativePath('')).toBe('/');
		expect(relativePath('  /sessions ')).toBe('/sessions');
		expect(relativePath('sessions?tab=1#top')).toBe('/sessions?tab=1#top');
		expect(relativePath('https://evil.example/steal?x=1')).toBe('/steal?x=1');
		expect(relativePath('//evil.example/steal')).toBe('/steal');
	});

	it('rejects non-http schemes', () => {
		expect(relativePath('javascript:alert(1)')).toBeNull();
		expect(relativePath('data:text/html,hi')).toBeNull();
	});
});

describe('YubiController.navigate', () => {
	it('moves the frame to the path on the preview origin and drops picking', async () => {
		const { ctl, contentWindow } = await connected();
		const assign = vi.fn();
		(contentWindow as { location?: unknown }).location = { assign };
		ctl.picking = true;
		ctl.navigate('https://evil.example/sessions?tab=1');
		expect(assign).toHaveBeenCalledWith('https://cctui-pv-abc123.example.com/sessions?tab=1');
		expect(ctl.route).toBe('/sessions?tab=1');
		expect(ctl.picking).toBe(false);
		ctl.navigate('javascript:alert(1)');
		expect(assign).toHaveBeenCalledTimes(1);
	});
});

describe('YubiController.post', () => {
	it('posts plain structured-cloneable objects, never a $state proxy', async () => {
		const { ctl, composer, contentWindow, deliver } = await connected();
		deliver({
			yubi: 1,
			type: 'pick:selected',
			targets: [TARGET],
			route: '/',
			viewport: { width: 1, height: 1 },
		});

		expect(composer.insertText).toHaveBeenCalledTimes(1);
		expect(ctl.pins).toEqual([{ id: 1, selector: 'body > h1' }]);
		const posted = contentWindow.postMessage.mock.calls.map(([data, origin]) => {
			expect(origin).toBe('https://cctui-pv-abc123.example.com');
			expect(() => structuredClone(data)).not.toThrow();
			return data;
		});
		expect(posted).toEqual([
			{ yubi: 1, type: 'pick:clear', id: 1 },
			{ yubi: 1, type: 'pins:set', pins: [{ id: 1, selector: 'body > h1' }] },
		]);
	});
});

describe('shouldAutoStart', () => {
	const base = {
		previews: 0,
		error: '',
		canSend: true,
		sent: false,
		boot: 'idle' as const,
		disabled: false,
	};
	it('asks only when the host can send, nothing is listed, and nothing was asked yet', () => {
		expect(shouldAutoStart(base)).toBe(true);
		expect(shouldAutoStart({ ...base, previews: 1 })).toBe(false);
		expect(shouldAutoStart({ ...base, canSend: false })).toBe(false);
		expect(shouldAutoStart({ ...base, sent: true })).toBe(false);
		expect(shouldAutoStart({ ...base, boot: 'pending' })).toBe(false);
		expect(shouldAutoStart({ ...base, error: 'previews: 500' })).toBe(false);
		expect(shouldAutoStart({ ...base, disabled: true })).toBe(false);
	});
});

describe('YubiController.open', () => {
	const session = { id: 's', machine_id: 'm', working_dir: '/w' };
	const bridge = () => ({ insertText: vi.fn(), addFiles: vi.fn(), focus: vi.fn(), send: vi.fn() });
	afterEach(() => vi.useRealTimers());

	it('sends the start prompt once when no preview exists and polls', async () => {
		vi.useFakeTimers();
		const composer = bridge();
		const ctl = new YubiController(session, composer);
		const calls = mockApi([]);
		await ctl.open();
		expect(composer.send).toHaveBeenCalledExactlyOnceWith(START_PROMPT);
		expect(ctl.boot).toBe('pending');
		await ctl.open();
		expect(composer.send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(START_POLL_MS);
		expect(calls.filter((c) => c.endsWith('/previews'))).toHaveLength(3);
		ctl.destroy();
	});

	it('frames the preview that appears while polling', async () => {
		vi.useFakeTimers();
		const composer = bridge();
		const ctl = new YubiController(session, composer);
		const previews: Preview[] = [];
		mockApi(previews);
		await ctl.open();
		await vi.advanceTimersByTimeAsync(START_POLL_MS);
		expect(ctl.selected).toBeNull();
		previews.push(PREVIEW);
		await vi.advanceTimersByTimeAsync(START_POLL_MS);
		expect(ctl.boot).toBe('idle');
		expect(ctl.selected?.id).toBe('abc123');
		expect(ctl.url).toContain('https://cctui-pv-abc123.example.com/__cctui/auth?ticket=');
		await vi.advanceTimersByTimeAsync(START_POLL_MS * 3);
		expect(composer.send).toHaveBeenCalledTimes(1);
	});

	it('times out after three minutes and lets a retry send again', async () => {
		vi.useFakeTimers();
		const composer = bridge();
		const ctl = new YubiController(session, composer);
		mockApi([]);
		await ctl.open();
		await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS);
		expect(ctl.boot).toBe('timeout');
		ctl.startServer();
		expect(composer.send).toHaveBeenCalledTimes(2);
		expect(ctl.boot).toBe('pending');
		ctl.destroy();
	});

	it('sends nothing when a preview already exists', async () => {
		const composer = bridge();
		const ctl = new YubiController(session, composer);
		mockApi([PREVIEW]);
		await ctl.open();
		expect(composer.send).not.toHaveBeenCalled();
		expect(ctl.boot).toBe('idle');
		expect(ctl.selected?.id).toBe('abc123');
	});

	it('shows the disabled refusal instead of waiting when previews are off', async () => {
		vi.useFakeTimers();
		const composer = bridge();
		const ctl = new YubiController(session, composer);
		mockDisabled();
		await ctl.open();
		expect(ctl.disabled).toBe(true);
		expect(ctl.error).toBe(PREVIEWS_DISABLED);
		expect(composer.send).not.toHaveBeenCalled();
		expect(ctl.boot).toBe('idle');
		await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS + START_POLL_MS);
		expect(ctl.boot).toBe('idle');
		ctl.startServer();
		expect(composer.send).not.toHaveBeenCalled();
	});

	it('stops a pending start as soon as previews turn off', async () => {
		vi.useFakeTimers();
		const composer = bridge();
		const ctl = new YubiController(session, composer);
		mockApi([]);
		await ctl.open();
		expect(ctl.boot).toBe('pending');
		mockDisabled();
		await vi.advanceTimersByTimeAsync(START_POLL_MS);
		expect(ctl.boot).toBe('idle');
		expect(ctl.disabled).toBe(true);
		expect(ctl.error).toBe(PREVIEWS_DISABLED);
		const before = composer.send.mock.calls.length;
		await vi.advanceTimersByTimeAsync(START_POLL_MS * 5);
		expect(composer.send.mock.calls).toHaveLength(before);
	});

	it('clears the disabled state once previews come back', async () => {
		const ctl = new YubiController(session, bridge());
		mockDisabled();
		await ctl.refresh();
		expect(ctl.disabled).toBe(true);
		mockApi([PREVIEW]);
		await ctl.refresh();
		expect(ctl.disabled).toBe(false);
		expect(ctl.error).toBe('');
		expect(ctl.selected?.id).toBe('abc123');
	});

	it('falls back to the plain empty state on hosts without send', async () => {
		const ctl = new YubiController(session, {
			insertText: vi.fn(),
			addFiles: vi.fn(),
			focus: vi.fn(),
		});
		mockApi([]);
		await ctl.open();
		expect(ctl.boot).toBe('idle');
		expect(ctl.selected).toBeNull();
	});
});
