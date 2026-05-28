#!/usr/bin/env node
'use strict';

// 列出 bot 所在的群及其 chat_id，用于填 config.json 的 push_chat_id。
// 用法：node scripts/list_chats.js

const bot = require('./lib/feishu-bot');

async function main() {
  const token = await bot.getBotToken();
  let items = [];
  let pt = '';
  do {
    const r = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/chats?page_size=100${pt ? `&page_token=${pt}` : ''}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const j = await r.json();
    if (j.code !== 0) throw new Error(`[${j.code}] ${j.msg}`);
    items = items.concat(j.data.items || []);
    pt = j.data.has_more ? j.data.page_token : '';
  } while (pt);

  if (!items.length) {
    console.log('bot 不在任何群里。先把 bot 拉进目标群，再运行本脚本。');
    return;
  }
  console.log('bot 所在的群：');
  for (const c of items) console.log(`  ${c.chat_id}  ${c.name || '(无名)'}`);
}

main().catch((e) => {
  console.error('获取失败:', e.message);
  process.exit(1);
});
