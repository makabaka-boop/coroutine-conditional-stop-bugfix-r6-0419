import { ConditionalStops, type ConditionalRule } from "./conditional";
import type {
  Coroutine,
  EngineStatus,
  FlowGraph,
  FlowNode,
  StepResult,
  TraceEntry,
} from "./types";
import { LIMITS } from "./types";
import { evalExpr, exprToString, RuntimeError } from "./expr";
import { nodeLabel } from "./graph";

export interface EngineOptions {
  maxNodeExecutions?: number;
  maxTicks?: number;
  maxCoroutines?: number;
  /** 每多少个事件落一个检查点（回退 = 最近检查点 + 确定性重放）。 */
  checkpointInterval?: number;
  breakpoints?: Set<string>;
  conditionalRules?: ConditionalRule[];
}

interface Checkpoint {
  eventsExecuted: number;
  tick: number;
  nextCoroutineId: number;
  variables: Record<string, number>;
  coroutines: Coroutine[];
  readyQueue: number[];
}

/**
 * 确定性流程图引擎。
 *
 * 调度模型：
 * - 一个“调度事件” = 一个协程执行一个节点。
 * - 同一 tick 的就绪协程按 ID 轮转推进（就绪队列 FIFO，新就绪者按 ID 序入队，
 *   当前协程若仍就绪则排到队尾）。
 * - 只有 wait 推进虚拟时间；没有就绪协程时，时间跳到最近的唤醒 tick。
 * - 没有任何就绪协程、也没有等待中的定时器，但仍有协程阻塞 → 死等，明确终止。
 *
 * 限制：节点执行总数 ≤ maxNodeExecutions，虚拟时间 ≤ maxTicks，
 * 同时存活协程 ≤ maxCoroutines（派生名额不足时父协程阻塞在 spawn 上）。
 */
export class Engine {
  conditional = new ConditionalStops();
  readonly graph: FlowGraph;
  private readonly maxNodeExecutions: number;
  private readonly maxTicks: number;
  private readonly maxCoroutines: number;
  private readonly checkpointInterval: number;

  tick = 0;
  eventsExecuted = 0;
  status: EngineStatus = "idle";
  terminateReason: string | null = null;
  variables: Record<string, number>;
  breakpoints: Set<string>;

  /** 命中断点时待执行的调度事件（副作用尚未发生）。 */
  pendingBreakpoint: { coroutineId: number; nodeId: string } | null = null;

  readonly trace: TraceEntry[] = [];

  private coroutines = new Map<number, Coroutine>();
  private readyQueue: number[] = [];
  private nextCoroutineId = 1;
  private readonly nodeIndex = new Map<string, FlowNode>();

  /** 每个已执行事件对应的协程 id。调度是图的纯函数，日志永不失效。 */
  private eventLog: number[] = [];
  private checkpoints: Checkpoint[] = [];
  /** 历史上到达过的最大事件数：回退允许的目标范围上界。 */
  private highWaterMark = 0;

  constructor(graph: FlowGraph, options: EngineOptions = {}) {
    this.graph = graph;
    this.maxNodeExecutions =
      options.maxNodeExecutions ?? LIMITS.maxNodeExecutions;
    this.maxTicks = options.maxTicks ?? LIMITS.maxTicks;
    this.maxCoroutines = options.maxCoroutines ?? LIMITS.maxCoroutines;
    this.checkpointInterval = options.checkpointInterval ?? 100;
    this.breakpoints = options.breakpoints ?? new Set();
    this.variables = { ...graph.variables };
    this.conditional = new ConditionalStops(options.conditionalRules ?? []);
    this.conditional.validate(
      new Set(graph.nodes.map((n) => n.id)),
      graph.variables,
    );
    for (const node of graph.nodes) this.nodeIndex.set(node.id, node);

    const main: Coroutine = {
      id: this.nextCoroutineId++,
      parentId: null,
      pc: graph.start,
      stack: [],
      status: "ready",
      wakeTick: null,
      children: [],
    };
    this.coroutines.set(main.id, main);
    this.readyQueue.push(main.id);
    this.saveCheckpoint(); // 事件 0 处的初始检查点
  }

  // -------------------------------------------------------------------------
  // 单步推进
  // -------------------------------------------------------------------------

  /**
   * 推进一条调度事件。
   * 若下一事件落在断点上，则在副作用发生前停住（返回 'breakpoint'）。
   */
  stepEvent(): StepResult {
    if (this.status === "done" || this.status === "terminated")
      return this.status;

    // 上次停在断点：该事件已被“批准”，直接执行（不再触发断点检查）。
    if (this.pendingBreakpoint) {
      const pending = this.pendingBreakpoint;
      this.pendingBreakpoint = null;
      if (this.readyQueue[0] === pending.coroutineId) {
        this.status = "ready";
        return this.execute(pending.coroutineId) ? "terminated" : "executed";
      }
      // 防御：队列状态已变化（理论上不会发生），丢弃过期断点事件。
    }

    const next = this.ensureNext();
    if (!next.ok) return next.result;

    const node = this.nodeOf(this.coroutines.get(next.cid)!.pc);
    if (
      this.breakpoints.has(node.id) ||
      this.conditional.shouldStop(node.id, next.cid, this.variables)
    ) {
      this.pendingBreakpoint = { coroutineId: next.cid, nodeId: node.id };
      this.status = "breakpoint";
      return "breakpoint";
    }

    this.status = "ready";
    return this.execute(next.cid) ? "terminated" : "executed";
  }

  /**
   * 找出下一个应推进的协程；必要时推进虚拟时间。
   * 返回 null 表示执行结束（done）或被明确终止（terminated）。
   */
  private ensureNext():
    | { ok: true; cid: number }
    | { ok: false; result: "done" | "terminated" } {
    while (this.readyQueue.length === 0) {
      if (this.allDone()) {
        this.status = "done";
        return { ok: false, result: "done" };
      }
      const wake = this.minWakeTick();
      if (wake !== null) {
        if (wake > this.maxTicks) {
          this.terminate(
            `tick-limit-exceeded: next wakeup at tick ${wake} exceeds limit ${this.maxTicks}`,
          );
          return { ok: false, result: "terminated" };
        }
        this.tick = wake;
        const woken: number[] = [];
        for (const c of this.coroutines.values()) {
          if (
            c.status === "waiting" &&
            c.wakeTick !== null &&
            c.wakeTick <= this.tick
          ) {
            const waitNode = this.nodeOf(c.pc);
            if (waitNode.kind !== "wait") {
              throw new Error(
                `internal: coroutine ${c.id} waiting on non-wait node`,
              );
            }
            c.status = "ready";
            c.wakeTick = null;
            c.pc = waitNode.next; // 越过 wait 节点
            woken.push(c.id);
          }
        }
        woken.sort((a, b) => a - b);
        this.readyQueue.push(...woken);
        continue;
      }
      // 没有定时器：若仍有阻塞中的协程 → 死等。
      const blocked = [...this.coroutines.values()].filter(
        (c) => c.status === "joining" || c.status === "spawn-blocked",
      );
      if (blocked.length === 0) {
        this.status = "done"; // 不可达（allDone 已覆盖），防御性兜底
        return { ok: false, result: "done" };
      }
      const detail = blocked
        .map((c) => `coroutine ${c.id} (${this.blockReason(c)})`)
        .join("; ");
      this.terminate(
        `deadlock: no ready coroutines, no pending timers; ${detail}`,
      );
      return { ok: false, result: "terminated" };
    }
    return { ok: true, cid: this.readyQueue[0] };
  }

  /** 执行协程 cid 当前节点（一条调度事件的副作用）。返回 true 表示执行被明确终止。 */
  private execute(cid: number): boolean {
    if (this.eventsExecuted >= this.maxNodeExecutions) {
      this.terminate(
        `node-limit-exceeded: ${this.maxNodeExecutions} node executions reached`,
      );
      return true;
    }
    this.readyQueue.shift();
    const c = this.coroutines.get(cid)!;
    const node = this.nodeOf(c.pc);

    this.conditional.visit(node.id, cid, this.variables);
    let note = "";
    try {
      note = this.applyNode(c, node);
    } catch (err) {
      if (err instanceof RuntimeError) {
        this.terminate(`runtime-error at node '${node.id}': ${err.message}`);
        return true;
      }
      throw err;
    }
    // 走到 null 出边（未接 end 节点）→ 正常结束。
    if (c.status === "ready" && c.pc === null) {
      c.status = "done";
      this.onCoroutineDone();
    }

    this.eventsExecuted++;
    // 事件日志：追加之；重走历史时校验确定性（调度是图的纯函数，必然一致）。
    const logIndex = this.eventsExecuted - 1;
    if (logIndex < this.eventLog.length) {
      const expected = this.eventLog[logIndex];
      if (expected !== cid) {
        throw new Error(
          `replay diverged at event ${this.eventsExecuted}: ` +
            `expected coroutine ${expected}, got ${cid}`,
        );
      }
    } else {
      this.eventLog.push(cid);
    }
    if (this.eventsExecuted > this.highWaterMark) {
      this.highWaterMark = this.eventsExecuted;
    }
    this.trace.push({
      event: this.eventsExecuted,
      tick: this.tick,
      coroutine: cid,
      node: node.id,
      kind: node.kind,
      note,
    });

    // 新就绪的协程（派生子、被释放的阻塞者）已在 applyNode 期间入队；
    // 当前协程若仍就绪，排到队尾 → 同 tick 按 ID 轮转。
    if (c.status === "ready") this.readyQueue.push(cid);
    // 检查点必须落在队列状态一致之后。
    if (this.eventsExecuted % this.checkpointInterval === 0)
      this.saveCheckpoint();
    return false;
  }

  /** 节点语义。返回 trace 备注。 */
  private applyNode(c: Coroutine, node: FlowNode): string {
    switch (node.kind) {
      case "start":
        c.pc = node.next;
        return "";
      case "assign": {
        const value = evalExpr(node.expr, this.variables);
        if (!(node.target in this.variables)) {
          throw new RuntimeError(
            `assign to undeclared variable '${node.target}'`,
          );
        }
        this.variables[node.target] = value;
        c.pc = node.next;
        return `${node.target} = ${value}`;
      }
      case "condition": {
        const value = evalExpr(node.expr, this.variables);
        c.pc = value !== 0 ? node.onTrue : node.onFalse;
        return `${exprToString(node.expr)} → ${value !== 0 ? "true" : "false"}`;
      }
      case "loop": {
        const top = c.stack[c.stack.length - 1];
        if (top && top.loopNodeId === node.id) {
          top.remaining -= 1;
          if (top.remaining > 0) {
            c.pc = node.body;
            return `iteration, ${top.remaining} left`;
          }
          c.stack.pop();
          c.pc = node.next;
          return "loop done";
        }
        const count = evalExpr(node.count, this.variables);
        if (count > 0) {
          c.stack.push({ loopNodeId: node.id, remaining: count });
          c.pc = node.body;
          return `enter ${count} iterations`;
        }
        c.pc = node.next;
        return "skipped (0 iterations)";
      }
      case "wait": {
        if (node.ticks === 0) {
          c.pc = node.next;
          return "wait 0 (no-op)";
        }
        c.status = "waiting";
        c.wakeTick = this.tick + node.ticks; // pc 停留在 wait 节点，便于检视
        return `sleep until tick ${c.wakeTick}`;
      }
      case "spawn": {
        if (this.aliveCount() >= this.maxCoroutines) {
          c.status = "spawn-blocked"; // pc 停留在 spawn 节点，名额释放后重试
          return `blocked: coroutine capacity ${this.maxCoroutines} reached`;
        }
        const child: Coroutine = {
          id: this.nextCoroutineId++,
          parentId: c.id,
          pc: node.entry,
          stack: [], // 子协程拥有独立栈
          status: "ready",
          wakeTick: null,
          children: [],
        };
        this.coroutines.set(child.id, child);
        c.children.push(child.id);
        this.readyQueue.push(child.id); // 先于父协程重新入队
        c.pc = node.next;
        return `spawned coroutine ${child.id} at '${node.entry}'`;
      }
      case "join": {
        const pending = c.children.filter(
          (ch) => this.coroutines.get(ch)!.status !== "done",
        );
        if (pending.length === 0) {
          c.pc = node.next;
          return "all children done";
        }
        c.status = "joining"; // pc 停留在 join 节点
        return `waiting for children [${pending.join(", ")}]`;
      }
      case "end": {
        c.status = "done";
        c.pc = null;
        this.onCoroutineDone();
        return "done";
      }
    }
  }

  /** 协程结束后：释放 join 阻塞者与 spawn 名额阻塞者（按 ID 序入队）。 */
  private onCoroutineDone(): void {
    const released: number[] = [];
    for (const c of this.coroutines.values()) {
      if (
        c.status === "joining" &&
        c.children.every((ch) => this.coroutines.get(ch)!.status === "done")
      ) {
        c.status = "ready";
        released.push(c.id);
      }
    }
    for (const c of [...this.coroutines.values()].sort((a, b) => a.id - b.id)) {
      if (
        c.status === "spawn-blocked" &&
        this.aliveCount() < this.maxCoroutines
      ) {
        c.status = "ready";
        released.push(c.id);
      }
    }
    released.sort((a, b) => a - b);
    this.readyQueue.push(...released);
  }

  // -------------------------------------------------------------------------
  // 检查点与回退
  // -------------------------------------------------------------------------

  private saveCheckpoint(): void {
    const cp: Checkpoint = {
      eventsExecuted: this.eventsExecuted,
      tick: this.tick,
      nextCoroutineId: this.nextCoroutineId,
      variables: { ...this.variables },
      coroutines: structuredClone([...this.coroutines.values()]),
      readyQueue: [...this.readyQueue],
    };
    const existing = this.checkpoints.findIndex(
      (c) => c.eventsExecuted === cp.eventsExecuted,
    );
    if (existing >= 0) {
      this.checkpoints[existing] = cp; // 确定性重走到同一事件：内容必然一致
      return;
    }
    // 保持按 eventsExecuted 升序（回退后重走历史可能乱序保存）。
    let i = this.checkpoints.length;
    while (i > 0 && this.checkpoints[i - 1].eventsExecuted > cp.eventsExecuted)
      i--;
    this.checkpoints.splice(i, 0, cp);
  }

  /**
   * 回退到第 to 个事件之后的状态：恢复最近检查点，再确定性重放到 to。
   * to 可取 [0, 历史到达过的最大事件数] 中的任意值——调度是图的纯函数，
   * 检查点与事件日志永不失效，因此可以回退也可以“前进”到曾到达的点。
   * 断点不参与重放。
   */
  rollback(to: number): void {
    if (to < 0 || to > this.highWaterMark) {
      throw new Error(
        `rollback target ${to} out of range [0, ${this.highWaterMark}]`,
      );
    }
    this.pendingBreakpoint = null;

    let cpIndex = this.checkpoints.length - 1;
    while (cpIndex > 0 && this.checkpoints[cpIndex].eventsExecuted > to)
      cpIndex--;
    const cp = this.checkpoints[cpIndex];

    this.tick = cp.tick;
    this.nextCoroutineId = cp.nextCoroutineId;
    this.variables = { ...cp.variables };
    this.coroutines = new Map(
      structuredClone(cp.coroutines).map((c) => [c.id, c] as const),
    );
    this.readyQueue = [...cp.readyQueue];
    this.eventsExecuted = cp.eventsExecuted;
    this.status = this.eventsExecuted === 0 ? "idle" : "ready";
    this.terminateReason = null;
    this.trace.length = cp.eventsExecuted;

    // 确定性重放（execute 内部会对照事件日志校验调度序列）。
    while (this.eventsExecuted < to) {
      const next = this.ensureNext();
      if (!next.ok) {
        throw new Error(
          `replay diverged at event ${this.eventsExecuted}: no next event`,
        );
      }
      this.status = "ready";
      if (this.execute(next.cid)) {
        throw new Error(
          `replay hit termination at event ${this.eventsExecuted}`,
        );
      }
    }
    this.status = this.eventsExecuted === 0 ? "idle" : "ready";
  }

  // -------------------------------------------------------------------------
  // 检视
  // -------------------------------------------------------------------------

  blockReason(c: Coroutine): string | null {
    switch (c.status) {
      case "waiting":
        return `wait: sleeps until tick ${c.wakeTick}`;
      case "joining": {
        const pending = c.children.filter(
          (ch) => this.coroutines.get(ch)!.status !== "done",
        );
        return `join: waiting for children [${pending.join(", ")}]`;
      }
      case "spawn-blocked":
        return `spawn: coroutine capacity ${this.maxCoroutines} reached`;
      default:
        return null;
    }
  }

  coroutineViews() {
    return [...this.coroutines.values()]
      .sort((a, b) => a.id - b.id)
      .map((c) => ({
        id: c.id,
        parentId: c.parentId,
        status: c.status,
        pc: c.pc,
        wakeTick: c.wakeTick,
        stack: c.stack.map((f) => ({ ...f })),
        children: [...c.children],
        blockReason: this.blockReason(c),
      }));
  }

  nodeOf(id: string | null): FlowNode {
    const node = id === null ? undefined : this.nodeIndex.get(id);
    if (!node) throw new Error(`internal: unknown node '${id}'`);
    return node;
  }

  nodeLabelOf(id: string): string {
    const node = this.nodeIndex.get(id);
    return node ? nodeLabel(node) : id;
  }

  /** 历史上到达过的最大事件数。 */
  get maxEventsReached(): number {
    return this.highWaterMark;
  }

  // -------------------------------------------------------------------------
  // 内部工具
  // -------------------------------------------------------------------------

  private allDone(): boolean {
    for (const c of this.coroutines.values())
      if (c.status !== "done") return false;
    return true;
  }

  private aliveCount(): number {
    let n = 0;
    for (const c of this.coroutines.values()) if (c.status !== "done") n++;
    return n;
  }

  private minWakeTick(): number | null {
    let min: number | null = null;
    for (const c of this.coroutines.values()) {
      if (c.status === "waiting" && c.wakeTick !== null) {
        if (min === null || c.wakeTick < min) min = c.wakeTick;
      }
    }
    return min;
  }

  private terminate(reason: string): void {
    this.status = "terminated";
    this.terminateReason = reason;
  }
}
