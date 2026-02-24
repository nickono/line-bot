'use strict';

console.log("BOOT VERSION: 2026-02-22-OCR-FILTER-DATE-TAKE-NOADDR-NOSLIPNO-FLEX-DONE-B-SINGLETIME-LOGJSON");

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const line = require('@line/bot-sdk');
const vision = require('@google-cloud/vision');

const app = express();

const {
  parseSlip,
  normalizeForJudge,
  extractDeliverDateKey,
  extractTimeSlot,
  buildSlipKey
} = require('./utils/parser');

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

const lineClient = new line.Client({ channelAccessToken: LINE_ACCESS_TOKEN });
const visionClient = new vision.ImageAnnotatorClient();

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

// ================= helpers =================

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

async function ocrWithVision(buf) {
  try {
    const [r] = await visionClient.textDetection({ image: { content: buf } });
    return r.textAnnotations?.[0]?.description || '';
  } catch (e) {
    console.error('Vision OCR error:', e?.message || e);
    return '';
  }
}

// ================= sorting =================

async function decideBasePointForSorting(st) {
  const useLive = String(USE_LIVE_LOCATION || '') === '1';
  if (useLive && st.lastLocation && isFreshLocation(st.lastLocation)) {
    return { type: 'live', ...st.lastLocation };
  }
  return { type: 'sushitaka', address: SUSHITAKA_ADDRESS || 'すし貴 宮崎' };
}

function isFreshLocation(loc) {
  const now = Date.now();
  return loc && (now - (loc.updatedAt || 0) < 1000 * 60 * 30);
}

async function sortSlips(slips, basePoint) {
  // ① 時間枠順（不明は最後）
  const groups = groupBy(slips, s => s.timeSlot || '99:99-99:99');
  const slotKeys = Object.keys(groups).sort((a, b) => slotToNumber(a) - slotToNumber(b));

  const ordered = [];
  for (const slot of slotKeys) {
    const arr = groups[slot];

    // ② 同じ時間枠内：APIキーがある場合は距離順、無ければ登録順
    const arrWithDist = await attachDistance(arr, basePoint);
    arrWithDist.sort((x, y) => (x._distValue ?? 1e15) - (y._distValue ?? 1e15));
    ordered.push(...arrWithDist);
  }
  return ordered;
}

function slotToNumber(slot) {
  // "10:30-11:30" も "10:30(指定)" も先頭のHH:MMでソートできる
  const m = String(slot || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return 999999;
  return Number(m[1]) * 100 + Number(m[2]);
}

function groupBy(arr, keyFn) {
  const m = {};
  for (const x of arr) {
    const k = keyFn(x);
    if (!m[k]) m[k] = [];
    m[k].push(x);
  }
  return m;
}

// optional: Distance Matrix（あれば精度UP）
async function attachDistance(slips, basePoint) {
  if (!GOOGLE_MAPS_API_KEY) {
    return slips.map(s => ({ ...s, _distText: '', _distValue: null, _durationText: '' }));
  }

  const origins = buildOriginParam(basePoint);
  const destinations = slips.map(s => (s.address || '').trim()).filter(Boolean);

  if (!origins || !destinations.length) {
    return slips.map(s => ({ ...s, _distText: '', _distValue: null, _durationText: '' }));
  }

  try {
    const url = 'https://maps.googleapis.com/maps/api/distancematrix/json';
    const res = await axios.get(url, {
      params: {
        origins,
        destinations: destinations.join('|'),
        key: GOOGLE_MAPS_API_KEY,
        language: 'ja',
        region: 'jp',
      },
      timeout: 20000,
    });

    const els = res.data?.rows?.[0]?.elements || [];
    const mapByAddr = new Map();

    for (let i = 0; i < destinations.length; i++) {
      const el = els[i];
      if (el?.status === 'OK') {
        mapByAddr.set(destinations[i], {
          text: el.distance?.text || '',
          value: el.distance?.value ?? null,
          durationText: el.duration?.text || '',
        });
      }
    }

    return slips.map(s => {
      const addr = (s.address || '').trim();
      const d = mapByAddr.get(addr);
      return {
        ...s,
        _distText: d ? d.text : '',
        _distValue: d ? d.value : null,
        _durationText: d ? d.durationText : '',
      };
    });
  } catch (e) {
    console.error('Distance Matrix error:', e?.message || e);
    return slips.map(s => ({ ...s, _distText: '', _distValue: null, _durationText: '' }));
  }
}

function buildOriginParam(basePoint) {
  if (!basePoint) return '';
  if (basePoint.type === 'live' && isFinite(basePoint.lat) && isFinite(basePoint.lng)) {
    return `${basePoint.lat},${basePoint.lng}`;
  }
  if (basePoint.type === 'sushitaka' && basePoint.address) {
    return basePoint.address;
  }
  return '';
}

// ================= Flex =================

function buildDeliveryFlex(slips, basePoint) {
  const title = basePoint?.type === 'live' ? '配達順（現在地基準）' : '配達順（すし貴基準）';
  const bubbles = slips.slice(0, 9).map((s, i) => buildSlipBubble(s, i + 1));

  return {
    type: 'carousel',
    contents: [
      buildSummaryBubble(title, slips, basePoint),
      ...bubbles,
    ].slice(0, 10),
  };
}

function buildSummaryBubble(title, slips, basePoint) {
  const baseLine = basePoint?.type === 'live'
    ? `基準: 現在地 (${basePoint.lat?.toFixed(4)}, ${basePoint.lng?.toFixed(4)})`
    : `基準: ${SUSHITAKA_ADDRESS || 'すし貴'}`;

  const slots = [...new Set(slips.map(s => s.timeSlot || '(不明)'))].slice(0, 6).join(' / ');

  return {
    type: 'bubble',
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      contents: [
        { type: 'text', text: title, weight: 'bold', size: 'lg', wrap: true },
        { type: 'text', text: `未配達: ${slips.length}件`, size: 'sm', color: '#666666' },
        { type: 'text', text: baseLine, size: 'sm', color: '#666666', wrap: true },
        { type: 'text', text: `時間: ${slots}`, size: 'sm', color: '#666666', wrap: true },
        { type: 'separator' },
        { type: 'text', text: '・ナビ→地図\n・完了→配達済みにして更新', size: 'sm', wrap: true },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', action: { type: 'postback', label: '一覧を再表示', data: 'list' } },
        { type: 'button', style: 'secondary', action: { type: 'postback', label: 'リセット', data: 'reset' } },
      ],
    },
  };
}

function buildSlipBubble(s, indexNo) {
  const timeLine = s.timeSlot ? `⏰ ${s.timeSlot}` : '⏰ (時間枠不明)';
  const nameLine = s.name || '(名前不明)';
  const addrLine = s.address || '(住所不明)';

  const mapsUrl = buildGoogleMapsUrl(addrLine);

  const body = [
    { type: 'text', text: `${indexNo}. ${timeLine}`, weight: 'bold', size: 'md', wrap: true },
    { type: 'text', text: nameLine, size: 'md', wrap: true },
    { type: 'text', text: addrLine, size: 'sm', color: '#555555', wrap: true },
  ];

  if (s._distText) {
    body.push({
      type: 'text',
      text: `距離: ${s._distText}${s._durationText ? ` / ${s._durationText}` : ''}`,
      size: 'sm',
      color: '#555555',
      wrap: true,
    });
  }

  if (s.phone) {
    body.push({ type: 'text', text: `TEL: ${s.phone}`, size: 'sm', color: '#555555', wrap: true });
  } else {
    body.push({ type: 'text', text: 'TEL: (不明)', size: 'sm', color: '#555555', wrap: true });
  }

  // ★④ 伝票番号はカルーセルに含めない（もともとの表示ブロックは入れない）

  const footerContents = [
    { type: 'button', style: 'primary', action: { type: 'uri', label: 'ナビ（Googleマップ）', uri: mapsUrl } },
  ];

  // タップ発信（数字だけ抽出してtel:へ）
  const tel = toTelUri(s.phone);
  if (tel) {
    footerContents.push({
      type: 'button',
      style: 'secondary',
      action: { type: 'uri', label: '電話する', uri: tel },
    });
  }

  footerContents.push({
    type: 'button',
    style: 'secondary',
    action: { type: 'postback', label: 'この配達を完了', data: `done:${s.key}` },
  });

  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerContents },
  };
}

function buildGoogleMapsUrl(address) {
  const q = encodeURIComponent(String(address || '').trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function toTelUri(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return `tel:${digits}`;
}

// ==== health check ====
app.get('/', (_, res) => res.status(200).send('ok'));

const port = Number(PORT) || 8080;
app.listen(port, () => console.log('Listening on', port));