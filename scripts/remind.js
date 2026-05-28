#!/usr/bin/env node
'use strict';

// 每天 22:00 由 launchd 触发：提醒记账，并带上今天已记的情况。
// 可传基准日期覆盖（测试用）：node remind.js 2026-05-28

const Q = require('./lib/query-core');
const bot = require('./lib/feishu-bot');

async function main() {
  const today = process.argv[2] || Q.todayStr();
  const cfg = Q.loadConfig();
  const rows = Q.filterRows(Q.fetchAllTransactions(cfg), { start: today, end: today });
  const s = Q.summarize(rows);

  let text;
  if (s.count === 0) {
    text = `⏰ 记账提醒\n今天还没记账哦～ 今天花了什么、有没有进账，发我一下就好 📝`;
  } else {
    text = `⏰ 记账提醒\n今天已记 ${s.count} 笔，支出 ¥${s.expense.toFixed(2)}。还有要补记的吗？没有就忽略我～`;
  }

  const target = cfg.push_chat_id || cfg.user_open_id;
  await bot.sendText(target, text);
  console.log(`[${new Date().toISOString()}] 已发记账提醒 (${today}, 今日 ${s.count} 笔)`);
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] 提醒失败:`, e.message);
  process.exit(1);
});
