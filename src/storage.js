const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sessionsDir } = require('./config');

// هذا الملف يُستخدم فقط لتخزين إعدادات إضافية (إيموجي التفاعل/تشغيل الحالات)
// بيانات الاعتماد الأساسية للواتساب تُخزن داخل مجلد جلسة Baileys نفسه.
// كل مستخدم تيليجرام له مجلد منفصل داخل data/sessions/<chatId>
const metaFile = path.join(sessionsDir, '_meta.json');

async function readMeta() {
  try {
    const raw = await fsp.readFile(metaFile, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    return {};
  }
}

async function writeMeta(meta) {
  await fsp.writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8');
}

function sessionFolder(chatId) {
  return path.join(sessionsDir, String(chatId));
}

async function ensureSessionFolder(chatId) {
  const dir = sessionFolder(chatId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function getMeta(chatId) {
  const meta = await readMeta();
  return meta[String(chatId)] || null;
}

async function setMeta(chatId, data) {
  const meta = await readMeta();
  const key = String(chatId);
  meta[key] = {
    reactionEmoji: '❤️',
    statusReact: true,
    phoneNumber: null,
    pairedAt: null,
    ...(meta[key] || {}),
    ...data
  };
  await writeMeta(meta);
  return meta[key];
}

async function deleteMeta(chatId) {
  const meta = await readMeta();
  delete meta[String(chatId)];
  await writeMeta(meta);
}

async function listAllLinkedUsers() {
  const meta = await readMeta();
  return Object.entries(meta).map(([chatId, data]) => ({
    chatId,
    ...data
  }));
}

async function removeSessionFolder(chatId) {
  const dir = sessionFolder(chatId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch (err) {
    // تجاهل إذا لم يوجد مجلد
  }
}

module.exports = {
  sessionFolder,
  ensureSessionFolder,
  getMeta,
  setMeta,
  deleteMeta,
  listAllLinkedUsers,
  removeSessionFolder
};
