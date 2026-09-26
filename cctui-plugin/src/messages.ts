export const messages = {
	name: 'Review',
	description:
		'Frames your running dev app next to the conversation. Point at an element and its source location lands in the composer, ready for your comment.',
	close: 'Close the Review pane',
	frameTitle: 'Reviewed app',
	load: 'Load',
	mixedContent:
		'cctui is served over https, so the browser only frames https or localhost apps; a plain http URL on another host will be blocked.',
	openTab: 'Open in a new tab',
	pick: 'Pick an element',
	pickKey: 'Press C to toggle picking',
	pickStop: 'Stop picking',
	pins: (count: number) => `${count} pinned`,
	reload: 'Reload',
	statusConnected: 'Picker connected — pick an element to drop its source into the composer.',
	statusIdle: 'Enter the URL of the running app to review.',
	statusLoading: 'Loading…',
	statusPicking: 'Picking — click an element in the app (Shift-click adds more).',
	statusWaiting: (origin: string) =>
		`Picker not detected: run \`yubi dev --parent-origin ${origin}\` in front of the app (or add @dorsk/yubisashi/vite to its vite config with that parent origin).`,
	urlLabel: 'App URL',
	urlPlaceholder: 'http://localhost:5173',
	openInReview: 'Open in Review',
};
