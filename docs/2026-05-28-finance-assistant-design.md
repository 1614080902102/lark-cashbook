# 财务支出小助手 — 设计文档（Phase 1）

日期：2026-05-28

## 目标

在飞书里跟 bot 你的飞书机器人 对话记账 → 数据落到一个飞书多维表格（Bitable）→ 能自然语言查询 → 多维表格原生看板自动出图。

Phase 1 范围：**记账 + 查询 + 看板**。不做定时主动推送（二期再加）。

## 已验证的技术事实（2026-05-28 实测）

- `lark-cli`（`/opt/homebrew/bin/lark-cli` v1.0.13）绑定的 app 为 `<lark_cli_app_id>`，**已具备多维表格读写权限**：
  - `POST /open-apis/bitable/v1/apps` 建表成功
  - `POST /open-apis/drive/v1/permissions/{token}/members`（`--params '{"type":"bitable"}'`）把表共享给用户 open_id `<your_open_id>`（`perm: full_access`）成功
  - `DELETE /open-apis/drive/v1/files/{token}`（`type=bitable`）删除成功
- **结论：无需在飞书开发者后台配置任何权限。** 用 `lark-cli api` 即可完成全部多维表格操作。
- 回复消息走 bridge（`~/.lark-channel` 守护进程，bot `<bridge_bot_app_id>`）自动完成——agent 只需输出文本，无需自己发消息。
- 注意 `lark-cli` 调用要用 `--params` 传 query 参数（URL 里拼的 query 不被识别），`--data` 传 body。环境有 HTTPS_PROXY 警告，不影响功能。

## 架构

```
飞书消息 "午饭35 打车120"
   │
   ▼
~/.lark-channel bridge 守护进程
   │  调起 Claude Code（cwd 路由到 lark-cashbook/）
   ▼
Claude Code agent  ── 读 lark-cashbook/CLAUDE.md
   │  1. 解析自然语言 → 结构化记录
   │  2. 调 scripts/add_record 写多维表格（lark-cli api → 飞书云端）
   │  3. 算今日/本月累计、预算剩余
   ▼
回复 "已记 2 笔，今日 155，本月累计 X，餐饮预算剩 Y"（经 bridge 回飞书）
```

## 组件

### 1. 触发入口
让飞书 bridge 在调起 Claude Code 时把工作目录指向本仓库（单仓库直接 cd 进来即可；若与其他项目共用 bridge，可按关键词「记账 / 花了 / 支出 / 收入 / 财务 / 账单」路由到本仓库）。

### 2. `lark-cashbook/CLAUDE.md`
教路由到此的 agent：
- 如何把自然语言解析成记录（金额、类别、支付方式、日期、类型）
- 调哪个脚本、传什么参数
- 解析不确定时**反问而非瞎记**（沿用现有"无法判断就回问"原则）
- 回复格式（小结：本次记了几笔 + 今日支出 + 本月累计 + 预算剩余）
- 存放多维表格的 app_token / table_id（建表后写入，作为单一事实来源）

### 3. 飞书多维表格「财务记账」
建表后把 app_token 等写入 `lark-cashbook/config.json`。两张表：

**流水表（transactions）**
| 字段 | 类型 | 说明 |
|---|---|---|
| 日期 | 日期 | 默认今天 |
| 类型 | 单选 | 支出 / 收入 |
| 金额 | 数字 | 正数 |
| 类别 | 单选 | 见下方预设 |
| 支付方式 | 单选 | 见下方预设 |
| 备注 | 文本 | 自由 |

**预算表（budgets）**
| 字段 | 类型 | 说明 |
|---|---|---|
| 月份 | 文本 | 如 2026-05 |
| 类别 | 单选 | 同流水类别，或"总预算" |
| 预算金额 | 数字 | |

预设分类（已确认）：
- 支出类别：衣、食、住、行、医疗、成长、娱乐、其他
- 收入类别：工资、外快、投资、报销、其他
- 支付方式：微信、支付宝、云闪付、其他

### 4. `lark-cashbook/scripts/`
- `setup_bitable.sh`（或 .js）：一次性建表 + 配置字段 + 共享给用户 + 建看板视图。输出 app_token/table_id 写入 config.json。
- `add_record.sh`：写一条/多条流水。入参为结构化记录（JSON），调 `bitable/v1/apps/{token}/tables/{table}/records/batch_create`。
- `query.sh`：按时间范围/类别筛选取记录，算总额 / 分类汇总 / 预算剩余。用 `records/search` 带 filter。

脚本统一通过 `lark-cli api` 调用，凭证用 lark-cli 现有 app。

### 5. 看板
多维表格原生「仪表盘」视图：类别支出饼图、月度收支趋势、本月预算进度。建一次随数据自动更新，不需维护。用户在飞书 App 里打开表即可看。

## 数据流

**记账**：见上方架构图。多笔可一条消息一次记入（batch_create）。

**查询**："这周餐饮花了多少" → agent 调 query.sh（filter: 类别=餐饮 且 日期在本周）→ 算和 → 回复数字 + 多维表格链接。

## 错误处理
- 金额缺失/无法解析、类别歧义 → bot 反问，不写入。
- API 调用失败 → 回复明确错误，不假装成功。
- 类别不在预设里 → 归"其他"并在回复里提示，或反问是否新增。

## 测试
- 记一笔 → 飞书多维表格里查得到，字段对。
- 一条消息多笔 → 正确拆分写入。
- 查询数字 == 手算。
- 预算剩余计算正确。
- 解析歧义场景触发反问而非瞎记。

## 二期（暂不做）
- 定时主动推送日/周/月报（本地 launchd 触发器，Mac 需开机；或飞书云端自动化）。
- 月报 LLM 叙述性点评。
```
