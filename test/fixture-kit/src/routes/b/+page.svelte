<h1 id="page-b">Page B</h1>
<section class="tall">
	{#each Array.from({ length: 200 }, (_, i) => i) as i (i)}
		<p class="b-line">Line {i} of page B.</p>
	{/each}
</section>
<p id="bottom">Bottom of page B</p>
<svelte:head><title>Page B</title></svelte:head>
