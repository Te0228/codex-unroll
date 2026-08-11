# CLAUDE.md

给在本仓库工作的 Claude Code / Codex 的指引。

---

## 0. 开工前必读

**[SPEC.md](./SPEC.md) 是本项目的唯一权威设计文档（14 章，912 行）。写任何代码前先完整读一遍。**

最关键的四章：

| 章节 | 内容 | 为什么必须先读 |
|---|---|---|
| **§3** | 数据源规格 | rollout JSONL 的真实结构，**里面有一个反直觉的点**（见下方"血泪教训"） |
| **§6** | UI 规格 | 三栏布局、6 组配色、两层下钻。**不要按常规长列表思路做** |
| **§9.1** | 密钥脱敏 | 安全硬约束，实现时最容易漏 `rawPretty` |
| **§14** | 验收 | **64 条断言，全部基于 `test/fixtures/` 的实测确切数字** |

---

## 1. 当前状态

```
M0   脚手架（Electron Forge + Vite + TS）        ✅ 完成
M0.5 测试夹具 + 实测期望值                        ✅ 完成
M1   升 TS / 接 React / 空窗口 / §9 安全约束       ✅ 完成
M2   shared/rollout.ts + 单测（§14.2 共 40 条）    ✅ 完成，40/40 绿
M3   主进程 IPC（§14.3 E1–E7）+ 跟随（G1–G7）      ✅ 完成
M4   React UI（§14.4 F1–F24）                     ✅ 完成
M5   实时跟随                                     ✅ 完成
M6   端到端冒烟（§14.6）已脚本化                    ✅ 51/51 绿
M7   打包分发                                     ✅ zip 产物可跑
────────────────────────────────────────────────
v0.2 主区「图」视图 Session▸Turn▸Step（§6.8）      ✅ §14.9 共 72 条
v0.2 中英双语（§15）                              ✅
v0.2 §5 P1 全部 F14–F18/F20（§6.9）               ✅ §14.10 共 64 条
```

**v0.1 功能完整；v0.2 加了图视图、双语、以及 §5 P1 的全部功能。** 单测 **546 条**全绿，端到端冒烟 **51/51**。

### 已装好的依赖

`typescript@7.0.2` · `react@19.2.8` · `react-dom@19.2.8` · `@vitejs/plugin-react@4.7.0` ·
`electron@43.2.0` · `vite@5.4.21` · `vitest@3.2.7`

> ⚠️ `@vitejs/plugin-react` **必须锁在 v4**。v6 要求 `vite@^8`，而 Electron Forge 的
> `plugin-vite` 锁的是 `vite@5.4`，装 v6 会 ERESOLVE 失败。

### ★ 为什么 linter 是 oxlint 而不是 ESLint

`typescript@7.0.2` 是**原生 tsgo 版**，主入口只导出 `./lib/version.cjs`——
`ts.TypeFlags` / `ts.createProgram` / `ts.SyntaxKind` 全是 `undefined`，
经典编译器 API 只在 `./unstable/*` 下。

所以 `@typescript-eslint` **在 TS 7 上根本无法工作**，不是版本太旧：
升到 v8 会 ERESOLVE（peer 要求 `typescript <5.9`），强装则运行时崩在读 `TypeFlags`。

**结论：换 oxlint**（Rust 实现，自己解析 TS/JSX，完全不依赖 `typescript` 包）。
`eslint` / `@typescript-eslint/*` / `eslint-plugin-import` 已从 devDependencies 移除，
`.eslintrc.json` 已删，配置在 `.oxlintrc.json`。

代价：没有需要类型信息的规则（如 `no-floating-promises`）。这部分由 `npm run typecheck` 兜底。

> 若将来要装回 ESLint，前提是 typescript-eslint 支持 TS 7 的 `./unstable/*` API，
> 或者把 typescript 降回 5.x（那样 `tsconfig.json` 还要把 `baseUrl`
> 和 `moduleResolution: node` 改回去——TS 7 移除了这两个选项）。

---

## 2. 血泪教训（照抄会踩的坑）

### ★ 统一信封 —— 曾经写错过一次

**所有 5 种记录的字段都在 `payload` 里**，顶层只有三个键：

```jsonc
{ "timestamp": "...", "type": "turn_context", "payload": { /* 全部内容在这 */ } }
```

早期用 `jq 'keys'` 调查时把 `payload | keys` 的输出误当成顶层 keys，
导致 SPEC 一度声称 `session_meta` / `turn_context` 的字段在顶层。**以夹具实测为准。**

区别只在于：`event_msg` / `response_item` 的 `payload` 有 `type` 字段作为二级判别式，
其余三种（`session_meta` / `turn_context` / `world_state`）没有。

### ★ 两条工具调用路径，都要支持

| 工具 | payload.type | 参数字段 | 参数格式 |
|---|---|---|---|
| `apply_patch` | `custom_tool_call` | `input` | 纯文本 patch |
| `shell` / `exec_command` | `function_call` | `arguments` | **JSON 字符串，需二次解析** |

只支持一条会导致另一条完全显示不出来。夹具 01 和 02 就是为了各覆盖一条才都保留的。

### ★ `sandbox_policy` 是内部标签

```jsonc
"sandbox_policy": { "type": "read-only" }     // ✅ 读 .type
"sandbox_policy": { "read_only": {} }         // ❌ 不是这样
```

同理 `context_window` 是对象 `{ window_id }`，不是数字。

### ★ 脱敏最容易漏 `rawPretty`

§9.1 要求脱敏，但很容易只处理了 `preview` 而漏掉 `rawPretty`。
**原始 JSON 面板才是用户实际复制粘贴的地方**，漏了等于没做。
验收 B7 专门查这个。

### ★ 夹具 01 和 02 的 `assistant` 计数不同（4 vs 2）

**这是真实差异，不是笔误。** 验收时不要"顺手改成一致"。

### ★ `role === "user"` 不等于"人打的字"

夹具 01 的索引 3 是 Codex 注入的 **AGENTS.md 内容**，落盘也带 `role: "user"`：

```jsonc
{ "type": "response_item",
  "payload": { "type": "message", "role": "user",
               "content": [{ "text": "# AGENTS.md instructions for /Users/dev/…" }] } }
```

唯一可靠的"人打的字"信号是 **`event_msg/user_message`**。
而且同一句输入常常**落两份**（事件一份 + `response_item` 一份），两份都显就是重复噪音。

规则（§6.8.7）：**有事件那份就只认它，一份都没有才退回 `response_item` + `role=user`**。
`src/shared/steps.ts` 的 `isUserInput` 和 `StepGraph` 的 `hasEventUser` 分支就是这件事。

### ★ Step 边界靠 `token_count`，所以图不能从过滤后的条目切

`event_msg/token_count` 是每次模型请求后的用量上报，天然是 Step 收尾——4 份样本全吻合。
但它属于**元信息**组，用户一关这一组，Step 边界就没了。

所以 `buildGraph` 吃的必须是**全量** entries，过滤只决定哪些行渲染出来（§6.8.5 第 3 条）。
验收 G7 专门查这个。

### ★ `file://` 是 secure context，剪贴板真的能用

差点按「`file://` 不安全所以 `navigator.clipboard` 不可用」去设计，**实测推翻了**：
Electron 43 + `sandbox: true` + `loadFile()` 下 `window.isSecureContext === true`，
`clipboard-write` 是 `granted`，窗口有焦点时 `writeText` 真的写进系统剪贴板。

但回退路径不是装饰：**窗口失焦时 `writeText` 抛 `NotAllowedError: Document is not focused`**，
而带真实点击手势的 `execCommand('copy')` 失焦也能成。
「从别的应用切回来直接点复制」正是失焦场景。两条路都要留。

两个连带的坑：

```js
await navigator.clipboard?.writeText(t)   // ❌ 没有 clipboard 时 await undefined 直接 resolve
                                          //    → 报告成功、其实什么都没复制
```

回退用的 textarea 只能移到屏幕外，**不能 `display:none` / `visibility:hidden`** ——
那样的元素选不中，复制出来是空串。

### ★ `total_token_usage` 是会话累计值，画图前必须做差

夹具 04 实测：`11840 → 24800 → … → 128620`，单调递增，因为字段名就叫 **total**。
直接画成曲线会得到一条永远向上的斜线，看着像每步暴涨，其实只是累计量 —— **图会骗人**。

增量**可能为负**，不许夹到 0。原因已在源码核实：`append_last_usage`
（`protocol/src/protocol.rs:2122`）是 `add_assign` 所以正常单调递增，
但 `fill_to_context_window`（同文件 2127）会整体替换该结构、把 input/output 归零。
**这和 compact 无关** —— compact 走的是另一套 `active_context_tokens` 埋点。

### ★ Task 和 Turn 是同一层

`codex-rs/core/src/tasks/mod.rs` 文件头原话：「协议里对外说的 Turn，在 core 内部的实现
就是这里的 Task。**它们是同一个东西，不是两层。**」

照着 `Task → Turn → Step` 画三层，中间那层永远是空的。真实层级见 §6.8.1。

---

## 3. 命令

```bash
npm start            # electron-forge start（Vite HMR）
npm run typecheck    # tsc --noEmit
npm test             # vitest run，546 条
npm test -- rollout  # 单文件
npm run test:cov     # 覆盖率（src/shared/ 门槛 90%）
npm run make         # 打包 zip
npm run lint         # oxlint（不是 ESLint，原因见 §1）
npm run lint:fix

# 用夹具当数据源启动
CODEX_HOME=$(pwd)/test npm start

# §14.6 端到端冒烟：自动走完 4 步、逐条打印 PASS/FAIL、留 4 张截图
CODEX_HOME=$(pwd)/test UNROLL_SHOT=/tmp/shots npm start
```

> 冒烟脚本在 `src/main/smoke.ts`，**只有设了 `UNROLL_SHOT` 才动态 import**。
> 它存在的理由：F2（每行等高）/ F3（不撑破布局）/ F12（面板独立滚动）是**布局断言**，
> 而 jsdom 不做布局（`offsetHeight` 恒为 0），这几条在单测里恒真、等于没测。

---

## 4. 架构

### 三进程边界（SPEC §7.2）

```
main.ts        唯一有 fs 权限：扫描 sessions、读文件、fs.watch 增量跟随
  ↓ IPC
preload.ts     contextBridge 窄接口，只暴露 §7.3 的 8 个方法到 window.unroll
  ↓
renderer/      React UI + JSONL 归一化（拿不到 fs / path / require）
```

**关键决策：解析放在渲染进程。** 主进程只负责"给我原始行"，
归一化是纯函数，方便单测且不阻塞主进程。

`src/shared/` 放主/渲染共用的类型（`types.ts`）和归一化纯函数（`rollout.ts`）。

### UI 的核心决策来由（SPEC §6.0）

实测：**19 行，每行 5 000–11 500 字符**。

> 这不是"长列表"问题，是"少量巨型对象"问题。
> **→ 时间线只承载结构（每条固定一行、永不换行），内容全部交给右侧详情面板。**

由此推出的四条，实现时不要擅自改回常规做法：

1. 时间线每条**固定单行高**，`white-space: nowrap`，超出截断
2. **详情面板选中才渲染**，未选中时时间线占满宽度
3. 下钻**恰好两层**（时间线选中 → 面板内容 + 折叠的原始 JSON），不要做第三层
4. 顶部只有一行状态条（`model · approval · sandbox`），**不做摘要卡片区**

配色 6 组（§6.3），且**符号 `●○▶⚠·` 独立于颜色**——灰度下也要能区分（验收 F21）。

### 解析必须宽松（SPEC §3.4）

`payload.type` 是开放集合：

- 未知值降级为 `other` 照常显示
- 单行 JSON 解析失败 → 生成 `_parse_error` 条目保留原文，**继续解析后续行**
- 所有字段读取都要有默认值

**绝不因为不认识就丢弃或崩溃。**

### 实时跟随要点（SPEC §7.4）

`fs.watch` 触发后 **120ms 去抖**（一次 turn 会触发多次 change）；从 offset 增量读取，
**只提交以 `\n` 结尾的完整行**，半行留到下次；`stat.size < offset` 说明文件被截断
→ 发 `session:reset` 让前端重读；**仅当用户已在底部（距底 <60px）时才自动滚动**。

---

## 5. 测试夹具

`test/fixtures/` 下四份，**随仓库提交，已脱敏**（`/Users/te` → `/Users/dev`）。

| 文件 | 行数 | 来源 | 覆盖 |
|---|---:|---|---|
| `01-apply-patch-rejected.jsonl` | 19 | 真实会话 | `custom_tool_call` + 沙箱拒绝路径 |
| `02-exec-command.jsonl` | 17 | 真实会话 | `function_call` + 成功路径 |
| `03-edge-cases.jsonl` | 14 | 手工构造 | 脱敏 / 坏行 / 未知类型 / 超大内容 / 缺字段 |
| `04-multi-turn.jsonl` | 58 | 手工构造 | 多 Turn / 逐轮冻结配置变化 / 三种 Step 收场 / 未收尾会话 |

★ 04 是**唯一一份多 Turn 夹具**，README 的图视图截图用的就是它。
它同时是唯一能显出「冻结配置是一轮一份、不是一会话一份」的样本。
注意它是手工构造的，**不能拿来当 Step 边界启发式的经验证据**（那个结论只算真实会话）。

**期望值全部在 SPEC §14.2，是实测算出的确切数字**，例如：

```
C9  summary.durationMs = 14058
C10 summary.ttftMs     = 3936
C11 inputTokens / outputTokens = 34188 / 263
C12 索引 11 → title='→ apply_patch', callId='call_00_VGd9DAeHsvuuvIgL2BSM1663'
F14 六组计数 = 输入6 · 思考2 · 行动2 · 输出4 · 元信息5 = 19
```

改夹具 = 改验收基线，**除非有充分理由，不要动这四个文件**。

---

## 6. 硬约束

- **完全不联网**：不做遥测、不检查更新、不上传任何数据。
  rollout 里可能含用户的 API key 和私有代码，任何"上传分析""崩溃上报"都不能加。
- **只读**：全程不写、不删、不改任何 rollout 文件。
- **密钥脱敏**：显示层默认遮蔽，保留尾 4 位（§9.1）。**不提供"显示明文"开关。**
- **纪律**：§14.2 的 40 条断言不全绿，**不写任何 UI 代码**。归一化是地基，
  它错了上层全是错的，而且是唯一能被纯函数彻底覆盖的一层。
- **本地化：归一化层不许出人话**（SPEC §15）。`Entry.title` / `Entry.preview` 是
  `Text = string | MsgRef`，不是 `string`。写新分类分支时判断标准只有一句：
  **换了语言它会变吗？** 会变 → `ref('some.key')`；不会变（工具名、命令输出、
  未知记录的类型名）→ 原样字符串。
- **`preload.ts` 只暴露 8 个方法**，验收 E7 用 `Object.keys(window.unroll).length === 8`
  钉死。语言偏好、主题这类渲染层的事**不许走 IPC** 去加第 9 个方法。
