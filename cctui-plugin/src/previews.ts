import { originOf } from './protocol.ts';

/** A dev server published through the cctui preview tunnel. */
export type Preview = { id: string; port: number; url: string; opened_at: string };

type Fetch = typeof fetch;

const same = (fetchImpl?: Fetch): Fetch => fetchImpl ?? ((input, init) => fetch(input, init));

async function json<T>(res: Response, what: string): Promise<T> {
	if (!res.ok) throw new Error(`${what}: ${res.status}`);
	return (await res.json()) as T;
}

export async function listPreviews(sessionId: string, fetchImpl?: Fetch): Promise<Preview[]> {
	const res = await same(fetchImpl)(`/api/v1/sessions/${encodeURIComponent(sessionId)}/previews`, {
		credentials: 'same-origin',
	});
	return json<Preview[]>(res, 'previews');
}

/** The `/__cctui/auth` URL that logs the iframe into `preview` with a fresh single-use ticket. */
export async function authUrl(
	sessionId: string,
	preview: Preview,
	fetchImpl?: Fetch,
): Promise<string> {
	const res = await same(fetchImpl)(
		`/api/v1/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(preview.id)}/ticket`,
		{ method: 'POST', credentials: 'same-origin' },
	);
	const { ticket } = await json<{ ticket: string }>(res, 'ticket');
	return `${originOf(preview.url)}/__cctui/auth?ticket=${encodeURIComponent(ticket)}`;
}

export function newest(previews: Preview[]): Preview | null {
	let best: Preview | null = null;
	for (const p of previews) if (!best || p.opened_at > best.opened_at) best = p;
	return best;
}

/** The preview a `yubisashi: <url>` line refers to (same origin), if listed. */
export function matchPreview(previews: Preview[], url: string): Preview | null {
	const origin = originOf(url);
	return (origin && previews.find((p) => originOf(p.url) === origin)) || null;
}
