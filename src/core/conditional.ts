export interface ConditionalRule {
  nodeId: string;
  variable: string;
  equals: number;
  hit: number;
}

/**
 * 条件断点：规则挂在节点上，条件观察节点副作用发生**之前**的共享变量。
 * 每个协程独立计数自己“条件成立”的访问（有效访问）；
 * 某协程的第 hit 次有效访问在副作用前停住。
 *
 * 计数只发生在 visit() —— 事件真正执行时、副作用前调用，因此：
 * - 无论该事件是否先被（普通）断点拦下，执行时恰好计一次；
 * - 回退重放经过相同的事件序列，计数随之确定性重建。
 * shouldStop() 是纯查询，不改变任何状态。
 */
export class ConditionalStops {
  /** (协程, 节点) → 已发生的有效访问次数。 */
  counts: Record<string, number> = {};

  constructor(public rules: ConditionalRule[] = []) {}

  validate(nodes: Set<string>, variables: Record<string, number>) {
    const seen = new Set<string>();
    for (const rule of this.rules) {
      if (
        !nodes.has(rule.nodeId) ||
        !(rule.variable in variables) ||
        !Number.isSafeInteger(rule.equals) ||
        !Number.isSafeInteger(rule.hit) ||
        rule.hit < 1 ||
        seen.has(rule.nodeId)
      )
        throw new Error("invalid conditional breakpoint");
      seen.add(rule.nodeId);
    }
  }

  /** 当前（副作用前）变量下，该节点是否命中某条规则的条件。 */
  matching(node: string, vars: Record<string, number>) {
    return this.rules.find(
      (r) => r.nodeId === node && vars[r.variable] === r.equals,
    );
  }

  /**
   * 纯查询：若本次访问条件成立，它是否是该协程的第 hit 次有效访问。
   * 不计数 —— 计数在 visit() 中、事件执行时进行。
   */
  shouldStop(node: string, coroutine: number, vars: Record<string, number>) {
    const rule = this.matching(node, vars);
    if (!rule) return false;
    return (this.counts[key(coroutine, node)] ?? 0) + 1 === rule.hit;
  }

  /** 事件执行时（副作用前）调用：条件成立才为该协程计一次有效访问。 */
  visit(node: string, coroutine: number, vars: Record<string, number>) {
    if (!this.matching(node, vars)) return;
    const k = key(coroutine, node);
    this.counts[k] = (this.counts[k] ?? 0) + 1;
  }
}

/** 协程 id 是整数前缀，键可以无歧义地解码，不会与节点 id 冲突。 */
function key(coroutine: number, node: string): string {
  return `${coroutine}:${node}`;
}
