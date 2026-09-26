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
	frame: HTMLIFrameElement | null = null;
	private readonly session: PluginSession;
	private readonly composer: ComposerBridge;

	constructor(session: PluginSession, composer: ComposerBridge) {
		this.session = session;
		this.composer = composer;
	}

	get origin(): string | null {
		return this.selected ? originOf(this.selected.url) : null;
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

	async reload() {
		if (this.selected) await this.frameSelected();
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
