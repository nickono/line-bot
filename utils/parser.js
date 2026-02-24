const crypto = require('crypto');

// ================= OCR parse (改行に強く) =================

function parseSlip(ocrText) {
  const text = normalize(ocrText);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ラベルの直後が改行でも拾う（次のラベルまで吸収）
  const nameRaw = extractMultilineField(lines, /^お名前\s*[:：]?\s*(.*)$/);
  const addrRaw = extractMultilineField(lines, /^(ご住所|住所)\s*[:：]?\s*(.*)$/);
  const phoneRaw = extractMultilineField(lines, /^お電話\s*[:：]?\s*(.*)$/);
  const deliverRaw = extractMultilineField(lines, /^お届日\s*[:：]?\s*(.*)$/);
  const slipNoRaw = extractMultilineField(lines, /^伝票番号\s*[:：]?\s*(.*)$/);

  const name = formatCustomerName(nameRaw);
  const phone = normalizePhone(phoneRaw);
  const address = cleanJoin(addrRaw);
  const deliverAt = cleanJoin(deliverRaw);
  const slipNo = cleanJoin(slipNoRaw);

  return {
    name,
    address,
    phone,
    deliverAt,
    slipNo,
  };
}

function normalize(s) {
  return String(s || '')
    .replace(/\r/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[：]/g, ':')
    .trim();
}

function cleanJoin(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ★判定用の軽い正規化（テイク検出など）
function normalizeForJudge(s) {
  return String(s || '')
    .replace(/\r/g, '\n')
    .replace(/[ 　]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

// 次の項目ラベルが出るまで連結
function extractMultilineField(lines, headRegex) {
  // 伝票に出やすい “次ラベル” を止め条件に
  const stopRegex = /^(ご住所|住所|ビル名|品名|品目|個数|お電話|お買上げ金額|配達備考|調理備考|地図コード|伝票番号|お届日|受付)\s*[:：]?/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headRegex);
    if (!m) continue;

    const parts = [];
    const first = (m[2] ?? m[1] ?? '').trim(); // regex次第でグループ位置が変わるので両対応
    if (first) parts.push(first);

    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (stopRegex.test(l)) break;
      if (/^(R$|TT$|=+)$/.test(l)) continue;
      parts.push(l);
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function formatCustomerName(nameRaw) {
  let n = (nameRaw || '').trim();
  if (!n) return '';
  if (/御中$/.test(n)) return n;
  if (/様$/.test(n)) return n;
  if (/社$/.test(n)) return `${n}様`;
  return `${n}様`;
}

function normalizePhone(raw) {
  let s = cleanJoin(raw);
  if (!s) return '';
  s = s.replace(/[^\d\-]/g, '');
  return s;
}

// ================= date key =================

// ★お届日から日付キーを取り出す（YYYY-MM-DD or MM-DD）
// 取れないときは ''（→日付違い判定をしない）
function extractDeliverDateKey(deliverAtText) {
  const s = String(deliverAtText || '')
    .replace(/[ 　]+/g, ' ')
    .trim();

  // 例）2026年02月07日
  let m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const y = m[1];
    const mm = String(m[2]).padStart(2, '0');
    const dd = String(m[3]).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  // 例）2026/02/07 or 2026-02-07
  m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mm = String(m[2]).padStart(2, '0');
    const dd = String(m[3]).padStart(2, '0');
    return `${y}-${mm}-${dd}`;
  }

  // 例）02月07日（年が落ちる場合の保険：MM-DD）
  m = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) {
    const mm = String(m[1]).padStart(2, '0');
    const dd = String(m[2]).padStart(2, '0');
    return `${mm}-${dd}`;
  }

  return '';
}

// ================= time slot =================

function extractTimeSlot(deliverAtText) {
  // お届日行は "2026年02月07日 (土) 10:30~11:30" や "… 10:30" 等が来る想定
  const s0 = String(deliverAtText || '');

  // 区切りの揺れを軽く吸収（全角チルダ/波ダッシュ/長音/ダッシュなど）
  const s = s0
    .replace(/～/g, '~')
    .replace(/−|—|ー/g, '-') // マイナス/ダッシュ/長音の混同対策
    .replace(/[ 　]+/g, ' ')
    .trim();

  // ① 10:30~11:30 / 10:30〜11:30 / 10:30-11:30
  const m = s.match(/(\d{1,2}:\d{2})\s*([~\-])\s*(\d{1,2}:\d{2})/);
  if (m) return `${padHm(m[1])}-${padHm(m[3])}`;

  // ② 10時30分〜11時30分
  const m2 = s.match(/(\d{1,2})\s*時\s*(\d{1,2})\s*分?\s*[~\-]\s*(\d{1,2})\s*時\s*(\d{1,2})\s*分?/);
  if (m2) {
    const a = `${String(m2[1]).padStart(2, '0')}:${String(m2[2]).padStart(2, '0')}`;
    const b = `${String(m2[3]).padStart(2, '0')}:${String(m2[4]).padStart(2, '0')}`;
    return `${a}-${b}`;
  }

  // ③ 片側だけ（10:30~）
  const m3 = s.match(/(\d{1,2}:\d{2})\s*[~\-]\s*$/);
  if (m3) return `${padHm(m3[1])}(指定)`;

  // ④ 時刻指定のみ（10:30）
  const m4 = s.match(/(?:^|\D)(\d{1,2}:\d{2})(?:\D|$)/);
  if (m4) return `${padHm(m4[1])}(指定)`;

  // ⑤ 時刻指定のみ（10時30分）
  const m5 = s.match(/(\d{1,2})\s*時\s*(\d{1,2})\s*分/);
  if (m5) {
    const a = `${String(m5[1]).padStart(2, '0')}:${String(m5[2]).padStart(2, '0')}`;
    return `${a}(指定)`;
  }

  // ⑥ 17時-18時（分なし枠）
  const m6 = s.match(/(\d{1,2})\s*時\s*[~\-]\s*(\d{1,2})\s*時/);
  if (m6) {
    const a = `${String(m6[1]).padStart(2, '0')}:00`;
    const b = `${String(m6[2]).padStart(2, '0')}:00`;
    return `${a}-${b}`;
  }

  return '';
}

function padHm(hm) {
  const [h, m] = String(hm).split(':');
  return `${String(h).padStart(2, '0')}:${String(m || '00').padStart(2, '0')}`;
}

// ================= key =================

function buildSlipKey(parsed) {
  const seed = `${parsed.slipNo || ''}|${parsed.address || ''}|${parsed.name || ''}|${parsed.deliverAt || ''}`.slice(0, 500);
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

module.exports = {
parseSlip,
normalizeForJudge,
extractDeliverDateKey,
extractTimeSlot,
buildSlipKey
};