// utils/flex.js
'use strict';

// 基準点として使う「すし貴」の住所を環境変数から取得（なければデフォルト値）
const SUSHITAKA_ADDRESS = process.env.SUSHITAKA_ADDRESS || 'すし貴 宮崎';

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
    : `基準: ${SUSHITAKA_ADDRESS}`;

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

  const footerContents = [
    { type: 'button', style: 'primary', action: { type: 'uri', label: 'ナビ（Googleマップ）', uri: mapsUrl } },
  ];

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

// 🐛 【修正済み】GoogleマップのユニバーサルURL（どのスマホでも安定して開く形式）
function buildGoogleMapsUrl(address) {
  const q = encodeURIComponent(String(address || '').trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function toTelUri(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  return `tel:${digits}`;
}

// 外の世界（server.js）に出荷
module.exports = {
  buildDeliveryFlex
};