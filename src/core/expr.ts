import type { Expr } from "./types";

/** 表达式求值时抛出的运行时错误（会被引擎捕获并转为明确终止）。 */
export class RuntimeError extends Error {}

/**
 * 确定性整数表达式求值。
 * 除法向零取整；除零、读取未声明变量都会抛 RuntimeError。
 */
export function evalExpr(expr: Expr, vars: Record<string, number>): number {
  switch (expr.kind) {
    case "lit":
      return expr.value | 0;
    case "var": {
      if (!(expr.name in vars)) {
        throw new RuntimeError(`read of undeclared variable '${expr.name}'`);
      }
      return vars[expr.name];
    }
    case "neg":
      return -evalExpr(expr.expr, vars);
    case "bin": {
      const l = evalExpr(expr.left, vars);
      const r = evalExpr(expr.right, vars);
      switch (expr.op) {
        case "+":
          return (l + r) | 0;
        case "-":
          return (l - r) | 0;
        case "*":
          return (l * r) | 0;
        case "/":
          if (r === 0) throw new RuntimeError("division by zero");
          return Math.trunc(l / r);
        case "%":
          if (r === 0) throw new RuntimeError("modulo by zero");
          return l % r;
        case "<":
          return l < r ? 1 : 0;
        case "<=":
          return l <= r ? 1 : 0;
        case ">":
          return l > r ? 1 : 0;
        case ">=":
          return l >= r ? 1 : 0;
        case "==":
          return l === r ? 1 : 0;
        case "!=":
          return l !== r ? 1 : 0;
      }
    }
  }
}

/** 表达式 → 可读字符串（用于 UI 标签）。 */
export function exprToString(expr: Expr): string {
  switch (expr.kind) {
    case "lit":
      return String(expr.value);
    case "var":
      return expr.name;
    case "neg":
      return `-${exprToString(expr.expr)}`;
    case "bin":
      return `(${exprToString(expr.left)} ${expr.op} ${exprToString(expr.right)})`;
  }
}
