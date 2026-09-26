import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	root,
	plugins: [svelte({ configFile: false })],
	resolve: { conditions: ['browser'] },
	test: { include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'], testTimeout: 60_000 },
});
