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
<div id="ruler-a" style="position:fixed;left:600px;top:100px;width:100px;height:40px;box-sizing:border-box;padding:4px 8px;background:#cde"></div>
<div id="ruler-b" style="position:fixed;left:724px;top:110px;width:60px;height:20px;background:#dec"></div>
<div id="ruler-c" style="position:fixed;left:613px;top:175px;width:60px;height:30px;margin:5px;background:#edc"></div>
<svelte:head><title>Kit fixture</title></svelte:head>
