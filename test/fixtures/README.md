# 测试夹具

SPEC §14 的验收基线。**期望值是从这些文件实测算出来的确切数字，改文件 = 改基线。**

## 文件

| 文件 | 行数 | 体积 | 来源 | 覆盖什么 |
|---|---:|---:|---|---|
| `01-apply-patch-rejected.jsonl` | 19 | 104 KB | 真实会话 | `custom_tool_call`(apply_patch) + **沙箱拒绝**路径 |
| `02-exec-command.jsonl` | 17 | 112 KB | 真实会话 | `function_call`(exec_command) + **成功**路径 |
| `03-edge-cases.jsonl` | 14 | 28 KB | 手工构造 | 脱敏 / 坏行 / 未知类型 / 超大内容 / 缺字段 |
| `04-multi-turn.jsonl` | 58 | 28 KB | 手工构造 | **多 Turn** / 逐轮冻结配置变化 / 三种 Step 收场 / 未收尾的会话 |

## 为什么 01 和 02 都要保留

两条工具调用路径的**数据形状不同**，代码路径也不同：

| 工具 | `payload.type` | 参数字段 | 参数格式 |
|---|---|---|---|
| `apply_patch` | `custom_tool_call` | `input` | 纯文本 patch |
| `exec_command` | `function_call` | `arguments` | **JSON 字符串，需二次解析** |

只留一份会导致另一条路径完全没有测试覆盖。

## 为什么要有 04

01/02/03 **全都是单 Turn**。也就是说 `Session ▸ Turn ▸ Step` 这条层级里，
中间那一层在真实数据上从来没被端到端验过——多 Turn 的分支此前只有 `synth()`
手搓的合成条目覆盖，而合成条目验不了「渲染出来长什么样」。

04 是刻意构造的一份**典型会话**，把前三份夹具凑不齐的形状一次补齐：

| 覆盖点 | 位置 | 为什么重要 |
|---|---|---|
| 3 个 Turn | 全篇 | 图视图的中间层，此前无真实数据覆盖 |
| **逐轮冻结配置变化** | Turn 1 `read-only`/`never` → Turn 2 `workspace-write`/`on-request` | TurnContext 是**一轮一冻结**，不是全会话一份。单 Turn 夹具永远显不出这件事 |
| 一轮内 5 个 Step | Turn 2 | ReAct 循环真正跑起来的样子：改 → 测试挂 → 修 → 测试过 → 收尾 |
| 三种 Step 收场 | `act` / `answer` / `open` | 旧夹具只有 act 和 answer |
| 两条工具路径同篇出现 | Turn 2 | 01/02 各占一条，04 让它们在同一张图里 |
| **未收尾的会话** | Turn 3 | 没有 `token_count`、没有 `task_complete`——正是「实时跟随」时看到的形态 |

★ **正文一律用英文**，这是刻意的：README 有中英两份，截图也有中英两套，而
**截图里的会话内容是同一份数据**——它只能是一种语言。选英文是因为这个领域里
英文对两边读者都读得通（Codex 自己的提示词、工具名、补丁、`cargo` 输出本来就是英文），
反过来不成立。界面文案由 i18n 负责切换，与夹具内容无关（SPEC §15）。

内容是虚构的（一个叫 `logfmt` 的 Rust CLI 加 `--json` 输出），
但**每个字段的形状都照着 01/02 的真实记录抄的**：同一句话该落两份的就落两份
（`event_msg/agent_message` + `response_item/message`），`total_token_usage` 是全会话累计、
`last_token_usage` 是本次单量，`sandbox_policy` 是 internally-tagged 的 `{"type": …}`。

⚠️ 它是**手工构造**的，所以不能拿它当「`token_count` 能切 Step」这条启发式的经验证据——
那个结论只算真实会话（见 SPEC §6.8）。它验的是**渲染与切分的行为**，不是协议事实。

### 04 的关键期望值

```
条目数           58
kind 计数        session1 lifecycle5 context3 state1 user7
                 assistant10 reasoning9 tool_call7 tool_out7 usage8
六组显示计数      输入11 · 思考9 · 行动14 · 输出10 · 元信息14   （合计 58）
model            gpt-5.4-codex
Turn 数 / Step 数 3 / 9
每轮 Step 数      3 / 5 / 1
收场序列          act act answer · act act act act answer · open
Turn 状态         complete complete open
sandbox 逐轮      read-only / workspace-write / workspace-write
approval 逐轮     never / on-request / on-request
首个 Step 累计 in 11840        末个收尾 Step 累计 in 128620
```

## 脱敏说明

01 / 02 来自真实会话，已做处理：

- `/Users/te` → `/Users/dev`（零残留，可用 `grep -c '/Users/te[^a-z]'` 验证）
- 无 API key —— Codex 的密钥存在 `~/.codex/auth.json`，**不写进 rollout**

03 里的密钥全部是**故意构造的假 key**，用于验证 SPEC §9.1 的脱敏逻辑：

| 类型 | 值（假） | 期望脱敏结果 |
|---|---|---|
| 字段名命中 `OPENAI_API_KEY` | `sk-FAKEkeyDoNotUse00000000000000ab12` | `sk-••••ab12` |
| 字段名命中 `api_key` | `sk-FAKEsecond000000000000000000cd34` | `sk-••••cd34` |
| 正文内嵌（值形态命中） | `sk-FAKEinline0000000000000000ef56` | `sk-••••ef56` |
| Bearer JWT | `Bearer eyJhbGciOi….FAKEsig00000000xy78` | `Bearer ••••xy78` |
| AWS（官方文档示例 key） | `AKIAIOSFODNN7EXAMPLE` | `••••MPLE` |
| GitHub token | `ghp_FAKE…wz90` | `ghp_••••wz90` |

**这些都不是真实凭证，不要试图使用。**

## 03 号夹具的结构

刻意构造的 14 行：

| 行 | 内容 | 验证什么 |
|---:|---|---|
| 1 | `session_meta`，含两个假 key 字段 | 脱敏 B1 / B2 |
| 2 | `turn_context`，`sandbox_policy: {"type":"read-only"}` | 内部标签解析 |
| 3 | `user_message`，正文内嵌 key | 脱敏 B3（值形态识别） |
| 4 | `message`，含 Bearer / AWS / GitHub token | 脱敏 B4–B6 |
| 5 | `payload.type` = `some_future_item_type_v9` | 未知二级类型 → `other`（A6） |
| 6 | 顶层 `type` = `brand_new_top_level_type` | 未知顶层类型 → `other`（A7） |
| 7 | **不合法 JSON** | 降级 `_parse_error` 且不中断（A4 / A5） |
| 8 | 空行 | 应被过滤，不产生条目（A2） |
| 9 | `message`，正文约 12 000 字符 | 超大内容截断与展开（F7 / F12） |
| 10 | `payload` 为空对象、无 timestamp | 缺字段容错（A8 / A9） |
| 11–12 | `function_call` + `function_call_output`，同一 `call_id` | 工具调用配对 |
| 13–14 | `token_count` + `task_complete` | 摘要提取 |

**期望：14 行 → 过滤 1 空行 → 产生 13 个条目，其中 1 条 `kind === 'error'`。**

## 关键期望值速查

完整清单在 SPEC §14.2。常用的几个：

```
# 01-apply-patch-rejected.jsonl
条目数           19
kind 计数        session1 context1 state1 user4 assistant4 reasoning2
                 tool_call1 tool_out1 usage2 lifecycle2
六组显示计数      输入6 · 思考2 · 行动2 · 输出4 · 元信息5   （合计 19）
model            deepseek-v4-flash
approval/sandbox never / read-only
durationMs       14058
ttftMs           3936
in/out tokens    34188 / 263
索引 11          tool_call  apply_patch  call_00_VGd9DAeHsvuuvIgL2BSM1663
索引 12          tool_out   "patch rejected: writing is blocked by read-only sandbox…"

# 02-exec-command.jsonl
条目数           17
六组显示计数      输入6 · 思考2 · 行动2 · 输出2 · 元信息5   （合计 17）
durationMs       13729
ttftMs           4241
in/out tokens    37032 / 393
索引 9           tool_call  exec_command  call_00_ZcxhkqWcZL0PNkjMBG5H1809
索引 10          tool_out   "Chunk ID: ed3acb…"
```

> ⚠️ **01 与 02 的 `assistant` 计数不同（4 vs 2）是真实差异**，不是笔误。
> 01 那次模型多输出了两条消息。验收时不要"顺手改成一致"。

## 用夹具当数据源运行

```bash
CODEX_HOME=$(pwd)/test npm start
```

主进程会扫描 `$CODEX_HOME/sessions`，因此本目录也可以按
`test/sessions/YYYY/MM/DD/` 组织一份软链接来模拟真实布局（M3 时按需添加）。
