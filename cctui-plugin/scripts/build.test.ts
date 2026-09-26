import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPlugin, FOLDER, OUT } from './build.ts';

const ID_RE = /^[a-z0-9-]{1,40}$/;
const version = (
	JSON.parse(readFileSync(join(OUT, '../package.json'), 'utf8')) as { version: string }
).version;

let bundle = '';

beforeAll(async () => {
	await buildPlugin();
	bundle = readFileSync(join(FOLDER, 'web/index.js'), 'utf8');
});

describe('dist-cctui', () => {
	it('lays out plugin.json, web/index.js, the skill and a tarball', () => {
		expect(existsSync(join(FOLDER, 'plugin.json'))).toBe(true);
		expect(existsSync(join(FOLDER, 'web/index.js'))).toBe(true);
		expect(existsSync(join(FOLDER, 'skills/yubisashi/SKILL.md'))).toBe(true);
		const listing = execFileSync('tar', ['-tzf', join(OUT, `yubisashi-${version}.tgz`)], {
			encoding: 'utf8',
		});
		expect(listing).toContain('yubisashi/plugin.json');
		expect(listing).toContain('yubisashi/web/index.js');
		expect(listing).toContain('yubisashi/skills/yubisashi/SKILL.md');
	});

	it('writes a valid plugin.json', () => {
		const m = JSON.parse(readFileSync(join(FOLDER, 'plugin.json'), 'utf8'));
		expect(m.id).toMatch(ID_RE);
		expect(m.id).toBe('yubisashi');
		expect(m.name).toBe('yubisashi');
		expect(m.version).toBe(version);
		expect(m.cctuiApi).toBe(1);
		expect(m.web).toBe('web/index.js');
		expect(m.skills).toEqual(['yubisashi']);
		expect(m).not.toHaveProperty('settings');
	});

	it('leaves svelte and tsumikit to the host runtime', () => {
		const imports = [...bundle.matchAll(/^import\b.*?from\s*["']([^"']+)["'];?$/gm)].map(
			(m) => m[1],
		);
		expect(imports.length).toBeGreaterThan(0);
		for (const spec of imports) expect(spec).toMatch(/^\/plugin-runtime\/[a-z-]+\.js$/);
		expect(bundle).not.toMatch(/from\s*["']svelte(\/|["'])/);
		expect(bundle).not.toMatch(/from\s*["']@dorsk\/tsumikit["']/);
		expect(bundle).not.toContain('svelte/internal/client');
		expect(bundle).toContain('/plugin-runtime/svelte-internal-client.js');
		expect(bundle).toContain('/plugin-runtime/tsumikit.js');
		expect(statSync(join(FOLDER, 'web/index.js')).size).toBeLessThan(80_000);
	});
});
