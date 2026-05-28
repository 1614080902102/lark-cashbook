#!/usr/bin/env node
'use strict';

// 一键创建「财务记账」多维表格（流水 + 预算两张表），并可选共享给指定用户。
// 用法：
//   node scripts/setup_bitable.js                 # 仅创建，打印 token
//   node scripts/setup_bitable.js ou_xxxx         # 创建并共享给该 open_id
// 完成后把打印的 app_token / url / table_id 填进 config.json。
// 分类、支付方式从 config.json（若存在）或 config.example.json 读取。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function lark(method, apiPath, { params, data } = {}) {
  const args = ['api', method, apiPath];
  if (params) args.push('--params', JSON.stringify(params));
  if (data) args.push('--data', JSON.stringify(data));
  const out = execFileSync('lark-cli', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 });
  const res = JSON.parse(out);
  if (res.code !== 0) throw new Error(`飞书 API 失败 [${res.code}] ${res.msg || ''} (${method} ${apiPath})`);
  return res.data;
}

function loadDefaults() {
  const root = path.join(__dirname, '..');
  const p = fs.existsSync(path.join(root, 'config.json'))
    ? path.join(root, 'config.json')
    : path.join(root, 'config.example.json');
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { categories: c.categories, payments: c.payment_methods };
}

function selectField(name, options) {
  return { field_name: name, type: 3, property: { options: options.map((o) => ({ name: o })) } };
}

async function main() {
  const shareOpenId = process.argv[2] || null;
  const { categories, payments } = loadDefaults();
  const allCats = [...new Set([...categories.expense, ...categories.income])];

  console.log('创建多维表格…');
  const app = lark('POST', '/open-apis/bitable/v1/apps', { data: { name: '财务记账' } }).app;
  const APP = app.app_token;
  console.log('  app_token:', APP);

  console.log('创建「流水」表…');
  const tx = lark('POST', `/open-apis/bitable/v1/apps/${APP}/tables`, {
    data: {
      table: {
        name: '流水',
        fields: [
          { field_name: '备注', type: 1 },
          { field_name: '日期', type: 5 },
          selectField('类型', ['支出', '收入']),
          { field_name: '金额', type: 2, property: { formatter: '0.00' } },
          selectField('类别', allCats),
          selectField('支付方式', payments),
        ],
      },
    },
  });

  console.log('创建「预算」表…');
  const budget = lark('POST', `/open-apis/bitable/v1/apps/${APP}/tables`, {
    data: {
      table: {
        name: '预算',
        fields: [
          { field_name: '月份', type: 1 },
          selectField('类别', ['总预算', ...categories.expense]),
          { field_name: '预算金额', type: 2, property: { formatter: '0.00' } },
        ],
      },
    },
  });

  console.log('删除默认空表…');
  lark('DELETE', `/open-apis/bitable/v1/apps/${APP}/tables/${app.default_table_id}`);

  if (shareOpenId) {
    console.log('共享给用户', shareOpenId, '…');
    lark('POST', `/open-apis/drive/v1/permissions/${APP}/members`, {
      params: { type: 'bitable', need_notification: 'true' },
      data: { member_type: 'openid', member_id: shareOpenId, perm: 'full_access' },
    });
  }

  console.log('\n完成。把下面这段填进 config.json：\n');
  console.log(JSON.stringify({
    app_token: APP,
    url: app.url,
    tables: {
      transactions: { table_id: tx.table_id, name: '流水' },
      budgets: { table_id: budget.table_id, name: '预算' },
    },
  }, null, 2));
}

main().catch((e) => {
  console.error('建表失败:', e.message);
  process.exit(1);
});
