// utils/line.js
'use strict';

const crypto = require('crypto');
const axios = require('axios');
const line = require('@line/bot-sdk');

// クライアントの初期化（鍵は使う瞬間に環境変数から取る設計もアリですが、ここではシンプルに）
const { LINE_ACCESS_TOKEN } = process.env;
const lineClient = new line.Client({ channelAccessToken: LINE_ACCESS_TOKEN });

function verifySignature(body, sig, secret) {
  try {
    const h = crypto.createHmac('sha256', secret).update(body).digest('base64');
    return h === sig;
  } catch (e) {
    console.error('verifySignature error:', e);
    return false;
  }
}

async function safeReply(token, text) {
  if (!token) return;
  try {
    await lineClient.replyMessage(token, { type: 'text', text: String(text).slice(0, 4900) });
  } catch (e) {
    const msg = e?.originalError?.response?.data
      ? JSON.stringify(e.originalError.response.data)
      : e?.message;
    console.error('LINE reply failed:', msg);
  }
}

async function safeReplyFlex(token, contents) {
  if (!token) return;
  try {
    await lineClient.replyMessage(token, {
      type: 'flex',
      altText: '配達順',
      contents,
    });
  } catch (e) {
    const msg = e?.originalError?.response?.data
      ? JSON.stringify(e.originalError.response.data)
      : e?.message;
    console.error('LINE flex reply failed:', msg);
  }
}

async function getLineImageContentBuffer(id) {
  const r = await axios.get(`https://api-data.line.me/v2/bot/message/${id}/content`, {
    responseType: 'arraybuffer',
    headers: { Authorization: `Bearer ${LINE_ACCESS_TOKEN}` },
    timeout: 30000,
  });
  return Buffer.from(r.data);
}

module.exports = {
  verifySignature,
  safeReply,
  safeReplyFlex,
  getLineImageContentBuffer
};