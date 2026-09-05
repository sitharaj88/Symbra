<script context="module" lang="ts">
  export const LIMIT = 100;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import TodoItem from './TodoItem.svelte';
  import { load } from '../lib/api';

  export let title: string;
  export let items: string[] = [];
  export let compact = false;

  let filter = '';

  $: visible = items.filter((i) => i.includes(filter));
  $: count = visible.length;

  /** Refresh from the API. */
  async function refresh(): Promise<void> {
    items = await load(title);
  }

  onMount(refresh);
</script>

<h1>{title}</h1>
<input bind:value={filter} />
<ul>
  {#each visible as item}
    <TodoItem {item} on:remove={refresh} />
  {/each}
</ul>
<todo-footer count={count} />
