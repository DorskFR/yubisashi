<script lang="ts">
	import { Badge, Button, IconButton, Input, Select, Switch, Text, Toolbar } from '@dorsk/tsumikit';
	import type { PaneProps } from '../sdk/types.ts';
	import { messages as m } from './messages.ts';
	import { YubiController } from './yubi.svelte.ts';

	let { session, composer, params, onclose }: PaneProps = $props();

	// svelte-ignore state_referenced_locally
	const ctl = new YubiController(session, composer);

	const statusText = $derived.by(() => {
		if (ctl.picking) return m.statusPicking;
		switch (ctl.status) {
			case 'idle':
				return m.statusIdle;
			case 'loading':
				return m.statusLoading;
			case 'waiting':
				return m.statusWaiting;
			case 'connected':
				return m.statusConnected;
		}
	});
	let path = $derived(ctl.route);
	const options = $derived(
		ctl.previews.map((p) => ({ value: p.id, label: m.preview(p.port), hint: new URL(p.url).host }))
	);

	let applied: string | undefined;
	$effect(() => {
		if (params.url === applied) return;
		applied = params.url;
		void ctl.open(params.url ?? '');
	});
	$effect(() => () => ctl.destroy());

	function onKey(e: KeyboardEvent) {
		if (e.key !== 'c' && e.key !== 'C') return;
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
		e.preventDefault();
		ctl.togglePick();
	}

	async function openTab() {
		const tab = window.open('', '_blank');
		const url = await ctl.tabUrl();
		if (!tab) return;
		if (url) tab.location.href = url;
		else tab.close();
	}
</script>

<svelte:window onmessage={(e) => ctl.onMessage(e)} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="yubi" data-journey="yubisashi" aria-label={m.name} onkeydown={onKey}>
	<Toolbar density="compact" label={m.name}>
		<IconButton icon="x" box="sm" label={m.close} onclick={onclose} />
		{#if ctl.previews.length > 1}
			<Select
				size="sm"
				{options}
				value={ctl.selected?.id ?? ''}
				aria-label={m.previewLabel}
				onchange={(e) => ctl.select((e.currentTarget as HTMLSelectElement).value)}
				data-journey="preview"
			/>
		{/if}
		<Input
			size="sm"
			mono
			grow
			bind:value={path}
			placeholder={m.pathPlaceholder}
			aria-label={m.pathLabel}
			disabled={!ctl.selected}
			data-journey="path"
			onenter={(v) => ctl.navigate(v)}
		/>
		<div class="actions">
			<IconButton
				icon="retry"
				box="sm"
				label={m.reload}
				title={m.reload}
				disabled={!ctl.selected || ctl.refreshing}
				spin={ctl.refreshing}
				data-journey="reload"
				onclick={() => ctl.reload()}
			/>
			<IconButton
				icon="external"
				box="sm"
				label={m.openTab}
				title={m.openTab}
				disabled={!ctl.selected}
				onclick={openTab}
			/>
			<IconButton
				box="sm"
				variant={ctl.picking ? 'primary' : 'default'}
				pressed={ctl.picking}
				label={ctl.picking ? m.pickStop : m.pick}
				title={`${ctl.picking ? m.pickStop : m.pick} — ${m.pickKey}`}
				disabled={ctl.status !== 'connected'}
				data-journey="pick"
				onclick={() => ctl.togglePick()}
			>
				<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
			</IconButton>
		</div>
	</Toolbar>
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
	{#if ctl.error}
		<div class="hint" role="alert">
			<Text size="sm" tone="danger">{ctl.error}</Text>
		</div>
	{/if}
	{#if ctl.lookNotice}
		<div class="notice" role="status" data-journey="look-notice">
			<Text size="sm" tone="accent">{ctl.lookNotice}</Text>
		</div>
	{/if}
	<div class="status" data-journey="status" data-status={ctl.status}>
		{#if ctl.selected}
			<Text size="sm" tone="faint">{ctl.lookAllowed ? statusText : m.lookOff}</Text>
		{:else if ctl.disabled}
			<Text size="sm" tone="faint">{m.previewsDisabled}</Text>
		{:else if ctl.boot === 'pending'}
			<Text size="sm" tone="faint">{m.starting}</Text>
		{:else if ctl.boot === 'timeout'}
			<Text size="sm" tone="danger">{m.startTimeout}</Text>
			<Button size="sm" data-journey="retry-start" onclick={() => ctl.startServer()}>{m.retry}</Button>
		{:else}
			<Text size="sm" tone="faint">{m.empty}</Text>
		{/if}
		{#if ctl.pins.length}
			<Badge tone="accent" size="sm">{m.pins(ctl.pins.length)}</Badge>
		{/if}
		{#if ctl.looks}
			<Badge tone="neutral" size="sm" data-journey="look-count">{m.looks(ctl.looks)}</Badge>
		{/if}
		<span class="consent">
			<Switch
				size="sm"
				label={m.lookAllow}
				labelVisible
				checked={ctl.lookAllowed}
				data-journey="look-allow"
				onclick={(e) => {
					e.preventDefault();
					ctl.setLookAllowed(!ctl.lookAllowed);
				}}
			/>
		</span>
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
	.actions {
		display: flex;
		align-items: center;
		gap: var(--sp-1);
		flex: none;
	}
	.status {
		display: flex;
		align-items: center;
		gap: var(--sp-2);
		padding: var(--sp-1) var(--sp-2);
		border-top: 1px solid var(--border);
		min-width: 0;
		flex-wrap: wrap;
	}
	.hint,
	.notice {
		padding: var(--sp-1) var(--sp-2);
		border-top: 1px solid var(--border);
	}
	.consent {
		margin-left: auto;
		flex: none;
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
