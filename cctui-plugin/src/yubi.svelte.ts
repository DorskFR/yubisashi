import type { ComposerBridge, PluginSession } from '../sdk/types.ts';
import { formatContextBlock } from './context.logic.ts';
import { authUrl, listPreviews, matchPreview, newest, type Preview } from './previews.ts';
import {
	isTrustedEvent,
	originOf,
	type ParentPayload,
	type Pin,
	parseChildMessage,
	type Selected,
	YUBI,
} from './protocol.ts';

export type PaneStatus = 'idle' | 'loading' | 'waiting' | 'connected';
export type BootStatus = 'idle' | 'pending' | 'timeout';

export const START_PROMPT = 'start a yubisashi server now';
export const START_POLL_MS = 2_000;
export const START_TIMEOUT_MS = 180_000;

/** The path (with query and hash) a typed address means inside the framed app. Any origin
 *  is dropped so the frame stays on the preview; non-http schemes yield `null`. */
export function relativePath(input: string): string | null {
	const text = input.trim();
	if (!text) return '/';
	let url: URL;
	try {
		url = new URL(text, 'http://yubi.invalid');
	} catch {
		return null;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	return url.pathname + url.search + url.hash;
}

/** Whether opening the pane should ask the agent to start a server: only when the host can
 *  send, nothing is framed yet, this pane never asked, and no request is pending. */
export function shouldAutoStart(input: {
	previews: number;
	error: string;
	canSend: boolean;
	sent: boolean;
	boot: BootStatus;
}): boolean {
	return (
		input.canSend && !input.error && input.previews === 0 && !input.sent && input.boot !== 'pending'
	);
}

/** State of one yubisashi pane: the session's cctui previews, the framed one,
 *  the picker handshake, and the pins for every block dropped into the composer
 *  since the pane opened. */
export class YubiController {
	previews = $state<Preview[]>([]);
	selected = $state<Preview | null>(null);
	/** Iframe src: the preview's `/__cctui/auth` URL carrying a fresh ticket. */
	url = $state('');
	error = $state('');
	refreshing = $state(false);
	status = $state<PaneStatus>('idle');
	picking = $state(false);
	route = $state('');
	pins = $state<Pin[]>([]);
	/** Bumped to remount the iframe (reload). */
	epoch = $state(0);
	/** Progress of the "start a server" request sent to the agent on open. */
	boot = $state<BootStatus>('idle');
	frame: HTMLIFrameElement | null = null;
	private sent = false;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly session: PluginSession;
	private readonly composer: ComposerBridge;

	constructor(session: PluginSession, composer: ComposerBridge) {
		this.session = session;
		this.composer = composer;
	}

	get origin(): string | null {
		return this.selected ? originOf(this.selected.url) : null;
	}

	get canSend(): boolean {
		return typeof this.composer.send === 'function';
	}

	/** Pane opened: frame what exists, else (once) ask the agent to start a server. */
	async open(wanted = '') {
		await this.refresh(wanted);
		const input = {
			previews: this.previews.length,
			error: this.error,
			canSend: this.canSend,
			sent: this.sent,
			boot: this.boot,
		};
		if (shouldAutoStart(input)) this.startServer();
	}

	/** Send the start prompt and poll for a preview until one appears or the timeout passes. */
	startServer() {
		if (!this.canSend || this.boot === 'pending') return;
		this.composer.send?.(START_PROMPT);
		this.sent = true;
		this.boot = 'pending';
		this.error = '';
		const deadline = Date.now() + START_TIMEOUT_MS;
		const tick = async () => {
			this.pollTimer = null;
			if (this.boot !== 'pending') return;
			try {
				this.previews = await listPreviews(this.session.id);
			} catch {
				this.previews = [];
			}
			if (this.boot !== 'pending') return;
			const next = newest(this.previews);
			if (next) {
				this.boot = 'idle';
				await this.select(next.id);
				return;
			}
			if (Date.now() >= deadline) {
				this.boot = 'timeout';
				return;
			}
			this.pollTimer = setTimeout(tick, START_POLL_MS);
		};
		this.pollTimer = setTimeout(tick, START_POLL_MS);
	}

	/** Stop polling when the pane unmounts. */
	destroy() {
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.pollTimer = null;
		if (this.boot === 'pending') this.boot = 'idle';
	}

	/** Reload the preview list; frame `wanted` (a `yubisashi:` URL) when listed, else keep the
	 *  current preview, else the newest. */
	async refresh(wanted = '') {
		this.refreshing = true;
		this.error = '';
		try {
			this.previews = await listPreviews(this.session.id);
		} catch (err) {
			this.error = (err as Error).message;
			this.refreshing = false;
			return;
		}
		this.refreshing = false;
		const byUrl = wanted ? matchPreview(this.previews, wanted) : null;
		const current = this.selected && this.previews.find((p) => p.id === this.selected?.id);
		const next = byUrl ?? current ?? newest(this.previews);
		if (next && next.id !== this.selected?.id) await this.select(next.id);
		else if (!next) this.clear();
	}

	async select(id: string) {
		const preview = this.previews.find((p) => p.id === id);
		if (!preview) return;
		this.selected = preview;
		await this.frameSelected();
	}

	/** Re-list the previews, then frame the selected one again through a fresh ticket. */
	async reload() {
		await this.refresh();
		if (this.selected) await this.frameSelected();
	}

	/** Point the framed app at `input`, kept on the preview's origin. */
	navigate(input: string) {
		const origin = this.origin;
		const path = relativePath(input);
		const win = this.frame?.contentWindow;
		if (!origin || !win || path === null) return;
		this.picking = false;
		this.route = path;
		win.location.assign(origin + path);
	}

	/** A fresh authenticated URL of the selected preview, for a new tab. */
	async tabUrl(): Promise<string | null> {
		if (!this.selected) return null;
		try {
			return await authUrl(this.session.id, this.selected);
		} catch (err) {
			this.error = (err as Error).message;
			return null;
		}
	}

	private async frameSelected() {
		const preview = this.selected;
		if (!preview) return;
		this.picking = false;
		this.status = 'loading';
		this.error = '';
		try {
			const url = await authUrl(this.session.id, preview);
			if (this.selected?.id !== preview.id) return;
			this.url = url;
			this.epoch++;
		} catch (err) {
			this.error = (err as Error).message;
			this.status = 'idle';
		}
	}

	private clear() {
		this.selected = null;
		this.url = '';
		this.picking = false;
		this.status = 'idle';
	}

	onFrameLoad() {
		if (this.status === 'loading') this.status = 'waiting';
		if (this.pins.length) this.post({ type: 'pins:set', pins: this.pins });
	}

	post(msg: ParentPayload) {
		const origin = this.origin;
		const win = this.frame?.contentWindow;
		if (!origin || !win) return;
		win.postMessage($state.snapshot({ ...msg, yubi: YUBI }), origin);
	}

	togglePick() {
		if (this.status !== 'connected') return;
		this.post({ type: this.picking ? 'pick:stop' : 'pick:start' });
	}

	onMessage(e: MessageEvent) {
		if (!isTrustedEvent(e, this.frame, this.origin)) return;
		const msg = parseChildMessage(e.data);
		if (!msg) return;
		this.status = 'connected';
		switch (msg.type) {
			case 'pick:state':
				this.picking = msg.picking;
				break;
			case 'route':
				this.route = msg.route;
				break;
			case 'pick:cancel':
				this.picking = false;
				break;
			case 'pin:open':
				this.composer.focus();
				break;
			case 'pick:selected':
				this.route = msg.route;
				this.insertSelection(msg);
				break;
			case 'pick:hover':
				break;
		}
	}

	private insertSelection(msg: Selected) {
		const first = msg.targets[0];
		if (!first) return;
		const id = this.pins.length + 1;
		this.composer.insertText(formatContextBlock(msg, id));
		this.pins = [...this.pins, { id, selector: first.selector }];
		this.post({ type: 'pick:clear', id });
		this.post({ type: 'pins:set', pins: this.pins });
	}
}
