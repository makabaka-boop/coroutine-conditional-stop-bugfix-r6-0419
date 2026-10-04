/**
 * 流程图调试器 —— 核心类型定义。
 *
 * 图由节点组成，主协程从 start 节点开始执行。
 * 所有协程共享图中声明的变量，但各自拥有独立的循环栈。
 */

// ---------------------------------------------------------------------------
// 表达式（整数运算，确定性求值）
// ---------------------------------------------------------------------------

export type Expr =
  | { kind: "lit"; value: number }
  | { kind: "var"; name: string }
  | { kind: "bin"; op: BinOp; left: Expr; right: Expr }
  | { kind: "neg"; expr: Expr };

export type BinOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "<"
  | "<="
  | ">"
  | ">="
  | "=="
  | "!=";

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

export type NodeKind =
  | "start"
  | "assign"
  | "condition"
  | "loop"
  | "wait"
  | "spawn"
  | "join"
  | "end";

interface NodeBase {
  id: string;
  kind: NodeKind;
}

/** 起始节点：主协程的入口。 */
export interface StartNode extends NodeBase {
  kind: "start";
  next: string | null;
}

/** 赋值：target = expr（target 必须是图中已声明的变量）。 */
export interface AssignNode extends NodeBase {
  kind: "assign";
  target: string;
  expr: Expr;
  next: string | null;
}

/** 条件：expr 非 0 走 onTrue，否则走 onFalse。 */
export interface ConditionNode extends NodeBase {
  kind: "condition";
  expr: Expr;
  onTrue: string | null;
  onFalse: string | null;
}

/** 循环：count 次迭代。进入时压栈一帧，循环体末尾应指回本节点。 */
export interface LoopNode extends NodeBase {
  kind: "loop";
  count: Expr;
  body: string | null;
  next: string | null;
}

/** 等待：挂起所属协程 ticks 个虚拟 tick（0 表示不挂起）。 */
export interface WaitNode extends NodeBase {
  kind: "wait";
  ticks: number;
  next: string | null;
}

/** 派生：创建子协程从 entry 开始执行；父协程继续走 next。 */
export interface SpawnNode extends NodeBase {
  kind: "spawn";
  entry: string;
  next: string | null;
}

/** 等待子协程完成：阻塞到本协程的全部直接子协程结束。 */
export interface JoinNode extends NodeBase {
  kind: "join";
  next: string | null;
}

/** 结束：协程终止。 */
export interface EndNode extends NodeBase {
  kind: "end";
}

export type FlowNode =
  | StartNode
  | AssignNode
  | ConditionNode
  | LoopNode
  | WaitNode
  | SpawnNode
  | JoinNode
  | EndNode;

// ---------------------------------------------------------------------------
// 图
// ---------------------------------------------------------------------------

export interface FlowGraph {
  /** 共享声明变量及其初值。 */
  variables: Record<string, number>;
  /** start 节点的 id。 */
  start: string;
  nodes: FlowNode[];
}

// ---------------------------------------------------------------------------
// 运行时状态
// ---------------------------------------------------------------------------

export type CoroutineStatus =
  | "ready" // 可调度
  | "waiting" // 被 wait 挂起，wakeTick 时唤醒
  | "joining" // 阻塞在 join，等待子协程
  | "spawn-blocked" // 阻塞在 spawn，等待协程名额
  | "done"; // 已结束

export interface LoopFrame {
  loopNodeId: string;
  remaining: number;
}

export interface Coroutine {
  id: number;
  parentId: number | null;
  /** 当前节点 id；done 时为 null。 */
  pc: string | null;
  /** 本协程私有的循环帧栈。 */
  stack: LoopFrame[];
  status: CoroutineStatus;
  /** status === 'waiting' 时的唤醒 tick。 */
  wakeTick: number | null;
  /** 本协程派生的直接子协程 id。 */
  children: number[];
}

export type EngineStatus =
  | "idle" // 尚未执行任何事件
  | "ready" // 可继续推进
  | "breakpoint" // 停在断点（副作用尚未发生）
  | "done" // 全部协程结束
  | "terminated"; // 超限 / 死等 / 运行时错误，被明确终止

export type StepResult = "executed" | "breakpoint" | "done" | "terminated";

export interface TraceEntry {
  /** 第几个调度事件（从 1 开始）。 */
  event: number;
  tick: number;
  coroutine: number;
  node: string;
  kind: NodeKind;
  note: string;
}

// ---------------------------------------------------------------------------
// 快照（引擎 → UI 的只读视图）
// ---------------------------------------------------------------------------

export interface CoroutineView {
  id: number;
  parentId: number | null;
  status: CoroutineStatus;
  pc: string | null;
  wakeTick: number | null;
  stack: LoopFrame[];
  children: number[];
  /** 人类可读的阻塞原因；未阻塞为 null。 */
  blockReason: string | null;
}

export type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "breakpoint"
  | "done"
  | "terminated";

export interface Snapshot {
  generation: number;
  status: SessionStatus;
  tick: number;
  eventsExecuted: number;
  /** 历史上到达过的最大事件数（回退/前进可选范围的上界）。 */
  eventsHighWater: number;
  variables: Record<string, number>;
  coroutines: CoroutineView[];
  breakpoints: string[];
  pendingBreakpoint: { coroutineId: number; nodeId: string } | null;
  terminateReason: string | null;
  trace: TraceEntry[];
}

// ---------------------------------------------------------------------------
// 限制常量
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxNodes: 30,
  maxCoroutines: 4,
  maxNodeExecutions: 5000,
  maxTicks: 500,
} as const;
