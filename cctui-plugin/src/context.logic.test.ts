import { describe, expect, it } from 'vitest';
import { formatContextBlock } from './context.logic.ts';
import type { Target } from './protocol.ts';

const button: Target = {
	tag: 'button',
	selector: 'main > ul > li:nth-of-type(2) > button.retry',
	text: '  Retry\n  ',
	html: '<button class="retry">Retry</button>',
	attrs: { class: 'retry' },
	rect: { x: 0, y: 0, width: 10, height: 10 },
	source: { file: 'src/lib/EpisodeRow.svelte', line: 12, column: 4 },
	stack: [
		{ type: 'component', name: '<EpisodeRow>', file: '+page.svelte', line: 30, column: 2 },
		{ type: 'component', name: '<Page>', file: '+layout.svelte', line: 5, column: 1 },
		{ type: 'root' },
	],
};

describe('formatContextBlock', () => {
	it('renders route, viewport, element, source, render stack and selector', () => {
		const block = formatContextBlock({
			targets: [button],
			route: '/route',
			viewport: { width: 1280, height: 800 },
		});
		expect(block).toBe(
			[
				'[yubisashi] on /route (viewport 1280x800)',
				'- <button> "Retry" — src/lib/EpisodeRow.svelte:12:4',
				'  rendered by: <EpisodeRow> +page.svelte:30:2 ← <Page> +layout.svelte:5:1',
				'  selector: main > ul > li:nth-of-type(2) > button.retry',
			].join('\n'),
		);
	});

	it('numbers the pin, tolerates missing source/text and flattens hostile text', () => {
		const bare: Target = {
			...button,
			text: 'a\n<script>alert(1)</script>\n"quoted"'.padEnd(200, 'x'),
			source: undefined,
			stack: [],
		};
		const block = formatContextBlock(
			{ targets: [bare, button], route: '', viewport: { width: 1, height: 2 } },
			3,
		);
		const lines = block.split('\n');
		expect(lines[0]).toBe('[yubisashi #3] on / (viewport 1x2)');
		expect(lines[1]?.startsWith('- <button> "a <script>alert(1)</script> \\"quoted\\"')).toBe(true);
		expect(lines[1]).not.toContain('\n');
		expect(lines[1]?.endsWith('…"')).toBe(true);
		expect(lines[1]).not.toContain(' — ');
		expect(lines[2]).toBe(`  selector: ${button.selector}`);
		expect(lines[3]).toContain('EpisodeRow.svelte:12:4');
		expect(block.split('\n').filter((l) => l.startsWith('- ')).length).toBe(2);
	});
});
