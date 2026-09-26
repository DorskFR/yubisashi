// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { YubiController } from './yubi.svelte.ts';

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

function connected() {
	const composer = { insertText: vi.fn(), addFiles: vi.fn(), focus: vi.fn() };
	const ctl = new YubiController({ id: 's', machine_id: 'm', working_dir: '/w' }, composer);
	ctl.load('http://app.test');
	const contentWindow = { postMessage: vi.fn() };
	ctl.frame = { contentWindow } as unknown as HTMLIFrameElement;
	const deliver = (data: unknown) =>
		ctl.onMessage({
			source: contentWindow,
			origin: 'http://app.test',
			data,
		} as unknown as MessageEvent);
	return { ctl, composer, contentWindow, deliver };
}

describe('YubiController.post', () => {
	it('posts plain structured-cloneable objects, never a $state proxy', () => {
		const { ctl, composer, contentWindow, deliver } = connected();
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
			expect(origin).toBe('http://app.test');
			expect(() => structuredClone(data)).not.toThrow();
			return data;
		});
		expect(posted).toEqual([
			{ yubi: 1, type: 'pick:clear', id: 1 },
			{ yubi: 1, type: 'pins:set', pins: [{ id: 1, selector: 'body > h1' }] },
		]);
	});
});
