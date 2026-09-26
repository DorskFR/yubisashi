import { describe, expect, it, vi } from 'vitest';
import { authUrl, listPreviews, matchPreview, newest, type Preview } from './previews.ts';

const A: Preview = {
	id: 'abc123',
	port: 4780,
	url: 'https://cctui-pv-abc123.example.com/',
	opened_at: '2026-09-26T10:00:00Z',
};
const B: Preview = {
	id: 'def456',
	port: 5173,
	url: 'https://cctui-pv-def456.example.com/',
	opened_at: '2026-09-26T11:00:00Z',
};

const reply = (body: unknown, status = 200) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('previews', () => {
	it('lists the session previews with the cctui cookie', async () => {
		const f = reply([A, B]);
		expect(await listPreviews('s/1', f)).toEqual([A, B]);
		expect(f).toHaveBeenCalledWith('/api/v1/sessions/s%2F1/previews', {
			credentials: 'same-origin',
		});
	});

	it('turns a ticket into the preview auth URL', async () => {
		const f = reply({ ticket: 't/1' });
		expect(await authUrl('s1', A, f)).toBe(
			'https://cctui-pv-abc123.example.com/__cctui/auth?ticket=t%2F1',
		);
		expect(f).toHaveBeenCalledWith('/api/v1/sessions/s1/previews/abc123/ticket', {
			method: 'POST',
			credentials: 'same-origin',
		});
	});

	it('reports failed calls', async () => {
		await expect(listPreviews('s1', reply({}, 403))).rejects.toThrow('previews: 403');
		await expect(authUrl('s1', A, reply({}, 404))).rejects.toThrow('ticket: 404');
	});

	it('picks the newest preview and matches a printed URL by origin', () => {
		expect(newest([A, B])).toBe(B);
		expect(newest([B, A])).toBe(B);
		expect(newest([])).toBeNull();
		expect(matchPreview([A, B], 'https://cctui-pv-abc123.example.com/some/path')).toBe(A);
		expect(matchPreview([A, B], 'http://localhost:4780/')).toBeNull();
		expect(matchPreview([A, B], 'garbage')).toBeNull();
	});
});
