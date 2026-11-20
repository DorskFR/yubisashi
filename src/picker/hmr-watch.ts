export const HMR_WATCH_PATH = '/__yubi/hmr.js';
export const HMR_EVENT = 'yubi:hmr';

export type HmrStatus = 'connected' | 'lost';

/** Classic script loaded ahead of the dev server's client: it tracks the Vite HMR socket so
 *  the picker can tell the pane when hot reload stops reaching the page. */
export const HMR_WATCH_JS = `(() => {
	const Native = window.WebSocket;
	if (window.parent === window || !Native || window.__yubiHmr) return;
	const state = { status: 'none' };
	window.__yubiHmr = state;
	let leaving = false;
	addEventListener('pagehide', () => { leaving = true; });
	addEventListener('pageshow', () => { leaving = false; });
	const set = (status) => {
		if (state.status === status) return;
		state.status = status;
		dispatchEvent(new CustomEvent(${JSON.stringify(HMR_EVENT)}, { detail: status }));
	};
	const isHmr = (p) => (Array.isArray(p) ? p : [p]).includes('vite-hmr');
	window.WebSocket = class WebSocket extends Native {
		constructor(url, protocols) {
			super(url, protocols);
			if (!isHmr(protocols)) return;
			this.addEventListener('open', () => set('connected'));
			this.addEventListener('close', () => { if (!leaving) set('lost'); });
		}
	};
})();
`;
