// @vitest-environment happy-dom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from '../sdk/types.ts';
import { messages as m } from './messages.ts';
import type { Preview } from './previews.ts';
import YubisashiPane from './YubisashiPane.svelte';

const preview = (id: string, port: number): Preview => ({
	id,
	port,
	url: `https://cctui-pv-${id}.example.com/`,
	opened_at: '2026-09-26T10:00:00Z',
});

function render(previews: Preview[]) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string) =>
			input.endsWith('/ticket') ? Response.json({ ticket: 't' }) : Response.json(previews),
		),
	);
	const onclose = vi.fn();
	const props: PaneProps = {
		session: { id: 's1', machine_id: 'm1', working_dir: '/w' },
		composer: { insertText: vi.fn(), addFiles: vi.fn(), focus: vi.fn() },
		params: {},
		onclose,
	};
	const pane = mount(YubisashiPane, { target: document.body, props });
	return { pane, onclose };
}

const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	flushSync();
};
const q = (journey: string) => document.querySelector<HTMLElement>(`[data-journey="${journey}"]`);

describe('YubisashiPane', () => {
	let mounted: ReturnType<typeof render> | undefined;
	afterEach(() => {
		if (mounted) unmount(mounted.pane);
		mounted = undefined;
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
	});

	it('renders the toolbar, the frame and the status row with tsumikit controls', async () => {
		mounted = render([preview('abc123', 4780)]);
		await settle();
		const section = q('yubisashi');
		expect(section?.getAttribute('aria-label')).toBe(m.name);
		expect(section?.querySelector('[data-tsu="Toolbar"]')).not.toBeNull();
		expect((q('path') as HTMLInputElement | null)?.disabled).toBe(false);
		expect(q('reload')?.getAttribute('aria-label')).toBe(m.reload);
		expect(q('pick')?.getAttribute('aria-label')).toBe(m.pick);
		expect(document.querySelector('iframe')?.getAttribute('src')).toContain('cctui-pv-abc123');
		expect(q('status')?.dataset.status).toBe('loading');
		expect(q('look-allow')).not.toBeNull();
		expect(q('preview')).toBeNull();
	});

	it('offers a preview select only when there are several', async () => {
		mounted = render([preview('abc123', 4780), preview('old000', 3000)]);
		await settle();
		const select = q('preview') as HTMLSelectElement | null;
		expect(select).not.toBeNull();
		expect([...(select?.options ?? [])].map((o) => o.textContent?.trim())).toEqual(
			expect.arrayContaining([expect.stringContaining('4780'), expect.stringContaining('3000')]),
		);
	});

	it('closes from the toolbar', async () => {
		mounted = render([]);
		await settle();
		const close = document.querySelector<HTMLButtonElement>(`button[aria-label="${m.close}"]`);
		close?.click();
		expect(mounted.onclose).toHaveBeenCalledOnce();
	});
});
