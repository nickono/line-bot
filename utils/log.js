'use strict';

// Cloud Logging で「検索しやすく」「1ログ=1行」で出すためのユーティリティ
function logJson(tag, obj) {
  try {
    // 1行JSONにして改行分割を防ぐ
    console.log(JSON.stringify({ tag, ...obj, ts: new Date().toISOString() }));
  } catch (e) {
    console.log(`[${tag}] (logJson failed)`, e?.message || e);
  }
}

// 長すぎるOCRはログ上限対策で軽くカット（必要なら増やしてOK）
function clipText(s, max = 12000) {
  const str = String(s || '');
  if (str.length <= max) return str;
  return str.slice(0, max) + ` ...[clipped ${str.length - max} chars]`;
}

// 外の世界に出荷
module.exports = {
  logJson,
  clipText
};