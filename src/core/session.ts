import type { ConditionalRule } from "./conditional";
import type { FlowGraph, SessionStatus, Snapshot } from "./types";
import { Engine, type EngineOptions } from "./engine";
import { validateGraph, ValidationError } from "./graph";

export type CmdResult = { ok: true } | { ok: false; error: string };

const OK: CmdResult = { ok: true };

export interface SessionOptions {
  engineOptions?: EngineOptions;
  /** 每个运行切片最多执行多少条调度事件（之后让出事件循环，pause 才能生效）。 */
  sliceSize?: number;
  /** 切片之间让出控制权的方式（Worker 里用 setTimeout，测试里可注入同步泵）。 */
  yieldFn?: () => Promise<void>;
  /** 状态变化回调。 */
  onState?: (snapshot: Snapshot) => void;
}

/**
 * 调试会话：包装引擎，提供代次管理、可暂停的连续运行、回退。
 *
 * - 每次 loadGraph（新建或编辑图）都会开启新的执行代次；
 *   携带旧代次号的命令一律被拒绝（stale-generation）。
 * - continue 以切片方式运行；pause 在切片边界生效；
 *   reset / rollback / loadGraph 会使正在运行的循环失效（runToken）。
 */
export class DebuggerSession {
  generation = 0;

  private engine: Engine | null = null;
  private graph: FlowGraph | null = null;
  private breakpoints = new Set<string>();

  private readonly sliceSize: number;
  private readonly yieldFn: () => Promise<void>;
  private readonly engineOptions: EngineOptions;
  private readonly onState: (snapshot: Snapshot) => void;

  private runToken = 0;
  private pauseRequested = false;
  private running = false;

  constructor(options: SessionOptions = {}) {
    this.sliceSize = options.sliceSize ?? 256;
    this.yieldFn =
      options.yieldFn ?? (() => new Promise((r) => setTimeout(r, 0)));
    this.engineOptions = options.engineOptions ?? {};
    this.onState = options.onState ?? (() => {});
  }

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  /** 加载（或编辑后重新加载）图：开启新执行代次。 */
  loadGraph(raw: unknown): CmdResult {
    let graph: FlowGraph;
    try {
      graph = validateGraph(raw);
    } catch (err) {
      if (err instanceof ValidationError)
        return { ok: false, error: err.message };
      throw err;
    }
    this.generation++;
    this.runToken++; // 使旧图上的运行循环失效
    this.running = false;
    this.pauseRequested = false;
    this.graph = graph;
    // 新执行代次：旧图的条件断点配置不允许作用于新图（普通节点断点仍按
    // 节点 id 过滤保留）。
    this.engineOptions.conditionalRules = [];
    // 过滤掉不属于新图的断点
    const known = new Set(graph.nodes.map((n) => n.id));
    this.breakpoints = new Set(
      [...this.breakpoints].filter((id) => known.has(id)),
    );
    this.engine = this.freshEngine();
    this.emit();
    return OK;
  }

  /** 单步：只执行下一条调度事件（断点会在副作用前停住）。 */
  step(generation?: number): CmdResult {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    if (!this.engine) return { ok: false, error: "no graph loaded" };
    if (this.running) return { ok: false, error: "cannot step while running" };
    this.engine.stepEvent();
    this.emit();
    return OK;
  }

  /** 连续运行：直到断点 / 暂停 / 结束 / 终止。 */
  async continue(generation?: number): Promise<CmdResult> {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    if (!this.engine) return { ok: false, error: "no graph loaded" };
    if (this.running) return { ok: false, error: "already running" };

    const engine = this.engine;
    const token = ++this.runToken;
    this.running = true;
    this.pauseRequested = false;
    this.emit();
    try {
      for (;;) {
        for (let i = 0; i < this.sliceSize; i++) {
          const result = engine.stepEvent();
          if (result !== "executed") return OK; // breakpoint / done / terminated
        }
        this.emit(); // 进度汇报
        if (this.pauseRequested) return OK; // 已暂停
        await this.yieldFn();
        // 让出期间可能发生 reset / rollback / loadGraph：本循环必须静默退出，
        // 不得再触碰（可能已被替换的）状态。
        if (token !== this.runToken) return OK;
        // 让出期间收到的 pause 在下一切片开始前生效。
        if (this.pauseRequested) return OK;
      }
    } finally {
      // 只有未被取代的运行循环才能清除 running 标志并汇报最终状态
      // （paused / breakpoint / done / terminated）。
      if (token === this.runToken) {
        this.running = false;
        this.emit();
      }
    }
  }

  /** 请求暂停：在下一个切片边界生效。 */
  pause(generation?: number): CmdResult {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    this.pauseRequested = true;
    return OK;
  }

  /** 重置：回到当前图的初始状态（代次不变）。 */
  reset(generation?: number): CmdResult {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    if (!this.graph) return { ok: false, error: "no graph loaded" };
    this.runToken++; // 中止进行中的运行循环
    this.running = false;
    this.pauseRequested = false;
    this.engine = this.freshEngine();
    this.emit();
    return OK;
  }

  /** 回退到第 to 个事件之后的状态（检查点 + 确定性重放）。 */
  rollback(to: number, generation?: number): CmdResult {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    if (!this.engine) return { ok: false, error: "no graph loaded" };
    if (this.running)
      return { ok: false, error: "cannot rollback while running" };
    this.runToken++;
    try {
      this.engine.rollback(to);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.emit();
    return OK;
  }

  /** 设置断点（不存在的节点 id 会被忽略）。 */
  setBreakpoints(breakpoints: string[], generation?: number): CmdResult {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    if (!this.engine) return { ok: false, error: "no graph loaded" };
    const known = new Set(this.engine.graph.nodes.map((n) => n.id));
    this.breakpoints = new Set(breakpoints.filter((id) => known.has(id)));
    this.engine.breakpoints = new Set(this.breakpoints);
    this.emit();
    return OK;
  }

  setConditionalBreakpoints(
    rules: ConditionalRule[],
    generation?: number,
  ): CmdResult {
    const stale = this.checkGeneration(generation);
    if (stale) return stale;
    if (!this.engine || !this.graph)
      return { ok: false, error: "no graph loaded" };
    if (this.running || this.engine.eventsExecuted !== 0)
      return { ok: false, error: "reset before changing conditions" };
    const prior = this.engineOptions.conditionalRules;
    try {
      this.engineOptions.conditionalRules = structuredClone(rules);
      this.engine = this.freshEngine();
    } catch (err) {
      this.engineOptions.conditionalRules = prior;
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.emit();
    return OK;
  }

  getSnapshot(): Snapshot | null {
    if (!this.engine) return null;
    const engine = this.engine;
    let status: SessionStatus;
    switch (engine.status) {
      case "idle":
        status = "idle";
        break;
      case "breakpoint":
        status = "breakpoint";
        break;
      case "done":
        status = "done";
        break;
      case "terminated":
        status = "terminated";
        break;
      default:
        status = this.running ? "running" : "paused";
    }
    return {
      generation: this.generation,
      status,
      tick: engine.tick,
      eventsExecuted: engine.eventsExecuted,
      eventsHighWater: engine.maxEventsReached,
      variables: { ...engine.variables },
      coroutines: engine.coroutineViews(),
      breakpoints: [...this.breakpoints],
      pendingBreakpoint: engine.pendingBreakpoint
        ? { ...engine.pendingBreakpoint }
        : null,
      terminateReason: engine.terminateReason,
      trace: [...engine.trace],
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  private freshEngine(): Engine {
    return new Engine(this.graph!, {
      ...this.engineOptions,
      breakpoints: new Set(this.breakpoints),
    });
  }

  private checkGeneration(generation?: number): CmdResult | null {
    if (generation !== undefined && generation !== this.generation) {
      return {
        ok: false,
        error: `stale-generation: command targets generation ${generation}, current is ${this.generation}`,
      };
    }
    return null;
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    if (snapshot) this.onState(snapshot);
  }
}
