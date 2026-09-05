<script lang="ts">
  import Badge from './Badge.svelte';

  interface Props {
    label: string;
    count?: number;
  }

  let { label, count = 0 }: Props = $props();

  let doubled = $derived(count * 2);

  function bump() {
    count += 1;
  }
</script>

<Badge {label} />
<button on:click={bump}>{doubled}</button>
