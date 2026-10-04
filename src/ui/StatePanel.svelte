<script lang="ts">
  import type { Snapshot } from '../core/types';

  export let snapshot: Snapshot | null;

  const STATUS_TEXT: Record<string, string> = {
    ready: '就绪',
    waiting: '等待中',
    joining: '汇合阻塞',
    'spawn-blocked': '派生阻塞',
    done: '已结束',
  };
</script>

<div class="panels">
  <section>
    <h3>协程</h3>
    {#if snapshot && snapshot.coroutines.length > 0}
      {#each snapshot.coroutines as c}
        <div class="coro" class:done={c.status === 'done'}>
          <div class="coro-head">
            <span class="cid">#{c.id}</span>
            <span class="status status-{c.status}">{STATUS_TEXT[c.status] ?? c.status}</span>
            {#if c.parentId !== null}
              <span class="parent">父 #{c.parentId}</span>
            {/if}
            {#if c.pc}
              <span class="pc">@ {c.pc}</span>
            {/if}
          </div>
          {#if c.blockReason}
            <div class="block-reason">⛔ {c.blockReason}</div>
          {/if}
          {#if c.children.length > 0}
            <div class="children">子协程: [{c.children.join(', ')}]</div>
          {/if}
          <div class="stack">
            {#if c.stack.length === 0}
              <span class="muted">栈空</span>
            {:else}
              {#each c.stack as frame}
                <span class="frame">loop {frame.loopNodeId} ×{frame.remaining}</span>
              {/each}
            {/if}
          </div>
        </div>
      {/each}
    {:else}
      <p class="muted">—</p>
    {/if}
  </section>

  <section>
    <h3>共享变量</h3>
    {#if snapshot}
      <table>
        <tbody>
          {#each Object.entries(snapshot.variables) as [name, value]}
            <tr>
              <td class="var-name">{name}</td>
              <td class="var-value">{value}</td>
            </tr>
          {:else}
            <tr><td class="muted">（无声明变量）</td></tr>
          {/each}
        </tbody>
      </table>
    {:else}
      <p class="muted">—</p>
    {/if}
  </section>
</div>

<style>
  .panels {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  h3 {
    margin: 0 0 8px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #8a8f98;
  }
  .coro {
    background: #1e2128;
    border: 1px solid #2c313c;
    border-radius: 6px;
    padding: 8px 10px;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .coro.done {
    opacity: 0.55;
  }
  .coro-head {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .cid {
    font-weight: 700;
    color: #ffd166;
  }
  .status {
    padding: 1px 8px;
    border-radius: 10px;
    font-size: 11px;
    background: #2c313c;
  }
  .status-ready { color: #6fbf73; }
  .status-waiting { color: #78a6ff; }
  .status-joining, .status-spawn-blocked { color: #ef476f; }
  .status-done { color: #8a8f98; }
  .parent, .pc, .children {
    color: #8a8f98;
    font-size: 12px;
  }
  .pc {
    font-family: ui-monospace, monospace;
    color: #aab0bb;
  }
  .block-reason {
    margin-top: 6px;
    color: #ef9a9a;
    font-size: 12px;
  }
  .children {
    margin-top: 4px;
  }
  .stack {
    margin-top: 6px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .frame {
    background: #3a2d5f;
    border-radius: 4px;
    padding: 1px 8px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 13px;
  }
  td {
    border-bottom: 1px solid #2c313c;
    padding: 4px 8px;
  }
  .var-name {
    font-family: ui-monospace, monospace;
    color: #78a6ff;
  }
  .var-value {
    text-align: right;
    font-family: ui-monospace, monospace;
    color: #e8ecf3;
  }
  .muted {
    color: #6b7280;
  }
</style>
