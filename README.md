# 流程图调试器（Flowchart Debugger）

Svelte + TypeScript Worker 实现的确定性流程图调试器。图最多 **30 个节点**、同时最多
**4 个协程**；执行引擎运行在 Web Worker 中，UI 通过消息协议与之交互。

## 运行

```bash
npm install
npm run dev      # 开发服务器
npm test         # 运行测试（vitest，28 个用例）
npm run check    # TypeScript 类型检查
npm run build    # 生产构建
```

## 节点类型

| 节点 | 语义 |
| --- | --- |
| `start` | 主协程入口 |
| `assign` | `target = expr`，写共享变量（目标必须已声明） |
| `condition` | 表达式非 0 走 `onTrue`，否则走 `onFalse` |
| `loop` | 进入时在**本协程私有栈**上压一帧（计 count 次），循环体末尾指回本节点 |
| `wait` | 挂起所属协程 N 个虚拟 tick（pc 停在 wait 节点上，可检视唤醒时刻） |
| `spawn` | 派生子协程（新 id、空栈、共享变量）；名额（4）满时父协程**阻塞**在 spawn 上 |
| `join` | 阻塞到本协程全部直接子协程结束 |
| `end` | 协程结束 |

表达式为整数运算（`+ - * / %` 与比较运算），除法向零取整，除零 / 读未声明变量
属于运行时错误。

## 执行模型

- **调度事件** = 一个协程执行一个节点。单步（step）只推进一条调度事件。
- 虚拟时间为整数 tick，**只有 wait 推进时间**；没有就绪协程时，时间跳到最近的
  唤醒 tick。
- 同一 tick 的就绪协程**按 ID 轮转**推进（就绪队列 FIFO，新就绪者按 ID 入队，
  当前协程仍就绪则排到队尾）。
- 派生后父子协程各自拥有独立的循环栈，共享图中声明的变量。

## 调试语义

- **断点**在节点副作用发生**之前**停住（`pendingBreakpoint` 指向待执行事件）；
  再 step/continue 一次才执行该事件。循环体上的断点每次迭代都会停。
- **暂停**后可检视：各协程的栈、状态、阻塞原因（`wait: sleeps until tick N` /
  `join: waiting for children [...]` / `spawn: coroutine capacity reached`）、
  共享变量、事件轨迹。
- **回退** = 检查点（每 100 事件一个）+ 确定性重放。调度是图的纯函数，重放时
  会对照事件日志校验调度序列；可回退到 `[0, 历史最大事件数]` 中任意一点。
- **执行代次（generation）**：加载 / 编辑图开启新代次；携带旧代次号的命令一律
  被 Worker 拒绝（`stale-generation`），旧步进指令无法操作新图。
- **竞争安全**：`continue` 以切片方式运行（每片 256 事件后让出事件循环），
  `pause` 在切片边界生效；`reset` / `rollback` / `loadGraph` 通过运行令牌
  （runToken）使进行中的运行循环静默失效。

## 限制与明确终止

| 限制 | 值 | 超限行为 |
| --- | --- | --- |
| 节点数 | 30 | 加载时拒绝 |
| 同时存活协程 | 4 | spawn 阻塞；全部阻塞且无定时器 → `deadlock` 终止 |
| 节点执行总数 | 5000 | `node-limit-exceeded` 终止 |
| 虚拟时间 | 500 tick | `tick-limit-exceeded` 终止 |
| 运行时错误 | — | `runtime-error: ...` 终止 |

## 架构

```
src/
  core/            # 纯 TypeScript，无环境依赖
    types.ts       # 图 / 协程 / 快照类型，限制常量
    expr.ts        # 整数表达式求值（确定性）
    graph.ts       # 图校验（≤30 节点、边引用、变量声明）
    engine.ts      # 调度器 + 解释器 + 检查点/重放
    session.ts     # 代次、可暂停运行循环、回退、断点
  worker/
    protocol.ts    # 消息协议（命令携带代次号）
    debugger.worker.ts
  ui/              # Svelte 组件
    App.svelte     # 工具栏 + 布局
    GraphView.svelte   # SVG 图渲染，点击节点切换断点
    StatePanel.svelte  # 协程栈 / 状态 / 阻塞原因 / 变量
    TracePanel.svelte  # 事件轨迹
    Editor.svelte      # 图 JSON 编辑器（应用即开新代次）
    client.ts      # Worker 客户端（Svelte store）
    samples.ts     # 预置示例
  test/            # vitest：引擎 / 会话 / Worker 协议
```

## 测试覆盖

- **跨协程等待**：wait 推进虚拟时间、join 阻塞与释放、阻塞原因可检视、
  父子各有独立栈。
- **断点前后状态**：停在副作用前（变量未变）、批准后副作用生效、循环体断点
  逐次命中。
- **暂停与重置竞争**：运行中 pause 在切片边界停住且状态一致；运行中 reset 使
  旧运行循环失效且不再触碰新状态；运行中 loadGraph 后旧代次命令全部失效。
- **代次**：旧代次 step 被拒绝（引擎层与 Worker 协议层各测一遍）。
- **回退**：跑到结束后回退到任意事件，状态与首次执行到该点时完全一致；
  回退后可重新前进且结果确定。
- **限制**：5000 节点上限、500 tick 上限、协程名额死等、未声明变量运行时错误、
  30 节点图校验。

## Conditional breakpoints
Use the JSON panel after resetting: [{"nodeId":"assign","variable":"x","equals":0,"hit":2}]. The condition observes shared variables before the node effect. Each coroutine independently counts only visits where the condition is true; the Nth eligible visit pauses before its effect. Resuming executes it once. Rollback restores eligible visit counts and replay does not pause on conditions. Reset keeps the current rules; loading a new graph clears them. Configuration commands belong to an execution generation.
