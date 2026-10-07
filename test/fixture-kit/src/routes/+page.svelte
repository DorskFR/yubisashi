<script>
import Row from '$lib/Row.svelte';
</script>

<h1>Kit fixture</h1>
<Row />
<input id="note" aria-label="note" />
<section class="filler">
	{#each Array.from({ length: 600 }, (_, i) => i) as i (i)}
		<p class="line" data-i={i}>Filler line {i} with enough words to make the page large.</p>
	{/each}
</section>
