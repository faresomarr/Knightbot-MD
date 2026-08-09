const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const dataFile = path.join(dataDir, 'users.json');

function ensureStorage() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ users: {} }, null, 2), 'utf8');
  }
}

function readDb() {
  ensureStorage();
  const raw = fs.readFileSync(dataFile, 'utf8');
  return JSON.parse(raw || '{"users":{}}');
}

function writeDb(db) {
  ensureStorage();
  fs.writeFileSync(dataFile, JSON.stringify(db, null, 2), 'utf8');
}

function getUser(telegramId) {
  const db = readDb();
  return db.users[String(telegramId)] || null;
}

function saveUser(telegramId, payload) {
  const db = readDb();
  const key = String(telegramId);
  const previous = db.users[key] || {};

  db.users[key] = {
    telegramId: Number(telegramId),
    reactionEmoji: '❤️',
    autoReact: false,
    notifyIncoming: true,
    notifyStatuses: true,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...previous,
    ...payload
  };

  writeDb(db);
  return db.users[key];
}

function removeUser(telegramId) {
  const db = readDb();
  delete db.users[String(telegramId)];
  writeDb(db);
}

function findUserByPhoneNumberId(phoneNumberId) {
  const db = readDb();
  return Object.values(db.users).find(
    (user) => String(user.phoneNumberId || '') === String(phoneNumberId || '')
  ) || null;
}

function findUserByVerifyToken(verifyToken) {
  const db = readDb();
  return Object.values(db.users).find(
    (user) => String(user.verifyToken || '') === String(verifyToken || '')
  ) || null;
}

module.exports = {
  getUser,
  saveUser,
  removeUser,
  findUserByPhoneNumberId,
  findUserByVerifyToken
};
