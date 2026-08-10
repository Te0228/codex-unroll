# codex-unroll · 设计规格

> **Unroll your Codex sessions** —— 把 Codex CLI 的 rollout JSONL 摊开成可读的时间线。

| | |
|---|---|
| 版本 | 0.1（草案） |
| 状态 | 设计中，未开始实现 |
| 技术栈 | Electron Forge + Vite + React + TypeScript |
| 目标平台 | macOS 优先，Windows / Linux 尽量兼容 |

---

## 1. 背景与动机

Codex CLI 每次会话都会在 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
留下一份完整的执行轨迹。这份文件是理解 agent 行为的**唯一真实记录**：
用户输入 → 提示词组装 → 模型响应 → 工具调用 → 工具结果 → token 用量 → 下一轮。

问题是它**没法读**：

- 每行是一个压平的 JSON，单行动辄数千字符
- 一次普通会话里，AGENTS.md 注入就有 23000 字符，全挤在一行
- `cat` / `jq` 在终端里输出会瞬间刷屏，人眼无法跟随
- 想看"这一轮调了哪些工具、各自耗时多少"，需要手写 jq 过滤器
- agent 正在跑的时候，无法实时观察

**codex-unroll 要解决的就是这件事：让 rollout 变得可读、可搜、可实时观察。**

### 谁会用

1. **读 Codex 源码的人**（首要）——需要把源码里的 `Op` / `EventMsg` 与真实数据对上号
2. **调试 agent 行为的人**——想知道"为什么模型选了这个工具""为什么这条命令被拒"
3. **做提示词工程的人**——想看每轮实际发给模型的完整上下文
4. **排查线上问题的人**——用户发来一份 rollout，需要快速定位出错点

---

## 2. 目标与非目标

### 目标

- **可读**：一屏看清一次会话的结构，而不是一堵 JSON 墙
- **可定位**：按类型过滤、全文搜索，秒级找到关心的那几条
- **可下钻**：摘要 → 展开看内容 → 再展开看原始 JSON，三层递进
- **可实时**：agent 跑的时候能跟着看，像 `tail -f` 但可读
- **零配置**：打开就能用，自动发现 `$CODEX_HOME/sessions`
- **只读**：绝不修改任何 rollout 文件

### 非目标（明确不做）

- ❌ 不做 Codex 的替代 UI，不发起会话、不与模型交互
- ❌ 不做 rollout 的编辑 / 删除 / 归档管理
- ❌ 不解析 `RUST_LOG` 的文本 trace 日志（格式不同，另开项目或后续版本）
- ❌ 不做云端同步、不上传任何数据
- ❌ v0.1 不做多会话对比 / 差异分析

---

## 3. 数据源规格

### 3.1 位置

```
$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO时间>-<session_id>.jsonl
默认 CODEX_HOME = ~/.codex
```

（常量定义见 Codex 源码 `codex-rs/rollout/src/lib.rs`：`SESSIONS_SUBDIR = "sessions"`）

### 3.2 行结构

每行一个 JSON 对象。实测共 **5 种顶层 `type`**：

| 顶层 `type` | 含义 | 出现次数 |
|---|---|---|
| `session_meta` | 会话头：cwd、cli_version、model_provider、git 信息 | 1（首行） |
| `turn_context` | 轮次配置：model、effort、approval_policy、sandbox_policy | 每轮 1 |
| `world_state` | 世界状态快照 | 偶发 |
| `event_msg` | 事件流，对应源码 `EventMsg` 枚举 | 多 |
| `response_item` | 与模型往返的条目，对应 `ResponseItem` | 多 |

### 3.2.1 ★ 统一信封（实测校正，2026-08-04）

**所有 5 种记录用的是同一个信封**，字段一律在 `payload` 里，顶层只有三个键：

```jsonc
{
  "timestamp": "2026-08-04T03:13:09.989Z",
  "type": "turn_context",
  "payload": { /* 全部内容都在这里 */ }
}
```

> ⚠️ **这条曾被写错。** 早期用 `jq 'keys'` 调查时把 `payload | keys` 的输出
> 误当成了顶层 keys，导致 spec 一度声称 `session_meta` / `turn_context`
> 的字段在顶层。以夹具实测为准：**它们同样在 `payload` 内**。
>
> 区别只在于：`event_msg` / `response_item` 的 `payload` 有 `type` 字段作为
> 二级判别式；其余三种没有。

### 3.3 已确认的 payload 结构

#### `session_meta`（`payload` 无 `type`）

```
session_id, id, timestamp, cwd, originator, cli_version, source,
thread_source, model_provider, base_instructions, history_mode,
context_window: { window_id },        ← 是对象，不是数字
git: { commit_hash, branch, repository_url }
```

#### `turn_context`（`payload` 无 `type`）

```
turn_id, cwd, workspace_roots[], current_date, timezone,
approval_policy: "never" | "on-request" | …,
sandbox_policy:  { "type": "read-only" },      ← 内部标签，读 .type
approvals_reviewer, permission_profile: { type, network, file_system },
model, personality, effort, summary,
collaboration_mode: { mode, settings: { model, reasoning_effort } },
multi_agent_version, realtime_active
```

> `sandbox_policy` 是 **internally-tagged**（`{"type":"read-only"}`），
> 不是 externally-tagged（`{"read_only":{}}`）。取值直接读 `.type`。

#### `world_state`（`payload` 无 `type`）

```
full, state
```

#### `event_msg`（`payload.type` 为判别式）

| payload.type | 关键字段 |
|---|---|
| `user_message` | `message`, `images`, `audio`, `local_images`, `local_audio`, `text_elements` |
| `agent_message` | `message`, `phase`, `memory_citation` |
| `task_started` | `turn_id`, `started_at`, `model_context_window`, `collaboration_mode_kind` |
| `task_complete` | `turn_id`, `started_at`, `completed_at`, `duration_ms`, `time_to_first_token_ms`, `last_agent_message` |
| `token_count` | `info.{last_token_usage, total_token_usage, model_context_window}`, `rate_limits` |

用量对象字段：`input_tokens`, `cached_input_tokens`, `output_tokens`,
`reasoning_output_tokens`, `total_tokens`

> 注：wire 格式用的是 v1 名字 `task_started` / `task_complete`，
> 源码枚举名是 `TurnStarted` / `TurnComplete`。UI 显示源码名并标注 wire 名。

#### `response_item`（`payload.type` 为判别式）

| payload.type | 关键字段 |
|---|---|
| `message` | `role`, `content[]`（`{type, text}` 数组）, `phase`, `id` |
| `reasoning` | `content`, `summary`, `encrypted_content`, `id` |
| `function_call` | `name`, `arguments`（JSON 字符串）, `call_id`, `id` |
| `function_call_output` | `call_id`, `output`, `id` |
| `custom_tool_call` | `name`, `input`, `call_id`, `id` |
| `custom_tool_call_output` | `call_id`, `output`, `id` |

> `apply_patch` 走的是 `custom_tool_call`（参数在 `input`），
> `shell` / `exec_command` 走 `function_call`（参数在 `arguments`，且是 JSON 字符串需二次解析）。
> **两条路径都必须支持。**

### 3.4 解析原则

- **宽松解析**：`payload.type` 是开放集合，遇到未知值必须降级为"其它"照常显示，
  绝不能因为不认识就丢弃或崩溃
- **坏行不致命**：单行 JSON 解析失败时，生成一条 `_parse_error` 条目保留原文，继续解析后续行
- **字段全部可选**：所有字段读取都要有默认值

---

## 4. 用户场景

### S1 · 复盘一次会话
打开 app → 左栏自动列出最近会话（带时间、模型、首条用户消息）→ 点开 →
右侧时间线按序展开 → 顶部卡片一眼看到 model / 审批策略 / 沙箱 / 耗时 / token 用量。

### S2 · 只看工具调用
点「只看工具调用」→ 时间线只剩 `function_call` / `function_call_output` →
自动展开 → 看到模型传了什么参数、拿回什么结果。

### S3 · 实时观察
勾选「实时跟随」→ 在另一个终端跑 `codex exec "..."` →
新事件实时追加到时间线底部，自动滚动。

### S4 · 定位一个错误
搜索框输入 `rejected` → 命中 `patch rejected: writing is blocked by read-only sandbox` →
展开看原始 JSON → 拿到 `call_id` → 搜 `call_id` 找到对应的 `function_call`，看模型当时想干什么。

---

## 5. 功能需求

### P0（v0.1 必须有）

| # | 功能 | 验收标准 |
|---|---|---|
| F1 | 自动发现会话 | 启动时扫描 `$CODEX_HOME/sessions`，按修改时间倒序列出 |
| F2 | 会话列表摘要 | 每项显示：时间、模型、文件大小、首条用户消息（截断） |
| F3 | 打开任意文件 | 支持 ⌘O 文件选择器；支持拖放 |
| F4 | 时间线渲染 | 每条**固定单行**：序号、时间、符号、类型、摘要（截断，永不换行） |
| F5 | **两层下钻** | 时间线选中 → 右侧详情面板（内容 + 可折叠的原始 JSON） |
| F6 | 类型过滤 | 按 §6.3 的 6 组分类，位于底部状态栏，显示各组计数 |
| F7 | 全文搜索 | 匹配标题 + 内容 + 原始 JSON，实时过滤 |
| F8 | **状态条 + 详情面板** | 顶部状态条只显示 model · approval · sandbox；其余摘要（provider/effort/耗时/token）在选中会话头条目时于详情面板展示 |
| F9 | 实时跟随 | `fs.watch` + 增量读取，新事件追加；在底部时自动滚动 |
| F10 | 深浅色主题 | 跟随系统 |
| F11 | 详情面板可调宽 | 拖拽改变宽度（默认 420px / 最小 320px），`Esc` 关闭 |
| F12 | 拖放打开 | 拖 `.jsonl` 到窗口任意位置即打开（空状态是显式拖放区） |
| F13 | 键盘导航 | `j`/`k`/`↑`/`↓` 切换选中条目，详情面板同步 |

### P1（v0.2）

| # | 功能 |
|---|---|
| F14 | 工具调用配对：`function_call` 与 `function_call_output` 通过 `call_id` 关联，详情面板内可互相跳转 |
| F15 | 轮次分组：按 `turn_id` 折叠成组，可整轮折叠 |
| F16 | 耗时可视化：每个工具调用画一条时间条，看清并发还是串行 |
| F17 | Token 用量图表：随轮次增长的曲线 |
| F18 | 复制：单条 JSON / 全部内容（均为**脱敏后**版本，见 §9.1） |
| ~~F19~~ | ~~`function_call.arguments` 的 JSON 字符串二次解析~~ ✅ **已提前到 v0.1**，见 §6.7 |
| F20 | 详情面板内的大内容分段渲染（AGENTS.md 注入这类按 markdown 标题折叠） |

### P2（想到但暂不做）

- 解析 `RUST_LOG` 文本 trace，与 rollout 时间线合并展示
- 两个 rollout 的 diff 对比
- `debug prompt-input` 输出的可视化
- 从 rollout 反推并展示提示词的组成成分占比

---

## 6. UI 规格

### 6.0 设计前提：这是"少量巨型对象"的浏览问题

实测数据（§10.1）：**19 行，每行 5 000–11 500 字符**。

```
容易误判成的形状：        真实形状：
┌─┬────────────┐        ┌─┬────────────┐
│ │ ─────      │        │ │ ██████████ │  ← 单条 11 000 字符
│ │ ─────      │        │ │ ██████████ │
│ │ ─────      │        │ │ ██████████ │
│ │ ─────      │        │ │            │  ← 总共才 19 条
│ │ ─────      │        │ │            │
└─┴────────────┘        └─┴────────────┘
  条目多、每条短            条目少、每条巨大
```

**这不是长列表问题，是"结构 + 细节"问题。** 由此推出核心决策：

> **时间线只承载结构（每条固定一行），内容全部交给独立的详情面板。**

参考同类"打开文件看结构"的工具（如 Netron 之于模型文件）的做法：
主区域展示结构、选中后侧栏展示细节、chrome 极少、配色克制。

### 6.1 布局

三栏，右栏按需出现。

```
┌───────────────────────────────────────────────────────────────────────────┐
│ ⌘ 01-apply-patch-rejected.jsonl   deepseek-v4-flash · never · read-only ⚙ │ ← 状态条(28px)
├──────────┬─────────────────────────────────────┬──────────────────────────┤
│ 会话  📂↻ │  时间线（主区）                       │  详情（选中才出现）        │
│ ┌──────┐ │                                     │                          │
│ │过滤… │ │  0  03:13:09 ● 会话开始              │  custom_tool_call        │
│ └──────┘ │  1  03:13:09 ● 轮次配置 never/ro     │  apply_patch             │
│ ┌──────┐ │  2  03:13:10 ● 用户    创建 hello…   │  call_00_VGd9DAeHsv…     │
│ │08-04 │ │  3  03:13:13 ○ 推理    I'll add…     │ ────────────────────────│
│ │18:28 │ │  4  03:13:16 ▶ 工具    apply_patch ◀─┤  *** Begin Patch         │
│ │exec… │ │  5  03:13:16 ▶ 结果    rejected ⚠    │  *** Add File: hello.txt │
│ │ 112K │ │  6  03:13:19 ● 模型    我没能创建…    │  +hi                     │
│ ├──────┤ │  7  03:13:23 ● 完成    14058ms       │  *** End Patch           │
│ │08-04 │ │                                     │                          │
│ │11:13◀│ │                                     │  ▾ 原始 JSON             │
│ │apply…│ │                                     │                          │
│ │ 104K │ │                                     │                          │
│ └──────┘ │                                     │                          │
├──────────┼─────────────────────────────────────┴──────────────────────────┤
│ 3 个会话  │ 19 条 · ●输入4 ○思考2 ▶行动2 ●输出4 ·弱6 · 🔍/ · ☑跟随 ●       │ ← 状态栏(26px)
└──────────┴────────────────────────────────────────────────────────────────┘
   240px                    自适应                       420px（可拖拽/可关）
```

**四条关键改动（相对旧设计）：**

| # | 改动 | 理由 |
|---|---|---|
| 1 | 时间线每条**固定一行高**，只放摘要 | 一屏看完 19 条的完整结构，这才是 "unroll" |
| 2 | 新增**右侧详情面板**，选中才出现 | 11 000 字符有了专属的宽区域，可独立滚动 |
| 3 | 顶部 11 个卡片 → **一行状态条**（3 个值） | 卡片区占了最贵的空间展示整场不变的值 |
| 4 | 三层下钻 → **两层** | 时间线（选）→ 详情面板（内容 + 折叠的原始 JSON） |

**详情面板行为：**
- 未选中任何条目时**不显示**，时间线占满宽度
- 选中后从右侧滑出，宽度可拖拽（默认 420px，最小 320px）
- `Esc` 关闭；再次点击同一条也关闭
- 内容区与「原始 JSON」是同一面板内的两段，JSON 段默认折叠

### 6.2 时间线行的构成

固定单行，超出省略号截断，**永不换行**：

```
 序号   时间       标记  类型     摘要（省略号截断）
  4    03:13:16    ▶    工具     apply_patch  {"input":"*** Begin Patch…
 └─3ch─┴──8ch───┴─1ch─┴─4ch──┴────────── 剩余全部 ──────────────────┘
```

标记符号（不依赖颜色，色盲可用）：

| 符号 | 含义 |
|---|---|
| `●` | 实心：主线内容（用户 / 模型输出 / 会话结构） |
| `○` | 空心：思考过程（弱化） |
| `▶` | 三角：行动（工具调用与结果） |
| `⚠` | 警告：错误 / 被拒绝 |
| `·` | 点：元信息（用量 / 世界状态） |

### 6.3 配色（12 → 6 收敛）

旧方案 12 个 kind 各一色，一屏同时出现过于花哨。
按"颜色只承载语义、不做装饰"的原则收敛到 **6 组**：

| 组 | 色值（浅/深） | 符号 | 包含的 kind | 说明 |
|---|---|---|---|---|
| **输入** | `#0969da` / `#58a6ff` | `●` | `user`、`context`、`session` | 进入 agent 的东西 |
| **思考** | `#8c959f` / `#6e7681` | `○` | `reasoning` | **刻意弱化**：量大但通常不是要找的 |
| **行动** | `#bc4c00` / `#db6d28` | `▶` | `tool_call`、`tool_out` | agent 对外界做的事 |
| **输出** | `#1a7f37` / `#3fb950` | `●` | `assistant` | agent 给出的结果 |
| **元信息** | `#8c959f` / `#6e7681` | `·` | `usage`、`state`、`lifecycle`、`other` | 极弱，几乎不抢视线 |
| **异常** | `#cf222e` / `#f85149` | `⚠` | `error`、`_parse_error` | 唯一的高饱和色 |

> `kind` 枚举（§8）保持 12 个不变——它是数据层的分类。
> 这里只是**显示层的分组映射**，一个 `kindToGroup()` 函数搞定。
> 这样 P1 若要细分显示，不用改数据模型。

配色沿用 GitHub 的中性底（浅 `#ffffff` / 深 `#0d1117`），与读代码场景一致（§12 Q5）。

### 6.4 空状态

无选中会话时，主区是一个大拖放区：

```
        ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
                     📜
         把 rollout .jsonl 拖到这里
        │  或从左侧选择，或按 ⌘O 打开  │

        └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
          扫描目录：~/.codex/sessions
```

拖放是一等入口，不是附属功能。

### 6.5 快捷键

| 键 | 动作 |
|---|---|
| `⌘O` | 打开文件 |
| `/` | 聚焦搜索 |
| `j` / `k` 或 `↑` `↓` | 上/下一条（选中即在详情面板展示） |
| `Esc` | 关闭详情面板 / 退出搜索框 |
| `⌘F` | 在详情面板内搜索 |
| `r` | 刷新会话列表 |
| `g` | 主区视图：图 ⇄ 列表（§6.8） |
| `⌘1` / `⌘2` | 折叠/展开 左栏 / 右栏 |

> `g` 用单键而不是 `⌘` 组合：`⌘1` / `⌘2` 已经是折叠左右栏，
> 别在同一个手势族里叠第三层语义。

> 注：旧方案的 `e` / `c`（全部展开/折叠）已移除——
> 两层结构下没有"全部展开"的语义了。

### 6.6 会话列表按项目分组（原 §12 Q3，已定案）

```
openai/codex                    3     ← 组头：项目名 + 会话数
  08-04 19:32  创建一个 hello.txt…      ← 组内按 mtime 倒序
  08-04 19:32  列出当前目录下的文件
  08-03 11:07  读一下 rollout 的写入…
example.com/x                   1
  08-04 19:43  帮我用这个 key 调接口…
```

> ★ **Codex 在磁盘上完全不按项目组织。** 目录是 `sessions/YYYY/MM/DD/`，纯日期，
> 没有任何一层项目目录。「项目」这个概念在 rollout 存储里根本不存在。
>
> 项目归属只存在于**每个文件第 1 行 `session_meta`** 的两个字段里：
> `payload.cwd` 和 `payload.git.repository_url`。
> 所以本节的分组**是从每个文件的第 1 行读出来重建的**，不是照搬目录结构——
> 这也正是下方性能约束存在的原因：1000 个会话就要读 1000 次第 1 行。

**分组键用 git 仓库，不用 cwd。** 实测 `cwd = /Users/dev/workspace/codex/codex-rs`
而仓库是 `openai/codex`——Codex 在哪个目录起会话 cwd 就是哪个，
同一仓库的 `codex-rs` / `codex-cli` / 根目录各起过会话的话，
按 cwd 分组会把**一个项目劈成三组**。

键优先取 `session_meta.payload.git.repository_url`（归一化 https / ssh / scp 三种写法到
`host/owner/repo`），无 git 才退回 `dir:<cwd>`。实现见 `src/shared/project.ts`。

**组按「组内最新会话的 mtime」倒序，不按项目名。**
分组的最大副作用是让「我最近在干什么」变难找（最新的会话可能落在第三组）。
组按最新活动倒序后，**第一组的第一条仍然是全局最新的**，
「最近」和「按项目找」两个诉求同时满足。

三条硬要求：

| # | 要求 | 理由 |
|---|---|---|
| 1 | **组头一律显示**，哪怕只有一个项目 | 见下方「一条被推翻的设计」 |
| 2 | 组头紧凑（~20px）、组内缩进 ≤8px | 左栏只有 240px，多一层缩进会挤掉本就不够的文件名空间 |
| 3 | 组头可折叠，状态存 `localStorage` | 项目多了以后需要收起不关心的 |
| 4 | 「未知项目」组**永远排最后** | 不参与活跃时间排序，避免元数据缺失的项目霸占顶部 |
| 5 | **顶部状态条也显示项目**，`title` 挂完整 cwd | 左栏可被 `⌘1` 折叠，折叠后项目身份不能跟着消失 |

> **一条被推翻的设计（2026-08-05）**
>
> 初版定的是「只有一个项目时不显示组头」，理由是「多数人 90% 的会话在同一仓库，
> 硬套一层分组是纯视觉噪音」。**实际使用后被推翻。**
>
> 错在把组头当成了「分组的装饰」，于是认为值恒定时就该省略。
> 但组头承载的是**项目身份**，不是分组结构的副产品。
> 真实反馈是：打开 app 后不知道自己在看哪个仓库——9 个会话全在同一项目，
> 组头被抑制，项目信息只剩详情面板里一个要点两次才看得到的 `cwd`。
>
> **身份信息不能因为「当前只有一个值」就隐藏。**
> 顶部状态条同时显示 model / approval / sandbox 也是恒定值，从没人说要省略它们。

**性能约束**：`project` 与 `model` / `firstUser` **不同级别**。
后两者受「只对最近 60 个做摘要」限制，但 `project` **必须每一项都有**，
否则超出上限的会话会全部掉进「未知项目」组，分组就废了。

而 `session_meta`（第 1 行）实测 **22 KB**（`base_instructions` 占绝大部分），
1000 个会话全量 `JSON.parse` 第 1 行 = 22 MB 解析量，会吃掉 §10.2「启动 <1s」的一大截。
因此分组字段用**定向提取**而非整行解析，且必须有测试证明与 `JSON.parse` 结果一致。


### 6.7 原始 JSON 的树视图（原 P1 F19，提前到 v0.1）

「原始 JSON」段从 `<pre>{rawPretty}</pre>` 改为**可折叠树视图**，另留「原文」视图供整段复制。

理由就是 §6.0 的设计前提：`session_meta` 实测 **22 KB**（`base_instructions` 占绝大部分）。
一段 22 KB 的 pretty JSON 平铺出来，和终端里 `cat` 一行 11 000 字符是同一个问题，
只是换了个地方发生。

| 要点 | 说明 |
|---|---|
| 默认展开 1～2 层 | 打开就有用，又不至于一泻千里 |
| 折叠摘要 | `{…} 12 项` / `[…] 5 项`，不展开也知道里面有多少 |
| 超长字符串截断 | >200 字符先截断 + 「展开全部」，否则 `base_instructions` 一行就把树撑爆 |
| **二次解析** | 值是字符串且能 `JSON.parse` 成对象/数组时，当子树渲染（这就是原 F19） |
| 缩进用 CSS | 不用空格字符，面板宽度变化时不会错位 |

> ⚠️ **`custom_tool_call.input` 不能当 JSON 解析。** 它是纯文本 patch（`*** Begin Patch…`），
> 要保留换行原样显示。判据是「parse 成功**且**结果是对象或数组」——
> parse 成数字或字符串的不算，否则 `"123"` 这种值会被错误地当成数字节点。

**选库：`react-json-view-lite`**（CSS Modules，零运行时依赖）。

> ⚠️ 曾经在这里写过「所有 JSON 查看器库都过不了 CSP，只能自己实现」——**这句话是错的**，
> 已按实测更正。真相是分库而论：`react-json-view` / `@textea/json-viewer` 靠 emotion
> 生成行内 style，确实过不了 `style-src 'self'`（§9）；但 `react-json-view-lite`
> 用的是 CSS Modules，编译期就落成静态 `.css` 文件，与 CSP 无冲突。
>
> 结论不是推理出来的，是**在打包产物的严格 CSP 下实测**的：§14.6 冒烟里有四条专门查这个
> （树渲染出来了 / 库的缩进样式生效 / 我们接的语义色落到值节点上 / 树里搜不到明文密钥），
> 全绿且 0 条 CSP 违规。把「某一类库不行」推广成「所有库都不行」是过度概括，代价是白写一个组件。

我们只写一层薄适配（`components/JsonTree.tsx`）：把六组语义色的 class 传进库的 `style` 插槽。
**不去覆盖库自己那些哈希 class 名**——那是内容哈希，库一升版就全变。

**只读**：这是查看器不是编辑器。§2 的非目标与 §9 的硬约束都要求全程不修改 rollout，
树里不出现任何可编辑控件。

---

### 6.8 主区「图」视图：Session ▸ Turn ▸ Step（v0.2）

中栏顶部一条 24px 视图条，`图 / 列表` 二选一（`g` 切换，选择存 localStorage）。
**默认「图」**。列表视图（§6.2 的固定单行时间线）原样保留，一条断言不改。

#### 6.8.1 层级来自 Codex 源码，不是我们发明的

`codex-rs/core/src/tasks/mod.rs` 文件头是权威：

```
Session
 └ Task  == Turn == 一个 turn_id == 一个冻结的 TurnContext
    └ run_turn   Turn 内的「一趟」（被插话 steer 就多一趟）
       └ Step    一次模型请求 + 处理它的回答
```

★ **Task 和 Turn 是同一层，不是两层**——源码原话「它们是同一个东西」。
所以本项目只有 Turn，没有 Task 这一级。照着「Task → Turn → Step」画三层，中间那层是空的。

★ **「趟」故意不还原**：rollout 里没有任何标记，只能靠「Turn 中段冒出 user_message」
去猜插话。宁可缺一层，不猜错一层。

#### 6.8.2 Step 边界怎么定：`token_count`

rollout 没有显式的 Step 标记。但 `event_msg/token_count` 是**每次模型请求之后的用量上报**，
天然就是 Step 的收尾。三份夹具 + 真实会话共 4 份样本全部吻合
（04 号夹具是手工构造的，**不计入这条经验证据**）：

```
turn_context ─────────────────────────────────────── Turn 开始
  reasoning → message → tool_call → tool_out → token_count   ← Step 1（调工具，循环继续）
  reasoning → message → token_count                          ← Step 2（只回消息，出环）
task_complete ────────────────────────────────────── Turn 结束
```

这正是 ReAct：Think → Act → Observe → 回到 Think，直到某个 Step 只回消息就出环。

> ⚠️ 这是**启发式，不是协议保证**。所以退化路径必须良性：一个 `token_count` 都没有的
> Turn 整体退化成一个 `open` 状态的 Step，内容一条不少，只是不分段。
> `flattenGraph(buildGraph(es))` **恒等于** `es`——同样的对象、同样的顺序，由 §14.9 S13 钉死。
> 切分可以是启发式，「不丢条目」不能是。

#### 6.8.3 为什么不画 SQ / EQ

`protocol/src/protocol.rs` 的 SQ(Submission Queue) / EQ(Event Queue) 这一对里，
**SQ 完全不落盘**：rollout 只有 agent 发出来的 `Event`（= `event_msg`），
没有上层发进去的 `Op`。画一条恒空的队列没有意义，因此只保留 EQ 这一半，融进 Step 内的条目。

#### 6.8.4 为什么是竖向链，不是环

turn loop 是 ReAct 循环没错，但真实会话动辄几十个 Step，画成环会糊成一团。
竖着串 `Step 1 ↓ Step 2 ↓ …`，Step 再多也只是纵向变长，滑轮就能看完。

#### 6.8.4.1 ★ 「图感」由三条线撑着，缺一条就退化成带框的列表

第一版只有嵌套的方框，读起来像分组列表不像图。**图的图感来自边**，补了三样：

| 元素 | 画法 | 作用 |
|---|---|---|
| **主干线** | `.turn::before` 一条竖线，两端 `◆` / `◇` 菱形节点 | 把整个 Turn 串成一条链 |
| **接线** | `.step::before` 一截 19px 横线 | Step 是**挂在**干线上的节点，不是并排的方块 |
| **支线** | `.branch::before` 左/上/下三边的括号 | 「出去调工具、带着结果回来」——ReAct 里最有形状的一步 |

外加 Step 序号做成干线上的圆点（`①②`），而不是满宽标题栏里的一行字。

> ⚠️ **三条线都画在元素框外面**（负 `left`），所以任何祖先加 `overflow: hidden`
> 都会把它们裁掉，视觉上表现为「节点浮着、没接上」。这个坑踩过两次
> （`.turn-head` 裁掉菱形、`.step` 裁掉接线），已钉成 CSS 回归断言。
> 圆角收边改由 `.step-head` / `.step-foot` 各自的圆角负责。
>
> ⚠️ 干线**不能用 `--border` 上色**：那个变量是给 1px 分隔线调的，
> 画 2px 竖线时淡到看不见。用 `--fg-muted` 压透明度。


#### 6.8.5 三条不许改回去的约束

1. **块只承载结构。** 块里每条仍是 §6.2 的固定单行 `.row`，内容全部交给右侧详情面板。
   §6.0 的设计前提在图里同样成立。
2. **下钻仍然恰好两层**（图 → 详情面板）。Turn 前言的展开、JSON 树内部的展开都属于
   **本层内部导航**，不计入层数（口径同 §14.8）。只有真正的下钻才打 `data-drill`。
3. **结构不随过滤器变形。** 图从**全量** entries 切，过滤只决定哪些行渲染出来。
   否则用户一关「元信息」组就会把 `token_count` 一起滤掉，而 Step 边界正是靠它切的——
   结构会当场散架。被滤掉的行在块内以「N 条被过滤」说明。

#### 6.8.6 块的构成

| 部件 | 内容 |
|---|---|
| Turn 头 | `Turn N` + 冻结配置 `model · effort · approval · sandbox` + `N step` |
| Turn 前言 | **默认全展开**；点「收起上下文 N 条」后只留**真人输入**和**异常**两类 |
| Step 头 | `Step N` + 本步调用的工具名 + 收场标记 |
| Step 正文 | 该步的条目，仍是固定单行 `.row` |
| Step 尾 | `输入 → 输出 tok`，点它下钻到那条 `token_count` |
| Step 间 | `↓ 工具结果写回历史，再问一次模型` |
| Turn 尾 | 时长 · 首字 · `task_complete` 链接；未收尾则显示「进行中」 |

收场三态，**符号独立于颜色**（同 §6.3 / F21 的原则，灰度下也分得开）：

| 收场 | 符号 | 左缘 | 含义 |
|---|---|---|---|
| `act` | ▶ | 橙实线 | 有工具调用，结果回灌历史，循环继续 |
| `answer` | ● | 绿实线 | 只回了消息，模型认为活干完了，出环 |
| `open` | · | 灰虚线 | 还没等到 `token_count`（正在跟随 / 被中断） |

#### 6.8.7 ★ 反直觉：`role === 'user'` 不等于「人打的字」

Turn 前言里哪一条常显，判据是「真人输入」。这里有个实测坑：

夹具 01 的索引 3 是 Codex 注入的 **AGENTS.md 内容**，落盘也带 `role: "user"`
（`# AGENTS.md instructions for …`）。所以唯一可靠的「人打的字」信号是
`event_msg/user_message`。

同时，同一句用户输入常常**落两份**（`event_msg/user_message` +
`response_item/message role=user`），两份都显就是重复噪音。

最终规则：**有事件那份就只认事件那份，一份都没有才退回 `response_item` + `role=user`。**
退路存在的理由是「万一某份 rollout 只写了后者，这一轮为什么开始会被整个折叠掉」。

#### 6.8.8 ★ 一条都不能少

图默认必须把**全部条目**摆出来，每条都有明确归宿。夹具 01 的 19 条：

| 出口 | 条数 | 内容 |
|---|---:|---|
| `.row` | 16 | 会话前言 1 + Turn 前言 7 + Step 1 的 5 + Step 2 的 3 |
| Step 块尾 | 2 | 两条 `token_count`，显示为 `输入 → 输出 tok`，点击下钻 |
| Turn 尾 | 1 | `task_complete`，显示为时长 · 首字 + 链接 |

> ⚠️ **这条是回归约束，不是描述。** Turn 前言一度默认收起，结果 19 条只显出 10 条——
> 藏掉了近一半。查看器的职责是「摊开」不是「摘要」，看不见的东西等于不存在。
> 折叠仍然留着（长会话里 AGENTS.md 那几条确实占地方），但**必须由用户主动按**。
> 验收 G6b 与 §14.6 各有一条断言钉住「16 + 2 + 1 = 19」。

#### 6.8.9 空态

一条都没命中时必须给话说（同 F17b：不许白屏）。光靠「Turn/Step 骨架 + N 条被过滤」不够——
会话若**一个 Turn 都没有**（全是无 Turn 标记的条目），骨架本身就是空的，主区会整片空白。
所以提示挂在图的最外层，不依赖任何骨架。

---

## 7. 技术架构

### 7.1 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 壳 | **Electron Forge 7** | 官方脚手架，打包/分发/签名开箱即用 |
| 构建 | **Vite 5** | Forge 的 `plugin-vite`，HMR 快 |
| UI | **React 19 + TypeScript** | 时间线是典型的列表渲染 + 状态过滤场景 |
| 样式 | CSS Modules 或 原生 CSS 变量 | 不引入 UI 框架，保持轻量、可控深浅色 |
| 状态 | React 内置（`useState`/`useReducer`） | 状态很简单，不需要 Redux/Zustand |
| 虚拟滚动 | **不做**（见 §10.1） | 实测行数 <20，用不上 |

> ⚠️ 脚手架默认装的是 `typescript@~4.5.4`，太老，**首个任务是升到 5.x** 并加 React。

### 7.2 进程模型

```
┌─────────────────── 主进程 (src/main.ts) ───────────────────┐
│  · 窗口生命周期                                             │
│  · 唯一拥有 fs 访问权                                       │
│  · 扫描 sessions 目录 / 读文件 / fs.watch 增量跟随           │
└──────────────────────────┬─────────────────────────────────┘
                           │ IPC（contextBridge 窄接口）
┌──────────────────────────┴─────────────────────────────────┐
│              preload (src/preload.ts)                       │
│  contextIsolation: true, nodeIntegration: false, sandbox    │
│  只暴露 §7.3 定义的 8 个方法                                 │
└──────────────────────────┬─────────────────────────────────┘
                           │ window.unroll
┌──────────────────────────┴─────────────────────────────────┐
│           渲染进程 React（src/renderer/）                    │
│  · 解析 + 归一化 JSONL（纯函数，可单测）                      │
│  · 组件渲染、过滤、搜索                                      │
│  · 拿不到 fs / path / require                               │
└─────────────────────────────────────────────────────────────┘
```

**关键决策：解析放在渲染进程。**
主进程只负责"给我原始行"，归一化是纯函数，方便单测且不阻塞主进程。

### 7.3 IPC 契约

```ts
interface UnrollAPI {
  /** 扫描 $CODEX_HOME/sessions，按 mtime 倒序 */
  listSessions(): Promise<{
    codexHome: string;
    sessionsDir: string;
    items: SessionListItem[];
  }>;

  /** 读整个文件，返回原始行 + 字节数（字节数用作跟随起点） */
  readSession(file: string): Promise<{ path: string; lines: string[]; size: number }>;

  /** 从 fromOffset 起跟随新增内容 */
  watchSession(file: string, fromOffset: number): Promise<{ ok: boolean; error?: string }>;
  unwatchSession(): Promise<void>;

  /** 新增行推送；返回取消订阅函数 */
  onAppend(cb: (p: { path: string; lines: string[] }) => void): () => void;
  /** 文件被截断/重建，需重读 */
  onReset(cb: (p: { path: string }) => void): () => void;

  openFileDialog(): Promise<string | null>;
  revealInFinder(file: string): Promise<void>;
}
```

### 7.4 实时跟随的实现要点

1. `readSession` 返回文件字节数，作为跟随起点 `offset`
2. `fs.watch` 触发时**不立即读**，用 120ms 去抖——一次 turn 会触发多次 change
3. 从 `offset` 增量读取，**只提交以 `\n` 结尾的完整行**，半行留到下次
4. `stat.size < offset` 说明文件被截断/重建 → 发 `session:reset`，前端重读
5. 渲染前记录滚动位置：**仅当用户已在底部（距底 <60px）时才自动滚动**，否则不打断阅读

### 7.5 目录结构（计划）

```
codex-unroll/
├── SPEC.md                     ← 本文档
├── README.md
├── LICENSE                     (MIT)
├── forge.config.ts
├── package.json
├── tsconfig.json
├── vite.{main,preload,renderer}.config.ts
├── index.html
└── src/
    ├── main.ts                 主进程
    ├── preload.ts              contextBridge
    ├── shared/
    │   ├── types.ts            IPC 契约 + 数据模型（主/渲染共用）
    │   └── rollout.ts          归一化纯函数（可单测）
    └── renderer/
        ├── main.tsx            React 挂载点
        ├── App.tsx
        ├── components/
        │   ├── StatusBar.tsx        顶部状态条（model·approval·sandbox）
        │   ├── SessionList.tsx      左栏
        │   ├── Timeline.tsx         主区
        │   ├── TimelineRow.tsx      固定单行，永不换行
        │   ├── DetailPanel.tsx      右栏，选中才渲染 ★新增
        │   ├── RawJson.tsx          详情面板内可折叠的原始 JSON 段
        │   ├── FilterBar.tsx        底部状态栏（6 组过滤 + 计数 + 跟随开关）
        │   └── DropZone.tsx         空状态拖放区
        ├── hooks/
        │   ├── useSessions.ts
        │   ├── useFollow.ts
        │   ├── useSelection.ts      选中态 + j/k 键盘导航
        │   └── useResizable.ts      详情面板宽度拖拽
        └── styles/
```

---

## 8. 数据模型

```ts
/** rollout 每行的统一信封（见 §3.2.1）——所有 5 种记录都长这样 */
export interface RolloutRecord {
  timestamp?: string;
  type: 'session_meta' | 'turn_context' | 'world_state'
      | 'event_msg' | 'response_item' | string;   // 开放集合，未知值照常处理
  payload?: Record<string, unknown> & { type?: string };
}

/** 会话列表项（主进程只读文件头 64KB 生成摘要） */
export interface SessionListItem {
  path: string;
  mtime: number;
  size: number;
  model?: string;
  cwd?: string;
  cliVersion?: string;
  firstUser?: string;   // 首条用户消息，截断 120 字符
}

export type EntryKind =
  | 'session' | 'context' | 'user' | 'assistant' | 'reasoning'
  | 'tool_call' | 'tool_out' | 'lifecycle' | 'usage'
  | 'state' | 'error' | 'other';

/** 时间线上的一条 */
export interface Entry {
  index: number;
  timestamp: string;
  topType: string;        // session_meta / event_msg / response_item / …
  payloadType: string;    // user_message / function_call / …
  kind: EntryKind;
  title: string;          // "→ exec_command"
  preview: string;        // 供折叠态展示的正文
  callId?: string;
  turnId?: string;
  raw: unknown;
  rawPretty: string;      // JSON.stringify(raw, null, 2)
}

/** 会话级摘要，渲染顶部卡片 */
export interface SessionSummary {
  sessionId: string;
  cwd: string;
  cliVersion: string;
  provider: string;
  model: string;
  effort: string;
  approval: string;
  sandbox: string;
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}
```

**核心纯函数**（`src/shared/rollout.ts`，全部可单测）：

```ts
parseLine(line: string, lineno: number): unknown          // 坏行降级为 _parse_error
classify(rec: unknown): { kind; title; preview }          // 归类 + 提取展示文本
toEntry(rec: unknown, index: number): Entry
summarize(entries: Entry[]): SessionSummary
```

---

## 9. 安全

| 项 | 措施 |
|---|---|
| 渲染进程隔离 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:` |
| 文件访问 | 仅主进程；渲染进程只能通过 §7.3 的固定接口请求 |
| 只读 | 全程不写、不删任何 rollout 文件 |
| 网络 | **完全不联网**。不做遥测、不检查更新、不上传 |
| 敏感内容 | rollout 可能含 API key、私有代码。**绝不能有任何外发行为** |
| 密钥脱敏 | **显示层默认遮蔽**，见 §9.1 |

> 这一条是硬约束：rollout 里可能有用户的密钥和私有代码，
> 任何"上传分析""崩溃上报"都不能加。

### 9.1 密钥脱敏（P0）

rollout 与 `turn_context` 里可能出现 API key、Bearer token、Authorization 头。
**默认一律遮蔽，但保留尾 4 位。**

```
sk-FAKEdocsExample00000000000b6b2   →   sk-••••b6b2
Bearer eyJhbGciOi…                    →   Bearer ••••kR2p
```

#### 为什么保留尾 4 位而不是全遮

真实排障场景需要**区分是哪一把 key**。本项目作者在 2026-08-04 debug 一个 401 时，
报错显示 `****b6cQ` 而实际配置的 key 尾号是 `b6b2`——正是这 4 位揭示了
「Codex 发的根本不是你配的那把 key」。全遮就丢掉了这个关键信息。

尾 4 位不足以复用密钥，但足以判别身份。**这是安全与可用性的平衡点。**

#### 识别策略（两条都要，取并集）

**① 按字段名**（更可靠，优先）——JSON key 命中即遮蔽其值：

```
/(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token
 |secret|password|passwd|credential|authorization|auth[_-]?token
 |bearer|private[_-]?key|session[_-]?token)/i
```

**② 按值的形态**（兜底，覆盖嵌在正文里的密钥）：

| 类型 | 正则 |
|---|---|
| OpenAI 风格 | `sk-[A-Za-z0-9_\-]{16,}` |
| Bearer | `Bearer\s+[A-Za-z0-9._\-]{20,}` |
| JWT | `eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+` |
| AWS Access Key | `AKIA[0-9A-Z]{16}` |
| GitHub token | `gh[pousr]_[A-Za-z0-9]{36,}` |

#### 实施要点

- 脱敏发生在**归一化层**（`shared/rollout.ts`），在数据进入 React state 之前完成。
  这样 `preview` 和 `rawPretty` **两处都自动覆盖**，不会有一处漏网
- 遮蔽后的文本**参与搜索**（搜 `b6b2` 能命中），原文不进入任何可检索结构
- 提供「复制原始 JSON」时**同样复制脱敏后的版本**——避免用户粘到 issue 里泄露
- 界面上被遮蔽处显示 🔒 图标 + tooltip「已脱敏，仅显示尾 4 位」，让用户知道这不是数据缺失
- **不提供「显示明文」开关**。需要看原文就直接开文件，工具不承担这个职责

#### 验收

```ts
redact('sk-FAKEdocsExample00000000000b6b2') === 'sk-••••b6b2'
redact('{"OPENAI_API_KEY":"sk-abc…xyz9"}')    // 值被遮蔽
redact('普通文本 hello')                        // 原样返回
```
单测必须覆盖上述全部模式，且**验证脱敏后的字符串里不含原 key 的任何前缀片段**。

---

## 10. 性能

### 10.1 实测数据（2026-08-04，本机 8 份 rollout）

| 行数 | 体积 | **单行平均字符数** |
|---:|---:|---:|
| 19 | 102.8 KB | **5 538** |
| 19 | 102.4 KB | **5 516** |
| 17 | 109.8 KB | **6 612** |
| 15 | 100.1 KB | **6 830** |
| 13 | 99.7 KB | **7 855** |
| 9 | 100.7 KB | **11 459** |

**这组数字定义了整个项目的设计重点：**

> **行数极少（<20），但每行 5 000–11 500 字符。**
>
> 瓶颈不是"条目太多"，而是**单条内容太大**。
> 一行 11 000 字符在终端里就是几十屏的刷屏——这正是 `cat` / `jq` 不可用的根本原因。

由此确定的取舍：

- ❌ **v0.1 不做虚拟滚动**。几十行的列表用不上，做了是过度设计
- ✅ **重点投在单条内容的呈现上**：折叠、分层下钻、大块内容的结构化渲染
- ✅ 对超大内容块（AGENTS.md 注入 23 000 字符、skills 指令块 13 000 字符）
  应**识别并特殊处理**：默认只显示前 N 行 + 「展开全部」，而不是一次塞进 DOM

> ⚠️ 样本偏差：这 8 份都是短会话（1–2 轮）。长时间工作会话行数会显著更多，
> 需要在 M4 之后用真实长会话复测。若行数超过 ~2000 再引入虚拟滚动。

### 10.2 性能目标

| 场景 | 目标 | 手段 |
|---|---|---|
| 会话列表 1000+ 个 | 启动 <1s | 只对最近 60 个预读文件头做摘要 |
| 典型文件（~100KB / 20 行） | 打开 <300ms | 直接全量渲染，无需虚拟化 |
| 单条 11 000 字符内容 | 展开不卡顿 | 默认截断 ~2000 字符 + 「展开全部」；`<pre>` 限高内部滚动 |
| 长会话（>2000 行） | 打开 <2s | 复测后决定是否引入虚拟滚动 |
| 实时跟随 | 不掉帧 | 120ms 去抖 + 增量追加（不重渲染全表） |

---

## 11. 里程碑

| 阶段 | 内容 | 完成标准（见 §14） | 状态 |
|---|---|---|---|
| **M0** | 脚手架 | Electron Forge + Vite + TS | ✅ 完成 |
| **M0.5** | 测试夹具 | 4 份脱敏夹具 + 实测期望值 | ✅ 完成 |
| **M1** | 升 TS、接入 React、空窗口 | `npm start` 出窗口；`webPreferences` 满足 §9 | ✅ 依赖已装，代码待改 |
| **M2** | `shared/rollout.ts` + 单测 | **§14.2 的 A/B/C/D 共 40 条断言全绿**，`src/shared/` 覆盖率 ≥90% | 待开始 |
| **M3** | 主进程 IPC | §14.3 的 E1–E7 | 待开始 |
| **M4** | React UI | §14.4 的 F1–F9 | 待开始 |
| **M5** | 实时跟随 | §14.5 的 G1–G7 | 待开始 |
| **M6** | 打磨 + README + 截图 | §14.6 端到端冒烟 5 步 | 待开始 |
| **M7** | 打包分发 | `npm run make` 产物可在干净机器打开 | 待开始 |

> **纪律：M2 不通过就不写 UI 代码。** 归一化是整个应用的地基，
> 它错了上层全是错的，而且是唯一能被纯函数测试彻底覆盖的一层。

---

## 12. 待定问题

| # | 问题 | 需要什么来决定 |
|---|---|---|
| ~~Q1~~ | ~~是否需要虚拟滚动？~~ | ✅ **已解决**：实测行数 <20，v0.1 不做。见 §10.1 |
| Q1b | 长会话（多轮工作）的行数上限是多少？ | M4 后用真实长会话复测 |
| Q2 | 是否支持 `RUST_LOG` 文本 trace？ | 先做完 rollout，看实际需求 |
| ~~Q3~~ | ~~会话列表要不要按天/项目分组？~~ | ✅ **已决定：按项目分组**，不按天。见 §6.6 |
| ~~Q4~~ | ~~是否发 npm？~~ | ✅ **已决定：不发 npm**，只发 GitHub Release（dmg / zip） |
| ~~Q5~~ | ~~深色配色沿用 GitHub `#0d1117` 系？~~ | ✅ **已决定：沿用**，配色收敛为 6 组，见 §6.3 |
| Q6 | 详情面板要不要支持"钉住"（切换条目时不关闭）？ | M4 用起来之后再看 |
| Q7 | 超大内容（AGENTS.md 注入）要不要按 markdown 标题分段折叠？ | 已列入 P1 F20，v0.1 先用简单截断 |

---

## 13. 参考

- Codex rollout 常量定义：`codex-rs/rollout/src/lib.rs`
- `EventMsg` / `Op` 枚举：`codex-rs/protocol/src/protocol.rs`
- 变体对照表：本机 `~/workspace/codex/study/op-event-reference.md`

---

## 14. 验收

> **原则：验收全部基于 `test/fixtures/` 下的真实数据，期望值是实测算出来的确切数字，
> 不接受"看起来对"这种判断。**

### 14.1 测试夹具

四份文件，随仓库提交，**已脱敏**（`/Users/te` → `/Users/dev`）。

| 文件 | 行数 | 体积 | 来源 | 覆盖什么 |
|---|---:|---:|---|---|
| `test/fixtures/01-apply-patch-rejected.jsonl` | 19 | 104 KB | 真实会话 | `custom_tool_call`(apply_patch) + **沙箱拒绝**路径 |
| `test/fixtures/02-exec-command.jsonl` | 17 | 112 KB | 真实会话 | `function_call`(exec_command) + **成功**路径 |
| `test/fixtures/03-edge-cases.jsonl` | 14 | 28 KB | 手工构造 | 脱敏 / 坏行 / 未知类型 / 超大内容 / 缺字段 |
| `test/fixtures/04-multi-turn.jsonl` | 58 | 28 KB | 手工构造 | **多 Turn** / 逐轮冻结配置变化 / 三种 Step 收场 / 未收尾的会话 |

> 01 与 02 之所以都保留，是因为 **apply_patch 走 `custom_tool_call`（参数在 `input`），
> exec_command 走 `function_call`（参数在 `arguments`，是 JSON 字符串）**——
> 两条代码路径不同，必须各有一份。

> **04 补的是层级**：01/02/03 全是单 Turn，`Session ▸ Turn ▸ Step` 的中间一层
> 此前只有 `synth()` 合成条目覆盖，而合成条目验不了渲染结果。04 还是唯一一份
> **同一会话内冻结配置发生变化**（Turn 1 `read-only`/`never` → Turn 2
> `workspace-write`/`on-request`）和 **末轮未收尾**（无 `token_count`、无
> `task_complete`）的夹具——后者正是实时跟随时屏幕上的形态。
> 详细期望值见 `test/fixtures/README.md`。

### 14.2 M2 验收 · 归一化纯函数（`src/shared/rollout.ts`）

#### A. 解析健壮性 —— 用 `03-edge-cases.jsonl`

| # | 断言 | 期望值 |
|---|---|---|
| A1 | 文件总行数 | 14 |
| A2 | 空行被过滤，不产生条目 | 过滤 1 行 |
| A3 | **产生的条目总数** | **13** |
| A4 | 坏行降级为 `_parse_error`，不抛异常、不中断 | 恰好 1 条，`kind === 'error'` |
| A5 | 坏行之后的记录**照常解析** | 第 8 行之后的条目数 = 6 |
| A6 | 未知 `payload.type`（`some_future_item_type_v9`）不丢弃 | `kind === 'other'`，`payloadType` 原样保留 |
| A7 | 未知顶层 `type`（`brand_new_top_level_type`）不丢弃 | `kind === 'other'` |
| A8 | `payload` 为空对象不崩 | 产生条目，`title` 有兜底值 |
| A9 | 缺 `timestamp` 不崩 | `timestamp === ''` |

#### B. 密钥脱敏（§9.1）—— 用 `03-edge-cases.jsonl`

| # | 输入位置 | 原文 | 期望输出 |
|---|---|---|---|
| B1 | `session_meta.payload.OPENAI_API_KEY`（字段名命中） | `sk-FAKEkeyDoNotUse00000000000000ab12` | `sk-••••ab12` |
| B2 | `session_meta.payload.api_key`（字段名命中） | `sk-FAKEsecond000000000000000000cd34` | `sk-••••cd34` |
| B3 | `user_message.message` **正文内嵌**（值形态命中） | `…sk-FAKEinline0000000000000000ef56…` | `…sk-••••ef56…` |
| B4 | Bearer JWT | `Bearer eyJhbGciOi….FAKEsig00000000xy78` | `Bearer ••••xy78` |
| B5 | AWS Access Key | `AKIAIOSFODNN7EXAMPLE` | `••••MPLE` |
| B6 | GitHub token | `ghp_FAKE…wz90` | `ghp_••••wz90` |
| B7 | **`rawPretty` 同样被脱敏** | — | 全文 `indexOf('FAKEkeyDoNotUse') === -1` |
| B8 | **`preview` 同样被脱敏** | — | 同上 |
| B9 | 普通文本不受影响 | `帮我用这个 key 调接口` | 原样 |
| B10 | 脱敏后仍可搜索尾 4 位 | 搜 `ab12` | 命中 B1 那条 |

> **B7 是最关键的一条**：只脱敏 `preview` 而漏掉 `rawPretty` 是最可能犯的错，
> 因为原始 JSON 面板才是用户实际复制粘贴的地方。

#### C. 分类与摘要 —— 用 `01-apply-patch-rejected.jsonl`

| # | 断言 | 期望值 |
|---|---|---|
| C1 | 条目总数 | **19** |
| C2 | kind 计数 | `session=1, context=1, state=1, user=4, assistant=4, reasoning=2, tool_call=1, tool_out=1, usage=2, lifecycle=2` |
| C3 | `summary.model` | `deepseek-v4-flash` |
| C4 | `summary.effort` | `high` |
| C5 | `summary.approval` | `never` |
| C6 | `summary.sandbox`（读 `sandbox_policy.type`） | `read-only` |
| C7 | `summary.provider` | `custom` |
| C8 | `summary.cwd` | `/Users/dev/workspace/codex/codex-rs` |
| C9 | `summary.durationMs` | **14058** |
| C10 | `summary.ttftMs` | **3936** |
| C11 | `summary.inputTokens` / `outputTokens` | **34188** / **263** |
| C12 | 索引 11 是工具调用 | `kind='tool_call'`, `title='→ apply_patch'`, `callId='call_00_VGd9DAeHsvuuvIgL2BSM1663'` |
| C13 | 索引 12 是工具结果，内容以拒绝信息开头 | `preview` 以 `patch rejected: writing is blocked by read-only sandbox` 开头 |
| C14 | 11 与 12 的 `callId` 相同（可配对） | 相等 |

#### D. 另一条工具路径 —— 用 `02-exec-command.jsonl`

| # | 断言 | 期望值 |
|---|---|---|
| D1 | 条目总数 | **17** |
| D2 | kind 计数 | `session=1, context=1, state=1, user=4, assistant=2, reasoning=2, tool_call=1, tool_out=1, usage=2, lifecycle=2` |
| D3 | `summary.durationMs` / `ttftMs` | **13729** / **4241** |
| D4 | `summary.inputTokens` / `outputTokens` | **37032** / **393** |
| D5 | 索引 9 是工具调用 | `title='→ exec_command'`, `callId='call_00_ZcxhkqWcZL0PNkjMBG5H1809'` |
| D6 | `function_call.arguments` 是 JSON 字符串，需二次解析后展示 | 展示为格式化后的对象，而非转义字符串 |
| D7 | 索引 10 工具结果 | `preview` 以 `Chunk ID:` 开头 |

> **C2 与 D2 的差异（assistant 4 vs 2）是真实的**，不是笔误：
> 01 的模型多输出了两条消息。**验收时不要"顺手改成一致"。**

### 14.3 M3 验收 · 主进程 IPC

| # | 断言 |
|---|---|
| E1 | `listSessions()` 返回按 `mtime` **倒序** |
| E2 | `$CODEX_HOME/sessions` 不存在时返回空数组，**不抛异常** |
| E3 | 尊重 `CODEX_HOME` 环境变量覆盖（测试时指向 `test/fixtures/`） |
| E4 | `readSession()` 返回的 `size` 等于文件字节数（作为跟随起点） |
| E5 | `readSession()` 的 `lines` 已过滤空行 |
| E6 | 渲染进程 `window.require`、`window.process` **均为 undefined** |
| E7 | `window.unroll` 恰好暴露 §7.3 定义的 8 个方法，不多不少 |

### 14.4 M4 验收 · UI

#### 时间线（§6.1、§6.2）

| # | 断言 | 验证方式 |
|---|---|---|
| F1 | 打开 01 号夹具渲染 **19 行** | 数 DOM 节点 |
| F2 | **每行高度完全相同**，且等于单行行高 | 取所有 `.row` 的 `offsetHeight`，`new Set(...).size === 1` |
| F3 | 11 459 字符的条目**仍只占一行**，不换行不撑破布局 | `scrollWidth <= clientWidth`；`white-space: nowrap` 生效 |
| F4 | 顶部状态条只显示 3 个值：`deepseek-v4-flash · never · read-only` | 文本断言 |
| F5 | **无「摘要卡片区」DOM** | `querySelector('.cards') === null`（旧设计已废除） |

#### 详情面板（§6.1）

| # | 断言 | 验证方式 |
|---|---|---|
| F6 | 初始**不渲染**详情面板，时间线占满宽度 | 面板节点不存在 |
| F7 | 点索引 11 → 面板出现，标题 `apply_patch` | 文本断言 |
| F8 | 面板内容以 `*** Begin Patch` 开头 | 内容段断言 |
| F9 | 「原始 JSON」段**默认折叠** | `aria-expanded === 'false'` |
| F10 | `Esc` 关闭面板；再点同一条也关闭 | 交互断言 |
| F11 | 面板宽度可拖拽，最小 320px | 拖到 200px 时钳制为 320 |
| F12 | 03 号夹具的 8 846 字符条目：面板内**独立滚动**，主区不滚 | 面板 `scrollHeight > clientHeight`，body 无滚动 |
| F13 | 下钻**恰好两层**（选中 → 面板） | 面板里**顶层**可折叠区段恰好 1 个（「原始 JSON」）。JSON 树内部的节点展开**不计**——见下方判定 |

#### 过滤 / 搜索 / 导航

| # | 断言 | 期望 |
|---|---|---|
| F14 | 底部状态栏按 §6.3 的 **6 组**显示，01 号夹具计数为 | 输入 6 · 思考 2 · 行动 2 · 输出 4 · 元信息 5 · 异常 0 |
| F15 | 只勾「行动」后剩 **2 条** | tool_call 1 + tool_out 1 |
| F16 | 搜 `rejected` 命中 **2 条**（索引 2、12），结果**必须包含索引 12** | 见下方校正 |
| F17 | 搜 `ab12`（03 号夹具）命中脱敏后的 key | 验证 B10 |
| F18 | `j` / `k` 切换选中，详情面板同步更新 | 键盘事件断言 |
| F19 | 选中项在视口外时自动滚入视口 | `scrollIntoView` 被调用 |

> **F14 的分组计数由 §14.2 C2 换算而来**：
> 输入 = session 1 + context 1 + user 4 = **6**；思考 = reasoning **2**；
> 行动 = tool_call 1 + tool_out 1 = **2**；输出 = assistant **4**；
> 元信息 = usage 2 + state 1 + lifecycle 2 = **5**；异常 **0**。合计 19 ✓

#### 视觉与安全

| # | 断言 | 验证方式 |
|---|---|---|
| F20 | 深浅色下正文对比度 ≥ **4.5:1**，弱化文字 ≥ **3:1** | 对 §6.3 六组色值逐一计算 |
| F21 | 分类**不只靠颜色**区分 | 灰度截图下仍可区分。⚠️ 符号只有 5 个而组有 6 个（`●` 被输入与输出共用），**必须再靠时间线的中文类型列**才能区分这两组 |
| F22 | 界面任何位置**搜不到**完整 fake key | 全局 `document.body.innerText` 断言不含 `FAKEkeyDoNotUse` |
| F23 | 空状态显示拖放区 + 扫描目录路径 | 文本断言 |
| F24 | 拖 `.jsonl` 到窗口任意位置即打开 | drop 事件断言 |

### 14.5 M5 验收 · 实时跟随

| # | 场景 | 期望 |
|---|---|---|
| G1 | 打开文件 → 勾选跟随 → 追加 3 行 | 时间线增加 3 条，**已有条目不重渲染** |
| G2 | 追加**半行**（无结尾换行） | 不产生条目；补齐换行后才出现 |
| G3 | 连续快速追加 20 次 | 因 120ms 去抖，IPC 推送次数 **< 20** |
| G4 | 用户滚到中部时追加 | **不自动滚动**，不打断阅读 |
| G5 | 用户在底部时追加 | 自动滚到底 |
| G6 | 文件被截断（`size < offset`） | 触发 `session:reset`，前端重读全量 |
| G7 | 切换到另一会话 | 旧 watcher 被关闭，无泄漏 |

**G1–G3 的自动化做法**：测试里用 `fs.appendFileSync` 往临时文件写，
不依赖真的跑 codex。

### 14.6 端到端冒烟（发布前必做）

**已脚本化**，不用手点：

```bash
CODEX_HOME=$(pwd)/test UNROLL_SHOT=/tmp/shots npm start
```

`src/main/smoke.ts` 会自动走完下面 5 步，逐条打印 PASS/FAIL 并在 `/tmp/shots` 留 5 张截图。
只有设了 `UNROLL_SHOT` 才会被动态 import，正常启动路径不加载。

1. 左栏列出 4 个夹具会话、3 个项目组（依赖 `test/sessions -> fixtures` 符号链接，随仓库提交）
2. 打开 04 号夹具（多轮），在**图**视图核对层级的完整形态：
   3 Turn / 9 Step / 三种收场都出现 / 冻结配置逐轮不同 / 末轮标记进行中 /
   58 条全有归宿（48 行 + 8 块尾 + 2 Turn 尾）/ 6 条连接线 / 无横向溢出
3. 打开 01 号夹具：先在**图**视图核对 §6.8 的结构（1 Turn / 2 Step / 收场 act→answer /
   连接线 / 块尾 token / 前言默认展开 / 图里行仍等高且不横向溢出），
   再点到**列表**视图核对 §14.4 的 F1/F2/F3/F5/F14
4. 选中索引 11，核对两层下钻（F7/F8/F12/F13）与 §6.7 的 JSON 树
5. 打开 03 号夹具、逐条展开，**断言界面任何位置搜不到 `FAKEkeyDoNotUse`**

> ⚠️ 视图偏好存在 localStorage，**上一次跑留下的值会带到这一次**。
> 所以脚本在每组断言前都**显式点到**要测的视图，不依赖默认值——
> 否则这几条会随机漂，而发布门禁不能有噪音（同 `waitFor` 那次的教训）。

**为什么必须有这一步**：F2（每行等高）、F3（巨型条目不撑破布局）、F12（面板独立滚动）
是**布局断言**，而 jsdom 不做布局（`offsetHeight` 恒为 0），单测里这几条恒真、等于没测。
只有真实渲染器能测。

仍需人工的两步：

5. 真实跑一次 `codex exec "echo hi"`，勾选跟随，确认新会话实时出现（G4/G5 的真实滚动）
6. `npm run make` 产物能在干净的 macOS 用户下打开

### 14.8 验收实测校正（2026-08-04，实现完成后回填）

原 spec 的期望值有 5 处与夹具实测不符，**已按实测改正上文**。记在这里是为了说明改动理由：

| 条目 | 原写法 | 实测 | 原因 |
|---|---|---|---|
| F16 | 搜 `rejected` 命中 1 条 | **2 条**（索引 2、12） | 01 号夹具索引 2 的 developer 消息里有 `commands will be rejected.`。而 F7 要求搜索范围含原始 JSON、F17/B10 又要求能搜到只存在于 `rawPretty` 的尾 4 位——两条共同锁死了搜索范围，2 条命中是必然结果。真正该断言的是「结果包含索引 12」 |
| F12 | ~12 000 字符条目 | **8 846** 字符 | 12 000 是那一整行 JSON 的长度，不是该条目 `preview` 的长度 |
| F21 | 符号 `●○▶⚠·` 可独立辨识 | 5 符号 / 6 组 | `●` 被「输入」和「输出」共用，符号本身分不出这两组，需靠中文类型列 |
| §6.1 图 | 底部「·弱6」 | 元信息 **5** | ASCII 图与 F14 打架，且图里漏了「异常」组。以 F14 为准 |
| §14.6-1 | 直接 `CODEX_HOME=$(pwd)/test` | 需符号链接 | 夹具在 `test/fixtures/`，而扫描的是 `$CODEX_HOME/sessions/`。已加 `test/sessions -> fixtures` |

另有两处**设计约束在实现时才暴露**：

- **F13 的「层级」指什么（2026-08-08 澄清）。**
  「原始 JSON」段从 `<pre>` 改成可折叠树视图后，面板里出现了大量 `aria-expanded` 节点。
  **判定：树内节点的展开不算新增下钻层级。** 它是「原始 JSON」这一层**内部**的导航，
  与时间线内部可以滚动是同一性质。层级的定义是「要看到内容必须先经过几次不同性质的选择」，
  而不是「页面上有几个展开控件」。
  断言相应改为：面板里**顶层**可折叠区段恰好 1 个，树内部节点显式排除。
- **F13「两层下钻」与 §10.2「默认截断 ~2000 字符 +『展开全部』」冲突。**
  取舍：「展开全部」只是同一段正文的截断阈值开关、不是新一层下钻，且只在正文 >2000 字符时出现。
  F13 形式化为「面板内 `[aria-expanded]` 恰好 1 个（原始 JSON），时间线行一个都没有」。
- **拖放打开的文件无法实时跟随。** Electron ≥32 移除了 `File.path`，`sandbox: true` 下也拿不到，
  而 §7.3 的 8 个方法里没有 `getPathForFile`。做法是拖放时直接在渲染进程读 `File.text()` 解析
  （解析本来就在渲染侧），代价是没有磁盘路径就不能 `fs.watch`，UI 上把「跟随」置灰并说明原因。
  这与场景 S4（别人发来一份 rollout）相符——那种文件本来就是静态的。
  若要支持「拖放后也能跟随」，需在 preload 加第 9 个方法，会破坏 E7 的「不多不少 8 个」。

### 14.9 v0.2 验收 · Session ▸ Turn ▸ Step 切分与图视图

两组，共 **53 条**（另有 6 条 CSS 回归断言在 `styles/global.css.test.ts`）。纯函数那组是地基，和 §14.2 一样：**它不全绿就不动 UI**。

**S 组（32 条）· `src/shared/steps.test.ts`** —— 纯函数切分

期望值全部从夹具实测算出，与 §14.2 对得上（S5 的 `14058/3936` 就是 C9/C10，
S8 的 `34188/263` 就是 C11）：

| 编号 | 断言 |
|---|---|
| S1–S9 | 夹具 01：1 Turn / 2 Step；`session_meta` 落会话前言；turnId、冻结配置、时长首字；前言到第一条模型产出为止（7 条）；Step 1 = act + `→ apply_patch` + `16986/187`；Step 2 = answer + `34188/263`；`task_complete` 挂 Turn 不进 Step |
| S10 | 夹具 02 走 `function_call` 路径，结构相同 |
| S11–S12 | 夹具 03 无 `task_started`，`turn_context` 也能起 Turn；未知类型/坏行照常保留 |
| **S13** | ★ **flatten 恒等**：四份夹具都满足 `flattenGraph(buildGraph(es))` 与 `es` 逐个引用相同 |
| S14–S24 | 退化路径：空输入 / 无 Turn 标记 / 一个 `token_count` 都没有 / 未收尾 / 第二个 `turn_context` 起新 Turn / `turn_id` 变了 / 无正文的 `token_count`（两种位置，顺序都不许乱）/ 坏行 → `hasError` |
| S25 | `isUserInput` 认两种落盘形式；**夹具 01 命中 3 条**，其中索引 3 是 AGENTS.md 注入而非真人输入（见 §6.8.7） |
| S26 | Turn 序号从 1 起且连续 |
| **S27–S33** | ★ 夹具 04（多轮）：3 Turn / 9 Step，每轮 `3/5/1`；**冻结配置逐轮生效**（`read-only`→`workspace-write`）；三种收场 `act/answer/open` 同篇出现；两条工具路径同篇出现；末轮无 `token_count`/`task_complete` → Step `open` + Turn `open`；累计 token 逐 Step 单调不减（`11840` → `128620`）；每轮前言都到第一条模型产出为止 |

**G 组（21 条）· `src/renderer/components/StepGraph.test.tsx`** —— 图视图组件

> 命名撞车提醒：这里的 G 是 **G**raph，与 §14.5 跟随的 G 组是两个命名空间。

| 编号 | 断言 |
|---|---|
| G1–G5 | 骨架：1 Turn / 2 Step；`data-outcome` = act / answer；恰好 1 条连接线且夹在两块中间；块尾 token 数与点击下钻的索引（13 / 17）；Turn 头的冻结配置 |
| G6 | ★ 前言**默认全展开**（7 条全在）；G6b 钉住「16 行 + 2 块尾 + 1 Turn 尾 = 19 条」一条不少；折叠后仍留真人输入与异常 |
| **G7** | ★ **结构不随过滤变形**：`visible` 缩到 2 条，Turn / Step 数量与 outcome 与连接线**完全不变**，被滤掉的以「N 条被过滤」说明；全滤掉时骨架仍在 |
| G8 | 选中态：命中行带 `selected` 且唯一；选中 `token_count` 时高亮的是块尾而非某行 |
| G9–G10 | MainPane：默认图、切列表、`aria-pressed` 翻转、偏好落 localStorage 后重挂载仍生效；视图条文案 `1 turn · 2 step` |
| G11–G12 | 退化：空图给文案；夹具 03 的坏行**默认就可见**，不被折叠藏起来 |
| **G13** | ★ **白屏回归**：会话一个 Turn 都没有（骨架自身为空）+ 一条都没命中 → 必须给提示 |
| G14 | 只有 `response_item` 形式的用户输入时，前言仍常显它（§6.8.7 的退路） |

另有 §14.6 冒烟里的 10 条图视图布局断言——`offsetHeight` / `scrollWidth` 这类只有真实渲染器能测。

### 14.7 测试工程

| 项 | 选择 |
|---|---|
| 框架 | **Vitest**（与 Vite 同源，零额外配置） |
| 纯函数测试 | `src/shared/*.test.ts`，直接读 `test/fixtures/` |
| 组件测试 | React Testing Library（M4 起） |
| 主进程测试 | Node 环境跑 `main.ts` 导出的纯函数（IPC handler 拆成可测函数） |
| 覆盖率门槛 | `src/shared/` **≥ 90%**（纯函数，没理由低） |
| Linter | **oxlint**，不是 ESLint —— `typescript@7` 是原生 tsgo 版，不暴露 `TypeFlags` / `createProgram` 等经典编译器 API，`@typescript-eslint` 无法工作 |
| CI | GitHub Actions：`lint` + `typecheck` + `test` + `build`，PR 必过 |

```bash
npm test              # 全部
npm test -- rollout   # 单文件
npm run test:cov      # 覆盖率
```

> **M2 完成的定义**：§14.2 的 A/B/C/D 共 **40 条断言全绿**，覆盖率达标。
> 在此之前不写任何 UI 代码。
