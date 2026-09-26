import { originOf } from './protocol.ts';

export const URL_KEY_PREFIX = 'cctui_yubi_url';

export const urlKey = (machineId: string, workingDir: string) =>
	`${URL_KEY_PREFIX}:${machineId}:${workingDir}`;

const storage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage);

export function rememberedUrl(machineId: string, workingDir: string): string {
	return storage()?.getItem(urlKey(machineId, workingDir)) ?? '';
}

export function rememberUrl(machineId: string, workingDir: string, url: string) {
	const key = urlKey(machineId, workingDir);
	if (url) storage()?.setItem(key, url);
	else storage()?.removeItem(key);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalhostUrl(url: string): boolean {
	try {
		return LOCAL_HOSTS.has(new URL(url).hostname);
	} catch {
		return false;
	}
}

/** A plain-http app framed from an https page is blocked as mixed content,
 *  except on loopback which browsers treat as potentially trustworthy. */
export function isMixedContent(url: string, pageProtocol: string): boolean {
	if (pageProtocol !== 'https:') return false;
	const o = originOf(url);
	return !!o?.startsWith('http:') && !isLocalhostUrl(url);
}

/** Turn what the user typed into a frameable URL: bare hosts get http://. */
export function normalizeUrl(raw: string): string {
	const s = raw.trim();
	if (!s) return '';
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`;
	return originOf(withScheme) ? withScheme : '';
}

export type PaneStatus = 'idle' | 'loading' | 'waiting' | 'connected';
