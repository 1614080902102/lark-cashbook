# 财务助手 Phase 2 — 定时主动推送 开发文档

日期：2026-05-28
前置：Phase 1（记账+查询+看板）已上线、实测通过。

## 目标

无人值守地把财务汇总**主动推送**到飞书：日报、周报、月报。用户不用开口问，bot 定时发。

## 已验证的技术事实（2026-05-28 实测）

主动（非应答）发消息必须用 **bridge bot**（`<bridge_bot_app_id>`，在与用户的会话里），lark-cli 的 app 不在会话里发不了。验证结论：

- bridge bot 密钥可在运行时取：
  `echo '{"protocolVersion":1,"ids":["app-<bridge_bot_app_id>"]}' | ~/.lark-channel/secrets-getter`
  返回 JSON，`values` 里是 app_secret（32 位）。**不要落盘，运行时现取。**
- 用该 app_id + secret 调 `POST /open-apis/auth/v3/app_access_token/internal` 成功拿到 `tenant_access_token`（已实测 code 0）。
- 发消息：`POST /open-apis/im/v1/messages?receive_id_type=open_id`，`receive_id` = 用户 open_id `<your_open_id>`，`msg_type` 用 `interactive`（卡片）或 `text`。
- **读多维表格仍走 lark-cli**（它的 app 已是表的协作者、有读权限）。bridge bot 不是协作者，读不了——所以读/发分两套凭证，各司其职。

## 架构

```
launchd 定时器（每日/每周/每月触发）
   │
   ▼
scripts/push_report.js  <类型>
   │  1. lark-cli 读「流水」表（复用 Phase 1 的 finance.js query 逻辑）
   │  2. 按 日/周/月 算汇总 + 分类 + 预算剩余
   │  3. 组装飞书卡片
   │  4. 运行时取 bridge bot secret → mint token → im/v1/messages 发给用户
   ▼
飞书收到一张汇总卡片
```

发送与回应（Phase 1 的对话记账）互不干扰：Phase 1 由 bridge 调起 Claude Code 应答，Phase 2 是独立脚本直接调 API，不经过 Claude，**确定性、零 LLM 成本**。

## 组件

### 1. `scripts/push_report.js`
入参：`daily` | `weekly` | `monthly`。
- 复用查询逻辑（建议把 Phase 1 `finance.js` 的 `fetchAll`/汇总抽成 `lib/query-core.js`，两边共用，避免重复）。
- 时间窗口：
  - daily：当天
  - weekly：本周一~今天（或上周一~周日，见下方决策）
  - monthly：上个月整月（月初推上月报）
- 预算剩余：读「预算」表当月各类预算 − 当月同类支出。
- 组卡片 → mint token → 发送。失败要 `exit 1` 并写日志（给 launchd 留痕）。

### 2. launchd 定时任务
单任务 `~/Library/LaunchAgents/com.larkcashbook.report.plist`，`StartCalendarInterval` 每天 23:59（Hour 23, Minute 59），跑 `run_scheduled.js`。plist 注入 `PATH`（含 lark-cli 目录）与 `HOME`，否则 launchd 精简环境找不到 lark-cli。

> launchd 特性：Mac 在触发时刻睡眠/关机会**错过**，但 `StartCalendarInterval` 在下次唤醒后会补跑一次（不会把多次错过都补齐，只补一次）。可接受。

提供 `scripts/install_launchd.sh` 一键写入并 `launchctl load`，`uninstall_launchd.sh` 卸载（兼容删除早期 daily/weekly/monthly 三任务）。

### 3. 卡片样式
飞书 interactive 卡片，建议结构：
- 标题：`📊 今日财务` / `本周财务` / `2026-04 月报`
- 正文：支出合计、收入合计、净额；分类明细（emoji + 类别 + 金额 + 占比）；预算进度条/剩余。
- 底部按钮：跳转多维表格链接。

## 已定决策（2026-05-28）

1. **推哪几份**：日报 + 周报 + 月报，全要。
2. **触发时刻 & 周期定义**：在周期结束当晚 23:59 触发，汇总**当前刚结束的周期**（含当天）。

   | 报 | 触发时刻 | 汇总范围 |
   |---|---|---|
   | 日报 | 每天 23:59 | 今天整天 |
   | 周报 | 周日 23:59 | 本周（周一 ~ 周日） |
   | 月报 | 当月最后一天 23:59 | 本月整月 |

3. **调度实现**：launchd 无法表达「每月最后一天」，故用**单个每天 23:59 触发的 `run_scheduled.js`** 统一判断：每天发日报；当天为周日加发周报；当天为当月最后一天加发月报。规避限制，行为等价。
4. **卡片**：飞书 interactive 卡片（schema 2.0）。支出分类用**字符条形图**（固定列对齐、纯实心条放行尾）——飞书原生图表对少类别场景高度不可控、留白过多，故弃用。
5. **配色**：日报青(turquoise) / 周报靛蓝(indigo) / 月报紫罗兰(violet)，按报种区分。
6. **推送目标**：群 **你的目标群**（`push_chat_id` in config.json），非私聊。
7. **触发器**：本地 launchd（Mac 常开；睡眠错过 23:59 由 launchd 唤醒后补跑一次）。

时间窗口计算据此实现（见 `periodWindow`）：
- daily：基准日当天。
- weekly：基准日所在周的周一 ~ 周日。
- monthly：基准日所在月 1 号 ~ 月末。

## 错误处理
- 取密钥失败 / mint token 失败 / 发送失败 → 写 `logs/push.log`，`exit 1`，不静默吞掉。
- 当期无任何记录 → 仍发一条「今日无记账」提醒（或按决策跳过）。

## 测试
- 手动 `node scripts/push_report.js daily` 立刻发一张，确认卡片内容与手算一致。
- 改 plist 时间到近 1~2 分钟后，确认 launchd 真能触发。
- 模拟跨月：用历史数据跑 monthly，核对上月汇总。

## 实现步骤（建议顺序）
1. 抽 `lib/query-core.js`，Phase 1 的 finance.js 改为引用它（不改对外行为）。
2. 写 `lib/feishu-bot.js`：取 secret → mint token → 发消息（卡片/文本）。
3. 写 `push_report.js`（daily 先跑通）。
4. 手动验证卡片。
5. 加 weekly/monthly。
6. 写 install/uninstall launchd 脚本，装好。
7. 真实定时验证一轮。

## 安全
- 不把 bridge bot secret 或 token 写进任何文件/仓库，运行时现取现用。
- push_report.js 与 launchd plist 可进仓库；密钥不进。

## Phase 3 后续设想（待做）

**数据导出。** 用户提出想要「导出数据文档之类的」。可能的形态（待挑选）：

1. **导出 CSV / Excel**：把流水按时间段导出成 `.csv`（或飞书表格 xlsx），方便存档/报税/给会计。
   - 实现：复用 `query-core` 拉记录 → 生成 CSV → 可上传飞书云盘（drive/v1/files/upload_all）后把下载链接发到群。
2. **生成飞书文档月报**：把月度汇总（数字 + 分类 + 趋势）渲染成一篇飞书云文档（docx），适合长期翻阅、分享。
   - 实现：docx/v1 创建文档 + 写块；或先出 Markdown 再转。
3. **对话式导出**：在飞书说「导出 5 月数据」→ agent 调脚本生成文件并回链接。

建议先做 1（CSV 导出 + 飞书云盘链接），成本最低、最实用。触发方式：先做成手动脚本 `scripts/export.js`，再按需接对话/定时。
