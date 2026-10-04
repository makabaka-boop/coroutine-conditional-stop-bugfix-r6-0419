/** 预置示例图（JSON 格式，可在编辑器中修改）。 */

const lit = (value: number) => ({ kind: "lit", value });
const v = (name: string) => ({ kind: "var", name });
const bin = (op: string, left: unknown, right: unknown) => ({
  kind: "bin",
  op,
  left,
  right,
});

export interface Sample {
  name: string;
  graph: unknown;
}

export const SAMPLES: Sample[] = [
  {
    name: "基础：赋值 / 条件 / 循环",
    graph: {
      variables: { i: 0, sum: 0, flag: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "L" },
        { id: "L", kind: "loop", count: lit(4), body: "b1", next: "c" },
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
          target: "sum",
          expr: bin("+", v("sum"), v("i")),
          next: "L",
        },
        {
          id: "c",
          kind: "condition",
          expr: bin(">", v("sum"), lit(5)),
          onTrue: "t",
          onFalse: "f",
        },
        { id: "t", kind: "assign", target: "flag", expr: lit(1), next: "e" },
        { id: "f", kind: "assign", target: "flag", expr: lit(2), next: "e" },
        { id: "e", kind: "end" },
      ],
    },
  },
  {
    name: "协程：派生 / 等待 / 汇合",
    graph: {
      variables: { result: 0, done: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "sp" },
        { id: "sp", kind: "spawn", entry: "w", next: "j" },
        { id: "j", kind: "join", next: "a" },
        { id: "a", kind: "assign", target: "done", expr: lit(1), next: "e" },
        { id: "e", kind: "end" },
        { id: "w", kind: "wait", ticks: 5, next: "c1" },
        {
          id: "c1",
          kind: "assign",
          target: "result",
          expr: lit(42),
          next: "c2",
        },
        { id: "c2", kind: "end" },
      ],
    },
  },
  {
    name: "协程：双worker竞争累加",
    graph: {
      variables: { counter: 0, rounds: 0 },
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "sp1" },
        { id: "sp1", kind: "spawn", entry: "w1", next: "sp2" },
        { id: "sp2", kind: "spawn", entry: "w2", next: "j" },
        { id: "j", kind: "join", next: "e" },
        { id: "e", kind: "end" },
        { id: "w1", kind: "loop", count: lit(3), body: "w1b", next: "w1e" },
        {
          id: "w1b",
          kind: "assign",
          target: "counter",
          expr: bin("+", v("counter"), lit(1)),
          next: "w1",
        },
        { id: "w1e", kind: "end" },
        { id: "w2", kind: "loop", count: lit(3), body: "w2b", next: "w2e" },
        {
          id: "w2b",
          kind: "assign",
          target: "counter",
          expr: bin("+", v("counter"), lit(10)),
          next: "w2",
        },
        { id: "w2e", kind: "end" },
      ],
    },
  },
  {
    name: "死等：协程名额耗尽",
    graph: {
      variables: {},
      start: "s",
      nodes: [
        { id: "s", kind: "start", next: "s1" },
        { id: "s1", kind: "spawn", entry: "c1", next: "j1" },
        { id: "j1", kind: "join", next: "e1" },
        { id: "e1", kind: "end" },
        { id: "c1", kind: "spawn", entry: "c2", next: "j2" },
        { id: "j2", kind: "join", next: "e2" },
        { id: "e2", kind: "end" },
        { id: "c2", kind: "spawn", entry: "c3", next: "j3" },
        { id: "j3", kind: "join", next: "e3" },
        { id: "e3", kind: "end" },
        { id: "c3", kind: "spawn", entry: "c4", next: "e4" },
        { id: "e4", kind: "end" },
        { id: "c4", kind: "end" },
      ],
    },
  },
  {
    name: "超限：死循环跑到 5000 事件",
    graph: {
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
    },
  },
];
