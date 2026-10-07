import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { parseArgs } from 'node:util';
import { type DevState, readDevState, STATE_DIR, STATE_FILE } from './dev.ts';
import { DEFAULT_LOOK_TIMEOUT } from './look.ts';
import type { PageInfo } from './picker/look.ts';

export const LOOK_USAGE = `Usage: yubi look <what> [selector] [options]

Asks the browser that has the app open in the yubisashi pane what it shows right now. Needs a
\`yubi dev\` started from this directory (it leaves ${STATE_DIR}/${STATE_FILE} behind) and the user's
consent (the pane's "Let the agent look" switch).

  page                    route, title, viewport, scroll, device pixel ratio, focused element

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

export type LookCommand = {
	kind: string;
	args: Record<string, unknown>;
	json: boolean;
	timeoutMs: number;
	format: (data: unknown) => string;
};

export function parseLook(argv: string[]): LookCommand | { usage: string; error?: string } {
	const spec = {
		options: {
			json: { type: 'boolean', default: false },
			timeout: { type: 'string' },
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
	io.stdout(
		command.json
			? `${JSON.stringify(result.data, null, '\t')}\n`
			: `${command.format(result.data)}\n`,
	);
	return EXIT.ok;
}
