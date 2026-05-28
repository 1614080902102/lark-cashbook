'use strict';

// 用 bridge bot（与用户同会话的 app）主动发飞书消息。
// 密钥运行时从 ~/.lark-channel 现取，不落盘。读多维表格用 lark-cli（另一套），
// 发消息必须用 bridge bot，否则不在会话里发不出去。

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHANNEL_DIR = path.join(os.homedir(), '.lark-channel');

function loadChannelConfig() {
  return JSON.parse(fs.readFileSync(path.join(CHANNEL_DIR, 'config.json'), 'utf8'));
}

// 运行时取 bot app_secret
function getBotSecret(secretId) {
  const req = JSON.stringify({ protocolVersion: 1, ids: [secretId] });
  const out = execFileSync(path.join(CHANNEL_DIR, 'secrets-getter'), [], {
    input: req,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const values = (JSON.parse(out).values) || {};
  const secret = Object.values(values)[0];
  if (!secret) throw new Error('未能从 secrets-getter 取到 bot 密钥: ' + secretId);
  return secret;
}

async function mintToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const j = await res.json();
  if (j.code !== 0 || !j.tenant_access_token) {
    throw new Error(`mint token 失败 [${j.code}] ${j.msg || ''}`);
  }
  return j.tenant_access_token;
}

// 取一个可用的 bot token（封装上面三步）
async function getBotToken() {
  const cfg = loadChannelConfig();
  const appId = cfg.accounts.app.id;
  const secretId = cfg.accounts.app.secret.id;
  const secret = getBotSecret(secretId);
  return mintToken(appId, secret);
}

// receiveId 可以是 open_id（私聊用户）或 chat_id（群），由 receiveIdType 指定
async function sendMessage(token, receiveId, msgType, contentObj, receiveIdType = 'open_id') {
  const res = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: msgType,
        content: JSON.stringify(contentObj),
      }),
    }
  );
  const j = await res.json();
  if (j.code !== 0) {
    throw new Error(`发送消息失败 [${j.code}] ${j.msg || ''}`);
  }
  return j.data;
}

function idType(id) {
  return id.startsWith('oc_') ? 'chat_id' : 'open_id';
}

async function sendCard(receiveId, card) {
  const token = await getBotToken();
  return sendMessage(token, receiveId, 'interactive', card, idType(receiveId));
}

async function sendText(receiveId, text) {
  const token = await getBotToken();
  return sendMessage(token, receiveId, 'text', { text }, idType(receiveId));
}

module.exports = { getBotToken, sendCard, sendText, loadChannelConfig };
