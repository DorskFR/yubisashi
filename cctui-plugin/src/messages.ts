export const messages = {
	name: 'yubisashi',
	description:
		'Frames your running dev app next to the conversation. Point at an element and its source location lands in the composer, ready for your comment.',
	close: 'Close the yubisashi pane',
	empty:
		'No yubisashi preview running for this session. Ask the agent: "start me a dev server with yubisashi".',
	frameTitle: 'Reviewed app',
	openTab: 'Open in a new tab',
	pick: 'Pick an element',
	pickKey: 'Press C to toggle picking',
	pickStop: 'Stop picking',
	pins: (count: number) => `${count} pinned`,
	preview: (port: number) => `port ${port}`,
	previewLabel: 'Preview',
	refresh: 'Refresh the preview list',
	reload: 'Reload',
	statusConnected: 'Picker connected — pick an element to drop its source into the composer.',
	statusIdle: 'Pick a preview to frame it.',
	statusLoading: 'Loading…',
	statusPicking: 'Picking — click an element in the app (Shift-click adds more).',
	statusWaiting:
		'Picker not detected: the app must be served by `yubi dev` (or use @dorsk/yubisashi/vite with this origin as parent).',
	openInYubisashi: 'Open in yubisashi',
	starting: 'Starting yubisashi…',
	startTimeout: "Didn't start — check the conversation.",
	retry: 'Retry',
};
