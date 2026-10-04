<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  export let source: string;
  export let error: string | null = null;

  const dispatch = createEventDispatcher<{ apply: unknown }>();

  let text = source;
  let parseError: string | null = null;
  let lastSource = source;

  // 仅当外部（切换示例）更新 source 时同步编辑器内容，不打断用户输入
  $: if (source !== lastSource) {
    lastSource = source;
    text = source;
    parseError = null;
  }

  function apply() {
    parseError = null;
    try {
      const graph = JSON.parse(text);
      dispatch('apply', graph);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<section>
  <h3>图编辑器（JSON）— 应用后开启新执行代次</h3>
  <textarea bind:value={text} spellcheck="false" rows="14"></textarea>
  <div class="row">
    <button on:click={apply}>应用（新代次）</button>
    {#if parseError}
      <span class="error">JSON 解析失败: {parseError}</span>
    {:else if error}
      <span class="error">{error}</span>
    {/if}
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
  textarea {
    width: 100%;
    box-sizing: border-box;
    background: #16181d;
    color: #e8ecf3;
    border: 1px solid #2c313c;
    border-radius: 6px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    padding: 8px;
    resize: vertical;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
  }
  button {
    background: #1f3a5f;
    color: #e8ecf3;
    border: 1px solid #2c4a73;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
  }
  button:hover {
    background: #274a77;
  }
  .error {
    color: #ef9a9a;
    font-size: 12px;
  }
</style>
