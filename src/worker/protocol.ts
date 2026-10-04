import type { Snapshot } from "../core/types";

/** UI → Worker 的命令。除 loadGraph 外都携带执行代次号。 */
export type Request =
  | { id: number; type: "loadGraph"; graph: unknown }
  | { id: number; type: "step"; generation: number }
  | { id: number; type: "continue"; generation: number }
  | { id: number; type: "pause"; generation: number }
  | { id: number; type: "reset"; generation: number }
  | { id: number; type: "rollback"; generation: number; to: number }
  | {
      id: number;
      type: "setBreakpoints";
      generation: number;
      breakpoints: string[];
    }
  | {
      id: number;
      type: "setConditionalBreakpoints";
      generation: number;
      rules: import("../core/conditional").ConditionalRule[];
    }
  | { id: number; type: "getState" };

/** Worker → UI 的消息。 */
export type Response =
  | { type: "state"; snapshot: Snapshot }
  | { type: "result"; id: number; ok: boolean; error?: string };
