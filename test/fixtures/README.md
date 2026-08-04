# 测试夹具

SPEC §14 的验收基线。**期望值是从这些文件实测算出来的确切数字，改文件 = 改基线。**

## 文件

| 文件 | 行数 | 体积 | 来源 | 覆盖什么 |
|---|---:|---:|---|---|
| `01-apply-patch-rejected.jsonl` | 19 | 104 KB | 真实会话 | `custom_tool_call`(apply_patch) + **沙箱拒绝**路径 |
| `02-exec-command.jsonl` | 17 | 112 KB | 真实会话 | `function_call`(exec_command) + **成功**路径 |
| `03-edge-cases.jsonl` | 14 | 28 KB | 手工构造 | 脱敏 / 坏行 / 未知类型 / 超大内容 / 缺字段 |

## 为什么 01 和 02 都要保留

两条工具调用路径的**数据形状不同**，代码路径也不同：

| 工具 | `payload.type` | 参数字段 | 参数格式 |
|---|---|---|---|
| `apply_patch` | `custom_tool_call` | `input` | 纯文本 patch |
| `exec_command` | `function_call` | `arguments` | **JSON 字符串，需二次解析** |

只留一份会导致另一条路径完全没有测试覆盖。

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
