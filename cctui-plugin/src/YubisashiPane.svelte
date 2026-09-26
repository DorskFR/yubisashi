<script lang="ts">
	import { Badge, IconButton, Input, Text, Toolbar } from '@dorsk/tsumikit';
	import { getContext } from 'svelte';
	import { HOST_CONTEXT_KEY, type HostContext, type PaneProps } from '../sdk/types.ts';
	import { messages as m } from './messages.ts';
	import { isMixedContent } from './pane.logic.ts';
	import { YubiController } from './yubi.svelte.ts';

	let { session, composer, params, onclose }: PaneProps = $props();

	const host = getContext<HostContext | undefined>(HOST_CONTEXT_KEY);
	const parentOrigin = host?.origin || (typeof location === 'undefined' ? '' : location.origin);

	// svelte-ignore state_referenced_locally
	const ctl = new YubiController(session, composer, params.url ?? '');
	const mixed = $derived(typeof location !== 'undefined' && isMixedContent(ctl.url, location.protocol));

	const statusText = $derived.by(() => {
		if (ctl.picking) return m.statusPicking;
		switch (ctl.status) {
			case 'idle':
				return m.statusIdle;
			case 'loading':
				return m.statusLoading;
			case 'waiting':
				return m.statusWaiting(parentOrigin);
			case 'connected':
				return m.statusConnected;
		}
	});
	const statusTone = $derived(
		ctl.status === 'connected' ? 'ok' : ctl.status === 'waiting' ? 'warn' : 'neutral'
	);

	// svelte-ignore state_referenced_locally
	let applied = params.url;
	$effect(() => {
		if (params.url === applied) return;
		applied = params.url;
		if (params.url) ctl.load(params.url);
	});

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'c' && e.key !== 'C') return;
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		ctl.togglePick();
	}

	function openTab() {
		if (ctl.url) window.open(ctl.url, '_blank', 'noopener');
	}
</script>

<svelte:window onmessage={(e) => ctl.onMessage(e)} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="yubi" data-journey="yubisashi" aria-label={m.name} onkeydown={onKey}>
	<Toolbar density="compact">
		<IconButton icon="x" box="sm" label={m.close} onclick={onclose} />
		<div class="url">
			<Input
				bind:value={ctl.draft}
				type="url"
				placeholder={m.urlPlaceholder}
				aria-label={m.urlLabel}
				onenter={(v) => ctl.load(v)}
				data-journey="url"
			/>
		</div>
		<IconButton icon="arrow-right" box="sm" label={m.load} onclick={() => ctl.load(ctl.draft)} />
		<IconButton icon="retry" box="sm" label={m.reload} disabled={!ctl.url} onclick={() => ctl.reload()} />
		<IconButton icon="external" box="sm" label={m.openTab} disabled={!ctl.url} onclick={openTab} />
		<IconButton
			icon="text-cursor"
			box="sm"
			variant={ctl.picking ? 'primary' : 'default'}
			pressed={ctl.picking}
			label={ctl.picking ? m.pickStop : m.pick}
			title={m.pickKey}
			disabled={ctl.status !== 'connected'}
			data-journey="pick"
			onclick={() => ctl.togglePick()}
		/>
	</Toolbar>
	<div class="status" data-journey="status" data-status={ctl.status}>
		<Badge tone={statusTone} size="sm">{ctl.route || '—'}</Badge>
		<Text size="sm" tone="faint">{statusText}</Text>
		{#if ctl.pins.length}
			<Badge tone="accent" size="sm">{m.pins(ctl.pins.length)}</Badge>
		{/if}
	</div>
	{#if mixed}
		<div class="hint">
			<Text size="sm" tone="warn">{m.mixedContent}</Text>
		</div>
	{/if}
	<div class="frame">
		{#if ctl.url}
			{#key ctl.epoch}
				<iframe
					bind:this={ctl.frame}
					src={ctl.url}
					title={m.frameTitle}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
					onload={() => ctl.onFrameLoad()}
				></iframe>
			{/key}
		{/if}
	</div>
</section>

<style>
	.yubi {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-width: 0;
		background: var(--bg);
		border-right: 1px solid var(--border);
	}
	.url {
		flex: 1 1 auto;
		min-width: 0;
	}
	.status {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-1) var(--sp-2);
		border-bottom: 1px solid var(--border);
		min-width: 0;
		flex-wrap: wrap;
	}
	.hint {
		padding: var(--sp-1) var(--sp-2);
		border-bottom: 1px solid var(--border);
	}
	.frame {
		flex: 1 1 auto;
		min-height: 0;
		background: var(--bg-elevated);
	}
	iframe {
		display: block;
		width: 100%;
		height: 100%;
		border: 0;
	}
</style>
