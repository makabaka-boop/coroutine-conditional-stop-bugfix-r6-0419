<script lang="ts">
  import type { Snapshot } from '../core/types';
  import { afterUpdate } from 'svelte';

  export let snapshot: Snapshot | null;

  let list: HTMLDivElement;

  afterUpdate(() => {
    if (list) list.scrollTop = list.scrollHeight;
  });

  $: trace = snapshot?.trace ?? [];
  $: recent = trace.slice(-200);
</script>

<section>
  <h3>事件轨迹（{trace.length}）</h3>
  <div class="trace" bind:this={list}>
    {#each recent as entry}
      <div class="entry">
        <span class="no">#{entry.event}</span>
        <span class="tick">t={entry.tick}</span>
        <span class="coro">协程{entry.coroutine}</span>
        <span class="node">{entry.node}</span>
        <span class="kind">{entry.kind}</span>
        {#if entry.note}
          <span class="note">{entry.note}</span>
        {/if}
      </div>
    {:else}
      <p class="muted">尚无事件</p>
    {/each}
  </div>
</section>

<style>
  h3 {
    margin: 0 0 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #8a8f98;
  }
  .trace {
    max-height: 260px;
    overflow-y: auto;
    font-size: 12px;
    font-family: ui-monospace, monospace;
    background: #16181d;
    border-radius: 6px;
    padding: 6px;
  }
  .entry {
    display: flex;
    gap: 10px;
    padding: 2px 4px;
    border-bottom: 1px solid #1e2128;
    white-space: nowrap;
  }
  .no { color: #6b7280; min-width: 42px; }
  .tick { color: #78a6ff; min-width: 44px; }
  .coro { color: #ffd166; min-width: 52px; }
  .node { color: #e8ecf3; min-width: 40px; }
  .kind { color: #8a8f98; min-width: 70px; }
  .note { color: #6fbf73; }
  .muted { color: #6b7280; padding: 4px; }
</style>
