// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { isMixedContent, normalizeUrl, rememberedUrl, rememberUrl, urlKey } from './pane.logic.ts';

beforeEach(() => localStorage.clear());

describe('yubisashi pane logic', () => {
	it('remembers the URL per machine and working dir', () => {
		expect(urlKey('m1', '/srv/app')).toBe('cctui_yubi_url:m1:/srv/app');
		rememberUrl('m1', '/srv/app', 'http://localhost:5173');
		expect(rememberedUrl('m1', '/srv/app')).toBe('http://localhost:5173');
		expect(rememberedUrl('m1', '/other')).toBe('');
		rememberUrl('m1', '/srv/app', '');
		expect(rememberedUrl('m1', '/srv/app')).toBe('');
	});

	it('normalizes what the user typed', () => {
		expect(normalizeUrl(' localhost:5173/shows ')).toBe('http://localhost:5173/shows');
		expect(normalizeUrl('https://app.test')).toBe('https://app.test');
		expect(normalizeUrl('javascript:alert(1)')).toBe('');
		expect(normalizeUrl('')).toBe('');
	});

	it('flags mixed content only for remote plain http under https', () => {
		expect(isMixedContent('http://192.0.2.5:3000', 'https:')).toBe(true);
		expect(isMixedContent('http://localhost:3000', 'https:')).toBe(false);
		expect(isMixedContent('http://127.0.0.1:3000', 'https:')).toBe(false);
		expect(isMixedContent('https://app.test', 'https:')).toBe(false);
		expect(isMixedContent('http://192.0.2.5:3000', 'http:')).toBe(false);
		expect(isMixedContent('garbage', 'https:')).toBe(false);
	});
});
