import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "../worker/protocol";
import type { Snapshot } from "../core/types";

/**
 * 通过 mock self 加载真实的 worker 模块，测试协议路由与代次校验。
 */

const ASSIGN_GRAPH = {
  variables: { x: 0 },
  start: "s",
  nodes: [
    { id: "s", kind: "start", next: "a" },
    {
      id: "a",
      kind: "assign",
      target: "x",
      expr: { kind: "lit", value: 5 },
      next: "e",
    },
    { id: "e", kind: "end" },
  ],
};

type NoId<T> = T extends unknown ? Omit<T, "id"> : never;

interface Harness {
  messages: Response[];
  send(msg: NoId<Request> & { id?: number }): void;
  states(): Snapshot[];
  lastState(): Snapshot;
  results(): Array<{ id: number; ok: boolean; error?: string }>;
}

async function makeWorker(): Promise<Harness> {
  vi.resetModules();
  const messages: Response[] = [];
  const selfObj: Record<string, unknown> = {
    postMessage: (m: Response) => messages.push(m),
    onmessage: null,
  };
  (globalThis as Record<string, unknown>).self = selfObj;
  await import("../worker/debugger.worker");
  const onmessage = selfObj.onmessage as (e: MessageEvent<Request>) => void;
  let nextId = 1;
  const states = () =>
    messages
      .filter((m) => m.type === "state")
      .map((m) => (m as { snapshot: Snapshot }).snapshot);
  return {
    messages,
    send: (msg) => {
      const id = msg.id ?? nextId++;
      onmessage({ data: { ...msg, id } as Request } as MessageEvent<Request>);
    },
    states,
    lastState: () => states()[states().length - 1],
    results: () =>
      messages
        .filter((m) => m.type === "result")
        .map((m) => m as { id: number; ok: boolean; error?: string }),
  };
}

describe("Worker 协议", () => {
  let worker: Harness;
  beforeEach(async () => {
    worker = await makeWorker();
  });

  it("loadGraph 开启代次并广播初始状态", () => {
    worker.send({ type: "loadGraph", graph: ASSIGN_GRAPH });
    const state = worker.lastState();
    expect(state.generation).toBe(1);
    expect(state.status).toBe("idle");
    expect(state.eventsExecuted).toBe(0);
    expect(worker.results().at(-1)!.ok).toBe(true);
  });

  it("携带旧代次的步进命令被拒绝，不能操作新图", () => {
    worker.send({ type: "loadGraph", graph: ASSIGN_GRAPH });
    worker.send({ type: "step", generation: 1 });
    expect(worker.lastState().eventsExecuted).toBe(1);

    // 编辑图 → 新代次
    worker.send({ type: "loadGraph", graph: ASSIGN_GRAPH });
    expect(worker.lastState().generation).toBe(2);
    expect(worker.lastState().eventsExecuted).toBe(0);

    // 旧代次命令被拒绝
    worker.send({ type: "step", generation: 1 });
    const result = worker.results().at(-1)!;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/stale-generation/);
    expect(worker.lastState().eventsExecuted).toBe(0);

    // 新代次命令正常
    worker.send({ type: "step", generation: 2 });
    expect(worker.results().at(-1)!.ok).toBe(true);
    expect(worker.lastState().eventsExecuted).toBe(1);
  });

  it("断点：continue 停在副作用前，状态经协议完整可见", async () => {
    worker.send({ type: "loadGraph", graph: ASSIGN_GRAPH });
    worker.send({ type: "setBreakpoints", generation: 1, breakpoints: ["a"] });
    worker.send({ type: "continue", generation: 1 });
    // continue 的首个切片同步执行到断点
    await vi.waitFor(() => {
      expect(worker.lastState().status).toBe("breakpoint");
    });
    const atBp = worker.lastState();
    expect(atBp.variables.x).toBe(0);
    expect(atBp.pendingBreakpoint).toEqual({ coroutineId: 1, nodeId: "a" });

    worker.send({ type: "step", generation: 1 });
    expect(worker.lastState().variables.x).toBe(5);

    worker.send({ type: "continue", generation: 1 });
    await vi.waitFor(() => {
      expect(worker.lastState().status).toBe("done");
    });
  });

  it("非法图返回错误且不改变状态", () => {
    worker.send({ type: "loadGraph", graph: ASSIGN_GRAPH });
    worker.send({
      type: "loadGraph",
      graph: { variables: {}, start: "x", nodes: [] },
    });
    const result = worker.results().at(-1)!;
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(worker.lastState().generation).toBe(1);
  });
});
