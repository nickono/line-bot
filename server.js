'use strict';

console.log("BOOT VERSION: 2026-02-22-OCR-FILTER-DATE-TAKE-NOADDR-NOSLIPNO-FLEX-DONE-B-SINGLETIME-LOGJSON");

const express = require('express');

const app = express();

const {
  parseSlip,
  normalizeForJudge,
  extractDeliverDateKey,
  extractTimeSlot,
  buildSlipKey
} = require('./utils/parser');

const { 
  logJson, 
  clipText 
} = require('./utils/log');

// ★ 新しく追加
const {
  buildDeliveryFlex
} = require('./utils/flex');

// ★ 新しく追加
const {
  decideBasePointForSorting,
  sortSlips
} = require('./utils/sorter');

// ★ 新しく追加
const {
  verifySignature,
  safeReply,
  safeReplyFlex,
  getLineImageContentBuffer
} = require('./utils/line');

const { ocrWithVision } = require('./utils/vision');

// ==========================
// ★安全装置：環境変数のサニティチェック（Fail Fast）
// ==========================
if (!process.env.LINE_ACCESS_TOKEN || !process.env.LINE_CHANNEL_SECRET) {
  console.error("🚨 [起動エラー] LINEのアクセスキーが読み込めません！ .env ファイルを確認してください。");
  process.exit(1); // 危険なのでサーバー起動を強制ストップ
}
// ==========================

// ==========================
// ★安全装置：モジュール読み込みチェック（Fail Fast）
// ==========================
const parserFns = { parseSlip, normalizeForJudge, extractDeliverDateKey, extractTimeSlot, buildSlipKey };
const logFns = { logJson, clipText };
const flexFns = { buildDeliveryFlex }; // ★ 追加
const sorterFns = { decideBasePointForSorting, sortSlips }; // ★ 追加
// ★ 2つのモジュールを追加
const lineFns = { verifySignature, safeReply, safeReplyFlex, getLineImageContentBuffer };
const visionFns = { ocrWithVision };
// ★ 全部合体
const allFns = { ...parserFns, ...logFns, ...flexFns, ...sorterFns, ...lineFns, ...visionFns };

for (const [funcName, funcBody] of Object.entries(allFns)) {
  if (typeof funcBody !== 'function') {
    console.error(`🚨 [起動エラー] 外部ファイルから '${funcName}' が読み込めません！export漏れやタイポがないか確認してください。`);
    process.exit(1); 
  }
}
// ==========================

// ==== ENV ====
const {
  LINE_CHANNEL_SECRET,
  LINE_ACCESS_TOKEN,
  PORT,
  SUSHITAKA_ADDRESS,
  USE_LIVE_LOCATION,      // "1" で現在地基準ON
  GOOGLE_MAPS_API_KEY,    // optional（あれば同じ時間枠内で距離順にできる）
} = process.env;

if (!LINE_CHANNEL_SECRET || !LINE_ACCESS_TOKEN) {
  console.error('Missing env: LINE_CHANNEL_SECRET / LINE_ACCESS_TOKEN');
}

// ==========================
// state (メモリ保持)
// ==========================
const stateByUser = new Map();
const STATE_TTL_MS = 1000 * 60 * 60 * 6;

function getUserState(userId) {
  const now = Date.now();
  let st = stateByUser.get(userId);
  if (!st) {
    // baseDateKey: 1枚目の伝票から抽出した日付キー（YYYY-MM-DD or MM-DD）
    st = { slips: [], done: new Set(), lastLocation: null, updatedAt: now, baseDateKey: '' };
    stateByUser.set(userId, st);
  }
  st.updatedAt = now;

  for (const [k, v] of stateByUser.entries()) {
    if (now - (v.updatedAt || 0) > STATE_TTL_MS) stateByUser.delete(k);
  }
  return st;
}

// ================= logging helpers =================

// Cloud Logging で「検索しやすく」「1ログ=1行」で出すためのユーティリティ　→ utils/log.js

// 長すぎるOCRはログ上限対策で軽くカット（必要なら増やしてOK）→ utils/log.js

// ==== Webhook ====
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  // LINE timeout対策：先に200返す
  res.status(200).send('OK');

  try {
    const signature = req.headers['x-line-signature'];
    if (!signature) {
      console.error('No x-line-signature');
      return;
    }
    if (!verifySignature(req.body, signature, LINE_CHANNEL_SECRET)) {
      console.error('Invalid signature');
      return;
    }

    const body = JSON.parse(req.body.toString('utf8'));
    if (!Array.isArray(body.events)) return;

    for (const event of body.events) {
      const replyToken = event.replyToken;
      const userId = event.source?.userId;

      if (!userId) {
        await safeReply(replyToken, 'userIdが取得できなかった…🥲');
        continue;
      }

      const st = getUserState(userId);

      // ===== postback（Flexボタン）=====
      if (event.type === 'postback') {
        const data = String(event.postback?.data || '');
        console.log('Postback:', { userId, data });

        // done:<slipKey>
        if (data.startsWith('done:')) {
          const key = data.replace('done:', '').trim();
          if (!key) {
            await safeReply(replyToken, '完了キーが空だった…🥲');
            continue;
          }
          st.done.add(key);

          const pending = st.slips.filter(s => !st.done.has(s.key));
          if (!pending.length) {
            await safeReply(replyToken, '🎉 全部完了！');
            continue;
          }

          const base = await decideBasePointForSorting(st);
          const ordered = await sortSlips(pending, base);
          await safeReplyFlex(replyToken, buildDeliveryFlex(ordered, base));
          continue;
        }

        if (data === 'list') {
          const pending = st.slips.filter(s => !st.done.has(s.key));
          if (!pending.length) {
            await safeReply(replyToken, '未配達がないよ！全部完了👏');
            continue;
          }
          const base = await decideBasePointForSorting(st);
          const ordered = await sortSlips(pending, base);
          await safeReplyFlex(replyToken, buildDeliveryFlex(ordered, base));
          continue;
        }

        if (data === 'reset') {
          st.slips = [];
          st.done = new Set();
          st.baseDateKey = ''; // ★基準日もリセット
          await safeReply(replyToken, 'リセットしたよ');
          continue;
        }

        await safeReply(replyToken, 'postbackを受け取ったけど内容が不明だった…🥲');
        continue;
      }

      // ===== location =====
      if (event.message?.type === 'location') {
        st.lastLocation = {
          lat: Number(event.message.latitude),
          lng: Number(event.message.longitude),
          updatedAt: Date.now(),
        };
        await safeReply(replyToken, '現在地OK！「配達順」と送ってね');
        continue;
      }

      // ===== text =====
      if (event.message?.type === 'text') {
        const text = (event.message.text || '').trim();

        if (/^(配達順|配達|一覧)$/.test(text)) {
          const pending = st.slips.filter(s => !st.done.has(s.key));
          if (!pending.length) {
            await safeReply(replyToken, '未配達がないよ！まず伝票画像を送ってね。');
            continue;
          }
          const base = await decideBasePointForSorting(st);
          const ordered = await sortSlips(pending, base);
          await safeReplyFlex(replyToken, buildDeliveryFlex(ordered, base));
          continue;
        }

        if (/^(現在地|位置情報)$/.test(text)) {
          await safeReply(replyToken, '了解！LINEの「＋」→「位置情報」を送ってね。送ってくれたら同じ時間枠は近い順にするよ。');
          continue;
        }

        if (/^(リセット|クリア)$/.test(text)) {
          st.slips = [];
          st.done = new Set();
          st.baseDateKey = ''; // ★基準日もリセット
          await safeReply(replyToken, '配達リストをリセットしたよ。伝票画像を送ってね。');
          continue;
        }

        await safeReply(replyToken, '伝票画像を送ってね。\nコマンド：配達順 / 現在地 / リセット');
        continue;
      }

      // ===== image =====
      if (event.message?.type === 'image') {
        const messageId = event.message.id;

        logJson('IMAGE_RECEIVED', { userId, messageId });

        const buf = await getLineImageContentBuffer(messageId);
        const ocrRaw = await ocrWithVision(buf);

        // ★ログ：OCR全文を「1行JSON」で出す（SEARCH("OCR_JSON")で確実に見える）
        logJson('OCR_JSON', { userId, messageId, ocr: clipText(ocrRaw) });

        // ★② テイクアウト除外（OCR全文で判定）
        const ocrNorm = normalizeForJudge(ocrRaw);
        if (ocrNorm.includes('テイク')) {
          logJson('FILTER_TAKEOUT', { userId, messageId, reason: 'contains テイク' });
          await safeReply(replyToken, 'これはテイクアウトです。');
          continue; // 配達リストに入れない
        }

        const parsed = parseSlip(ocrRaw);

        // ★ログ：PARSEDを「1行JSON」で出す（SEARCH("PARSED_JSON")で確実に見える）
        logJson('PARSED_JSON', { userId, messageId, parsed });

        const name = (parsed.name || '').trim();
        const address = (parsed.address || '').trim();

        // ★③ 住所が無いなら除外（要件どおり）
        if (!address) {
          logJson('FILTER_NOADDR', { userId, messageId, reason: 'address empty', parsed });
          await safeReply(replyToken, '住所が不明です。');
          continue; // 配達リストに入れない
        }

        // 最低限：住所 or 名前（住所必須にしたので、ここは実質保険）
        if (!name && !address) {
          logJson('FILTER_NONAME_NOADDR', { userId, messageId, parsed });
          await safeReply(replyToken, '住所も名前も拾えなかった…🥲\n住所欄が大きく写るように撮り直して送ってね。');
          continue;
        }

        const timeSlot = extractTimeSlot(parsed.deliverAt || '');

        // ★① 日付違いチェック（2枚目以降）
        const thisDateKey = extractDeliverDateKey(parsed.deliverAt || '');
        if (!st.baseDateKey) {
          if (thisDateKey) st.baseDateKey = thisDateKey;
          logJson('BASE_DATE_SET', { userId, messageId, baseDateKey: st.baseDateKey || '(empty)', thisDateKey: thisDateKey || '(empty)' });
        } else {
          if (thisDateKey && thisDateKey !== st.baseDateKey) {
            logJson('FILTER_DATE_MISMATCH', { userId, messageId, baseDateKey: st.baseDateKey, thisDateKey, deliverAt: parsed.deliverAt || '' });
            await safeReply(replyToken, '前の伝票と日付が違います。');
            continue; // 配達リストに入れない
          }
        }

        const slip = {
          key: buildSlipKey(parsed),
          name,
          address,
          phone: (parsed.phone || '').trim(),
          // slipNo は内部で持ってても良いけど、要件④でカルーセルに出さない
          slipNo: (parsed.slipNo || '').trim(),
          deliverAt: (parsed.deliverAt || '').trim(),
          timeSlot,
          createdAt: Date.now(),
          _dateKey: thisDateKey || '',
        };

        // ==========================
        // ★ バグ退治＆機能追加：二重登録のブロック（Fail Fast）
        // ==========================
        // 1. すでに未配達リストに入っているか？
        const isAlreadyPending = st.slips.some(s => s.key === slip.key);
        if (isAlreadyPending) {
          logJson('FILTER_DUPLICATE_PENDING', { userId, messageId, slipKey: slip.key });
          await safeReply(replyToken, '⚠️ この伝票はすでに「未配達リスト」に登録済みだよ！\n「配達順」と送って確認してみてね。');
          continue; // リストに入れずにここで処理をストップ
        }

        // 2. すでに配達完了（done）になっているか？
        const isAlreadyDone = st.done.has(slip.key);
        if (isAlreadyDone) {
          logJson('FILTER_DUPLICATE_DONE', { userId, messageId, slipKey: slip.key });
          await safeReply(replyToken, '📦✨ この伝票はすでに「配達完了」になっているよ！');
          continue; // リストに入れずにここで処理をストップ
        }
        // ==========================

        // ↓ 元からある行（ここへ到達するのは新規伝票だけになる！）

        st.slips.push(slip);

        logJson('SLIP_ADDED', {
          userId,
          messageId,
          slip: {
            key: slip.key,
            timeSlot: slip.timeSlot,
            name: slip.name,
            address: slip.address,
            phone: slip.phone,
            _dateKey: slip._dateKey,
          },
          total: st.slips.length,
        });

        await safeReply(
          replyToken,
          `登録したよ✅\n` +
          `時間: ${timeSlot || '(不明)'}\n` +
          `名前: ${slip.name || '(不明)'}\n` +
          `住所: ${slip.address || '(不明)'}\n` +
          `TEL: ${slip.phone || '(不明)'}\n\n` +
          `次に「配達順」と送ってね。`
        );
        continue;
      }

      await safeReply(replyToken, 'テキストか伝票画像を送ってね。');
    }
  } catch (e) {
    console.error('Webhook fatal:', e);
  }
});

// ================= helpers ================= → line.js & vision.js

// ================= sorting ================= → sorter.js

// ================= Flex =================　→ flex.js

// ==== health check ====
app.get('/', (_, res) => res.status(200).send('ok'));

const port = Number(PORT) || 8080;
app.listen(port, () => console.log('Listening on', port));