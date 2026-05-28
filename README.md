# lark-cashbook

在飞书里跟机器人聊天就能记账。说一句「午饭 35 打车 120」，它帮你解析、存进飞书多维表格，并回一条当日小结；每天定时提醒记账，按日/周/月推送带图表的财务卡片。

## 能做什么

- **对话记账**：自然语言一句话记一笔或多笔，自动识别金额、类别、支付方式、收入/支出、日期（含「昨天」这种相对日期）。
- **存进多维表格**：数据落在飞书多维表格，手机/电脑随时翻，可筛选、可做看板。
- **随时查询**：「这周餐饮花了多少」「本月支出」直接问。
- **定时报表**：每天 23:59 推日报；周日推周报；月末推月报。卡片含收支汇总、分类条形图、本月累计、预算进度。
- **记账提醒**：每天 22:00 提醒你记账（当天没记会催，记了会问要不要补）。

报表/提醒发到你指定的飞书群。

## 工作原理

```
你在飞书发消息  ──►  lark-channel bridge（守护进程）
                         │  在本机调起 Claude Code，工作目录指向本仓库
                         ▼
                    Claude Code 读 CLAUDE.md
                         │  解析记账意图 → 调 scripts 写多维表格 → 回小结
                         ▼
              飞书多维表格（数据在云端）  ◄── lark-cli 调飞书 OpenAPI 读写

定时：本机 launchd ─每天定时─► run_scheduled.js / remind.js
        读多维表格算账 → 用 bot 凭证主动发卡片到群
```

两套凭证各司其职：

- **读写多维表格**：用 `lark-cli` 绑定的飞书自建应用（需开通多维表格读写权限）。
- **主动发消息**：用 lark-channel bridge 那个 bot 的凭证（运行时现取，不落盘），因为只有它在你的群里。

## 依赖

- macOS（定时任务用 launchd）
- Node.js 18+（用到内置 `fetch`）
- [`lark-cli`](https://github.com/larksuite/cli)，且其绑定的飞书自建应用已开通**多维表格读写** + **云文档**权限
- [Claude Code](https://claude.com/claude-code) + lark-channel bridge（让飞书消息能触发 Claude Code 跑本仓库）
- 一个飞书机器人（bridge 用），并已被拉进你接收报表的群

本仓库无 npm 依赖，纯 Node + lark-cli。

## 安装

```bash
git clone https://github.com/1614080902102/lark-cashbook.git
cd lark-cashbook
cp config.example.json config.json
```

1. **建多维表格**（自动创建两张表并共享给你）：
   ```bash
   node scripts/setup_bitable.js <你的飞书 open_id>
   ```
   把输出的 `app_token` / `url` / `table_id` 填进 `config.json`。

2. **找群 chat_id**（先把 bot 拉进群再运行）：
   ```bash
   node scripts/list_chats.js
   ```
   把目标群的 `chat_id` 填进 `config.json` 的 `push_chat_id`，`user_open_id` 填你自己的 open_id。

3. **接通对话记账**：让 lark-channel bridge 调起 Claude Code 时工作目录是本仓库（或路由到这里）。`CLAUDE.md` 就是记账逻辑的大脑——它告诉 Claude 如何解析消息、调哪个脚本、怎么回小结。

4. **装定时任务**（每天 22:00 提醒 + 23:59 报表）：
   ```bash
   bash scripts/install_launchd.sh
   ```
   卸载：`bash scripts/uninstall_launchd.sh`

## 日常使用

在飞书里跟 bot 发消息：

| 你说 | 它做 |
|---|---|
| `午饭35 打车120` | 记两笔支出，回当日小结 |
| `昨天买书58` | 按昨天日期记一笔「成长」 |
| `工资到账8000` | 记一笔收入 |
| `这个月花了多少` | 汇总本月支出 |
| `这周餐饮多少` | 汇总本周「食」类 |

分类、支付方式在 `config.json` 里配，默认：

- 支出：衣 / 食 / 住 / 行 / 医疗 / 成长 / 娱乐 / 其他
- 收入：工资 / 外快 / 投资 / 报销 / 其他
- 支付方式：微信 / 支付宝 / 云闪付 / 其他

## 预算

在多维表格的「预算」表里手动加行：`月份`(如 2026-05) + `类别`(某类或「总预算」) + `预算金额`。
报表卡片会显示当月预算进度（正常 / 临界 / 超支）。

## 手动触发（调试用）

```bash
node scripts/finance.js query '{"month":"2026-05"}'   # 查询
node scripts/push_report.js daily 2026-05-28          # 发某天的日报
node scripts/run_scheduled.js 2026-05-31              # 模拟某天的定时调度
node scripts/remind.js                                # 立刻发记账提醒
```

## 目录结构

```
config.json              # 你的配置（不进版本库，从 config.example.json 复制）
CLAUDE.md                # 对话记账逻辑（Claude Code 读取）
scripts/
  finance.js             # 记账 add / 查询 query
  push_report.js         # 日/周/月报卡片
  run_scheduled.js       # 每天 23:59 调度：日报(+周日周报)(+月末月报)
  remind.js              # 每天 22:00 记账提醒
  setup_bitable.js       # 一键建多维表格
  list_chats.js          # 列出 bot 所在群的 chat_id
  install_launchd.sh     # 安装定时任务
  uninstall_launchd.sh   # 卸载定时任务
  lib/
    query-core.js        # 读表 + 汇总共用逻辑
    feishu-bot.js        # 取 bot 凭证 → 发消息
docs/                    # 设计文档
```

## 说明

- 数据存在飞书云端的多维表格，本仓库不存任何财务数据。
- 不存任何密钥：bot 凭证由 lark-channel 在运行时提供，lark-cli 的凭证由它自己管理。
- 定时任务靠本机 launchd，需要 Mac 在触发时刻是开机/唤醒状态；睡眠错过会在下次唤醒补跑一次。
