import { describe } from './inspect.ts';
import type { LookContext, LookHandler } from './look.ts';
import { isPickerNode, resolveOne } from './look-dom.ts';
import type { Frame } from './protocol.ts';

export type Box = { top: number; right: number; bottom: number; left: number };

export type Visibility = {
	visible: boolean;
	reasons: string[];
	coveredBy?: string;
};

export type StylesResult =
	| {
			selector: string;
			tag: string;
			source?: { file: string; line: number; column: number };
			stack: Frame[];
			pseudo?: string;
			styles: Record<string, string>;
			variables: Record<string, string>;
			box: { content: { width: number; height: number }; padding: Box; border: Box; margin: Box };
			rect: { x: number; y: number; width: number; height: number };
			visibility: Visibility;
	  }
	| { error: string; matches: { count: number; first: string[] } };

const px = (v: string) => Math.round(parseFloat(v) * 100) / 100 || 0;

const sides = (cs: CSSStyleDeclaration, prefix: string, suffix = ''): Box => ({
	top: px(cs.getPropertyValue(`${prefix}-top${suffix}`)),
	right: px(cs.getPropertyValue(`${prefix}-right${suffix}`)),
	bottom: px(cs.getPropertyValue(`${prefix}-bottom${suffix}`)),
	left: px(cs.getPropertyValue(`${prefix}-left${suffix}`)),
});

const IGNORED = /^(-webkit-|-moz-|inline-size|block-size|inset-|d$|cx$|cy$|r$|rx$|ry$|x$|y$)/;

/** Computed properties of `el` that differ from a bare element of the same tag. */
function diffAgainstProbe(
	doc: Document,
	el: Element,
	cs: CSSStyleDeclaration,
	pseudo: string | undefined,
): Record<string, string> {
	const probe = doc.createElement(el.localName);
	probe.setAttribute('data-yubi', 'probe');
	doc.body.appendChild(probe);
	const base = doc.defaultView?.getComputedStyle(probe, pseudo);
	const out: Record<string, string> = {};
	try {
		for (const name of cs) {
			if (IGNORED.test(name)) continue;
			const value = cs.getPropertyValue(name);
			if (!base || base.getPropertyValue(name) !== value) out[name] = value;
		}
	} finally {
		probe.remove();
	}
	return out;
}

/** `var(--x)` references in the element's own and computed styles, resolved. */
function variablesOf(el: Element, cs: CSSStyleDeclaration): Record<string, string> {
	const names = new Set<string>();
	const scan = (text: string) => {
		for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) if (m[1]) names.add(m[1]);
	};
	scan(el.getAttribute('style') ?? '');
	const doc = el.ownerDocument;
	for (const sheet of doc.styleSheets) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue;
		}
		for (const rule of rules) {
			const style = rule as CSSStyleRule;
			if (!style.selectorText || !style.style) continue;
			try {
				if (!el.matches(style.selectorText)) continue;
			} catch {
				continue;
			}
			scan(style.style.cssText);
		}
	}
	const out: Record<string, string> = {};
	for (const name of names) out[name] = cs.getPropertyValue(name).trim() || '(unset)';
	return out;
}

function visibilityOf(
	el: Element,
	cs: CSSStyleDeclaration,
	rect: DOMRect,
	{ doc, win, root }: LookContext,
): Visibility {
	const reasons: string[] = [];
	if (cs.display === 'none') reasons.push('display: none');
	if (cs.visibility !== 'visible') reasons.push(`visibility: ${cs.visibility}`);
	if (parseFloat(cs.opacity) === 0) reasons.push('opacity: 0');
	if (rect.width === 0 || rect.height === 0) reasons.push('zero size');
	if (
		rect.bottom <= 0 ||
		rect.right <= 0 ||
		rect.top >= win.innerHeight ||
		rect.left >= win.innerWidth
	)
		reasons.push('off-screen');
	let coveredBy: string | undefined;
	if (!reasons.length) {
		const x = Math.min(Math.max(rect.left + rect.width / 2, 0), win.innerWidth - 1);
		const y = Math.min(Math.max(rect.top + rect.height / 2, 0), win.innerHeight - 1);
		const top = doc.elementsFromPoint(x, y).find((n) => !isPickerNode(n, root));
		if (top && top !== el && !el.contains(top)) {
			coveredBy = describe(top).selector;
			reasons.push(`covered by ${coveredBy}`);
		}
	}
	return { visible: reasons.length === 0, reasons, coveredBy };
}

export const lookStyles: LookHandler = (args, ctx: LookContext): StylesResult => {
	const { doc, win, root } = ctx;
	const selector = typeof args.selector === 'string' ? args.selector : '';
	if (!selector) return { error: 'look styles needs a selector', matches: { count: 0, first: [] } };
	let resolved = resolveOne(doc, selector, root);
	if ('error' in resolved && resolved.matches.count > 1) {
		const first = doc.querySelector(selector);
		if (first) resolved = { el: first };
	}
	if ('error' in resolved) return resolved;
	const el = resolved.el;
	const pseudo = typeof args.pseudo === 'string' && args.pseudo ? args.pseudo : undefined;
	const cs = win.getComputedStyle(el, pseudo);
	const props =
		Array.isArray(args.props) && args.props.length
			? args.props.filter((p): p is string => typeof p === 'string')
			: null;
	let styles: Record<string, string>;
	if (props) {
		styles = {};
		for (const name of props) styles[name] = cs.getPropertyValue(name);
	} else if (args.all === true) {
		styles = {};
		for (const name of cs) styles[name] = cs.getPropertyValue(name);
	} else styles = diffAgainstProbe(doc, el, cs, pseudo);
	const info = describe(el);
	const rect = el.getBoundingClientRect();
	const border = sides(cs, 'border', '-width');
	const padding = sides(cs, 'padding');
	return {
		selector: info.selector,
		tag: info.tag,
		source: info.source,
		stack: info.stack,
		pseudo,
		styles,
		variables: variablesOf(el, cs),
		box: {
			content: {
				width:
					Math.round(
						(rect.width - padding.left - padding.right - border.left - border.right) * 100,
					) / 100,
				height:
					Math.round(
						(rect.height - padding.top - padding.bottom - border.top - border.bottom) * 100,
					) / 100,
			},
			padding,
			border,
			margin: sides(cs, 'margin'),
		},
		rect: {
			x: Math.round(rect.x * 100) / 100,
			y: Math.round(rect.y * 100) / 100,
			width: Math.round(rect.width * 100) / 100,
			height: Math.round(rect.height * 100) / 100,
		},
		visibility: visibilityOf(el, cs, rect, ctx),
	};
};
