import type { ComposerBridge, PluginSession } from '../sdk/types.ts';
import { formatContextBlock } from './context.logic.ts';
import { normalizeUrl, type PaneStatus, rememberedUrl, rememberUrl } from './pane.logic.ts';
import {
	isTrustedEvent,
	originOf,
	type ParentPayload,
	type Pin,
	parseChildMessage,
	type Selected,
	YUBI,
} from './protocol.ts';

/** State of one Review pane: the framed URL, the picker handshake, and the
 *  pins for every block dropped into the composer since the pane opened. */
export class YubiController {
	url = $state('');
	draft = $state('');
	status = $state<PaneStatus>('idle');
	picking = $state(false);
	route = $state('');
	pins = $state<Pin[]>([]);
	/** Bumped to remount the iframe (reload). */
	epoch = $state(0);
	frame: HTMLIFrameElement | null = null;
	private readonly session: PluginSession;
	private readonly composer: ComposerBridge;

	constructor(session: PluginSession, composer: ComposerBridge, initialUrl = '') {
		this.session = session;
		this.composer = composer;
		const start = initialUrl || rememberedUrl(session.machine_id, session.working_dir);
		this.draft = start;
		if (start) this.load(start);
	}

	get origin(): string | null {
		return originOf(this.url);
	}

	load(raw: string) {
		const next = normalizeUrl(raw);
		this.draft = next || raw;
		rememberUrl(this.session.machine_id, this.session.working_dir, next);
		this.url = next;
		this.picking = false;
		this.status = next ? 'loading' : 'idle';
		this.epoch++;
	}

	reload() {
		if (!this.url) return;
		this.picking = false;
		this.status = 'loading';
		this.epoch++;
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
