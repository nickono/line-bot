// utils/sorter.js
'use strict';

const axios = require('axios'); // 距離計算のAPI通信に必要

// すし貴の座標（ハードコード）
const SUSHITAKA_LAT = 31.93130;
const SUSHITAKA_LNG = 131.41403;

// ================= sorting =================

async function decideBasePointForSorting(st) {
  const { USE_LIVE_LOCATION, SUSHITAKA_ADDRESS } = process.env;
  const useLive = String(USE_LIVE_LOCATION || '') === '1';
  if (useLive && st.lastLocation && isFreshLocation(st.lastLocation)) {
    return { type: 'live', ...st.lastLocation };
  }
  return {
    type: 'sushitaka',
    address: SUSHITAKA_ADDRESS || 'すし貴 宮崎',
    lat: SUSHITAKA_LAT,
    lng: SUSHITAKA_LNG,
  };
}

function isFreshLocation(loc) {
  const now = Date.now();
  return loc && (now - (loc.updatedAt || 0) < 1000 * 60 * 30);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 全スリップのジオコーディングをまとめて行う
async function geocodeAllSlips(slips) {
  const results = [];
  for (const s of slips) {
    const addr = (s.address || '').trim();
    let lat = null, lng = null;
    if (addr) {
      const coords = await geocodeNominatim(addr);
      if (coords) { lat = coords.lat; lng = coords.lng; }
      await sleep(300); // レート制限対策
    }
    results.push({ ...s, _lat: lat, _lng: lng, _distText: '', _distValue: null, _durationText: '' });
  }
  return results;
}

// 時間枠番号でグループ化
function groupBySlotNumber(slips) {
  const m = {};
  for (const s of slips) {
    const k = slotToNumber(s.timeSlot || '99:99-99:99');
    if (!m[k]) m[k] = [];
    m[k].push(s);
  }
  return m;
}

async function sortSlips(slips, basePoint) {
  // ① 全スリップのジオコーディング（一括）
  const geocoded = await geocodeAllSlips(slips);

  // ② 時間枠でグループ化
  const groups = groupBySlotNumber(geocoded);
  const slotNumbers = Object.keys(groups).map(Number).sort((a, b) => a - b);

  // ③ 起点の初期値はすし貴
  let currentLat = basePoint?.lat ?? SUSHITAKA_LAT;
  let currentLng = basePoint?.lng ?? SUSHITAKA_LNG;

  const ordered = [];

  for (const num of slotNumbers) {
    let remaining = [...groups[num]];

    while (remaining.length > 0) {
      // 現在の起点から各配達先までのハーバーサイン距離を計算
      // _lat/_lng が取得できなかったものは最後尾に回す
      remaining.forEach(s => {
        s._distValue = (s._lat != null && s._lng != null)
          ? haversineMeters(currentLat, currentLng, s._lat, s._lng)
          : 1e15;
      });

      // 最近の1件を選ぶ
      remaining.sort((a, b) => a._distValue - b._distValue);
      const nearest = remaining[0];
      ordered.push(nearest);

      // 起点を更新
      if (nearest._lat != null && nearest._lng != null) {
        currentLat = nearest._lat;
        currentLng = nearest._lng;
      }

      // 選んだ1件を remaining から除外
      remaining = remaining.slice(1);
    }
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

// ハーバーサイン距離（メートル）
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nominatim でジオコーディング
async function geocodeNominatim(address) {
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: address, format: 'json', limit: 1, countrycodes: 'jp' },
      timeout: 8000,
      headers: { 'User-Agent': 'sushitaka-linebot/1.0' },
    });
    const hit = res.data?.[0];
    if (hit && hit.lat && hit.lon) {
      return { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) };
    }
  } catch (e) {
    // silent
  }
  return null;
}

// optional: Distance Matrix（あれば精度UP）、未設定時は Nominatim + ハーバーサイン
// sortSlips からは呼ばれなくなったが念のため残す
/*
async function attachDistance(slips, basePoint) {
  const { GOOGLE_MAPS_API_KEY } = process.env;

  // --- Google Maps Distance Matrix ---
  if (GOOGLE_MAPS_API_KEY) {
    const origins = buildOriginParam(basePoint);
    const destinations = slips.map(s => (s.address || '').trim()).filter(Boolean);

    if (origins && destinations.length) {
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
      }
    }
  }

  // --- フォールバック: Nominatim + ハーバーサイン ---
  const baseLat = basePoint?.lat ?? SUSHITAKA_LAT;
  const baseLng = basePoint?.lng ?? SUSHITAKA_LNG;

  const results = await Promise.all(
    slips.map(async s => {
      const addr = (s.address || '').trim();
      if (!addr) return { ...s, _distText: '', _distValue: null, _durationText: '' };
      const geo = await geocodeNominatim(addr);
      if (!geo) return { ...s, _distText: '', _distValue: null, _durationText: '' };
      const meters = haversineMeters(baseLat, baseLng, geo.lat, geo.lng);
      const km = (meters / 1000).toFixed(1);
      return { ...s, _distText: `${km} km`, _distValue: Math.round(meters), _durationText: '' };
    })
  );
  return results;
}
*/

function buildOriginParam(basePoint) {
  if (!basePoint) return '';
  // lat/lng があれば座標文字列を優先
  if (isFinite(basePoint.lat) && isFinite(basePoint.lng)) {
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
  sortSlips,
};
