import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { type Plugin, searchForWorkspaceRoot } from 'vite';

export type YubisashiOptions = {
	/** Origin(s) allowed to frame the app; falls back to `YUBI_PARENT_ORIGIN` (comma-separated). */
	parentOrigin?: string | string[];
};

export const VIRTUAL_ID = 'virtual:yubisashi';
const RESOLVED_ID = `\0${VIRTUAL_ID}`;
const SCRIPT_SRC = `/@id/__x00__${VIRTUAL_ID}`;
const PICKER_URL = new URL('../picker/index.js', import.meta.url);
const CSP_HEADERS = ['content-security-policy', 'content-security-policy-report-only'];

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

export function injectScript(html: string): string {
	const nonce = html.match(/<script[^>]*\snonce="([^"]+)"/i)?.[1];
	const tag = `<script type="module"${nonce ? ` nonce="${nonce}"` : ''} src="${SCRIPT_SRC}"></script>`;
	if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${tag}</head>`);
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${tag}</body>`);
	return html + tag;
}

type Header = number | string | readonly string[];

function relaxHeaders(res: ServerResponse, origins: string[]) {
	const fix = (name: string, value: Header): Header | null => {
		const key = name.toLowerCase();
		if (key === 'x-frame-options') return null;
		if (CSP_HEADERS.includes(key) && typeof value === 'string') return relaxCsp(value, origins);
		return value;
	};
	const setHeader = res.setHeader.bind(res);
	res.setHeader = (name, value) => {
		const fixed = fix(name, value);
		return fixed === null ? res : setHeader(name, fixed);
	};
	const writeHead = res.writeHead.bind(res) as (
		status: number,
		...rest: unknown[]
	) => ServerResponse;
	res.writeHead = ((status: number, ...rest: unknown[]) => {
		const headers = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as
			| Record<string, Header>
			| undefined;
		if (headers)
			for (const [name, value] of Object.entries(headers)) {
				const fixed = fix(name, value);
				if (fixed === null) delete headers[name];
				else headers[name] = fixed;
			}
		if (isHtml(res, headers)) {
			res.removeHeader('content-length');
			for (const name of Object.keys(headers ?? {}))
				if (name.toLowerCase() === 'content-length') delete headers?.[name];
		}
		return writeHead(status, ...rest);
	}) as typeof res.writeHead;
}

const header = (res: ServerResponse, name: string, extra?: Record<string, Header>) =>
	String(
		Object.entries(extra ?? {}).find(([k]) => k.toLowerCase() === name)?.[1] ??
			res.getHeader(name) ??
			'',
	);

const isHtml = (res: ServerResponse, extra?: Record<string, Header>) =>
	header(res, 'content-type', extra).includes('text/html') &&
	!header(res, 'content-encoding', extra);

const toBuffer = (chunk: unknown): Buffer =>
	Buffer.isBuffer(chunk)
		? chunk
		: chunk instanceof Uint8Array
			? Buffer.from(chunk)
			: Buffer.from(String(chunk));

function injectHtml(res: ServerResponse) {
	const chunks: Buffer[] = [];
	const write = res.write.bind(res);
	const end = res.end.bind(res);
	let buffering: boolean | undefined;
	const decide = () => {
		if (buffering === undefined) buffering = isHtml(res);
		return buffering;
	};
	res.write = ((chunk: unknown, ...rest: unknown[]) => {
		if (!decide()) return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
		if (chunk) chunks.push(toBuffer(chunk));
		return true;
	}) as typeof res.write;
	res.end = ((chunk: unknown, ...rest: unknown[]) => {
		const callback = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
		if (!decide()) return (end as (...a: unknown[]) => ServerResponse)(chunk, ...rest);
		if (chunk && typeof chunk !== 'function') chunks.push(toBuffer(chunk));
		const html = injectScript(Buffer.concat(chunks).toString('utf8'));
		if (!res.headersSent) res.setHeader('content-length', Buffer.byteLength(html));
		return end(html, callback);
	}) as typeof res.end;
}

/**
 * Dev-only: lets a review panel at `parentOrigin` frame the app and injects the yubisashi picker
 * into every HTML page. Inactive unless an origin is configured.
 */
export function yubisashi(options: YubisashiOptions = {}): Plugin {
	const origins = parentOrigins(options.parentOrigin);
	const pickerFile = fileURLToPath(PICKER_URL);
	return {
		name: 'yubisashi',
		apply: 'serve',
		config: (user) =>
			origins.length
				? {
						server: {
							fs: {
								allow: [
									...(user.server?.fs?.allow ?? [
										searchForWorkspaceRoot(user.root ?? process.cwd()),
									]),
									fileURLToPath(new URL('.', PICKER_URL)),
								],
							},
						},
					}
				: undefined,
		resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : undefined),
		load: (id) =>
			id === RESOLVED_ID
				? `import { createPicker } from ${JSON.stringify(pickerFile)};
if (window.parent !== window) createPicker({ parentOrigin: ${JSON.stringify(origins)} });
`
				: undefined,
		configureServer(server) {
			if (!origins.length) return;
			server.config.logger.info(`yubisashi: framing allowed from ${origins.join(', ')}`);
			server.middlewares.use((_req: IncomingMessage, res: ServerResponse, next: () => void) => {
				relaxHeaders(res, origins);
				injectHtml(res);
				next();
			});
		},
	};
}

export default yubisashi;
