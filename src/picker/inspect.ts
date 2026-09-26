import type { Frame, Target } from './protocol.ts';

type MetaFrame = {
	type: string;
	componentTag?: string;
	file?: string;
	line?: number;
	column?: number;
	parent?: MetaFrame | null;
};
type Meta = { loc: { file: string; line: number; column?: number }; parent?: MetaFrame | null };

export const shortFile = (file?: string) => (file ? (file.split('/').at(-1) ?? '') : '');

function svelteMeta(el: Element): Meta | null {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const meta = (node as Element & { __svelte_meta?: Meta }).__svelte_meta;
		if (meta) return meta;
	}
	return null;
}

function stackOf(meta: Meta | null): Frame[] {
	const frames: Frame[] = [];
	for (let p = meta?.parent; p && frames.length < 12; p = p.parent) {
		if (p.type !== 'component' || p.file?.includes('.svelte-kit/generated')) continue;
		frames.push({
			type: p.type,
			name: p.componentTag ? `<${p.componentTag}>` : undefined,
			file: p.file,
			line: p.line,
			column: p.column,
		});
	}
	return frames;
}

const SCOPED_CLASS = /^(svelte|s)-[\w-]{5,}$/;
const HOOK_ATTRS = ['data-testid', 'data-verb', 'data-test'];
const KEPT_ATTRS = ['role', 'aria-label', 'href', 'name', 'type', 'title', 'alt'];

export function selectorOf(el: Element): string {
	const doc = el.ownerDocument;
	const parts: string[] = [];
	for (
		let node: Element | null = el;
		node && node.nodeType === 1 && node !== doc.documentElement;
		node = node.parentElement
	) {
		for (const attr of HOOK_ATTRS) {
			const value = node.getAttribute(attr);
			if (value) {
				parts.unshift(`[${attr}="${CSS.escape(value)}"]`);
				return parts.join(' > ');
			}
		}
		if (node.id && !/\d{3,}/.test(node.id)) {
			parts.unshift(`#${CSS.escape(node.id)}`);
			return parts.join(' > ');
		}
		let part = node.localName;
		const classes = [...node.classList].filter((c) => !SCOPED_CLASS.test(c)).slice(0, 2);
		if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('');
		const siblings = node.parentElement
			? [...node.parentElement.children].filter((s) => s.localName === node.localName)
			: [];
		if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
		parts.unshift(part);
		if (parts.length >= 6) break;
	}
	return parts.join(' > ');
}

export function describe(el: Element): Target {
	const meta = svelteMeta(el);
	const attrs: Record<string, string> = {};
	for (const a of el.attributes) {
		if (a.name.startsWith('data-') || KEPT_ATTRS.includes(a.name))
			attrs[a.name] = a.value.slice(0, 200);
	}
	const r = el.getBoundingClientRect();
	const html = el.outerHTML.replace(/\s+/g, ' ');
	const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
	return {
		tag: el.localName,
		selector: selectorOf(el),
		text: text.replace(/\s+/g, ' ').trim().slice(0, 100),
		html: html.length > 500 ? `${html.slice(0, 500)}…` : html,
		attrs,
		rect: {
			x: Math.round(r.x),
			y: Math.round(r.y),
			width: Math.round(r.width),
			height: Math.round(r.height),
		},
		source: meta
			? { file: meta.loc.file, line: meta.loc.line, column: meta.loc.column ?? 0 }
			: undefined,
		stack: stackOf(meta),
	};
}

export const label = (info: Target) =>
	`<${info.tag}> ${info.source ? `${shortFile(info.source.file)}:${info.source.line}` : info.selector}`;
