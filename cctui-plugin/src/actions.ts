import type { MessageAction, PluginMessage } from '../sdk/types.ts';
import { messages } from './messages.ts';

const LINE = /^yubisashi: (https?:\/\/\S+)$/gm;

/** Every distinct `yubisashi: <url>` line an agent printed, in order. */
export function reviewUrls(text: string): string[] {
	const urls: string[] = [];
	for (const m of text.matchAll(LINE)) {
		const url = m[1] as string;
		if (!urls.includes(url)) urls.push(url);
	}
	return urls;
}

export function messageActions(msg: PluginMessage): MessageAction[] {
	if (msg.role !== 'assistant') return [];
	return reviewUrls(msg.text).map((url, i) => ({
		label: messages.openInYubisashi,
		icon: 'eye',
		params: { url },
		open: 'sessionPane',
		autoOpen: i === 0,
	}));
}
