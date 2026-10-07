#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolveCctui, startDev } from './dev.ts';
import { parentOrigins } from './frame.ts';
import { runLook } from './look-cli.ts';

const USAGE = `Usage: yubi dev [options] [-- <dev command>]
       yubi look <what> [selector] [options]     (yubi look --help)

Runs <dev command> (e.g. "npm run dev") and serves it through a proxy that the yubisashi pane
at --parent-origin may frame; the picker is injected into every page.

Under cctui (cctui-daemon on PATH and a session id from --session or CCTUI_SESSION_ID) the
proxy listens on loopback over
plain HTTP and is published as a cctui preview of the session: the printed URL is the cctui one,
--parent-origin defaults to CCTUI_WEB_ORIGIN and the TLS options are ignored.

Options:
  --target URL           dev server URL (default: first localhost URL the command prints,
                         else http://localhost:5173)
  --port N               proxy port (default 4780)
  --host H               bind address, or YUBI_HOST (default 127.0.0.1: this machine only).
                         Set an interface address to let another device reach it.
  --advertise NAME       host name or address printed in the URLs, or YUBI_ADVERTISE
                         (default: the bind address)
  --cert FILE --key FILE PEM certificate and key to serve, or YUBI_TLS_CERT / YUBI_TLS_KEY.
                         Default: a self-signed certificate naming only the address the
                         browser connected to (mkcert's CA when mkcert is installed).
  --parent-origin O      origin allowed to frame the app; repeatable, or YUBI_PARENT_ORIGIN
                         (comma-separated). Required.
  --http                 plain HTTP instead of HTTPS
  --session ID           cctui session to publish the preview to, when CCTUI_SESSION_ID is
                         not in the environment
  --no-cctui             serve locally even when running under cctui
  --look-timeout S       seconds a \`yubi look\` request waits for the browser (default 15)
  --no-look              no look channel: \`yubi look\` cannot reach this proxy
  -h, --help
`;

function fail(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(2);
}

async function main(argv: string[]) {
	if (argv[0] === 'look') {
		const code = await runLook(argv.slice(1), {
			cwd: process.cwd(),
			stdout: (t) => process.stdout.write(t),
			stderr: (t) => process.stderr.write(t),
		});
		process.exitCode = code;
		return;
	}
	const dash = argv.indexOf('--');
	const own = dash === -1 ? argv : argv.slice(0, dash);
	const command = dash === -1 ? [] : argv.slice(dash + 1);
	let parsed: ReturnType<typeof parseArgs<typeof spec>>;
	const spec = {
		options: {
			target: { type: 'string' },
			port: { type: 'string', default: '4780' },
			host: { type: 'string' },
			advertise: { type: 'string' },
			cert: { type: 'string' },
			key: { type: 'string' },
			'parent-origin': { type: 'string', multiple: true },
			http: { type: 'boolean', default: false },
			session: { type: 'string' },
			'no-cctui': { type: 'boolean', default: false },
			'look-timeout': { type: 'string' },
			'no-look': { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
		allowPositionals: true,
	} as const;
	try {
		parsed = parseArgs({ args: own, ...spec });
	} catch (err) {
		fail(`${(err as Error).message}\n\n${USAGE}`);
	}
	const { values, positionals } = parsed;
	if (values.help) {
		process.stdout.write(USAGE);
		return;
	}
	if (positionals[0] !== 'dev' || positionals.length !== 1) fail(USAGE);
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid --port ${values.port}`);
	const lookTimeout =
		values['look-timeout'] === undefined ? undefined : Number(values['look-timeout']);
	if (lookTimeout !== undefined && !(lookTimeout > 0))
		fail(`invalid --look-timeout ${values['look-timeout']}`);
	const env = process.env;
	const cctui = resolveCctui({
		session: values.session,
		noCctui: values['no-cctui'],
		env,
	});
	const originArgs =
		values['parent-origin'] ?? env.YUBI_PARENT_ORIGIN ?? (cctui ? env.CCTUI_WEB_ORIGIN : undefined);
	let origins: string[];
	try {
		origins = parentOrigins(originArgs);
	} catch (err) {
		fail(`invalid --parent-origin: ${(err as Error).message}`);
	}
	if (!origins.length) fail(`--parent-origin (or YUBI_PARENT_ORIGIN) is required\n\n${USAGE}`);

	const host = cctui ? '127.0.0.1' : values.host || env.YUBI_HOST || '127.0.0.1';
	const advertise = values.advertise || env.YUBI_ADVERTISE || undefined;
	const https = !values.http && !cctui;
	const certFile = https ? values.cert || env.YUBI_TLS_CERT : undefined;
	const keyFile = https ? values.key || env.YUBI_TLS_KEY : undefined;
	if (!certFile !== !keyFile)
		fail('--cert and --key (or YUBI_TLS_CERT and YUBI_TLS_KEY) go together');
	let tls: { cert: Buffer; key: Buffer } | undefined;
	if (certFile && keyFile) {
		try {
			tls = { cert: readFileSync(certFile), key: readFileSync(keyFile) };
		} catch (err) {
			fail(`cannot read the certificate: ${(err as Error).message}`);
		}
	}

	const log = (line: string) => process.stderr.write(`${line}\n`);
	if (values.http && !['127.0.0.1', '::1', 'localhost'].includes(host))
		log(
			`yubisashi: warning: serving plain HTTP on ${host}; anyone on that network can read the traffic`,
		);
	const handle = await startDev({
		command,
		target: values.target,
		port,
		host,
		advertise,
		tls,
		origins,
		https,
		cctui,
		lookTimeout,
		noLook: values['no-look'],
		log,
	}).catch((err: Error) => fail(err.message));

	for (const url of handle.urls) process.stdout.write(`yubisashi: ${url}\n`);
	log(`yubisashi: framing allowed from ${origins.join(', ')}`);
	if (cctui) log(`yubisashi: published as a cctui preview of session ${cctui.sessionId}`);
	if (!values['no-look']) log('yubisashi: `yubi look` can reach this proxy from this directory');
	if (https && !tls)
		log(
			'yubisashi: the certificate is self-signed; open one of the URLs above in a browser tab and accept it once, then the yubisashi pane can frame it',
		);

	const stop = (code: number) => {
		void handle.close().then(() => process.exit(code));
	};
	process.on('SIGINT', () => stop(130));
	process.on('SIGTERM', () => stop(143));
	process.on('SIGHUP', () => stop(129));
	handle.child?.on('exit', (code) => process.exit(code ?? 1));
}

void main(process.argv.slice(2));
