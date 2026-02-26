// utils/sheets.js
const { google } = require('googleapis');

// ボットの鍵（JSON）を使ってアクセス権を準備
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// スプレッドシートを操作する「リモコン」を作成
const sheets = google.sheets({ version: 'v4', auth });
const spreadsheetId = process.env.SPREADSHEET_ID;

// テスト用：スプレッドシートに文字を書き込んでみる関数
async function testConnection() {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'slips!A1', // slipsシートのA1セルから書き込む
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['連携テスト大成功！', 'NickさんのMacから書き込みました！', new Date().toLocaleString()]]
      }
    });
    console.log('✅ スプレッドシートへの接続テスト大成功！シートを見てみてください！');
  } catch (error) {
    console.error('❌ スプレッドシート接続エラー:', error.message);
  }
}

module.exports = {
  sheets,
  spreadsheetId,
  testConnection
};