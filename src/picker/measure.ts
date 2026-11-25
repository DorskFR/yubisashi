export type Rect = { x: number; y: number; width: number; height: number };
export type Axis = 'x' | 'y';
export type Edge = 'left' | 'centre-x' | 'right' | 'top' | 'centre-y' | 'bottom';

/** A distance line: from `from` to `to` along `axis`, drawn at `at` on the other axis. */
export type Line = { axis: Axis; from: number; to: number; at: number; length: number };

export type AxisDistance = {
	axis: Axis;
	/** `after`: B starts past A's end; `before`: B ends before A's start; else they overlap. */
	relation: 'after' | 'before' | 'overlap';
	/** Between the nearest edges when apart, else 0. */
	gap: number;
	/** Shared length when they overlap, else 0. */
	overlap: number;
	/** B's start minus A's start, and B's end minus A's end. */
	start: number;
	end: number;
	lines: Line[];
};

export type Alignment = {
	edge: Edge;
	axis: Axis;
	a: number;
	b: number;
	/** B minus A. */
	delta: number;
	status: 'aligned' | 'near';
};

export type Measurement = {
	a: Rect;
	b: Rect;
	horizontal: AxisDistance;
	vertical: AxisDistance;
	alignments: Alignment[];
};

/** Edges or centres this close count as aligned. */
export const ALIGNED_WITHIN = 0.5;
/** Further than aligned but no further than this is a near miss. */
export const NEAR_MISS_MAX = 3;

export const round = (n: number) => Math.round(n * 100) / 100 || 0;

export const rectOf = (r: Rect): Rect => ({
	x: round(r.x),
	y: round(r.y),
	width: round(r.width),
	height: round(r.height),
});

type Span = { start: number; end: number; centre: number };

const span = (r: Rect, axis: Axis): Span => {
	const start = axis === 'x' ? r.x : r.y;
	const size = axis === 'x' ? r.width : r.height;
	return { start, end: round(start + size), centre: round(start + size / 2) };
};

const line = (axis: Axis, p: number, q: number, at: number): Line => ({
	axis,
	from: Math.min(p, q),
	to: Math.max(p, q),
	at,
	length: round(Math.abs(q - p)),
});

function distance(a: Rect, b: Rect, axis: Axis): AxisDistance {
	const cross: Axis = axis === 'x' ? 'y' : 'x';
	const [pa, pb] = [span(a, axis), span(b, axis)];
	const [ca, cb] = [span(a, cross), span(b, cross)];
	const lo = Math.max(ca.start, cb.start);
	const hi = Math.min(ca.end, cb.end);
	const at = lo <= hi ? round((lo + hi) / 2) : ca.centre;
	const start = round(pb.start - pa.start);
	const end = round(pb.end - pa.end);
	if (pb.start >= pa.end) {
		const gap = round(pb.start - pa.end);
		return {
			axis,
			relation: 'after',
			gap,
			overlap: 0,
			start,
			end,
			lines: [line(axis, pa.end, pb.start, at)],
		};
	}
	if (pb.end <= pa.start) {
		const gap = round(pa.start - pb.end);
		return {
			axis,
			relation: 'before',
			gap,
			overlap: 0,
			start,
			end,
			lines: [line(axis, pb.end, pa.start, at)],
		};
	}
	const inner = lo <= hi ? at : cb.centre;
	return {
		axis,
		relation: 'overlap',
		gap: 0,
		overlap: round(Math.min(pa.end, pb.end) - Math.max(pa.start, pb.start)),
		start,
		end,
		lines: [line(axis, pa.start, pb.start, inner), line(axis, pa.end, pb.end, inner)].filter(
			(l) => l.length > 0,
		),
	};
}

const EDGES: { edge: Edge; axis: Axis; key: keyof Span }[] = [
	{ edge: 'left', axis: 'x', key: 'start' },
	{ edge: 'centre-x', axis: 'x', key: 'centre' },
	{ edge: 'right', axis: 'x', key: 'end' },
	{ edge: 'top', axis: 'y', key: 'start' },
	{ edge: 'centre-y', axis: 'y', key: 'centre' },
	{ edge: 'bottom', axis: 'y', key: 'end' },
];

/** Edges and centres of A and B that line up (within 0.5 px) or nearly do (up to 3 px). */
export function alignments(a: Rect, b: Rect): Alignment[] {
	const out: Alignment[] = [];
	for (const { edge, axis, key } of EDGES) {
		const va = span(a, axis)[key];
		const vb = span(b, axis)[key];
		const delta = round(vb - va);
		const off = Math.abs(delta);
		if (off > NEAR_MISS_MAX) continue;
		out.push({
			edge,
			axis,
			a: va,
			b: vb,
			delta,
			status: off <= ALIGNED_WITHIN ? 'aligned' : 'near',
		});
	}
	return out;
}

/** Distances between the nearest edges of A and B on both axes, and their alignments. */
export function measure(a: Rect, b: Rect): Measurement {
	const ra = rectOf(a);
	const rb = rectOf(b);
	return {
		a: ra,
		b: rb,
		horizontal: distance(ra, rb, 'x'),
		vertical: distance(ra, rb, 'y'),
		alignments: alignments(ra, rb),
	};
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

const EDGE_TEXT: Record<Edge, string> = {
	left: 'left',
	'centre-x': 'centre x',
	right: 'right',
	top: 'top',
	'centre-y': 'centre y',
	bottom: 'bottom',
};

function distanceText(d: AxisDistance): string {
	const [lo, hi] = d.axis === 'x' ? ['left', 'right'] : ['top', 'bottom'];
	const name = d.axis === 'x' ? 'horizontal' : 'vertical';
	if (d.relation === 'after') return `${name}: ${d.gap}px gap (A ${hi} → B ${lo})`;
	if (d.relation === 'before') return `${name}: ${d.gap}px gap (B ${hi} → A ${lo})`;
	return `${name}: ${d.overlap}px overlap (B ${lo} ${signed(d.start)}px, B ${hi} ${signed(d.end)}px)`;
}

const rectText = (r: Rect) => `${r.width}x${r.height} at ${r.x},${r.y}`;

/** The measurement as text, the same for the composer block and `yubi look measure`. */
export function formatMeasurement(m: Measurement, labels: { a: string; b: string }): string[] {
	const lines = [
		`  A ${labels.a}: ${rectText(m.a)}`,
		`  B ${labels.b}: ${rectText(m.b)}`,
		`  ${distanceText(m.horizontal)}`,
		`  ${distanceText(m.vertical)}`,
	];
	const aligned = m.alignments.filter((al) => al.status === 'aligned');
	if (aligned.length)
		lines.push(`  aligned: ${aligned.map((al) => `${EDGE_TEXT[al.edge]} ${al.a}`).join(', ')}`);
	for (const al of m.alignments.filter((x) => x.status === 'near'))
		lines.push(
			`  near miss: ${EDGE_TEXT[al.edge]} A=${al.a} B=${al.b} (${Math.abs(al.delta)}px off)`,
		);
	return lines;
}
