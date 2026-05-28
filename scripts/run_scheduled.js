#!/usr/bin/env node
'use strict';

// 由 launchd 每天 23:59 触发。统一判断该发哪些报：
//   每天        -> 日报（今天）
//   周日        -> 加发周报（本周一~周日）
//   当月最后一天 -> 加发月报（本月）
// 这样规避了 launchd 无法表达「每月最后一天」的限制。
// 可传基准日期覆盖（测试用）：node run_scheduled.js 2026-05-31

const { pushReport } = require('./push_report');
const Q = require('./lib/query-core');

function isLastDayOfMonth(d) {
  const t = new Date(d);
  t.setDate(t.getDate() + 1);
  return t.getDate() === 1;
}

async function main() {
  const baseStr = process.argv[2] || Q.todayStr();
  const [y, m, dd] = baseStr.split('-').map(Number);
  const base = new Date(y, m - 1, dd);

  const jobs = ['daily'];
  if (base.getDay() === 0) jobs.push('weekly'); // 周日
  if (isLastDayOfMonth(base)) jobs.push('monthly');

  console.log(`[${new Date().toISOString()}] 基准日 ${baseStr} -> 待发: ${jobs.join(', ')}`);
  for (const type of jobs) {
    await pushReport(type, baseStr);
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] 调度失败:`, e.message);
  process.exit(1);
});
