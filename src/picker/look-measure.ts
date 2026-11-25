import { describe } from './inspect.ts';
import type { LookHandler } from './look.ts';
import { type DomMatch, resolveOne } from './look-dom.ts';
import { type Measurement, measure, rectOf } from './measure.ts';

export type MeasuredElement = {
	selector: string;
	tag: string;
	source?: { file: string; line: number; column: number };
};

export type MeasureResult =
	| (Measurement & { elements: { a: MeasuredElement; b: MeasuredElement } })
	| { error: string; matches: DomMatch };

function first(doc: Document, selector: string, root: Element) {
	const resolved = resolveOne(doc, selector, root);
	if ('error' in resolved && resolved.matches.count > 1) {
		const el = [...doc.querySelectorAll(selector)].find((e) => !root.contains(e));
		if (el) return { el };
	}
	return resolved;
}

const element = (el: Element): MeasuredElement => {
	const info = describe(el);
	return { selector: info.selector, tag: info.tag, source: info.source };
};

/** Distances and alignments between the first matches of two selectors, computed exactly as
 *  ruler mode draws them. */
export const lookMeasure: LookHandler = (args, { doc, root }): MeasureResult => {
	const a = typeof args.selector === 'string' ? args.selector : '';
	const b = typeof args.other === 'string' ? args.other : '';
	if (!a || !b)
		return { error: 'look measure needs two selectors', matches: { count: 0, first: [] } };
	const ra = first(doc, a, root);
	if ('error' in ra) return ra;
	const rb = first(doc, b, root);
	if ('error' in rb) return rb;
	return {
		elements: { a: element(ra.el), b: element(rb.el) },
		...measure(rectOf(ra.el.getBoundingClientRect()), rectOf(rb.el.getBoundingClientRect())),
	};
};
