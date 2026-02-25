// utils/vision.js
'use strict';

const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient();

async function ocrWithVision(buf) {
  try {
    const [r] = await visionClient.textDetection({ image: { content: buf } });
    return r.textAnnotations?.[0]?.description || '';
  } catch (e) {
    console.error('Vision OCR error:', e?.message || e);
    return '';
  }
}

module.exports = {
  ocrWithVision
};