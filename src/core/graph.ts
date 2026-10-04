import type { BinOp, Expr, FlowGraph, FlowNode } from "./types";
import { LIMITS } from "./types";
import { exprToString } from "./expr";

/** 图结构非法时抛出（loadGraph 会捕获并作为错误返回）。 */
export class ValidationError extends Error {}

const BIN_OPS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateExpr(raw: unknown, path: string): Expr {
  if (!isRecord(raw))
    throw new ValidationError(`${path}: expression must be an object`);
  switch (raw.kind) {
    case "lit":
      if (typeof raw.value !== "number" || !Number.isInteger(raw.value)) {
        throw new ValidationError(`${path}: lit.value must be an integer`);
      }
      return { kind: "lit", value: raw.value };
    case "var":
      if (typeof raw.name !== "string" || raw.name === "") {
        throw new ValidationError(
          `${path}: var.name must be a non-empty string`,
        );
      }
      return { kind: "var", name: raw.name };
    case "neg":
      return { kind: "neg", expr: validateExpr(raw.expr, `${path}.expr`) };
    case "bin":
      if (typeof raw.op !== "string" || !BIN_OPS.has(raw.op)) {
        throw new ValidationError(
          `${path}: unknown binary op '${String(raw.op)}'`,
        );
      }
      return {
        kind: "bin",
        op: raw.op as BinOp,
        left: validateExpr(raw.left, `${path}.left`),
        right: validateExpr(raw.right, `${path}.right`),
      };
    default:
      throw new ValidationError(
        `${path}: unknown expression kind '${String(raw.kind)}'`,
      );
  }
}

function validateRef(
  ref: unknown,
  ids: Set<string>,
  path: string,
  allowNull: true,
): string | null {
  if (ref === null) return null;
  if (typeof ref !== "string" || !ids.has(ref)) {
    throw new ValidationError(
      `${path}: reference '${String(ref)}' is not a known node id`,
    );
  }
  return ref;
}

/**
 * 校验并规范化外部传入的图描述。
 * 限制：节点数 ≤ 30、恰好一个 start、所有边引用存在的节点、变量初值为整数。
 */
export function validateGraph(raw: unknown): FlowGraph {
  if (!isRecord(raw)) throw new ValidationError("graph must be an object");

  // 变量声明
  if (!isRecord(raw.variables)) {
    throw new ValidationError(
      "graph.variables must be an object of name -> integer",
    );
  }
  const variables: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw.variables)) {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new ValidationError(
        `variable '${name}' must have an integer initial value`,
      );
    }
    variables[name] = value;
  }

  // 节点
  if (!Array.isArray(raw.nodes))
    throw new ValidationError("graph.nodes must be an array");
  if (raw.nodes.length === 0)
    throw new ValidationError("graph must contain at least one node");
  if (raw.nodes.length > LIMITS.maxNodes) {
    throw new ValidationError(
      `graph has ${raw.nodes.length} nodes, exceeding the limit of ${LIMITS.maxNodes}`,
    );
  }

  const ids = new Set<string>();
  for (const n of raw.nodes) {
    if (!isRecord(n) || typeof n.id !== "string" || n.id === "") {
      throw new ValidationError("every node needs a non-empty string id");
    }
    if (ids.has(n.id)) throw new ValidationError(`duplicate node id '${n.id}'`);
    ids.add(n.id);
  }

  const nodes: FlowNode[] = raw.nodes.map((n, i) => {
    const path = `nodes[${i}]('${String(n.id)}')`;
    if (!isRecord(n))
      throw new ValidationError(`${path}: node must be an object`);
    const id = n.id as string;
    switch (n.kind) {
      case "start":
        return {
          id,
          kind: "start",
          next: validateRef(n.next, ids, `${path}.next`, true),
        };
      case "assign": {
        if (typeof n.target !== "string" || !(n.target in variables)) {
          throw new ValidationError(
            `${path}: assign target '${String(n.target)}' is not a declared variable`,
          );
        }
        return {
          id,
          kind: "assign",
          target: n.target,
          expr: validateExpr(n.expr, `${path}.expr`),
          next: validateRef(n.next, ids, `${path}.next`, true),
        };
      }
      case "condition":
        return {
          id,
          kind: "condition",
          expr: validateExpr(n.expr, `${path}.expr`),
          onTrue: validateRef(n.onTrue, ids, `${path}.onTrue`, true),
          onFalse: validateRef(n.onFalse, ids, `${path}.onFalse`, true),
        };
      case "loop":
        return {
          id,
          kind: "loop",
          count: validateExpr(n.count, `${path}.count`),
          body: validateRef(n.body, ids, `${path}.body`, true),
          next: validateRef(n.next, ids, `${path}.next`, true),
        };
      case "wait": {
        if (
          typeof n.ticks !== "number" ||
          !Number.isInteger(n.ticks) ||
          n.ticks < 0
        ) {
          throw new ValidationError(
            `${path}: wait.ticks must be a non-negative integer`,
          );
        }
        return {
          id,
          kind: "wait",
          ticks: n.ticks,
          next: validateRef(n.next, ids, `${path}.next`, true),
        };
      }
      case "spawn":
        return {
          id,
          kind: "spawn",
          entry: validateRef(n.entry, ids, `${path}.entry`, true)!,
          next: validateRef(n.next, ids, `${path}.next`, true),
        };
      case "join":
        return {
          id,
          kind: "join",
          next: validateRef(n.next, ids, `${path}.next`, true),
        };
      case "end":
        return { id, kind: "end" };
      default:
        throw new ValidationError(
          `${path}: unknown node kind '${String(n.kind)}'`,
        );
    }
  });

  // start 引用
  if (typeof raw.start !== "string" || !ids.has(raw.start)) {
    throw new ValidationError(
      `graph.start '${String(raw.start)}' is not a known node id`,
    );
  }
  const startNode = nodes.find((n) => n.id === raw.start)!;
  if (startNode.kind !== "start") {
    throw new ValidationError(
      `graph.start must reference a node of kind 'start'`,
    );
  }

  return { variables, start: raw.start, nodes };
}

/** 节点的单行可读标签（用于 UI）。 */
export function nodeLabel(node: FlowNode): string {
  switch (node.kind) {
    case "start":
      return "start";
    case "assign":
      return `${node.target} = ${exprToString(node.expr)}`;
    case "condition":
      return `if ${exprToString(node.expr)}`;
    case "loop":
      return `loop ${exprToString(node.count)}×`;
    case "wait":
      return `wait ${node.ticks}t`;
    case "spawn":
      return `spawn → ${node.entry}`;
    case "join":
      return "join children";
    case "end":
      return "end";
  }
}
