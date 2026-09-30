import { describe, expect, it, vi } from 'vitest';
import {
	authUrl,
	listPreviews,
	matchPreview,
	newest,
	normalizePreview,
	PREVIEWS_DISABLED,
	type Preview,
	previewsDisabled,
} from './previews.ts';

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

	it("carries the server's own message, and flags the instance-wide refusal", async () => {
		const off = reply({ error: PREVIEWS_DISABLED }, 503);
		await expect(listPreviews('s1', off)).rejects.toThrow(PREVIEWS_DISABLED);
		await listPreviews('s1', off).catch((err) => expect(previewsDisabled(err)).toBe(true));
		const other = reply({ error: 'not your session' }, 403);
		await expect(listPreviews('s1', other)).rejects.toThrow('not your session');
		await listPreviews('s1', other).catch((err) => expect(previewsDisabled(err)).toBe(false));
		await listPreviews('s1', reply({}, 500)).catch((err) =>
			expect(previewsDisabled(err)).toBe(false),
		);
		expect(previewsDisabled(new Error(PREVIEWS_DISABLED))).toBe(false);
	});

	it('reads the server camelCase openedAt and still accepts opened_at', () => {
		const { opened_at: _, ...bare } = B;
		expect(normalizePreview({ ...bare, openedAt: '2026-09-27T00:00:00Z' })).toEqual({
			...bare,
			opened_at: '2026-09-27T00:00:00Z',
		});
		expect(normalizePreview(B)).toEqual(B);
		expect(newest([A, normalizePreview({ ...bare, openedAt: '2026-09-27T00:00:00Z' })])?.id).toBe(
			B.id,
		);
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
