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

describe('formatContextBlock in ruler mode', () => {
	const a: Target = { ...button, tag: 'span', text: 'dot', selector: '.dot' };
	const b: Target = {
		...button,
		tag: 'span',
		text: 'emoji',
		selector: '.emoji',
		source: { file: 'src/lib/Badge.svelte', line: 7, column: 2 },
	};

	it('appends the measurement block: both elements with source, distances and the near miss', () => {
		const block = formatContextBlock(
			{
				targets: [a, b],
				route: '/',
				viewport: { width: 1000, height: 700 },
				measure: {
					a: { x: 420, y: 10, width: 36, height: 20 },
					b: { x: 470, y: 12, width: 32, height: 20 },
				},
			},
			2,
		);
		const lines = block.split('\n');
		const at = lines.indexOf('measure (ruler):');
		expect(at).toBeGreaterThan(0);
		expect(lines.slice(at)).toEqual([
			'measure (ruler):',
			'  A <span> src/lib/EpisodeRow.svelte:12: 36x20 at 420,10',
			'  B <span> src/lib/Badge.svelte:7: 32x20 at 470,12',
			'  horizontal: 14px gap (A right → B left)',
			'  vertical: 18px overlap (B top +2px, B bottom +2px)',
			'  near miss: top A=10 B=12 (2px off)',
			'  near miss: centre y A=20 B=22 (2px off)',
			'  near miss: bottom A=30 B=32 (2px off)',
		]);
	});

	it('says which edges line up and flattens hostile selectors', () => {
		const block = formatContextBlock({
			targets: [{ ...a, source: undefined, selector: '.x\n<b>' }, b],
			route: '/',
			viewport: { width: 1, height: 1 },
			measure: {
				a: { x: 0, y: 0, width: 10, height: 10 },
				b: { x: 0, y: 40, width: 10, height: 10 },
			},
		});
		expect(block).toContain('  aligned: left 0, centre x 5, right 10');
		expect(block).toContain('  A <span> .x <b>: 10x10 at 0,0');
		expect(block).toContain('  vertical: 30px gap (A bottom → B top)');
	});

	it('has no measurement block outside ruler mode', () => {
		const block = formatContextBlock({
			targets: [a, b],
			route: '/',
			viewport: { width: 1, height: 1 },
		});
		expect(block).not.toContain('measure');
	});
});
