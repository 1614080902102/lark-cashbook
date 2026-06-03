#!/usr/bin/env node
'use strict';

// 财务记账助手核心脚本。子命令：
//   node finance.js add '<json>'     写入一条或多条流水（json 为对象或数组）
//   node finance.js query '<json>'   查询并汇总（json 为筛选条件，可省略）
//
// 记账对象字段：
//   { type:"支出"|"收入", amount:数字, category:字符串, payment?:字符串, note?:字符串, date?:"YYYY-MM-DD" }
//   date 缺省为今天。
// 查询条件字段（都可选）：
//   { start:"YYYY-MM-DD", end:"YYYY-MM-DD", type:"支出"|"收入", category:字符串, month:"YYYY-MM" }
//
// 凭证由 lark-cli 自带的 app 处理，无需在本脚本配置密钥。

const fs = require('fs');
const Q = require('./lib/query-core');

const cfg = Q.loadConfig();
const APP = cfg.app_token;
const TX = cfg.tables.transactions.table_id;
const LOAN = cfg.tables.loans && cfg.tables.loans.table_id;

function recordToFields(r) {
  if (r.amount == null || isNaN(Number(r.amount))) {
    throw new Error('记录缺少有效金额: ' + JSON.stringify(r));
  }
  if (r.type !== '支出' && r.type !== '收入') {
    throw new Error('记录的 type 必须是 支出 或 收入: ' + JSON.stringify(r));
  }
  const fields = {
    '类型': r.type,
    '金额': Number(r.amount),
    '日期': Q.dateToMs(r.date || Q.todayStr()),
  };
  if (r.category) fields['类别'] = r.category;
  if (r.payment) fields['支付方式'] = r.payment;
  if (r.note) fields['备注'] = r.note;
  return { fields };
}

function add(input) {
  const arr = Array.isArray(input) ? input : [input];
  const records = arr.map(recordToFields);
  const data = Q.larkCli('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${TX}/records/batch_create`, {
    data: { records },
  });
  // 拿涉及到的 (月份, 类别) 对，回填预算状态。
  // 同时把「总预算」一并返回（如有），便于客户端展示。
  const expenseCats = new Set();
  const months = new Set();
  for (const r of arr) {
    if (r.type !== '支出') continue;
    months.add((r.date || Q.todayStr()).slice(0, 7));
    if (r.category) expenseCats.add(r.category);
  }
  const budgets = [];
  for (const m of months) {
    const all = Q.computeBudgetStatus(cfg, m);
    for (const b of all) {
      if (b.category === '总预算' || expenseCats.has(b.category)) {
        budgets.push({ month: m, ...b });
      }
    }
  }
  return { added: (data.records || []).length, budgets };
}

function budget(cond = {}) {
  const month = cond.month || Q.todayStr().slice(0, 7);
  return { month, statuses: Q.computeBudgetStatus(cfg, month, cond.category) };
}

function query(cond = {}) {
  const rows = Q.filterRows(Q.fetchAllTransactions(cfg), cond);
  const s = Q.summarize(rows);
  return {
    range: { start: cond.start || (cond.month ? `${cond.month}-01` : null) || null, end: cond.end || null },
    ...s,
    records: rows,
  };
}

function loanRecordToFields(r) {
  const dirs = ['借出', '借入', '收回', '偿还'];
  if (!dirs.includes(r.direction)) {
    throw new Error('往来记录方向必须是 借出/借入/收回/偿还: ' + JSON.stringify(r));
  }
  if (r.amount == null || isNaN(Number(r.amount)) || Number(r.amount) <= 0) {
    throw new Error('往来记录缺少有效金额（正数）: ' + JSON.stringify(r));
  }
  if (!r.counterparty) throw new Error('往来记录缺少对方: ' + JSON.stringify(r));
  const fields = {
    '对方': r.counterparty,
    '方向': r.direction,
    '金额': Number(r.amount),
    '日期': Q.dateToMs(r.date || Q.todayStr()),
  };
  if (r.note) fields['备注'] = r.note;
  return { fields };
}

function loanAdd(input) {
  if (!LOAN) throw new Error('config.json 缺少 tables.loans');
  const arr = Array.isArray(input) ? input : [input];
  const records = arr.map(loanRecordToFields);
  const data = Q.larkCli('POST', `/open-apis/bitable/v1/apps/${APP}/tables/${LOAN}/records/batch_create`, {
    data: { records },
  });
  return { added: (data.records || []).length };
}

function loanBalance(cond = {}) {
  const all = Q.fetchAllLoans(cfg);
  const rows = cond.counterparty ? all.filter((r) => r.counterparty === cond.counterparty) : all;
  const byPerson = Q.summarizeLoans(rows);
  const balances = Object.entries(byPerson)
    .map(([name, v]) => ({ counterparty: name, net: v.net, events: v.events.length }))
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const outstanding = balances.filter((b) => b.net !== 0);
  return { balances, outstanding, detail: cond.counterparty ? byPerson[cond.counterparty] || null : null };
}

function main() {
  const cmd = process.argv[2];
  const sub = process.argv[3];
  let rawIdx = 3;
  if (cmd === 'loan') rawIdx = 4;
  const raw = process.argv[rawIdx];
  let payload = null;
  if (raw) payload = JSON.parse(raw);
  else if (!process.stdin.isTTY) {
    try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || 'null'); } catch (_) {}
  }

  let result;
  if (cmd === 'add') result = add(payload);
  else if (cmd === 'query') result = query(payload || {});
  else if (cmd === 'budget') result = budget(payload || {});
  else if (cmd === 'loan' && sub === 'add') result = loanAdd(payload);
  else if (cmd === 'loan' && sub === 'balance') result = loanBalance(payload || {});
  else {
    console.error('用法:\n  node finance.js add|query \'<json>\'\n  node finance.js budget [\'<json>\']\n  node finance.js loan add \'<json>\'\n  node finance.js loan balance [\'<json>\']');
    process.exit(2);
  }
  console.log(JSON.stringify(result, null, 2));
}

main();
