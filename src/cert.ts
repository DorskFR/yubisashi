import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Cert = { key: Buffer; cert: Buffer; file: string; tool: 'mkcert' | 'openssl' };

export const cacheDir = (env: NodeJS.ProcessEnv = process.env) =>
	join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'yubisashi');

/** Names a certificate served on `address` may carry: only that address, so no client learns the others. */
export function namesFor(address: string): string[] {
	const a = address.replace(/^::ffff:/, '');
	return a === '127.0.0.1' || a === '::1' ? ['localhost', '127.0.0.1'] : [a];
}

const isIp = (host: string) => /^\d+\.\d+\.\d+\.\d+$/.test(host);

function available(bin: string, probe: string) {
	try {
		execFileSync(bin, [probe], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

/** Self-signed certificate for `hosts`, cached under `dir`; mkcert when installed, else openssl. */
export function ensureCert(hosts: string[], dir = cacheDir()): Cert {
	const names = [...new Set(hosts)].sort();
	const tool = available('mkcert', '-version') ? 'mkcert' : 'openssl';
	const id = createHash('sha256')
		.update(`${tool}\n${names.join('\n')}`)
		.digest('hex')
		.slice(0, 12);
	const keyFile = join(dir, `${id}-key.pem`);
	const certFile = join(dir, `${id}-cert.pem`);
	if (!existsSync(keyFile) || !existsSync(certFile)) {
		mkdirSync(dir, { recursive: true });
		if (tool === 'mkcert')
			execFileSync('mkcert', ['-key-file', keyFile, '-cert-file', certFile, ...names], {
				stdio: 'ignore',
			});
		else if (available('openssl', 'version')) {
			const san = names.map((h) => (isIp(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
			execFileSync(
				'openssl',
				['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825']
					.concat(['-subj', '/CN=yubisashi dev', '-addext', `subjectAltName=${san}`])
					.concat(['-keyout', keyFile, '-out', certFile]),
				{ stdio: 'ignore' },
			);
		} else throw new Error('yubisashi: neither mkcert nor openssl found; use --http');
	}
	return { key: readFileSync(keyFile), cert: readFileSync(certFile), file: certFile, tool };
}
