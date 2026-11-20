import { parseArgs } from 'node:util';
import { STATE_DIR, STATE_FILE } from './dev.ts';
import { DEFAULT_LOOK_TIMEOUT } from './look.ts';
import { EXIT, formatPage, type LookIo, look } from './look-cli.ts';
import type { GoResult } from './picker/go.ts';
import type { PageInfo } from './picker/look.ts';
import { DEFAULT_SHOW_TTL_S, type ShowResult } from './picker/show.ts';

export const GO_USAGE = `Usage: yubi go <path|url> [--scroll SELECTOR] [options]
       yubi go back | forward | reload

Moves the app the user has open in the yubisashi pane to another route of the same origin,
through the app's client router when it has one, waits for the page to settle and prints the
same summary as \`yubi look page\`. Needs a \`yubi dev\` started from this directory (it leaves
${STATE_DIR}/${STATE_FILE} behind) and the pane's "Let the agent look" switch. Refused while the user is
typing in a field.

  --scroll SELECTOR       scroll that element into view once the page has settled
  --json                  raw JSON instead of text
  --timeout S             seconds to wait for the browser (default ${DEFAULT_LOOK_TIMEOUT / 1000})
  -h, --help
`;

export const SHOW_USAGE = `Usage: yubi show <selector> [--label TEXT] [--ttl S] [--all] [options]
       yubi show --clear

Highlights an element in the user's tab, numbered so you can refer to it ("see 2"). Calls
stack; each highlight follows its element, goes away after --ttl, on --clear or when the user
clicks it, and is listed in the pane as "Agent showed".

  --label TEXT            text on the highlight's tag (default: the element's selector)
  --ttl S                 seconds before it goes away (default ${DEFAULT_SHOW_TTL_S}; 0 keeps it)
  --all                   every match instead of the first
  --clear                 remove every highlight
  --json                  raw JSON instead of text
  --timeout S             seconds to wait for the browser (default ${DEFAULT_LOOK_TIMEOUT / 1000})
  -h, --help
`;

const REFUSED =
	'the user has turned "Let the agent look" off, which also covers go and show: do not retry; ask the user';

type Failure = { code: number; message: string };

const isFailure = (r: unknown): r is Failure =>
	typeof r === 'object' && r !== null && 'code' in r && 'message' in r;

function errorOf(data: unknown): string | null {
	if (typeof data !== 'object' || data === null) return null;
	const error = (data as { error?: unknown }).error;
	return typeof error === 'string' ? error : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function timeoutOf(raw: string | undefined): number | string {
	if (raw === undefined) return DEFAULT_LOOK_TIMEOUT;
	const seconds = Number(raw);
	return seconds > 0 ? seconds * 1000 : `invalid --timeout ${raw}`;
}

async function ask(io: LookIo, kind: string, args: Record<string, unknown>, timeoutMs: number) {
	const result = await look(io, kind, args, timeoutMs);
	if ('code' in result)
		return result.code === EXIT.refused ? { code: EXIT.refused, message: REFUSED } : result;
	const error = errorOf(result.data);
	return error === null ? { data: result.data } : { code: EXIT.failed, message: error };
}

/** After a full page load the old document has answered; wait for the new one to connect. */
async function nextPage(io: LookIo, old: string | undefined, deadline: number) {
	for (;;) {
		const left = deadline - Date.now();
		if (left <= 0)
			return { code: EXIT.timeout, message: 'the new page did not connect to the proxy in time' };
		const reply = await look(io, 'page', {}, Math.min(left, 3000));
		if ('data' in reply) {
			const info = reply.data as PageInfo;
			if (info.instance === undefined || info.instance !== old) return { data: info };
		} else if (reply.code !== EXIT.noBrowser && reply.code !== EXIT.timeout) return reply;
		await sleep(250);
	}
}

export type GoOutput = { from: string; page: PageInfo; scrolled?: string; scrollError?: string };

export function formatGo(out: GoOutput): string {
	const lines = [`navigated ${out.from} → ${out.page.route}`, formatPage(out.page)];
	if (out.scrolled) lines.push(`scrolled ${out.scrolled}`);
	if (out.scrollError) lines.push(`warning: ${out.scrollError}`);
	return lines.join('\n');
}

export async function go(
	io: LookIo,
	args: { to?: string; action?: string; scroll?: string },
	timeoutMs: number,
	retried = false,
): Promise<GoOutput | Failure> {
	const deadline = Date.now() + timeoutMs;
	const first = await ask(io, 'go', args, timeoutMs);
	if (isFailure(first)) return first;
	const result = first.data as GoResult;
	if ('error' in result) return { code: EXIT.failed, message: result.error };
	if (!('full' in result)) return { from: result.page.route, ...result };
	if (!result.full) return result;
	const landed = await nextPage(io, result.instance, deadline);
	if (isFailure(landed)) return landed;
	// Something else replaced the page mid-navigation (a dev-server reload): ask the new one.
	if (args.to && !retried && landed.data.route !== result.to) {
		const again = await go(io, args, Math.max(1000, deadline - Date.now()), true);
		return isFailure(again) ? again : { ...again, from: result.from };
	}
	const out: GoOutput = { from: result.from, page: landed.data };
	if (!args.scroll) return out;
	const left = Math.max(1000, deadline - Date.now());
	const scrolled = await ask(io, 'go', { scroll: args.scroll }, left);
	if (isFailure(scrolled)) return { ...out, scrollError: scrolled.message };
	const data = scrolled.data as { scrolled: string; page: PageInfo };
	return { ...out, page: data.page, scrolled: data.scrolled };
}

export async function runGo(argv: string[], io: LookIo): Promise<number> {
	let parsed: ReturnType<typeof parseGo>;
	try {
		parsed = parseGo(argv);
	} catch (err) {
		io.stderr(`${(err as Error).message}\n\n${GO_USAGE}`);
		return EXIT.usage;
	}
	if (parsed.help) {
		io.stdout(GO_USAGE);
		return EXIT.ok;
	}
	const out = await go(io, parsed.args, parsed.timeoutMs);
	if (isFailure(out)) {
		io.stderr(`yubi go: ${out.message}\n`);
		return out.code;
	}
	io.stdout(parsed.json ? `${JSON.stringify(out, null, '\t')}\n` : `${formatGo(out)}\n`);
	return EXIT.ok;
}

export function parseGo(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			scroll: { type: 'string' },
			json: { type: 'boolean', default: false },
			timeout: { type: 'string' },
			help: { type: 'boolean', short: 'h', default: false },
		},
		allowPositionals: true,
	});
	const timeoutMs = timeoutOf(values.timeout);
	if (typeof timeoutMs === 'string') throw new Error(timeoutMs);
	const base = { help: values.help, json: values.json, timeoutMs };
	if (values.help) return { ...base, args: {} };
	const [where, extra] = positionals;
	if (!where) throw new Error('yubi go needs a path, a URL, back, forward or reload');
	if (extra !== undefined) throw new Error(`unexpected argument "${extra}"`);
	const scroll = values.scroll || undefined;
	if (where === 'back' || where === 'forward' || where === 'reload')
		return { ...base, args: { action: where, scroll } };
	return { ...base, args: { to: where, scroll } };
}

export function formatShow(result: ShowResult): string {
	if ('cleared' in result)
		return `cleared ${result.cleared} highlight${result.cleared === 1 ? '' : 's'}`;
	if ('error' in result) return result.error;
	const lines = result.shown.map((s) => {
		const label = s.label !== s.selector ? `"${s.label}"` : '';
		return [String(s.n).padEnd(3), s.selector, s.source ?? '', label].filter(Boolean).join('  ');
	});
	const of = result.matches === 1 ? '1 match' : `${result.matches} matches`;
	const how = result.ttl > 0 ? `for ${result.ttl}s` : 'until cleared';
	lines.push(`showing ${result.shown.length} of ${of} ${how}`);
	return lines.join('\n');
}

export function parseShow(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			label: { type: 'string' },
			ttl: { type: 'string' },
			all: { type: 'boolean', default: false },
			clear: { type: 'boolean', default: false },
			json: { type: 'boolean', default: false },
			timeout: { type: 'string' },
			help: { type: 'boolean', short: 'h', default: false },
		},
		allowPositionals: true,
	});
	const timeoutMs = timeoutOf(values.timeout);
	if (typeof timeoutMs === 'string') throw new Error(timeoutMs);
	const base = { help: values.help, json: values.json, timeoutMs };
	if (values.help) return { ...base, args: {} };
	const [selector, extra] = positionals;
	if (extra !== undefined) throw new Error(`unexpected argument "${extra}"`);
	if (values.clear) {
		if (selector !== undefined) throw new Error('show --clear takes no selector');
		return { ...base, args: { clear: true } };
	}
	if (!selector) throw new Error('yubi show needs a selector (or --clear)');
	const ttl = values.ttl === undefined ? undefined : Number(values.ttl);
	if (ttl !== undefined && !(ttl >= 0)) throw new Error(`invalid --ttl ${values.ttl}`);
	return { ...base, args: { selector, label: values.label, ttl, all: values.all } };
}

export async function runShow(argv: string[], io: LookIo): Promise<number> {
	let parsed: ReturnType<typeof parseShow>;
	try {
		parsed = parseShow(argv);
	} catch (err) {
		io.stderr(`${(err as Error).message}\n\n${SHOW_USAGE}`);
		return EXIT.usage;
	}
	if (parsed.help) {
		io.stdout(SHOW_USAGE);
		return EXIT.ok;
	}
	const reply = await look(io, 'show', parsed.args, parsed.timeoutMs);
	if ('code' in reply) {
		io.stderr(`yubi show: ${reply.code === EXIT.refused ? REFUSED : reply.message}\n`);
		return reply.code;
	}
	const result = reply.data as ShowResult;
	const text = parsed.json ? JSON.stringify(result, null, '\t') : formatShow(result);
	if ('error' in result) {
		const matches = result.matches.count
			? `\n${result.matches.count} matches, first: ${result.matches.first.join(', ')}`
			: '';
		io.stderr(parsed.json ? `${text}\n` : `yubi show: ${text}${matches}\n`);
		return EXIT.failed;
	}
	io.stdout(`${text}\n`);
	return EXIT.ok;
}
