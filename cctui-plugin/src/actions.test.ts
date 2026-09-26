import { describe, expect, it } from 'vitest';
import { messageActions, reviewUrls } from './actions.ts';

const text = [
	'Started the proxy.',
	'yubisashi: https://review.example.com:4780/',
	'Also plain: yubisashi: http://192.0.2.10:4780/ inline does not count',
	'yubisashi: http://localhost:4780/',
	'yubisashi: https://review.example.com:4780/',
	'yubisashi: ftp://nope.example.com/',
].join('\n');

describe('reviewUrls', () => {
	it('keeps whole `yubisashi: <http(s) url>` lines, deduplicated, in order', () => {
		expect(reviewUrls(text)).toEqual([
			'https://review.example.com:4780/',
			'http://localhost:4780/',
		]);
		expect(reviewUrls('nothing here')).toEqual([]);
		expect(reviewUrls('yubisashi: https://a.example.com b')).toEqual([]);
	});
});

describe('messageActions', () => {
	it('returns one Open in Review action per URL, auto-opening the first only', () => {
		const actions = messageActions({ role: 'assistant', text });
		expect(actions).toEqual([
			{
				label: 'Open in Review',
				icon: 'eye',
				params: { url: 'https://review.example.com:4780/' },
				open: 'sessionPane',
				autoOpen: true,
			},
			{
				label: 'Open in Review',
				icon: 'eye',
				params: { url: 'http://localhost:4780/' },
				open: 'sessionPane',
				autoOpen: false,
			},
		]);
	});

	it('ignores user lines and text without a review URL', () => {
		expect(messageActions({ role: 'user', text })).toEqual([]);
		expect(messageActions({ role: 'assistant', text: 'yubisashi is great' })).toEqual([]);
	});
});
