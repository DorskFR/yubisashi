import { originOf } from './protocol.ts';

/** A dev server published through the cctui preview tunnel. */
export type Preview = { id: string; port: number; url: string; opened_at: string };

/** The server sends `openedAt`; older builds sent `opened_at`. */
type RawPreview = Omit<Preview, 'opened_at'> & { openedAt?: string; opened_at?: string };

export function normalizePreview({ openedAt, opened_at, ...rest }: RawPreview): Preview {
	return { ...rest, opened_at: openedAt ?? opened_at ?? '' };
}

/** The server's verbatim refusal when `CCTUI_PREVIEW_HOST` is unset. */
export const PREVIEWS_DISABLED = 'previews are disabled on this instance';

type Fetch = typeof fetch;

const same = (fetchImpl?: Fetch): Fetch => fetchImpl ?? ((input, init) => fetch(input, init));

/** A failed preview call, carrying the server's own message rather than a bare status. */
export class PreviewApiError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'PreviewApiError';
	}

	/** Previews are off instance-wide: no amount of waiting will produce one. */
	get disabled(): boolean {
		return this.message.includes(PREVIEWS_DISABLED);
	}
}

/** Whether an unknown thrown value is the instance-wide refusal. */
export function previewsDisabled(err: unknown): boolean {
	return err instanceof PreviewApiError && err.disabled;
}

async function json<T>(res: Response, what: string): Promise<T> {
	if (!res.ok) {
		let message = `${what}: ${res.status}`;
		try {
			const detail = ((await res.json()) as { error?: unknown }).error;
			if (typeof detail === 'string' && detail) message = detail;
		} catch {
			// A non-JSON body leaves the status as the only thing worth saying.
		}
		throw new PreviewApiError(res.status, message);
	}
	return (await res.json()) as T;
}

export async function listPreviews(sessionId: string, fetchImpl?: Fetch): Promise<Preview[]> {
	const res = await same(fetchImpl)(`/api/v1/sessions/${encodeURIComponent(sessionId)}/previews`, {
		credentials: 'same-origin',
	});
	return (await json<RawPreview[]>(res, 'previews')).map(normalizePreview);
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
