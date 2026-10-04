import { DebuggerSession } from "../core/session";
import type { Request, Response } from "./protocol";

/**
 * 调试引擎运行在 Worker 中：UI 线程只收发消息。
 * continue 以切片方式运行并在切片间让出事件循环，
 * 因此 pause / reset 消息可以及时生效。
 */
interface WorkerScope {
  postMessage(message: Response): void;
  onmessage: ((event: MessageEvent<Request>) => void) | null;
}
const ctx = self as unknown as WorkerScope;

function post(message: Response): void {
  ctx.postMessage(message);
}

const session = new DebuggerSession({
  onState: (snapshot) => post({ type: "state", snapshot }),
});

ctx.onmessage = (event: MessageEvent<Request>) => {
  const msg = event.data;
  let result: { ok: boolean; error?: string };
  switch (msg.type) {
    case "loadGraph":
      result = session.loadGraph(msg.graph);
      break;
    case "step":
      result = session.step(msg.generation);
      break;
    case "continue":
      // 不 await：让运行循环在后台切片推进，pause 等消息才能被处理。
      // 代次校验同步完成，错误立即随 result 返回。
      result = { ok: true };
      void session.continue(msg.generation).then((r) => {
        if (!r.ok)
          post({ type: "result", id: msg.id, ok: false, error: r.error });
      });
      break;
    case "pause":
      result = session.pause(msg.generation);
      break;
    case "reset":
      result = session.reset(msg.generation);
      break;
    case "rollback":
      result = session.rollback(msg.to, msg.generation);
      break;
    case "setBreakpoints":
      result = session.setBreakpoints(msg.breakpoints, msg.generation);
      break;
    case "setConditionalBreakpoints":
      result = session.setConditionalBreakpoints(msg.rules, msg.generation);
      break;
    case "getState": {
      const snapshot = session.getSnapshot();
      if (snapshot) post({ type: "state", snapshot });
      result = { ok: true };
      break;
    }
  }
  post({ type: "result", id: msg.id, ...result });
};
