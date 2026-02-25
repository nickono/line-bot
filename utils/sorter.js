// utils/sorter.js
'use strict';

const axios = require('axios'); // 距離計算のAPI通信に必要

// ================= sorting =================

async function decideBasePointForSorting(st) {
  const { USE_LIVE_LOCATION, SUSHITAKA_ADDRESS } = process.env;
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
  const { GOOGLE_MAPS_API_KEY } = process.env;
  
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

// 外の世界（server.js）に出荷
module.exports = {
  decideBasePointForSorting,
  sortSlips
};