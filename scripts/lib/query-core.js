'use strict';

// 读多维表格 + 汇总的共用逻辑。Phase 1 记账/查询和 Phase 2 定时推送都依赖它。
// 凭证由 lark-cli 自带的 app 处理（已是表的协作者，有读权限）。

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf8'));
}

function larkCli(method, apiPath, { params, data } = {}) {
  const args = ['api', method, apiPath];
  if (params) args.push('--params', JSON.stringify(params));
  if (data) args.push('--data', JSON.stringify(data));
  const out = execFileSync('lark-cli', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
  const res = JSON.parse(out);
  if (res.code !== 0) {
    throw new Error(`飞书 API 失败 [${res.code}] ${res.msg || ''} (${method} ${apiPath})`);
  }
  return res.data;
}

// "YYYY-MM-DD" -> 当地零点毫秒时间戳
function dateToMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}
// 毫秒时间戳 -> "YYYY-MM-DD"（当地时区）
function msToDate(ms) {
  const dt = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}
function todayStr() {
  return msToDate(Date.now());
}

function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((seg) => seg.text || '').join('');
  return String(v);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 拉取全部流水记录（分页），返回标准化数组
function fetchAllTransactions(cfg = loadConfig()) {
  const APP = cfg.app_token;
  const TX = cfg.tables.transactions.table_id;
  const all = [];
  let pageToken;
  do {
    const params = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;
    const data = larkCli('GET', `/open-apis/bitable/v1/apps/${APP}/tables/${TX}/records`, { params });
    for (const item of data.items || []) {
      const f = item.fields || {};
      all.push({
        record_id: item.record_id,
        type: f['类型'] || '',
        amount: Number(f['金额'] || 0),
        category: f['类别'] || '',
        payment: f['支付方式'] || '',
        note: textOf(f['备注']),
        date: f['日期'] ? msToDate(f['日期']) : '',
      });
    }
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return all;
}

// 拉取预算表，返回 { "YYYY-MM": { 类别: 金额 } }
function fetchBudgets(cfg = loadConfig()) {
  const APP = cfg.app_token;
  const B = cfg.tables.budgets.table_id;
  const out = {};
  let pageToken;
  do {
    const params = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;
    const data = larkCli('GET', `/open-apis/bitable/v1/apps/${APP}/tables/${B}/records`, { params });
    for (const item of data.items || []) {
      const f = item.fields || {};
      const month = textOf(f['月份']);
      const cat = f['类别'] || '';
      const amt = Number(f['预算金额'] || 0);
      if (!month || !cat) continue;
      (out[month] = out[month] || {})[cat] = amt;
    }
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return out;
}

function fetchAllLoans(cfg = loadConfig()) {
  const APP = cfg.app_token;
  const L = cfg.tables.loans.table_id;
  const all = [];
  let pageToken;
  do {
    const params = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;
    const data = larkCli('GET', `/open-apis/bitable/v1/apps/${APP}/tables/${L}/records`, { params });
    for (const item of data.items || []) {
      const f = item.fields || {};
      all.push({
        record_id: item.record_id,
        counterparty: textOf(f['对方']),
        direction: f['方向'] || '',
        amount: Number(f['金额'] || 0),
        date: f['日期'] ? msToDate(f['日期']) : '',
        note: textOf(f['备注']),
      });
    }
    pageToken = data.has_more ? data.page_token : null;
  } while (pageToken);
  return all;
}

// 借出/偿还为正方向（对方欠我增加），借入/收回为负方向。
// 净额 > 0 表示对方还欠我，< 0 表示我还欠对方。
function summarizeLoans(rows) {
  const byPerson = {};
  for (const r of rows) {
    const p = r.counterparty || '未知';
    if (!byPerson[p]) byPerson[p] = { net: 0, events: [] };
    let sign = 0;
    if (r.direction === '借出' || r.direction === '偿还') sign = 1;
    else if (r.direction === '借入' || r.direction === '收回') sign = -1;
    byPerson[p].net += sign * r.amount;
    byPerson[p].events.push(r);
  }
  for (const p of Object.keys(byPerson)) byPerson[p].net = round2(byPerson[p].net);
  return byPerson;
}

function filterRows(rows, cond = {}) {
  let { start, end, type, category, month } = cond;
  if (month) {
    start = `${month}-01`;
    const [y, m] = month.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    end = `${month}-${String(last).padStart(2, '0')}`;
  }
  let out = rows;
  if (start) out = out.filter((r) => r.date && r.date >= start);
  if (end) out = out.filter((r) => r.date && r.date <= end);
  if (type) out = out.filter((r) => r.type === type);
  if (category) out = out.filter((r) => r.category === category);
  return out;
}

function summarize(rows) {
  const expense = rows.filter((r) => r.type === '支出').reduce((s, r) => s + r.amount, 0);
  const income = rows.filter((r) => r.type === '收入').reduce((s, r) => s + r.amount, 0);
  const byCategory = {};
  for (const r of rows) {
    if (r.type !== '支出') continue;
    const k = r.category || '未分类';
    byCategory[k] = (byCategory[k] || 0) + r.amount;
  }
  return {
    count: rows.length,
    expense: round2(expense),
    income: round2(income),
    net: round2(income - expense),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, round2(v)])),
  };
}

// 计算指定月份各类别的预算状态。
// 返回数组：[{ category, limit, used, remaining, pct, status }]，pct 为整数百分比，
// status: 'safe'(<80) / 'warning'(80-100) / 'over'(>=100)。
// 「总预算」对应该月所有支出之和。
// 若 onlyCategory 传入，仅返回该类别（或总预算）。
function computeBudgetStatus(cfg, monthStr, onlyCategory) {
  const budgets = fetchBudgets(cfg);
  const monthBudget = budgets[monthStr] || {};
  if (Object.keys(monthBudget).length === 0) return [];
  const rows = filterRows(fetchAllTransactions(cfg), { month: monthStr, type: '支出' });
  const s = summarize(rows);
  const out = [];
  for (const [cat, limit] of Object.entries(monthBudget)) {
    if (onlyCategory && cat !== onlyCategory) continue;
    const used = cat === '总预算' ? s.expense : (s.byCategory[cat] || 0);
    const remaining = round2(limit - used);
    const pct = limit > 0 ? Math.round((used / limit) * 100) : 0;
    let status = 'safe';
    if (pct >= 100) status = 'over';
    else if (pct >= 80) status = 'warning';
    out.push({ category: cat, limit, used: round2(used), remaining, pct, status });
  }
  return out;
}

module.exports = {
  loadConfig,
  larkCli,
  dateToMs,
  msToDate,
  todayStr,
  textOf,
  round2,
  fetchAllTransactions,
  fetchBudgets,
  fetchAllLoans,
  summarizeLoans,
  computeBudgetStatus,
  filterRows,
  summarize,
};
