import { writable, get, type Writable } from "svelte/store";
import type { Snapshot } from "../core/types";
import type { Request, Response } from "../worker/protocol";

export interface DebuggerClient {
  snapshot: Writable<Snapshot | null>;
  lastError: Writable<string | null>;
  loadGraph(graph: unknown): void;
  step(): void;
  continue(): void;
  pause(): void;
  reset(): void;
  rollback(to: number): void;
  toggleBreakpoint(nodeId: string): void;
  conditions(rules: import("../core/conditional").ConditionalRule[]): void;
}

/**
 * UI 侧的 Worker 客户端：把命令发给 Worker，把状态写进 Svelte store。
 * 命令携带当前快照的代次号；loadGraph 开启新代次。
 */
export function createDebuggerClient(): DebuggerClient {
  const worker = new Worker(
    new URL("../worker/debugger.worker.ts", import.meta.url),
    {
      type: "module",
    },
  );

  const snapshot = writable<Snapshot | null>(null);
  const lastError = writable<string | null>(null);
  let requestId = 0;

  worker.onmessage = (event: MessageEvent<Response>) => {
    const msg = event.data;
    if (msg.type === "state") {
      snapshot.set(msg.snapshot);
    } else if (!msg.ok) {
      lastError.set(msg.error ?? "unknown error");
    }
  };

  const generation = () => get(snapshot)?.generation ?? 0;

  type NoId<T> = T extends unknown ? Omit<T, "id"> : never;

  function send(msg: NoId<Request>): void {
    lastError.set(null);
    worker.postMessage({ ...msg, id: ++requestId } as Request);
  }

  return {
    snapshot,
    lastError,
    conditions: (rules) =>
      send({
        type: "setConditionalBreakpoints",
        generation: generation(),
        rules,
      }),
    loadGraph: (graph) => send({ type: "loadGraph", graph }),
    step: () => send({ type: "step", generation: generation() }),
    continue: () => send({ type: "continue", generation: generation() }),
    pause: () => send({ type: "pause", generation: generation() }),
    reset: () => send({ type: "reset", generation: generation() }),
    rollback: (to) => send({ type: "rollback", generation: generation(), to }),
    toggleBreakpoint(nodeId) {
      const snap = get(snapshot);
      if (!snap) return;
      const breakpoints = new Set(snap.breakpoints);
      if (breakpoints.has(nodeId)) breakpoints.delete(nodeId);
      else breakpoints.add(nodeId);
      send({
        type: "setBreakpoints",
        generation: snap.generation,
        breakpoints: [...breakpoints],
      });
    },
  };
}
