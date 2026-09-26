import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { cctuiPluginConfig } from '../sdk/vite.ts';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(plugin, '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };

export const PLUGIN_ID = 'yubisashi';
export const OUT = join(repo, 'dist-cctui');
export const FOLDER = join(OUT, PLUGIN_ID);

export const manifest = (version: string) => ({
	id: PLUGIN_ID,
	name: 'Review',
	description:
		'Frames your running dev app next to the conversation. Point at an element and its source location lands in the composer, ready for your comment.',
	version,
	cctuiApi: 1,
	icon: 'eye',
	web: 'web/index.js',
	skills: [PLUGIN_ID],
	settings: [
		{ key: 'host', label: 'Bind address', env: 'YUBI_HOST', type: 'string' },
		{ key: 'advertise', label: 'Advertised host name', env: 'YUBI_ADVERTISE', type: 'string' },
		{
			key: 'tlsCert',
			label: 'TLS certificate path (on the session machine)',
			env: 'YUBI_TLS_CERT',
			type: 'string',
		},
		{
			key: 'tlsKey',
			label: 'TLS key path (on the session machine)',
			env: 'YUBI_TLS_KEY',
			type: 'string',
		},
	],
});

export async function buildPlugin(): Promise<{ folder: string; tarball: string }> {
	rmSync(OUT, { recursive: true, force: true });
	mkdirSync(FOLDER, { recursive: true });
	await build({
		configFile: false,
		root: plugin,
		logLevel: 'warn',
		...cctuiPluginConfig({ entry: join(plugin, 'src/index.ts'), outDir: join(FOLDER, 'web') }),
	});
	writeFileSync(
		join(FOLDER, 'plugin.json'),
		`${JSON.stringify(manifest(pkg.version), null, '\t')}\n`,
	);
	cpSync(join(repo, 'skill'), join(FOLDER, 'skills', PLUGIN_ID), { recursive: true });
	const tarball = join(OUT, `${PLUGIN_ID}-${pkg.version}.tgz`);
	execFileSync('tar', ['-czf', tarball, '-C', OUT, PLUGIN_ID]);
	return { folder: FOLDER, tarball };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { folder, tarball } = await buildPlugin();
	console.log(`cctui plugin: ${folder}\n${tarball}`);
}
