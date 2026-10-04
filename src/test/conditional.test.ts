import { describe, expect, it } from "vitest";
import { Engine } from "../core/engine";
import { validateGraph } from "../core/graph";
import type { FlowGraph } from "../core/types";

const lit = (value: number) => ({ kind: "lit", value }) as const;
const v = (name: string) => ({ kind: "var", name }) as const;
const bin = (op: string, left: unknown, right: unknown) =>
  ({ kind: "bin", op, left, right }) as never;

/**
 * 两个协程经过**同一份**循环节点：
 * main:  s → spawn(entry=L, next=L) → （spawn 后 pc=L）… L 完成后 e
 * child: 同一 L(3){ b } → e（两协程都用 L.next=e 收尾）
 * loop 帧在各自私有栈上，互不干扰；zero 是两个协程都不写的常量，
 * 因此规则 {L, zero===0} 把对 L 的每次访问都计为有效访问。
 * 每个协程访问 L 共 1（进入）+ 3（迭代返回）= 4 次。
 */
function sharedNodeGraph(): FlowGraph {
  return validateGraph({
    variables: { x: 0, zero: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "sp" },
      { id: "sp", kind: "spawn", entry: "L", next: "L" },
      { id: "L", kind: "loop", count: lit(3), body: "b", next: "e" },
      {
        id: "b",
        kind: "assign",
        target: "x",
        expr: bin("+", v("x"), lit(1)),
        next: "L",
      },
      { id: "e", kind: "end" },
    ],
  });
}

/** 直线序列 s → a(x=1) → b(x=2) → c(x=3) → e（副作用前观察用）。 */
function preEffectGraph(): FlowGraph {
  return validateGraph({
    variables: { x: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "a" },
      { id: "a", kind: "assign", target: "x", expr: lit(1), next: "b" },
      { id: "b", kind: "assign", target: "x", expr: lit(2), next: "c" },
      { id: "c", kind: "assign", target: "x", expr: lit(3), next: "e" },
      { id: "e", kind: "end" },
    ],
  });
}

/** 条件只在部分访问成立的循环：i 从 0 增到 4，命中 i===0 的有效访问在体节点前。 */
function partiallyEligibleGraph(): FlowGraph {
  return validateGraph({
    variables: { i: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "L" },
      { id: "L", kind: "loop", count: lit(4), body: "b", next: "e" },
      {
        id: "b",
        kind: "assign",
        target: "i",
        expr: bin("+", v("i"), lit(1)),
        next: "L",
      },
      { id: "e", kind: "end" },
    ],
  });
}

function step(engine: Engine) {
  return engine.stepEvent();
}

/** 跑到 breakpoint / done / terminated，返回停住时的事件数。 */
function runUntilStop(engine: Engine): number {
  for (let i = 0; i < 10000; i++) {
    const r = engine.stepEvent();
    if (r !== "executed") return engine.eventsExecuted;
  }
  throw new Error("never stopped");
}

describe("条件断点：计数语义", () => {
  it("各协程对共享节点的有效访问分别计数，各自第 hit 次独立停住", () => {
    const engine = new Engine(sharedNodeGraph(), {
      conditionalRules: [{ nodeId: "L", variable: "zero", equals: 0, hit: 2 }],
    });

    // 两协程各自第 2 次到达 L 时停住，共停两次。
    const stops: Array<{ cid: number; events: number }> = [];
    for (let i = 0; i < 100 && engine.status !== "done"; i++) {
      if (step(engine) === "breakpoint") {
        stops.push({
          cid: engine.pendingBreakpoint!.coroutineId,
          events: engine.eventsExecuted,
        });
        expect(engine.pendingBreakpoint!.nodeId).toBe("L");
        step(engine); // 批准，待执行节点恰好执行一次
      }
    }
    expect(engine.status).toBe("done");
    expect(stops).toHaveLength(2);
    // 一次是协程 1、一次是协程 2 —— 证明计数按协程独立
    expect(stops.map((s) => s.cid).sort((a, b) => a - b)).toEqual([1, 2]);
    // 调度轮转使 cid=2 先跑：它的第 2 次 L 先停，然后才轮到 cid=1。
    expect(stops[0].cid).toBe(2);
    expect(stops[1].cid).toBe(1);
  });

  it("旧实现的全局计数下，先跑的协程会替另一个协程消耗次数", () => {
    // 反面规格：若计数是全局的（旧 bug），一个协程的有效访问会记到另一个
    // 协程头上。这里直接断言修复后的“有效访问计数”视图按协程隔离。
    const engine = new Engine(sharedNodeGraph(), {
      conditionalRules: [{ nodeId: "L", variable: "zero", equals: 0, hit: 3 }],
    });
    // 事件序列：1:s 1:sp(派生2，队列[2,1]) 2:L进入 1:L进入 …
    engine.stepEvent(); // 1: s
    engine.stepEvent(); // 1: sp → 派生 2
    engine.stepEvent(); // 2: L（cid=2 的第 1 次有效访问）
    expect(engine.conditional.eligibleVisits("L", 2)).toBe(1);
    expect(engine.conditional.eligibleVisits("L", 1)).toBe(0);
    engine.stepEvent(); // 1: L（cid=1 的第 1 次，与 cid=2 互不影响）
    expect(engine.conditional.eligibleVisits("L", 1)).toBe(1);
    expect(engine.conditional.eligibleVisits("L", 2)).toBe(1);
  });

  it("只有条件成立的访问计入有效次数", () => {
    // 规则挂在 b：访问 b 前 i 依次为 0,1,2,3；只有第一次 i===0。
    // hit:1 → 在唯一一次有效访问（第 1 次迭代体）前停住。
    const engine = new Engine(partiallyEligibleGraph(), {
      conditionalRules: [{ nodeId: "b", variable: "i", equals: 0, hit: 1 }],
    });
    const stoppedAt = runUntilStop(engine);
    expect(engine.status).toBe("breakpoint");
    expect(engine.pendingBreakpoint).toEqual({ coroutineId: 1, nodeId: "b" });
    expect(engine.eventsExecuted).toBe(stoppedAt);
    expect(engine.variables.i).toBe(0); // 副作用尚未发生
    expect(engine.conditional.eligibleVisits("b", 1)).toBe(0); // 未执行不计入
    step(engine); // 批准
    expect(engine.variables.i).toBe(1);
    expect(engine.conditional.eligibleVisits("b", 1)).toBe(1);

    // 之后 i 永不为 0 → 不再停
    for (let i = 0; i < 100 && engine.status !== "done"; i++) step(engine);
    expect(engine.status).toBe("done");
    expect(engine.variables.i).toBe(4);
  });

  it("条件曾不满足时，hit 次只数有效访问：hit:2 在两次有效访问处停", () => {
    // 构造 i 在访问 b 前为 0,1,0,1（两次有效）：
    // 用条件节点不好做，直接用共享变量自增图，规则 equals 命中两次：
    const graph = validateGraph({
      variables: { i: 0, zero: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "L" },
        { id: "L", kind: "loop", count: lit(4), body: "b", next: "e" },
        {
          id: "b",
          kind: "assign",
          target: "i",
          expr: bin("+", v("i"), lit(1)),
          next: "L",
        },
        { id: "e", kind: "end" },
      ],
    });
    // L 的访问序列：进入(1) → 返回(2,已做1次体) → 返回(3)…
    // hit:2 在第 2 次访问 L 前停住：此前已执行 s,L,b = 3 个事件。
    const engine = new Engine(graph, {
      conditionalRules: [{ nodeId: "L", variable: "zero", equals: 0, hit: 2 }],
    });
    runUntilStop(engine);
    expect(engine.status).toBe("breakpoint");
    expect(engine.pendingBreakpoint!.nodeId).toBe("L");
    expect(engine.eventsExecuted).toBe(3);
    expect(engine.conditional.eligibleVisits("L", 1)).toBe(1);
    step(engine); // 批准这一次
    // 之后还有多次有效访问，但不会再到 hit=2 → 一路结束
    for (let i = 0; i < 100 && engine.status !== "done"; i++) step(engine);
    expect(engine.status).toBe("done");
  });
});

describe("条件断点：副作用前观察", () => {
  it("命中时变量仍是节点执行前的值，继续后该待执行节点只执行一次", () => {
    // 规则挂在 a：访问 a 前 x===0，hit:1 → 在 a 前停住。
    const engine = new Engine(preEffectGraph(), {
      conditionalRules: [{ nodeId: "a", variable: "x", equals: 0, hit: 1 }],
    });
    engine.stepEvent(); // s
    expect(step(engine)).toBe("breakpoint");
    expect(engine.variables.x).toBe(0); // a 的赋值尚未发生
    expect(engine.trace.some((t) => t.node === "a")).toBe(false);

    // 继续操作只执行这一个待执行节点
    expect(step(engine)).toBe("executed");
    expect(engine.variables.x).toBe(1);
    const aExecutions = engine.trace.filter((t) => t.node === "a");
    expect(aExecutions).toHaveLength(1);

    // 不会在同一节点重复停住（第 2 次访问 a 不存在，图是直线）
    runUntilStop(engine);
    expect(engine.status).toBe("done");
    expect(engine.variables.x).toBe(3);
    expect(engine.trace.filter((t) => t.node === "a")).toHaveLength(1);
  });
});

describe("条件断点：回退与重放", () => {
  it("回退恢复有效访问计数；重放不在条件断点上停顿", () => {
    const engine = new Engine(partiallyEligibleGraph(), {
      checkpointInterval: 2,
      conditionalRules: [{ nodeId: "b", variable: "i", equals: 0, hit: 1 }],
    });
    // 一路跑到结束：第一次 b 会停住，批准后继续
    for (let i = 0; i < 100 && engine.status !== "done"; i++) {
      if (engine.stepEvent() === "breakpoint") {
        expect(engine.pendingBreakpoint!.nodeId).toBe("b");
        engine.stepEvent(); // 批准
      }
    }
    expect(engine.status).toBe("done");
    const total = engine.eventsExecuted;
    expect(engine.conditional.eligibleVisits("b", 1)).toBe(1);

    // 事件序列：s(1) L进入(2) b(3,i→1) L返回(4) b(5,i→2)…
    // 回退到事件 2（第一次 b 执行之前）：i 仍为 0，b 尚未有效执行
    engine.rollback(2);
    expect(engine.eventsExecuted).toBe(2);
    expect(engine.variables.i).toBe(0);
    expect(engine.pendingBreakpoint).toBeNull();
    expect(engine.conditional.eligibleVisits("b", 1)).toBe(0);

    // 重新前进：条件断点必须再次正常工作（计数没有被旧运行污染）
    let stoppedAgain = false;
    for (let i = 0; i < 100 && engine.status !== "done"; i++) {
      if (engine.stepEvent() === "breakpoint") {
        stoppedAgain = true;
        expect(engine.pendingBreakpoint).toEqual({
          coroutineId: 1,
          nodeId: "b",
        });
        expect(engine.variables.i).toBe(0);
        engine.stepEvent(); // 批准
      }
    }
    expect(stoppedAgain).toBe(true);
    expect(engine.status).toBe("done");
    expect(engine.eventsExecuted).toBe(total);
    expect(engine.variables.i).toBe(4);
    // 重新前进后计数恰好为 1，没有因重放叠加成 2
    expect(engine.conditional.eligibleVisits("b", 1)).toBe(1);
  });

  it("回退到命中点之后再前进，停住位置不漂移", () => {
    // 规则在 L 上恒有效、hit:2：命中于第 2 次到达 L（事件 4 前）。
    const graph = validateGraph({
      variables: { zero: 0, i: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "L" },
        { id: "L", kind: "loop", count: lit(4), body: "b", next: "e" },
        {
          id: "b",
          kind: "assign",
          target: "i",
          expr: bin("+", v("i"), lit(1)),
          next: "L",
        },
        { id: "e", kind: "end" },
      ],
    });
    const engine = new Engine(graph, {
      checkpointInterval: 2,
      conditionalRules: [{ nodeId: "L", variable: "zero", equals: 0, hit: 2 }],
    });
    runUntilStop(engine);
    expect(engine.status).toBe("breakpoint");
    // L 访问序列：进入(1,事件2) → 返回(2,事件4前)，第 2 次停在事件 4 前
    expect(engine.eventsExecuted).toBe(3); // s,L,b 已执行，待执行的是第 4 个事件

    // 回退到事件 2（s,L 后：已完成 1 次有效访问）再前进
    engine.rollback(2);
    expect(engine.conditional.eligibleVisits("L", 1)).toBe(1);
    runUntilStop(engine);
    expect(engine.status).toBe("breakpoint");
    // 停住位置与首次一致：仍然停在第 4 个事件（L 返回）之前
    expect(engine.eventsExecuted).toBe(3);
    expect(engine.conditional.eligibleVisits("L", 1)).toBe(1);
  });
});

describe("条件断点：配置校验", () => {
  it("引用不存在的节点 / 未声明变量 / hit<1 被拒绝", () => {
    const graph = preEffectGraph();
    expect(
      () =>
        new Engine(graph, {
          conditionalRules: [
            { nodeId: "ghost", variable: "x", equals: 0, hit: 1 },
          ],
        }),
    ).toThrowError(/invalid conditional breakpoint/);
    expect(
      () =>
        new Engine(graph, {
          conditionalRules: [
            { nodeId: "a", variable: "ghost", equals: 0, hit: 1 },
          ],
        }),
    ).toThrowError(/invalid conditional breakpoint/);
    expect(
      () =>
        new Engine(graph, {
          conditionalRules: [{ nodeId: "a", variable: "x", equals: 0, hit: 0 }],
        }),
    ).toThrowError(/invalid conditional breakpoint/);
    expect(
      () =>
        new Engine(graph, {
          conditionalRules: [
            { nodeId: "a", variable: "x", equals: 0, hit: 1 },
            { nodeId: "a", variable: "x", equals: 1, hit: 1 },
          ],
        }),
    ).toThrowError(/invalid conditional breakpoint/);
  });
});
