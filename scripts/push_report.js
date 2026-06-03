#!/usr/bin/env node
'use strict';

// 定时主动推送日/周/月报到飞书。
//   node push_report.js daily|weekly|monthly [基准日期YYYY-MM-DD]
// 基准日期缺省为今天（即"触发时刻"）；报告汇总的是基准日期前一个刚结束的周期。
//   daily   -> 基准日的前一天
//   weekly  -> 基准日所在周的上一周（上周一~周日）
//   monthly -> 基准日的上个月整月
// 读数据用 lark-cli（其 app 有表读权限），发消息用 bridge bot（同会话）。

const Q = require('./lib/query-core');
const bot = require('./lib/feishu-bot');

const CAT_EMOJI = {
  衣: '👕', 食: '🍚', 住: '🏠', 行: '🚗', 医疗: '💊', 成长: '📚', 娱乐: '🎮',
  人际交往: '🤝', 订阅: '📦', 其他: '📋', 总预算: '💰',
  工资: '💰', 外快: '🧧', 投资: '📈', 报销: '🧾', 未分类: '❓',
};

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function monthOf(s) { return s.slice(0, 7); }
function yuan(n) { return '¥' + Number(n).toFixed(2); }

// 返回 { title, color, start, end } —— 报告窗口。
// 在周期结束当晚 23:59 触发，汇总「当前刚结束的周期」（含基准日当天）。
function periodWindow(type, baseStr) {
  const [by, bm, bd] = baseStr.split('-').map(Number);
  const base = new Date(by, bm - 1, bd);
  if (type === 'daily') {
    const s = baseStr;
    return { title: `📊 日报 · ${s}`, color: 'turquoise', start: s, end: s };
  }
  if (type === 'weekly') {
    // 本周一 ~ 本周日（周一为一周起点；周日 23:59 触发时基准日即周日）
    const dow = (base.getDay() + 6) % 7; // 周一=0
    const mon = new Date(base); mon.setDate(base.getDate() - dow);
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    const s = fmtDate(mon), e = fmtDate(sun);
    return { title: `📊 周报 · ${s} ~ ${e}`, color: 'indigo', start: s, end: e };
  }
  if (type === 'monthly') {
    const first = new Date(by, bm - 1, 1); // 本月一号
    const last = new Date(by, bm, 0); // 本月最后一天
    const s = fmtDate(first), e = fmtDate(last);
    return { title: `📊 月报 · ${monthOf(s)}`, color: 'violet', start: s, end: e };
  }
  throw new Error('未知报告类型: ' + type);
}

const BAR_SLOTS = 14;
// 纯实心条，长度 ∝ ratio。放在行尾，参差不影响前面列对齐；
// 不用空心轨道，避免 █/░ 宽度不一导致错位。>0 至少给 1 格。
function bar(ratio) {
  const n = Math.max(ratio > 0 ? 1 : 0, Math.min(BAR_SLOTS, Math.round(ratio * BAR_SLOTS)));
  return '█'.repeat(n);
}
function colorMoney(n, color) {
  return `<font color='${color}'>${yuan(n)}</font>`;
}

function budgetRow(cat, spent, limit) {
  const ratio = limit > 0 ? spent / limit : 0;
  const left = Q.round2(limit - spent);
  const flag = left < 0 ? `<font color='red'>超支</font>` : ratio >= 0.9 ? `<font color='orange'>临界</font>` : `<font color='green'>正常</font>`;
  return `${CAT_EMOJI[cat] || '•'} **${cat}**　\`${bar(ratio)}\`　${yuan(spent)}/${yuan(limit)} · ${flag}`;
}
function budgetLines(budgets, monthStr, monthByCategory) {
  const b = budgets[monthStr];
  if (!b || !Object.keys(b).length) return null;
  const lines = [];
  if (b['总预算'] != null) {
    const totalSpent = Object.values(monthByCategory).reduce((s, v) => s + v, 0);
    lines.push(budgetRow('总预算', Q.round2(totalSpent), b['总预算']));
  }
  for (const [cat, limit] of Object.entries(b)) {
    if (cat === '总预算') continue;
    lines.push(budgetRow(cat, monthByCategory[cat] || 0, limit));
  }
  return lines.length ? lines.join('\n') : null;
}

// 支出分类字符条形图：固定列（名/金额/占比）对齐，纯实心条放行尾参差，紧凑可控。
function breakdownLines(byCategory, total) {
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '_本期无支出_';
  const maxName = Math.max(...entries.map(([c]) => c.length));
  const amtStrs = entries.map(([, v]) => yuan(v));
  const amtW = Math.max(...amtStrs.map((s) => s.length));
  return entries
    .map(([cat, amt], i) => {
      const name = cat + '　'.repeat(maxName - cat.length);
      const ratio = total > 0 ? amt / total : 0;
      const pctS = `${Math.round(ratio * 100)}%`.padStart(4);
      const amtS = amtStrs[i].padStart(amtW);
      return `${CAT_EMOJI[cat] || '•'} \`${name} ${amtS} ${pctS} ${bar(ratio)}\``;
    })
    .join('\n');
}

function kpiColumn(label, valueMd) {
  return {
    tag: 'column',
    width: 'weighted',
    weight: 1,
    vertical_align: 'center',
    elements: [
      { tag: 'markdown', content: `<font color='grey'>${label}</font>`, text_align: 'center' },
      { tag: 'markdown', content: valueMd, text_align: 'center' },
    ],
  };
}

function buildCard(win, summary, monthStr, monthSummary, budgetText, url) {
  const netColor = summary.net >= 0 ? 'green' : 'red';
  const elements = [];

  // KPI 三栏（带灰底）
  elements.push({
    tag: 'column_set',
    flex_mode: 'bisect',
    background_style: 'grey',
    horizontal_spacing: 'default',
    columns: [
      kpiColumn('支出', `**${colorMoney(summary.expense, 'red')}**`),
      kpiColumn('收入', `**${colorMoney(summary.income, 'green')}**`),
      kpiColumn('净额', `**<font color='${netColor}'>${yuan(summary.net)}</font>**`),
    ],
  });

  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>共 ${summary.count} 笔　·　本月累计支出 ${yuan(monthSummary.expense)}</font>`,
    text_align: 'center',
  });

  elements.push({ tag: 'hr' });

  // 支出分类（字符条形图，紧凑对齐）
  elements.push({ tag: 'markdown', content: `**🗂 支出分类**` });
  elements.push({ tag: 'markdown', content: breakdownLines(summary.byCategory, summary.expense) });

  // 本月预算（设了才显示）
  if (budgetText) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `**🎯 本月预算（${monthStr}）**` });
    elements.push({ tag: 'markdown', content: budgetText });
  }

  // 按钮
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '📖 打开账本明细' },
    type: 'primary',
    width: 'default',
    behaviors: [{ type: 'open_url', default_url: url, pc_url: url, ios_url: url, android_url: url }],
  });
  elements.push({
    tag: 'markdown',
    content: `<font color='grey'>财务记账助手 · ${new Date().toLocaleString('zh-CN', { hour12: false })}</font>`,
    text_align: 'center',
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      template: win.color,
      title: { tag: 'plain_text', content: win.title },
      subtitle: { tag: 'plain_text', content: `${win.start} ~ ${win.end}` },
    },
    body: { elements },
  };
}

// 生成并推送某类型报告。colorOverride 仅用于配色对比测试。
async function pushReport(type, baseStr = Q.todayStr(), colorOverride = null) {
  const cfg = Q.loadConfig();
  const win = periodWindow(type, baseStr);
  if (colorOverride) {
    win.color = colorOverride;
    win.title += ` [${colorOverride}]`;
  }

  const allRows = Q.fetchAllTransactions(cfg);
  const periodRows = Q.filterRows(allRows, { start: win.start, end: win.end });
  const summary = Q.summarize(periodRows);

  const monthStr = monthOf(win.start);
  const monthRows = Q.filterRows(allRows, { month: monthStr });
  const monthSummary = Q.summarize(monthRows);

  const budgets = Q.fetchBudgets(cfg);
  const budgetText = budgetLines(budgets, monthStr, monthSummary.byCategory);

  const card = buildCard(win, summary, monthStr, monthSummary, budgetText, cfg.url);
  const target = cfg.push_chat_id || cfg.user_open_id;
  await bot.sendCard(target, card);
  console.log(`[${new Date().toISOString()}] 已推送 ${type} (${win.start}~${win.end}) 共 ${summary.count} 笔`);
}

module.exports = { pushReport, periodWindow };

if (require.main === module) {
  const type = process.argv[2];
  const baseStr = process.argv[3] || Q.todayStr();
  const colorOverride = process.argv[4] || null;
  if (!['daily', 'weekly', 'monthly'].includes(type)) {
    console.error('用法: node push_report.js daily|weekly|monthly [YYYY-MM-DD] [颜色]');
    process.exit(2);
  }
  pushReport(type, baseStr, colorOverride).catch((e) => {
    console.error(`[${new Date().toISOString()}] 推送失败:`, e.message);
    process.exit(1);
  });
}
