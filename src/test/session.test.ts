import { describe, expect, it } from "vitest";
import { DebuggerSession } from "../core/session";
import type { Snapshot } from "../core/types";

const lit = (value: number) => ({ kind: "lit", value }) as const;
const v = (name: string) => ({ kind: "var", name }) as const;
const bin = (op: string, left: unknown, right: unknown) =>
  ({ kind: "bin", op, left, right }) as never;

/** 27 个事件的循环图：start + 9×loop + 8×assign + end。 */
const LOOP_GRAPH = {
  variables: { i: 0 },
  start: "s",
  nodes: [
    { id: "s", kind: "start", next: "L" },
    { id: "L", kind: "loop", count: lit(8), body: "b", next: "e" },
    {
      id: "b",
      kind: "assign",
      target: "i",
      expr: bin("+", v("i"), lit(1)),
      next: "L",
    },
    { id: "e", kind: "end" },
  ],
};

const ASSIGN_GRAPH = {
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
};

/** 手动泵：让 yieldFn 的让出时机完全由测试控制。 */
function makePump() {
  const queue: Array<() => void> = [];
  const yieldFn = () =>
    new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  /** 让出一个等待中的切片边界，并刷新微任务。 */
  async function releaseOne() {
    const resolve = queue.shift();
    if (!resolve) throw new Error("pump: no pending yield");
    resolve();
    await Promise.resolve();
  }
  async function releaseAll() {
    while (queue.length > 0) await releaseOne();
  }
  return { queue, yieldFn, releaseOne, releaseAll };
}

function makeSession(sliceSize = 5) {
  const pump = makePump();
  const snapshots: Snapshot[] = [];
  const session = new DebuggerSession({
    sliceSize,
    yieldFn: pump.yieldFn,
    onState: (s) => snapshots.push(s),
  });
  return {
    session,
    pump,
    snapshots,
    last: () => snapshots[snapshots.length - 1],
  };
}

describe("会话：代次（generation）", () => {
  it("加载/编辑图开启新代次，旧代次的步进命令被拒绝", () => {
    const { session } = makeSession();
    expect(session.loadGraph(ASSIGN_GRAPH)).toEqual({ ok: true });
    const gen1 = session.generation;
    expect(session.loadGraph(ASSIGN_GRAPH)).toEqual({ ok: true });
    const gen2 = session.generation;
    expect(gen2).toBe(gen1 + 1);

    // 旧代次的命令不能操作新图
    const stale = session.step(gen1);
    expect(stale.ok).toBe(false);
    expect((stale as { error: string }).error).toMatch(/stale-generation/);
    // 状态未被旧命令触碰
    expect(session.getSnapshot()!.eventsExecuted).toBe(0);

    // 新代次命令正常工作
    expect(session.step(gen2)).toEqual({ ok: true });
    expect(session.getSnapshot()!.eventsExecuted).toBe(1);
  });

  it("非法图被拒绝且不改变代次", () => {
    const { session } = makeSession();
    expect(session.loadGraph(ASSIGN_GRAPH)).toEqual({ ok: true });
    const gen = session.generation;
    const bad = session.loadGraph({ variables: {}, start: "x", nodes: [] });
    expect(bad.ok).toBe(false);
    expect(session.generation).toBe(gen);
  });
});

describe("会话：暂停与重置竞争", () => {
  it("运行中请求暂停：在切片边界停住，状态可检视，可继续", async () => {
    const { session, pump, last } = makeSession(5);
    session.loadGraph(LOOP_GRAPH);
    const gen = session.generation;

    const p = session.continue(gen);
    await Promise.resolve(); // 让第一个切片跑完（5 个事件）
    expect(last().status).toBe("running");
    expect(last().eventsExecuted).toBe(5);

    // 暂停请求在运行循环让出期间到达
    expect(session.pause(gen)).toEqual({ ok: true });
    await pump.releaseOne(); // 运行循环从让出中返回，看到暂停请求
    await p;

    const paused = last();
    expect(paused.status).toBe("paused");
    expect(paused.eventsExecuted).toBe(5); // 停住后没有多执行
    expect(paused.variables.i).toBe(2); // 5 个事件：s, L, b, L, b → i=2
    // 暂停后可检视栈与协程
    expect(paused.coroutines[0].stack.length).toBeGreaterThan(0);

    // 继续运行到结束
    const p2 = session.continue(gen);
    await Promise.resolve();
    await pump.releaseAll();
    await p2;
    expect(last().status).toBe("done");
    expect(last().variables.i).toBe(8);
  });

  it("运行中重置：旧运行循环失效且不再触碰新状态", async () => {
    const { session, pump, last, snapshots } = makeSession(5);
    session.loadGraph(LOOP_GRAPH);
    const gen = session.generation;

    const p = session.continue(gen);
    await Promise.resolve();
    expect(last().eventsExecuted).toBe(5);

    // 重置与正在运行的循环竞争
    expect(session.reset(gen)).toEqual({ ok: true });
    expect(last().eventsExecuted).toBe(0);
    expect(last().status).toBe("idle");

    // 旧循环从让出中返回后必须静默退出
    const countBefore = snapshots.length;
    await pump.releaseOne();
    await p;
    // 旧循环没有再发出（属于旧状态的）快照
    expect(snapshots.length).toBe(countBefore);
    expect(last().eventsExecuted).toBe(0);
    expect(last().status).toBe("idle");

    // 新状态上步进正常
    expect(session.step(gen)).toEqual({ ok: true });
    expect(last().eventsExecuted).toBe(1);
  });

  it("运行中加载新图：旧循环退出，旧代次命令全部失效", async () => {
    const { session, pump, last } = makeSession(5);
    session.loadGraph(LOOP_GRAPH);
    const gen1 = session.generation;
    const p = session.continue(gen1);
    await Promise.resolve();

    session.loadGraph(ASSIGN_GRAPH);
    const gen2 = session.generation;
    await pump.releaseOne();
    await p;

    expect(last().generation).toBe(gen2);
    expect(last().eventsExecuted).toBe(0);
    expect(session.pause(gen1).ok).toBe(false);
    expect(session.reset(gen1).ok).toBe(false);
    expect(session.rollback(0, gen1).ok).toBe(false);
  });
});

describe("会话：断点前后状态", () => {
  it("continue 停在断点（副作用前），step 执行副作用", async () => {
    const { session, last } = makeSession();
    session.loadGraph(ASSIGN_GRAPH);
    const gen = session.generation;
    session.setBreakpoints(["a"], gen);

    await session.continue(gen);
    const atBp = last();
    expect(atBp.status).toBe("breakpoint");
    expect(atBp.pendingBreakpoint).toEqual({ coroutineId: 1, nodeId: "a" });
    expect(atBp.variables.x).toBe(0); // 副作用尚未发生

    session.step(gen); // 执行被批准的断点事件
    expect(last().variables.x).toBe(5); // 副作用已发生

    await session.continue(gen);
    expect(last().status).toBe("done");
    expect(last().variables.x).toBe(6);
  });

  it("断点可在运行中途设置", async () => {
    const { session, pump, last } = makeSession(3);
    session.loadGraph(LOOP_GRAPH);
    const gen = session.generation;
    session.setBreakpoints(["b"], gen);

    const p = session.continue(gen);
    await Promise.resolve();
    await pump.releaseAll();
    await p;
    expect(last().status).toBe("breakpoint");
    expect(last().pendingBreakpoint!.nodeId).toBe("b");
    expect(last().variables.i).toBe(0); // 第一次迭代体尚未执行
  });
});

describe("会话：回退", () => {
  it("回退到历史事件后状态一致，且可重新前进", async () => {
    const { session, pump, last } = makeSession(100);
    session.loadGraph(LOOP_GRAPH);
    const gen = session.generation;

    const p = session.continue(gen);
    await Promise.resolve();
    await pump.releaseAll();
    await p;
    expect(last().status).toBe("done");
    expect(last().variables.i).toBe(8);
    const total = last().eventsExecuted;

    // 回退到第 3 个事件（s, L, b 之后）：i 应为 1，栈上有一帧（尚未回到 L 扣减）
    expect(session.rollback(3, gen)).toEqual({ ok: true });
    const rolled = last();
    expect(rolled.eventsExecuted).toBe(3);
    expect(rolled.variables.i).toBe(1);
    expect(rolled.status).toBe("paused");
    expect(rolled.coroutines[0].stack).toEqual([
      { loopNodeId: "L", remaining: 8 },
    ]);
    expect(rolled.trace.length).toBe(3);

    // 重新前进到结束，结果不变（确定性）
    const p2 = session.continue(gen);
    await Promise.resolve();
    await pump.releaseAll();
    await p2;
    expect(last().status).toBe("done");
    expect(last().variables.i).toBe(8);
    expect(last().eventsExecuted).toBe(total);
  });

  it("回退目标越界被拒绝", async () => {
    const { session, last } = makeSession();
    session.loadGraph(ASSIGN_GRAPH);
    const gen = session.generation;
    session.step(gen);
    session.step(gen);
    expect(session.rollback(99, gen).ok).toBe(false);
    expect(session.rollback(-1, gen).ok).toBe(false);
    expect(last().eventsExecuted).toBe(2); // 状态未被破坏
  });
});
