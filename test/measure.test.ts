import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { alignments, formatMeasurement, measure, rectOf } from '../src/picker/measure.ts';

const A = { x: 600, y: 100, width: 100, height: 40 };

describe('measure distances', () => {
	test('apart on x: the gap between A right and B left, drawn at the middle of the shared y range', () => {
		const m = measure(A, { x: 724, y: 110, width: 60, height: 20 });
		assert.equal(m.horizontal.relation, 'after');
		assert.equal(m.horizontal.gap, 24);
		assert.deepEqual(m.horizontal.lines, [{ axis: 'x', from: 700, to: 724, at: 120, length: 24 }]);
		assert.equal(m.vertical.relation, 'overlap');
		assert.equal(m.vertical.overlap, 20);
		assert.equal(m.vertical.start, 10);
		assert.equal(m.vertical.end, -10);
	});

	test('B before A on both axes: two gaps, each to the nearest edge', () => {
		const m = measure(A, { x: 500, y: 20, width: 80, height: 50 });
		assert.equal(m.horizontal.relation, 'before');
		assert.equal(m.horizontal.gap, 20);
		assert.equal(m.vertical.relation, 'before');
		assert.equal(m.vertical.gap, 30);
		assert.deepEqual(m.vertical.lines[0], { axis: 'y', from: 70, to: 100, at: 650, length: 30 });
	});

	test('below A: the vertical gap; touching edges are a 0 px gap', () => {
		const below = measure(A, { x: 618, y: 180, width: 60, height: 30 });
		assert.equal(below.vertical.relation, 'after');
		assert.equal(below.vertical.gap, 40);
		const touching = measure(A, { x: 700, y: 100, width: 10, height: 40 });
		assert.equal(touching.horizontal.relation, 'after');
		assert.equal(touching.horizontal.gap, 0);
	});

	test('B inside A: overlap with the inset on each side, no zero-length line', () => {
		const m = measure(A, { x: 610, y: 100, width: 50, height: 20 });
		assert.equal(m.horizontal.relation, 'overlap');
		assert.equal(m.horizontal.gap, 0);
		assert.equal(m.horizontal.overlap, 50);
		assert.equal(m.horizontal.start, 10);
		assert.equal(m.horizontal.end, -40);
		assert.deepEqual(
			m.horizontal.lines.map((l) => [l.from, l.to, l.length]),
			[
				[600, 610, 10],
				[660, 700, 40],
			],
		);
		assert.deepEqual(
			m.vertical.lines.map((l) => [l.from, l.to]),
			[[120, 140]],
			'the shared top edge draws no line',
		);
	});

	test('partial overlap reports the shared length', () => {
		const m = measure(A, { x: 680, y: 130, width: 40, height: 40 });
		assert.equal(m.horizontal.overlap, 20);
		assert.equal(m.vertical.overlap, 10);
	});

	test('sub-pixel rects are rounded to 0.01 px with no float noise', () => {
		assert.deepEqual(rectOf({ x: 0.1 + 0.2, y: -0.004, width: 10.005, height: 3.333333 }), {
			x: 0.3,
			y: 0,
			width: 10.01,
			height: 3.33,
		});
		const m = measure(
			{ x: 0.1, y: 0, width: 0.2, height: 1 },
			{ x: 0.5, y: 0, width: 1, height: 1 },
		);
		assert.equal(m.horizontal.gap, 0.2);
	});
});

describe('measure alignment', () => {
	const find = (list: ReturnType<typeof alignments>, edge: string) =>
		list.find((al) => al.edge === edge);

	test('centres within 0.5 px are aligned; edges further than 3 px are left out', () => {
		const list = alignments(A, { x: 724, y: 110.5, width: 60, height: 20 });
		assert.deepEqual(find(list, 'centre-y'), {
			edge: 'centre-y',
			axis: 'y',
			a: 120,
			b: 120.5,
			delta: 0.5,
			status: 'aligned',
		});
		assert.equal(find(list, 'top'), undefined);
		assert.equal(find(list, 'left'), undefined);
		assert.equal(list.length, 1);
	});

	test('exactly matching edges are aligned with delta 0', () => {
		const list = alignments(A, { x: 600, y: 300, width: 100, height: 10 });
		assert.deepEqual(
			list.map((al) => [al.edge, al.delta, al.status]),
			[
				['left', 0, 'aligned'],
				['centre-x', 0, 'aligned'],
				['right', 0, 'aligned'],
			],
		);
	});

	test('1, 2 and 3 px off are near misses; 3.5 px is not flagged', () => {
		for (const off of [1, 2, 3]) {
			const al = find(alignments(A, { x: 620 - off, y: 180, width: 60, height: 30 }), 'centre-x');
			assert.ok(al, `${off}px off is reported`);
			assert.equal(al.status, 'near');
			assert.equal(al.delta, -off);
		}
		const near = find(alignments(A, { x: 618, y: 180, width: 60, height: 30 }), 'centre-x');
		assert.deepEqual(near, {
			edge: 'centre-x',
			axis: 'x',
			a: 650,
			b: 648,
			delta: -2,
			status: 'near',
		});
		assert.equal(
			find(alignments(A, { x: 616.5, y: 180, width: 60, height: 30 }), 'centre-x'),
			undefined,
		);
	});
});

describe('formatMeasurement', () => {
	test('names both elements and spells out gaps, overlaps, alignments and near misses', () => {
		const m = measure(A, { x: 618, y: 180, width: 60, height: 30 });
		assert.deepEqual(formatMeasurement(m, { a: '<div> a.svelte:3', b: '<div> b.svelte:9' }), [
			'  A <div> a.svelte:3: 100x40 at 600,100',
			'  B <div> b.svelte:9: 60x30 at 618,180',
			'  horizontal: 60px overlap (B left +18px, B right -22px)',
			'  vertical: 40px gap (A bottom → B top)',
			'  near miss: centre x A=650 B=648 (2px off)',
		]);
		const side = formatMeasurement(measure(A, { x: 724, y: 110, width: 60, height: 20 }), {
			a: 'a',
			b: 'b',
		});
		assert.equal(side[2], '  horizontal: 24px gap (A right → B left)');
		assert.equal(side[4], '  aligned: centre y 120');
	});
});
