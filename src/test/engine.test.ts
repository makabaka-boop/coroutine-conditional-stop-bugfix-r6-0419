import { describe, expect, it } from "vitest";
import { Engine } from "../core/engine";
import { validateGraph } from "../core/graph";
import type { FlowGraph } from "../core/types";

// ---------------------------------------------------------------------------
// 测试用图
// ---------------------------------------------------------------------------

const lit = (value: number) => ({ kind: "lit", value }) as const;
const v = (name: string) => ({ kind: "var", name }) as const;
const bin = (op: string, left: unknown, right: unknown) =>
  ({ kind: "bin", op, left, right }) as never;

/** main: start → spawn(child=c1) → join → assign done=1 → end；child: wait 3 → assign x=42 → end */
function crossCoroutineGraph(): FlowGraph {
  return validateGraph({
    variables: { x: 0, done: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "sp" },
      { id: "sp", kind: "spawn", entry: "c1", next: "j" },
      { id: "j", kind: "join", next: "a" },
      { id: "a", kind: "assign", target: "done", expr: lit(1), next: "e" },
      { id: "e", kind: "end" },
      { id: "c1", kind: "wait", ticks: 3, next: "c2" },
      { id: "c2", kind: "assign", target: "x", expr: lit(42), next: "c3" },
      { id: "c3", kind: "end" },
    ],
  });
}

/** main: start → assign a → assign b → end（断点测试用） */
function assignGraph(): FlowGraph {
  return validateGraph({
    variables: { x: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "a" },
      { id: "a", kind: "assign", target: "x", expr: lit(5), next: "b" },
      {
        id: "b",
        kind: "assign",
        target: "x",
        expr: bin("+", v("x"), lit(1)),
        next: "e",
      },
      { id: "e", kind: "end" },
    ],
  });
}

/** main: start → spawn → a1 → a2 → end；child: b1 → b2 → end（调度顺序测试用） */
function interleaveGraph(): FlowGraph {
  return validateGraph({
    variables: { a: 0, b: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "sp" },
      { id: "sp", kind: "spawn", entry: "b1", next: "a1" },
      { id: "a1", kind: "assign", target: "a", expr: lit(1), next: "a2" },
      { id: "a2", kind: "assign", target: "a", expr: lit(2), next: "ae" },
      { id: "ae", kind: "end" },
      { id: "b1", kind: "assign", target: "b", expr: lit(1), next: "b2" },
      { id: "b2", kind: "assign", target: "b", expr: lit(2), next: "be" },
      { id: "be", kind: "end" },
    ],
  });
}

/** main: start → loop(3){ i = i + 1 } → end */
function loopGraph(): FlowGraph {
  return validateGraph({
    variables: { i: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "L" },
      { id: "L", kind: "loop", count: lit(3), body: "body", next: "e" },
      {
        id: "body",
        kind: "assign",
        target: "i",
        expr: bin("+", v("i"), lit(1)),
        next: "L",
      },
      { id: "e", kind: "end" },
    ],
  });
}

/** 死循环：start → L(loop 1){cond true → L}… 实际用 condition 自环 */
function infiniteGraph(): FlowGraph {
  return validateGraph({
    variables: { x: 0 },
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "c" },
      { id: "c", kind: "condition", expr: lit(1), onTrue: "a", onFalse: "e" },
      {
        id: "a",
        kind: "assign",
        target: "x",
        expr: bin("+", v("x"), lit(1)),
        next: "c",
      },
      { id: "e", kind: "end" },
    ],
  });
}

/** 协程名额死等：main→spawn c1→join；c1→spawn c2→join；c2→spawn c3→join；c3→spawn(第5个，阻塞) */
function deadlockGraph(): FlowGraph {
  return validateGraph({
    variables: {},
    start: "s",
    nodes: [
      { id: "s", kind: "start", next: "s1" },
      { id: "s1", kind: "spawn", entry: "c1s", next: "j1" },
      { id: "j1", kind: "join", next: "e1" },
      { id: "e1", kind: "end" },
      { id: "c1s", kind: "spawn", entry: "c2s", next: "j2" },
      { id: "j2", kind: "join", next: "e2" },
      { id: "e2", kind: "end" },
      { id: "c2s", kind: "spawn", entry: "c3s", next: "j3" },
      { id: "j3", kind: "join", next: "e3" },
      { id: "e3", kind: "end" },
      { id: "c3s", kind: "spawn", entry: "c4s", next: "e4" },
      { id: "e4", kind: "end" },
      { id: "c4s", kind: "end" },
    ],
  });
}

function runToEnd(engine: Engine): void {
  for (
    let i = 0;
    i < 20000 && engine.status !== "done" && engine.status !== "terminated";
    i++
  ) {
    engine.stepEvent();
  }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

describe("引擎：基本执行", () => {
  it("赋值与条件按序执行，变量共享", () => {
    const engine = new Engine(assignGraph());
    runToEnd(engine);
    expect(engine.status).toBe("done");
    expect(engine.variables.x).toBe(6); // 5 然后 +1
  });

  it("循环节点通过私有栈计次，循环体执行 count 次", () => {
    const engine = new Engine(loopGraph());
    runToEnd(engine);
    expect(engine.status).toBe("done");
    expect(engine.variables.i).toBe(3);
  });

  it("同一 tick 的就绪协程按 ID 轮转推进", () => {
    const engine = new Engine(interleaveGraph());
    runToEnd(engine);
    expect(engine.status).toBe("done");
    // 调度序列：1(start) 1(spawn) 2(b1) 1(a1) 2(b2) 1(a2) 2(end) 1(end)
    const seq = engine.trace.map((t) => t.coroutine);
    expect(seq).toEqual([1, 1, 2, 1, 2, 1, 2, 1]);
    // 每个事件执行一个节点
    expect(engine.eventsExecuted).toBe(8);
  });
});

describe("引擎：跨协程等待", () => {
  it("wait 挂起所属协程并推进虚拟时间；join 阻塞到子协程完成", () => {
    const engine = new Engine(crossCoroutineGraph());
    const seen: string[] = [];
    while (engine.status !== "done" && engine.status !== "terminated") {
      engine.stepEvent();
      const main = engine.coroutineViews().find((c) => c.id === 1)!;
      const child = engine.coroutineViews().find((c) => c.id === 2);
      seen.push(
        `t${engine.tick} main=${main.status}${main.pc ? "@" + main.pc : ""} ` +
          (child
            ? `child=${child.status}${child.pc ? "@" + child.pc : ""}`
            : "child=∙"),
      );
    }
    expect(engine.status).toBe("done");
    // 子协程 sleep 到 tick 3；main 在 join 上阻塞期间 tick 推进到 3
    expect(engine.tick).toBe(3);
    // 子先写 x=42，main 醒来后写 done=1
    expect(engine.variables.x).toBe(42);
    expect(engine.variables.done).toBe(1);
    // trace 顺序：子协程的赋值发生在 main 的赋值之前
    const trace = engine.trace;
    const childAssign = trace.findIndex((t) => t.node === "c2");
    const mainAssign = trace.findIndex((t) => t.node === "a");
    expect(childAssign).toBeGreaterThan(-1);
    expect(mainAssign).toBeGreaterThan(childAssign);
    // main 曾被 join 阻塞、子协程曾因 wait 挂起
    expect(seen.some((s) => s.includes("main=joining@j"))).toBe(true);
    expect(seen.some((s) => s.includes("child=waiting@c1"))).toBe(true);
  });

  it("阻塞原因可检视：wait 给出唤醒 tick，join 列出未完成子协程", () => {
    const engine = new Engine(crossCoroutineGraph());
    // 推进到 main 阻塞在 join、子协程在 sleep
    while (engine.status !== "done" && engine.status !== "terminated") {
      engine.stepEvent();
      const views = engine.coroutineViews();
      const main = views.find((c) => c.id === 1)!;
      const child = views.find((c) => c.id === 2);
      if (main.status === "joining" && child?.status === "waiting") {
        expect(main.blockReason).toBe("join: waiting for children [2]");
        expect(child.blockReason).toBe("wait: sleeps until tick 3");
        expect(child.wakeTick).toBe(3);
        return;
      }
    }
    throw new Error("never observed the expected blocked state");
  });

  it("派生后父子各自拥有独立的循环栈", () => {
    const graph = validateGraph({
      variables: { p: 0, q: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "sp" },
        { id: "sp", kind: "spawn", entry: "cL", next: "pL" },
        // 父循环 2 次
        { id: "pL", kind: "loop", count: lit(2), body: "pb", next: "j" },
        {
          id: "pb",
          kind: "assign",
          target: "p",
          expr: bin("+", v("p"), lit(1)),
          next: "pL",
        },
        { id: "j", kind: "join", next: "e" },
        { id: "e", kind: "end" },
        // 子循环 3 次
        { id: "cL", kind: "loop", count: lit(3), body: "cb", next: "ce" },
        {
          id: "cb",
          kind: "assign",
          target: "q",
          expr: bin("+", v("q"), lit(1)),
          next: "cL",
        },
        { id: "ce", kind: "end" },
      ],
    });
    const engine = new Engine(graph);
    runToEnd(engine);
    expect(engine.status).toBe("done");
    expect(engine.variables.p).toBe(2);
    expect(engine.variables.q).toBe(3);
    // 运行结束后两个协程的栈都应为空（帧已弹出）
    for (const c of engine.coroutineViews()) expect(c.stack).toEqual([]);
  });
});

describe("引擎：断点", () => {
  it("断点在节点副作用前停住，下一事件才执行副作用", () => {
    const engine = new Engine(assignGraph(), { breakpoints: new Set(["a"]) });
    // 第 1 步：start（无断点）
    expect(engine.stepEvent()).toBe("executed");
    // 第 2 步：命中节点 a 的断点 —— 停住，x 仍为 0
    expect(engine.stepEvent()).toBe("breakpoint");
    expect(engine.status).toBe("breakpoint");
    expect(engine.variables.x).toBe(0);
    expect(engine.pendingBreakpoint).toEqual({ coroutineId: 1, nodeId: "a" });
    // 第 3 步：执行被批准的 a —— 副作用发生，x 变为 5
    expect(engine.stepEvent()).toBe("executed");
    expect(engine.variables.x).toBe(5);
    // 继续到结束：x = 6
    runToEnd(engine);
    expect(engine.variables.x).toBe(6);
  });

  it("循环体上的断点每次迭代都会停住", () => {
    const engine = new Engine(loopGraph(), { breakpoints: new Set(["body"]) });
    let hits = 0;
    for (let i = 0; i < 100 && engine.status !== "done"; i++) {
      if (engine.stepEvent() === "breakpoint") {
        hits++;
        // 停住时副作用未发生：i 记录的是已完成的迭代数
        expect(engine.variables.i).toBe(hits - 1);
      }
    }
    expect(hits).toBe(3);
    expect(engine.variables.i).toBe(3);
  });
});

describe("引擎：检查点回退与确定性重放", () => {
  it("回退到任意事件后，状态与首次执行到该点时完全一致", () => {
    const graph = validateGraph({
      variables: { i: 0, acc: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "L" },
        { id: "L", kind: "loop", count: lit(8), body: "b1", next: "e" },
        {
          id: "b1",
          kind: "assign",
          target: "i",
          expr: bin("+", v("i"), lit(1)),
          next: "b2",
        },
        {
          id: "b2",
          kind: "assign",
          target: "acc",
          expr: bin("+", v("acc"), bin("*", v("i"), lit(2))),
          next: "L",
        },
        { id: "e", kind: "end" },
      ],
    });
    // 参考运行：逐事件记录变量快照
    const reference = new Engine(graph, { checkpointInterval: 3 });
    const history: Array<{ i: number; acc: number; tick: number }> = [
      { i: 0, acc: 0, tick: 0 },
    ];
    while (reference.status !== "done" && reference.status !== "terminated") {
      reference.stepEvent();
      history.push({
        i: reference.variables.i,
        acc: reference.variables.acc,
        tick: reference.tick,
      });
    }
    const total = reference.eventsExecuted;

    // 实际运行：一路跑到结束，再逐个回退校验
    const engine = new Engine(graph, { checkpointInterval: 3 });
    runToEnd(engine);
    expect(engine.eventsExecuted).toBe(total);

    for (const to of [total, total - 1, 7, 4, 3, 1, 0]) {
      engine.rollback(to);
      expect(engine.eventsExecuted).toBe(to);
      expect(engine.variables.i).toBe(history[to].i);
      expect(engine.variables.acc).toBe(history[to].acc);
      expect(engine.tick).toBe(history[to].tick);
      expect(engine.trace.length).toBe(to);
    }
    // 回退后可以继续前进，且结果与参考一致
    engine.rollback(5);
    runToEnd(engine);
    expect(engine.status).toBe("done");
    expect(engine.variables.acc).toBe(history[total].acc);
  });

  it("回退清除待执行断点，且重放不含断点停顿", () => {
    const engine = new Engine(assignGraph(), {
      breakpoints: new Set(["a", "b"]),
    });
    engine.stepEvent(); // start
    expect(engine.stepEvent()).toBe("breakpoint"); // 停在 a
    engine.rollback(0);
    expect(engine.pendingBreakpoint).toBeNull();
    expect(engine.eventsExecuted).toBe(0);
    expect(engine.variables.x).toBe(0);
  });
});

describe("引擎：限制与明确终止", () => {
  it("节点执行总数超过 5000 → 明确终止", () => {
    const engine = new Engine(infiniteGraph());
    runToEnd(engine);
    expect(engine.status).toBe("terminated");
    expect(engine.terminateReason).toMatch(/^node-limit-exceeded/);
    expect(engine.eventsExecuted).toBe(5000);
  });

  it("虚拟时间超过 500 tick → 明确终止", () => {
    const graph = validateGraph({
      variables: {},
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "w" },
        { id: "w", kind: "wait", ticks: 600, next: "e" },
        { id: "e", kind: "end" },
      ],
    });
    const engine = new Engine(graph);
    runToEnd(engine);
    expect(engine.status).toBe("terminated");
    expect(engine.terminateReason).toMatch(/^tick-limit-exceeded/);
    expect(engine.tick).toBe(0); // 时间尚未跳到越界的唤醒点
  });

  it("协程名额被占满且无人可推进 → 死等，明确终止", () => {
    const engine = new Engine(deadlockGraph());
    runToEnd(engine);
    expect(engine.status).toBe("terminated");
    expect(engine.terminateReason).toMatch(/^deadlock/);
    expect(engine.terminateReason).toContain("spawn");
  });

  it("读取未声明变量 → 运行时错误，明确终止", () => {
    const graph = validateGraph({
      variables: { x: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "a" },
        { id: "a", kind: "assign", target: "x", expr: v("ghost"), next: null },
      ],
    });
    const engine = new Engine(graph);
    runToEnd(engine);
    expect(engine.status).toBe("terminated");
    expect(engine.terminateReason).toMatch(/^runtime-error/);
    expect(engine.terminateReason).toContain("ghost");
  });

  it("图校验：节点数超过 30 被拒绝", () => {
    const nodes: unknown[] = [{ id: "s", kind: "start", next: null }];
    for (let i = 0; i < 30; i++) nodes.push({ id: `n${i}`, kind: "end" });
    expect(() =>
      validateGraph({ variables: {}, start: "s", nodes }),
    ).toThrowError(/30/);
  });
});
