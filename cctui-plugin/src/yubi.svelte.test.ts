// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Preview } from './previews.ts';
import { YubiController } from './yubi.svelte.ts';

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
		expect(ctl.url).toMatch(/ticket=t-5$/);
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
