export const CSP_HEADERS = ['content-security-policy', 'content-security-policy-report-only'];

export function parentOrigins(
	option: string | string[] | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const raw = option ?? env.YUBI_PARENT_ORIGIN ?? '';
	return [raw]
		.flat()
		.flatMap((s) => s.split(','))
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => new URL(s).origin);
}

export function relaxCsp(value: string, origins: string[]): string {
	const directives = value
		.split(';')
		.map((d) => d.trim())
		.filter(Boolean);
	const kept = directives.filter((d) => !/^frame-ancestors\b/i.test(d));
	return [...kept, `frame-ancestors ${origins.join(' ')}`].join('; ');
}

const pageNonce = (html: string) => html.match(/<script[^>]*\snonce="([^"]+)"/i)?.[1];

/** A classic, blocking script at the very start of `<head>`, so it runs before any module. */
export function injectFirstScript(html: string, src: string): string {
	const nonce = pageNonce(html);
	const tag = `<script${nonce ? ` nonce="${nonce}"` : ''} src="${src}"></script>`;
	const head = html.match(/<head(\s[^>]*)?>/i);
	if (head?.index !== undefined) {
		const at = head.index + head[0].length;
		return html.slice(0, at) + tag + html.slice(at);
	}
	const script = html.search(/<script\b/i);
	return script < 0 ? html : html.slice(0, script) + tag + html.slice(script);
}

export function injectScript(html: string, src: string): string {
	const nonce = pageNonce(html);
	const tag = `<script type="module"${nonce ? ` nonce="${nonce}"` : ''} src="${src}"></script>`;
	if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
	return html + tag;
}

export const bootstrap = (
	pickerModule: string,
	origins: string[],
	extra: { look?: boolean } = {},
) =>
	`import { createPicker } from ${JSON.stringify(pickerModule)};
if (window.parent !== window) createPicker({ parentOrigin: ${JSON.stringify(origins)}${extra.look ? ', look: true' : ''} });
`;
