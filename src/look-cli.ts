import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type DevState, readDevState, STATE_DIR, STATE_FILE } from './dev.ts';
import { DEFAULT_LOOK_TIMEOUT } from './look.ts';
import type { PageInfo } from './picker/look.ts';
import type { DomResult } from './picker/look-dom.ts';
import { DEFAULT_DOM_DEPTH, DEFAULT_DOM_MAX_BYTES } from './picker/look-dom.ts';
import type { ShotResult } from './picker/look-shot.ts';
import type { StylesResult } from './picker/look-styles.ts';

export const LOOK_USAGE = `Usage: yubi look <what> [selector] [options]

Asks the browser that has the app open in the yubisashi pane what it shows right now. Needs a
\`yubi dev\` started from this directory (it leaves ${STATE_DIR}/${STATE_FILE} behind) and the user's
consent (the pane's "Let the agent look" switch).

  page                    route, title, viewport, scroll, device pixel ratio, focused element
  dom [selector]          the live DOM under selector (default body), compact, with
                          data-yubi-src="file:line" on Svelte elements
      --depth N           replace subtrees deeper than N with <!-- N children --> (default ${DEFAULT_DOM_DEPTH})
      --max-bytes N       hard cap on the output (default ${DEFAULT_DOM_MAX_BYTES})
  styles <selector>       computed style of the first match (only what differs from a bare
                          <tag>), box model, rect, visibility, source and component chain
      --props a,b,…       only these properties
      --all               every computed property
      --pseudo ::before   style a pseudo-element instead
  shot [selector]         PNG of the viewport (or the element), rendered from the DOM inside
                          the user's tab; written to ${STATE_DIR}/shots/<timestamp>.png
      --out FILE          write the PNG there instead
      --scale N           pixel ratio of the image (default 1)
      --raster            accepted for compatibility; the DOM raster is the only path

Options:
  --json                  raw JSON instead of text
  --timeout S             seconds to wait for the browser (default ${DEFAULT_LOOK_TIMEOUT / 1000})
  -h, --help
`;

export type LookIo = {
	cwd: string;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
};

export const EXIT = {
	ok: 0,
	failed: 1,
	usage: 2,
	noDev: 3,
	noBrowser: 4,
	timeout: 5,
	refused: 6,
} as const;

type Reply = { status: number; body: unknown };

export function lookRequest(
	state: DevState,
	kind: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<Reply> {
	const payload = JSON.stringify({ kind, args, timeout: timeoutMs });
	const send = state.scheme === 'https' ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		const req = send(
			{
				host: state.host,
				port: state.port,
				path: '/__yubi/look',
				method: 'POST',
				headers: {
					authorization: `Bearer ${state.token}`,
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(payload),
				},
				rejectUnauthorized: false,
				timeout: timeoutMs + 5000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					let body: unknown = text;
					try {
						body = JSON.parse(text);
					} catch {}
					resolve({ status: res.statusCode ?? 0, body });
				});
				res.on('error', reject);
			},
		);
		req.on('timeout', () => req.destroy(new Error('no answer from the proxy')));
		req.on('error', reject);
		req.end(payload);
	});
}

const errorOf = (body: unknown) =>
	typeof body === 'object' &&
	body !== null &&
	typeof (body as { error?: unknown }).error === 'string'
		? (body as { error: string }).error
		: '';

/** Sends one request and turns the proxy's answer into data or a `{ code, message }` failure. */
export async function look(
	io: LookIo,
	kind: string,
	args: Record<string, unknown>,
	timeoutMs: number,
): Promise<{ data: unknown } | { code: number; message: string }> {
	const state = readDevState(io.cwd);
	if (!state)
		return {
			code: EXIT.noDev,
			message: `no \`yubi dev\` running here: ${STATE_DIR}/${STATE_FILE} not found in ${io.cwd}`,
		};
	let reply: Reply;
	try {
		reply = await lookRequest(state, kind, args, timeoutMs);
	} catch (err) {
		return {
			code: EXIT.noDev,
			message: `no \`yubi dev\` running here: ${state.scheme}://${state.host}:${state.port} did not answer (${(err as Error).message}); remove ${STATE_DIR}/${STATE_FILE} if it is stale`,
		};
	}
	const error = errorOf(reply.body);
	switch (reply.status) {
		case 200:
			return { data: (reply.body as { data: unknown }).data };
		case 503:
			return {
				code: EXIT.noBrowser,
				message: `no browser has the app open: ask the user to open the yubisashi pane (${error})`,
			};
		case 504:
			return { code: EXIT.timeout, message: `the browser did not answer: ${error}` };
		case 403:
			return { code: EXIT.refused, message: error || 'the user has turned looking off' };
		default:
			return { code: EXIT.failed, message: error || `proxy answered ${reply.status}` };
	}
}

const row = (key: string, value: string) => `${key.padEnd(9)}${value}`;

export function formatPage(info: PageInfo): string {
	return [
		row('route', info.route),
		row('title', info.title || '(untitled)'),
		row('viewport', `${info.viewport.width}x${info.viewport.height} @${info.dpr}x`),
		row('scroll', `${info.scroll.x},${info.scroll.y}`),
		row('focus', info.focus ?? '(none)'),
		row('ready', info.readyState),
	].join('\n');
}

const matchesText = (m: { count: number; first: string[] }) =>
	m.count ? `\n${m.count} matches, first: ${m.first.join(', ')}` : '';

export function formatDom(result: DomResult): string {
	if ('error' in result) return `${result.error}${matchesText(result.matches)}`;
	return result.html.replace(/\n$/, '');
}

const boxLine = (name: string, b: { top: number; right: number; bottom: number; left: number }) =>
	row(name, `${b.top} ${b.right} ${b.bottom} ${b.left}`);

export function formatStyles(result: StylesResult): string {
	if ('error' in result) return `${result.error}${matchesText(result.matches)}`;
	const lines = [row('element', `<${result.tag}> ${result.selector}${result.pseudo ?? ''}`)];
	if (result.source) lines.push(row('source', `${result.source.file}:${result.source.line}`));
	const chain = result.stack.filter((f) => f.name || f.file).slice(0, 4);
	if (chain.length)
		lines.push(
			row('rendered', chain.map((f) => `${f.name ?? f.type} ${f.file}:${f.line}`).join(' ← ')),
		);
	const r = result.rect;
	lines.push(row('rect', `${r.x},${r.y} ${r.width}x${r.height}`));
	lines.push(row('content', `${result.box.content.width}x${result.box.content.height}`));
	lines.push(boxLine('padding', result.box.padding));
	lines.push(boxLine('border', result.box.border));
	lines.push(boxLine('margin', result.box.margin));
	lines.push(
		row(
			'visible',
			result.visibility.visible ? 'yes' : `no (${result.visibility.reasons.join('; ')})`,
		),
	);
	const vars = Object.entries(result.variables);
	if (vars.length) lines.push(row('vars', vars.map(([k, v]) => `${k}: ${v}`).join('; ')));
	lines.push('');
	const names = Object.keys(result.styles);
	if (!names.length) lines.push('(nothing differs from a bare element)');
	for (const name of names) lines.push(`${name}: ${result.styles[name]}`);
	return lines.join('\n');
}

export const SHOT_TIMEOUT_MS = 60_000;

const pngSize = (png: Buffer) =>
	png.length >= 24 && png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
		? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
		: null;

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);

export type SavedShot =
	| { path: string; width: number; height: number; scale: number; warnings: string[] }
	| { error: string };

/** Writes the shot and returns what to print for it. */
export function saveShot(result: ShotResult, io: LookIo, out?: string): SavedShot {
	if ('error' in result) return result;
	const comma = result.png.indexOf(',');
	if (!result.png.startsWith('data:image/png;base64,') || comma < 0)
		return { error: 'the browser returned something that is not a PNG' };
	const png = Buffer.from(result.png.slice(comma + 1), 'base64');
	const size = pngSize(png);
	if (!size) return { error: 'the browser returned a malformed PNG' };
	const path = resolve(io.cwd, out ?? join(STATE_DIR, 'shots', `${stamp()}.png`));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, png);
	return { path, ...size, scale: result.scale, warnings: result.warnings };
}

export function formatShot(saved: SavedShot): string {
	if ('error' in saved) return saved.error;
	return [
		saved.path,
		`${saved.width}x${saved.height} px (scale ${saved.scale})`,
		...saved.warnings.map((w) => `warning: ${w}`),
	].join('\n');
}

export type LookCommand = {
	kind: string;
	args: Record<string, unknown>;
	json: boolean;
	timeoutMs: number;
	format: (data: unknown) => string;
	/** Turns the browser's data into what is printed; by default the data itself. */
	finish?: (data: unknown, io: LookIo) => unknown;
};

export function parseLook(argv: string[]): LookCommand | { usage: string; error?: string } {
	const spec = {
		options: {
			json: { type: 'boolean', default: false },
			timeout: { type: 'string' },
			depth: { type: 'string' },
			'max-bytes': { type: 'string' },
			props: { type: 'string' },
			all: { type: 'boolean', default: false },
			pseudo: { type: 'string' },
			out: { type: 'string' },
			scale: { type: 'string' },
			raster: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
		allowPositionals: true,
	} as const;
	let parsed: ReturnType<typeof parseArgs<typeof spec>>;
	try {
		parsed = parseArgs({ args: argv, ...spec });
	} catch (err) {
		return { usage: LOOK_USAGE, error: (err as Error).message };
	}
	const { values, positionals } = parsed;
	if (values.help) return { usage: LOOK_USAGE };
	const [kind, selector] = positionals;
	const seconds = values.timeout === undefined ? undefined : Number(values.timeout);
	if (seconds !== undefined && !(seconds > 0))
		return { usage: LOOK_USAGE, error: `invalid --timeout ${values.timeout}` };
	const base = { json: values.json, timeoutMs: (seconds ?? DEFAULT_LOOK_TIMEOUT / 1000) * 1000 };
	switch (kind) {
		case 'page':
			if (selector !== undefined)
				return { usage: LOOK_USAGE, error: 'look page takes no selector' };
			return { ...base, kind, args: {}, format: (d) => formatPage(d as PageInfo) };
		case 'dom': {
			const depth = values.depth === undefined ? undefined : Number(values.depth);
			const maxBytes = values['max-bytes'] === undefined ? undefined : Number(values['max-bytes']);
			if (depth !== undefined && !(Number.isInteger(depth) && depth >= 0))
				return { usage: LOOK_USAGE, error: `invalid --depth ${values.depth}` };
			if (maxBytes !== undefined && !(maxBytes > 0))
				return { usage: LOOK_USAGE, error: `invalid --max-bytes ${values['max-bytes']}` };
			return {
				...base,
				kind,
				args: { selector: selector ?? 'body', depth, maxBytes },
				format: (d) => formatDom(d as DomResult),
			};
		}
		case 'styles': {
			if (!selector) return { usage: LOOK_USAGE, error: 'look styles needs a selector' };
			const props = values.props
				?.split(',')
				.map((p) => p.trim())
				.filter(Boolean);
			return {
				...base,
				kind,
				args: { selector, props, all: values.all, pseudo: values.pseudo },
				format: (d) => formatStyles(d as StylesResult),
			};
		}
		case 'shot': {
			const scale = values.scale === undefined ? undefined : Number(values.scale);
			if (scale !== undefined && !(scale > 0 && scale <= 4))
				return { usage: LOOK_USAGE, error: `invalid --scale ${values.scale}` };
			const out = values.out;
			return {
				...base,
				timeoutMs: seconds === undefined ? SHOT_TIMEOUT_MS : base.timeoutMs,
				kind,
				args: { selector, scale },
				format: (d) => formatShot(d as SavedShot),
				finish: (d, io) => saveShot(d as ShotResult, io, out),
			};
		}
		default:
			return { usage: LOOK_USAGE, error: kind ? `unknown look "${kind}"` : undefined };
	}
}

export async function runLook(argv: string[], io: LookIo): Promise<number> {
	const command = parseLook(argv);
	if ('usage' in command) {
		if (command.error) {
			io.stderr(`${command.error}\n\n${command.usage}`);
			return EXIT.usage;
		}
		io.stdout(command.usage);
		return EXIT.ok;
	}
	const result = await look(io, command.kind, command.args, command.timeoutMs);
	if ('code' in result) {
		io.stderr(`yubi look: ${result.message}\n`);
		return result.code;
	}
	const data = command.finish ? command.finish(result.data, io) : result.data;
	if (
		typeof data === 'object' &&
		data !== null &&
		typeof (data as { error?: unknown }).error === 'string'
	) {
		io.stderr(
			command.json
				? `${JSON.stringify(data, null, '\t')}\n`
				: `yubi look: ${command.format(data)}\n`,
		);
		return EXIT.failed;
	}
	io.stdout(command.json ? `${JSON.stringify(data, null, '\t')}\n` : `${command.format(data)}\n`);
	return EXIT.ok;
}
