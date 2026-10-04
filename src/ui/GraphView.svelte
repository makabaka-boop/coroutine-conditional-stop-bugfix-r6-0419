<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { FlowGraph, FlowNode, Snapshot } from '../core/types';
  import { nodeLabel } from '../core/graph';

  export let graph: FlowGraph | null;
  export let snapshot: Snapshot | null;

  const dispatch = createEventDispatcher<{ toggleBreakpoint: string }>();

  const NODE_W = 150;
  const NODE_H = 48;
  const GAP_X = 200;
  const GAP_Y = 96;

  const KIND_COLORS: Record<string, string> = {
    start: '#2d4a22',
    assign: '#1f3a5f',
    condition: '#4a3a1f',
    loop: '#3a2d5f',
    wait: '#1f4a4a',
    spawn: '#5f2d4a',
    join: '#5f2d4a',
    end: '#3d3d3d',
  };

  const CORO_COLORS = ['#ffd166', '#06d6a0', '#ef476f', '#78a6ff'];

  interface Edge {
    from: string;
    to: string;
    label: string;
    style: string;
  }

  function outgoing(node: FlowNode): Array<{ to: string | null; label: string; style: string }> {
    switch (node.kind) {
      case 'start':
      case 'assign':
      case 'wait':
      case 'join':
        return [{ to: node.next, label: '', style: '' }];
      case 'condition':
        return [
          { to: node.onTrue, label: 'T', style: 'true' },
          { to: node.onFalse, label: 'F', style: 'false' },
        ];
      case 'loop':
        return [
          { to: node.body, label: 'body', style: '' },
          { to: node.next, label: 'exit', style: 'exit' },
        ];
      case 'spawn':
        return [
          { to: node.entry, label: 'spawn', style: 'spawn' },
          { to: node.next, label: '', style: '' },
        ];
      case 'end':
        return [];
    }
  }

  interface Layout {
    pos: Map<string, { x: number; y: number }>;
    edges: Edge[];
    width: number;
    height: number;
  }

  function computeLayout(g: FlowGraph): Layout {
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const depth = new Map<string, number>();
    const queue: string[] = [g.start];
    depth.set(g.start, 0);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const d = depth.get(id)!;
      const node = byId.get(id);
      if (!node) continue;
      for (const e of outgoing(node)) {
        if (e.to !== null && !depth.has(e.to)) {
          depth.set(e.to, d + 1);
          queue.push(e.to);
        }
      }
    }
    // 不可达节点放到最后一层之后
    let maxDepth = 0;
    for (const d of depth.values()) maxDepth = Math.max(maxDepth, d);
    for (const n of g.nodes) {
      if (!depth.has(n.id)) depth.set(n.id, maxDepth + 1);
    }
    // 分层计数 → 坐标
    const inLayer = new Map<string, number>();
    const pos = new Map<string, { x: number; y: number }>();
    let maxY = 0;
    for (const n of g.nodes) {
      const d = depth.get(n.id)!;
      const idx = inLayer.get(d) ?? 0;
      inLayer.set(d, idx + 1);
      pos.set(n.id, { x: 24 + d * GAP_X, y: 24 + idx * GAP_Y });
      maxY = Math.max(maxY, idx);
    }
    const edges: Edge[] = [];
    for (const n of g.nodes) {
      for (const e of outgoing(n)) {
        if (e.to !== null) edges.push({ from: n.id, to: e.to, label: e.label, style: e.style });
      }
    }
    return {
      pos,
      edges,
      width: 24 + (maxDepth + 2) * GAP_X,
      height: 24 + (maxY + 1) * GAP_Y + NODE_H,
    };
  }

  $: layout = graph ? computeLayout(graph) : null;
  $: breakpoints = new Set(snapshot?.breakpoints ?? []);
  $: pcByNode = (() => {
    const map = new Map<string, number[]>();
    for (const c of snapshot?.coroutines ?? []) {
      if (c.pc !== null && c.status !== 'done') {
        const list = map.get(c.pc) ?? [];
        list.push(c.id);
        map.set(c.pc, list);
      }
    }
    return map;
  })();
  $: pendingNode = snapshot?.pendingBreakpoint?.nodeId ?? null;

  function edgePath(from: { x: number; y: number }, to: { x: number; y: number }): string {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_H / 2;
    if (x2 > x1) {
      const mx = (x1 + x2) / 2;
      return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    }
    // 回边（如循环体指回循环节点）：绕下方走
    const yy = Math.max(y1, y2) + 34;
    return `M ${x1} ${y1} C ${x1 + 40} ${yy}, ${x2 - 40} ${yy}, ${x2} ${y2}`;
  }
</script>

<div class="graph-view">
  {#if layout && graph}
    <svg width={layout.width} height={layout.height} role="img">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#8a8f98" />
        </marker>
      </defs>

      {#each layout.edges as edge}
        {@const from = layout.pos.get(edge.from)}
        {@const to = layout.pos.get(edge.to)}
        {#if from && to}
          <path
            class="edge {edge.style}"
            d={edgePath(from, to)}
            marker-end="url(#arrow)"
          />
          {#if edge.label}
            <text
              class="edge-label {edge.style}"
              x={(from.x + NODE_W + to.x) / 2}
              y={(from.y + to.y) / 2 + NODE_H / 2 - 6}
            >{edge.label}</text>
          {/if}
        {/if}
      {/each}

      {#each graph.nodes as node}
        {@const p = layout.pos.get(node.id)}
        {#if p}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <g
            class="node"
            class:pending={pendingNode === node.id}
            transform="translate({p.x},{p.y})"
            on:click={() => dispatch('toggleBreakpoint', node.id)}
            title="点击切换断点 · {node.id}"
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx="8"
              fill={KIND_COLORS[node.kind] ?? '#333'}
              stroke={pendingNode === node.id ? '#ffd166' : '#555'}
              stroke-width={pendingNode === node.id ? 3 : 1}
            />
            <text class="kind" x="10" y="16">{node.kind}</text>
            <text class="label" x="10" y="34">{nodeLabel(node)}</text>
            <text class="id" x={NODE_W - 10} y="16">{node.id}</text>
            {#if breakpoints.has(node.id)}
              <circle class="bp" cx="12" cy={NODE_H - 10} r="6" />
            {/if}
            {#each pcByNode.get(node.id) ?? [] as cid, i}
              <circle
                class="pc"
                cx={NODE_W - 14 - i * 18}
                cy={NODE_H - 10}
                r="8"
                fill={CORO_COLORS[(cid - 1) % CORO_COLORS.length]}
              />
              <text class="pc-id" x={NODE_W - 14 - i * 18} y={NODE_H - 6.5}>{cid}</text>
            {/each}
          </g>
        {/if}
      {/each}
    </svg>
  {:else}
    <p class="empty">尚未加载图</p>
  {/if}
</div>

<style>
  .graph-view {
    overflow: auto;
    background: #16181d;
    border-radius: 8px;
    min-height: 200px;
  }
  .edge {
    fill: none;
    stroke: #8a8f98;
    stroke-width: 1.5;
  }
  .edge.spawn {
    stroke-dasharray: 5 4;
    stroke: #e08aa8;
  }
  .edge.true {
    stroke: #6fbf73;
  }
  .edge.false {
    stroke: #e06c75;
  }
  .edge-label {
    fill: #aab0bb;
    font-size: 11px;
    text-anchor: middle;
  }
  .edge-label.true {
    fill: #6fbf73;
  }
  .edge-label.false {
    fill: #e06c75;
  }
  .node {
    cursor: pointer;
  }
  .node .kind {
    fill: #9aa3b2;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .node .label {
    fill: #e8ecf3;
    font-size: 13px;
    font-family: ui-monospace, monospace;
  }
  .node .id {
    fill: #6b7280;
    font-size: 9px;
    text-anchor: end;
  }
  .node.pending rect {
    filter: drop-shadow(0 0 6px #ffd166);
  }
  .bp {
    fill: #ef476f;
    stroke: #fff;
    stroke-width: 1.5;
  }
  .pc {
    stroke: #111;
    stroke-width: 1.5;
  }
  .pc-id {
    fill: #111;
    font-size: 10px;
    font-weight: 700;
    text-anchor: middle;
  }
  .empty {
    color: #8a8f98;
    padding: 24px;
  }
</style>
