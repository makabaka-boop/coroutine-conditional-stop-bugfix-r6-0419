<script lang="ts">
  import { onMount } from 'svelte';
  import { createDebuggerClient } from './client';
  import { validateGraph } from '../core/graph';
  import type { FlowGraph } from '../core/types';
  import { SAMPLES } from './samples';
  import GraphView from './GraphView.svelte';
  import StatePanel from './StatePanel.svelte';
  import TracePanel from './TracePanel.svelte';
  import Editor from './Editor.svelte';

  const client = createDebuggerClient();
  const { snapshot, lastError } = client;

  let graph: FlowGraph | null = null;
  let editorSource = '';
  let editorError: string | null = null;
  let rollbackTarget = 0;
  let selectedSample = 0;
  let conditionalJson = "[]";
  function setConditions() {
    try { client.conditions(JSON.parse(conditionalJson)); }
    catch (err) { editorError = String(err); }
  }

  const STATUS_TEXT: Record<string, string> = {
    idle: '空闲',
    running: '运行中',
    paused: '已暂停',
    breakpoint: '断点',
    done: '完成',
    terminated: '已终止',
  };

  function loadSample(index: number) {
    selectedSample = index;
    const source = JSON.stringify(SAMPLES[index].graph, null, 2);
    applyGraphSource(SAMPLES[index].graph, source);
  }

  function applyGraphSource(raw: unknown, source: string) {
    editorError = null;
    try {
      graph = validateGraph(raw);
    } catch (err) {
      editorError = err instanceof Error ? err.message : String(err);
      return;
    }
    editorSource = source;
    client.loadGraph(raw);
  }

  function onEditorApply(event: CustomEvent<unknown>) {
    applyGraphSource(event.detail, JSON.stringify(event.detail, null, 2));
  }

  onMount(() => loadSample(0));

  $: snap = $snapshot;
  // 事件数变化时同步回退目标；用户手动输入期间不被覆盖
  let lastEvents = -1;
  $: if (snap && snap.eventsExecuted !== lastEvents) {
    lastEvents = snap.eventsExecuted;
    rollbackTarget = snap.eventsExecuted;
  }
  $: canStep = snap && (snap.status === 'idle' || snap.status === 'paused' || snap.status === 'breakpoint');
  $: canRun = canStep;
  $: canPause = snap?.status === 'running';
</script>
<div class="conditions"><label>条件断点 JSON <textarea bind:value={conditionalJson}></textarea></label><button on:click={setConditions}>设置条件断点</button></div>

<main>
  <header>
    <h1>流程图调试器</h1>
    {#if snap}
      <span class="badge gen">代次 {snap.generation}</span>
      <span class="badge status-{snap.status}">{STATUS_TEXT[snap.status]}</span>
      <span class="badge">tick {snap.tick}</span>
      <span class="badge">事件 {snap.eventsExecuted}</span>
    {/if}
  </header>

  {#if snap?.terminateReason}
    <div class="terminate">明确终止：{snap.terminateReason}</div>
  {/if}
  {#if snap?.pendingBreakpoint}
    <div class="bp-hit">
      断点命中：协程 #{snap.pendingBreakpoint.coroutineId} 即将执行节点
      「{snap.pendingBreakpoint.nodeId}」（副作用尚未发生）
    </div>
  {/if}
  {#if $lastError}
    <div class="error">{$lastError}</div>
  {/if}

  <div class="toolbar">
    <select bind:value={selectedSample} on:change={() => loadSample(selectedSample)}>
      {#each SAMPLES as sample, i}
        <option value={i}>{sample.name}</option>
      {/each}
    </select>
    <button disabled={!canStep} on:click={client.step}>⏭ 单步</button>
    <button disabled={!canRun} on:click={client.continue}>▶ 继续</button>
    <button disabled={!canPause} on:click={client.pause}>⏸ 暂停</button>
    <button disabled={!snap} on:click={client.reset}>↺ 重置</button>
    <span class="rollback">
      回退到事件
      <input
        type="number"
        min="0"
        max={snap?.eventsHighWater ?? 0}
        bind:value={rollbackTarget}
        disabled={!snap}
      />
      / {snap?.eventsHighWater ?? 0}
      <button
        disabled={!snap || snap.status === 'running'}
        on:click={() => client.rollback(rollbackTarget)}
      >⏪ 回退</button>
    </span>
  </div>

  <div class="body">
    <div class="left">
      <GraphView {graph} snapshot={snap} on:toggleBreakpoint={(e) => client.toggleBreakpoint(e.detail)} />
      <TracePanel snapshot={snap} />
    </div>
    <div class="right">
      <StatePanel snapshot={snap} />
      <Editor source={editorSource} error={editorError} on:apply={onEditorApply} />
    </div>
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #101216;
    color: #e8ecf3;
    font-family: system-ui, sans-serif;
  }
  main {
    max-width: 1440px;
    margin: 0 auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  h1 {
    font-size: 18px;
    margin: 0 12px 0 0;
  }
  .badge {
    background: #1e2128;
    border: 1px solid #2c313c;
    border-radius: 12px;
    padding: 2px 12px;
    font-size: 12px;
  }
  .gen { color: #c792ea; }
  .status-running { color: #78a6ff; }
  .status-paused { color: #ffd166; }
  .status-breakpoint { color: #ef476f; }
  .status-done { color: #6fbf73; }
  .status-terminated { color: #e06c75; }
  .terminate {
    background: #4a1f1f;
    border: 1px solid #7a2e2e;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .bp-hit {
    background: #4a3a1f;
    border: 1px solid #7a652e;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .error {
    background: #4a1f2e;
    border: 1px solid #7a2e4a;
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .toolbar button, .toolbar select {
    background: #1e2128;
    color: #e8ecf3;
    border: 1px solid #2c313c;
    border-radius: 6px;
    padding: 6px 14px;
    font-size: 13px;
    cursor: pointer;
  }
  .toolbar button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .toolbar button:not(:disabled):hover {
    background: #262b34;
  }
  .rollback {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: #aab0bb;
  }
  .rollback input {
    width: 72px;
    background: #16181d;
    color: #e8ecf3;
    border: 1px solid #2c313c;
    border-radius: 6px;
    padding: 5px 8px;
  }
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 380px;
    gap: 12px;
    align-items: start;
  }
  .left, .right {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  @media (max-width: 1000px) {
    .body {
      grid-template-columns: 1fr;
    }
  }
</style>
