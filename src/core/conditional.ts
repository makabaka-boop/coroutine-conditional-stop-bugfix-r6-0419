export interface ConditionalRule {
  nodeId: string;
  variable: string;
  equals: number;
  hit: number;
}
export class ConditionalStops {
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
  matching(node: string, vars: Record<string, number>) {
    return this.rules.find(
      (r) => r.nodeId === node && vars[r.variable] === r.equals,
    );
  }
  shouldStop(node: string, coroutine: number, vars: Record<string, number>) {
    const key = node;
    this.counts[key] = (this.counts[key] ?? 0) + 1;
    const rule = this.matching(node, vars);
    return !!rule && this.counts[key] === rule.hit;
  }
  visit(node: string, coroutine: number, vars: Record<string, number>) {}
}
