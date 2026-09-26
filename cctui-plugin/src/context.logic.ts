import type { Frame, Selected, Target } from './protocol.ts';

const MAX_TEXT = 80;
const MAX_STACK = 4;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function quote(text: string): string {
	const t = oneLine(text);
	if (!t) return '';
	const cut = t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
	return ` "${cut.replace(/"/g, '\\"')}"`;
}

const loc = (f: { file?: string; line?: number; column?: number }): string =>
	f.file ? [f.file, f.line, f.column].filter((v) => v !== undefined).join(':') : '';

function frameLabel(f: Frame): string {
	const name = f.name ?? `<${f.type}>`;
	const at = loc(f);
	return at ? `${name} ${at}` : name;
}

function targetLines(t: Target): string[] {
	const head = `- <${t.tag}>${quote(t.text)}${t.source ? ` — ${loc(t.source)}` : ''}`;
	const lines = [head];
	const stack = t.stack.filter((f) => f.name || f.file).slice(0, MAX_STACK);
	if (stack.length) lines.push(`  rendered by: ${stack.map(frameLabel).join(' ← ')}`);
	if (t.selector) lines.push(`  selector: ${t.selector}`);
	return lines;
}

/** The plain-text block dropped into the composer for one selection. Element
 *  data is untrusted: it is flattened to one line per field and never rendered
 *  as markup. */
export function formatContextBlock(
	sel: Pick<Selected, 'targets' | 'route' | 'viewport'>,
	pin?: number,
): string {
	const tag = pin === undefined ? '[yubisashi]' : `[yubisashi #${pin}]`;
	const head = `${tag} on ${sel.route || '/'} (viewport ${sel.viewport.width}x${sel.viewport.height})`;
	return [head, ...sel.targets.flatMap(targetLines)].join('\n');
}
