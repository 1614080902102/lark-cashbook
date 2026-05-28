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
  filterRows,
  summarize,
};
