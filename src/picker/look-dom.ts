import { selectorOf } from './inspect.ts';
import type { LookContext, LookHandler } from './look.ts';

export const DEFAULT_DOM_DEPTH = 12;
export const DEFAULT_DOM_MAX_BYTES = 40 * 1024;
const MAX_TEXT = 160;
const MAX_ATTR = 120;
const MAX_PATH = 24;
const TRUNCATED = '<!-- truncated -->';

const VOID = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'source',
	'track',
	'wbr',
]);
const DROP_BODY = new Set(['script', 'style', 'noscript', 'template']);

type Meta = { loc?: { file?: string; line?: number } };

export type DomMatch = { count: number; first: string[] };

export type DomResult =
	| { html: string; bytes: number; truncated: boolean; selector: string; matches: number }
	| { error: string; matches: DomMatch };

const escapeText = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;');

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Whether `el` belongs to the picker itself. */
export const isPickerNode = (el: Element, root: Element) => root.contains(el);

/** Resolve `selector` to exactly one element, else describe what matched. */
export function resolveOne(
	doc: Document,
	selector: string,
	root: Element,
): { el: Element } | { error: string; matches: DomMatch } {
	let all: Element[];
	try {
		all = [...doc.querySelectorAll(selector)].filter((el) => !isPickerNode(el, root));
	} catch {
		return { error: `invalid selector "${selector}"`, matches: { count: 0, first: [] } };
	}
	if (all.length === 1 && all[0]) return { el: all[0] };
	const first = all.slice(0, 5).map((el) => selectorOf(el));
	return {
		error:
			all.length === 0
				? `no element matches "${selector}"`
				: `${all.length} elements match "${selector}"; narrow it down`,
		matches: { count: all.length, first },
	};
}

function attrsOf(el: Element): string {
	const out: string[] = [];
	for (const a of el.attributes) {
		let value = a.value;
		if (a.name === 'd' || a.name === 'points') value = cut(value, 24);
		else if (a.name === 'style' || a.name === 'srcset' || a.name.startsWith('data-'))
			value = cut(value, MAX_ATTR);
		else if (value.startsWith('data:')) value = cut(value, 32);
		else value = cut(value, MAX_ATTR);
		out.push(value === '' ? a.name : `${a.name}="${escapeAttr(value)}"`);
	}
	const input = el as HTMLInputElement;
	const tag = el.localName;
	if (tag === 'input' || tag === 'textarea' || tag === 'select') {
		const type = (input.type ?? '').toLowerCase();
		if (type === 'checkbox' || type === 'radio') {
			if (input.checked !== el.hasAttribute('checked'))
				out.push(input.checked ? ':checked' : ':unchecked');
		} else if (type !== 'password' && input.value !== (el.getAttribute('value') ?? '')) {
			out.push(`:value="${escapeAttr(cut(input.value, MAX_ATTR))}"`);
		}
	}
	const meta = (el as Element & { __svelte_meta?: Meta }).__svelte_meta;
	if (meta?.loc?.file)
		out.push(`data-yubi-src="${escapeAttr(`${meta.loc.file}:${meta.loc.line ?? 0}`)}"`);
	return out.length ? ` ${out.join(' ')}` : '';
}

/** A compact, live serialization of `el`: current form values, runtime classes, Svelte
 *  source annotations, with scripts, styles and deep subtrees left out. */
export function serializeDom(
	el: Element,
	options: { depth?: number; maxBytes?: number; root: Element },
): { html: string; bytes: number; truncated: boolean } {
	const depth = options.depth ?? DEFAULT_DOM_DEPTH;
	const maxBytes = options.maxBytes ?? DEFAULT_DOM_MAX_BYTES;
	const out: string[] = [];
	let size = 0;
	let truncated = false;
	const push = (s: string) => {
		if (truncated) return false;
		if (size + s.length > maxBytes) {
			truncated = true;
			return false;
		}
		out.push(s);
		size += s.length;
		return true;
	};
	const walk = (node: Node, level: number, indent: string) => {
		if (truncated) return;
		if (node.nodeType === 3) {
			const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
			if (text) push(`${indent}${escapeText(cut(text, MAX_TEXT))}\n`);
			return;
		}
		if (node.nodeType !== 1) return;
		const e = node as Element;
		if (isPickerNode(e, options.root)) return;
		const tag = e.localName;
		const d = tag === 'path' ? e.getAttribute('d') : null;
		if (d && d.length > MAX_PATH) {
			push(`${indent}<path d="…"/>\n`);
			return;
		}
		if (VOID.has(tag)) {
			push(`${indent}<${tag}${attrsOf(e)}>\n`);
			return;
		}
		if (DROP_BODY.has(tag)) {
			push(
				`${indent}<${tag}${attrsOf(e)}><!-- ${(e.textContent ?? '').length} chars --></${tag}>\n`,
			);
			return;
		}
		const children = [...e.childNodes].filter(
			(c) =>
				(c.nodeType === 1 && !isPickerNode(c as Element, options.root)) ||
				(c.nodeType === 3 && (c.textContent ?? '').trim()),
		);
		if (!children.length) {
			push(`${indent}<${tag}${attrsOf(e)}></${tag}>\n`);
			return;
		}
		if (level >= depth) {
			push(`${indent}<${tag}${attrsOf(e)}><!-- ${e.children.length} children --></${tag}>\n`);
			return;
		}
		if (!push(`${indent}<${tag}${attrsOf(e)}>\n`)) return;
		for (const child of children) walk(child, level + 1, `${indent}  `);
		push(`${indent}</${tag}>\n`);
	};
	walk(el, 0, '');
	let html = out.join('');
	if (truncated) html += `${TRUNCATED}\n`;
	return { html, bytes: html.length, truncated };
}

export const lookDom: LookHandler = (args, { doc, root }: LookContext): DomResult => {
	const selector = typeof args.selector === 'string' && args.selector ? args.selector : 'body';
	const found = resolveOne(doc, selector, root);
	if ('error' in found) return found;
	const depth = typeof args.depth === 'number' ? args.depth : undefined;
	const maxBytes = typeof args.maxBytes === 'number' ? args.maxBytes : undefined;
	return { ...serializeDom(found.el, { depth, maxBytes, root }), selector, matches: 1 };
};
