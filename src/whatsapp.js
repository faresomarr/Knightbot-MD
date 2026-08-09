const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { ensureSessionFolder, getMeta, setMeta } = require('./storage');

// مفتاح ثابت محلي لتشفير Signal key داخل Baileys (لا يخرج من الجهاز)
const NOISE_KEY = Buffer.from('knightbot-md-pairing-secret-v1-key-not-secret-just-static');

const activeSockets = new Map(); // chatId -> sock

function logger() {
  return pino({ level: 'silent' });
}

// ينشئ سوكيت واتساب لمستخدم تيليجرام معيّن ويبدأ عملية الاقتران بالكود
async function startPairing(chatId, phoneNumber) {
  const folder = await ensureSessionFolder(chatId);
  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger())
    },
    logger: logger(),
    printQRInTerminal: false,
    browser: ['Knightbot-MD', 'Chrome', '4.0.0'],
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false
  });

  sock.ev.on('creds.update', saveCreds);

  // نخزّن السوكيت فوراً ليصله messages.upsert في اللحظة المناسبة
  activeSockets.set(chatId, sock);

  // وعد يكمّل عند فتح الاتصال بنجاح أو تعذّر الاقتران
  const pairingResult = await new Promise(async (resolve, reject) => {
    let resolved = false;

    const onUpdate = async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        if (resolved) return;
        resolved = true;
        sock.ev.off('connection.update', onUpdate);
        await setMeta(chatId, {
          phoneNumber,
          pairedAt: new Date().toISOString(),
          status: 'connected'
        });
        // فعّل المستمع للحالات فوراً
        sock.ev.on('messages.upsert', (event) => {
          onMessages(chatId, event, sock).catch(() => {});
        });
        resolve({ ok: true });
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`[wa:${chatId}] closed (statusCode=${reason})`);
        await setMeta(chatId, { status: 'disconnected' });
        if (!resolved) {
          resolved = true;
          sock.ev.off('connection.update', onUpdate);
          // 515 = restart required -> أعد إنشاء السوكيت تلقائياً (سيُحلّ داخلياً)
          if (reason === 515) {
            resolve({ ok: false, restart: true, reason });
          } else {
            resolve({ ok: false, reason });
          }
        } else {
          // بعد الاقتران، أغلق بهدوء وأعد الاتصال إن لزم
          activeSockets.delete(chatId);
          if (reason === 515) {
            setTimeout(() => startPairing(chatId, phoneNumber).catch(() => {}), 1000);
          }
        }
      }
    };

    sock.ev.on('connection.update', onUpdate);

    // أعطِ السوكيت لحظة لتهيئة المصادقة
    setTimeout(async () => {
      try {
        if (sock.authState?.creds?.registered) {
          if (!resolved) {
            resolved = true;
            sock.ev.off('connection.update', onUpdate);
            resolve({ ok: true, alreadyRegistered: true });
          }
          return;
        }
        const code = await sock.requestPairingCode(phoneNumber);
        if (resolved) return;
        resolved = true;
        sock.ev.off('connection.update', onUpdate);
        resolve({ ok: true, code });
      } catch (err) {
        if (resolved) return;
        resolved = true;
        sock.ev.off('connection.update', onUpdate);
        reject(err);
      }
    }, 1200);
  });

  return { sock, result: pairingResult };
}

// مراقبة الحالات على status@broadcast و تفاعل تلقائي عليها
async function onMessages(chatId, event, sock) {
  let meta;
  try { meta = await getMeta(chatId); } catch { return; }
  if (!meta) return;

  const messages = event.messages || [];
  for (const msg of messages) {
    const isStatus =
      msg.key?.remoteJid === 'status@broadcast' ||
      msg.message?.protocolMessage?.type === 5; // 5 = STATUS@BROADCAST
    if (!isStatus) continue;

    // تفاعل تلقائي فقط إذا كان مفعّلاً ضمن إعدادات المستخدم
    if (meta.statusReact && meta.reactionEmoji && msg.key?.id && msg.key?.participant) {
      try {
        await sock.sendMessage('status@broadcast', {
          react: {
            text: meta.reactionEmoji,
            key: msg.key
          }
        });
      } catch (err) {
        // بصمت: خطأ التفاعل لا يوقف بقية العمل
      }
    }
  }
}

function getSocket(chatId) {
  return activeSockets.get(chatId) || null;
}

async function logout(chatId) {
  const sock = activeSockets.get(chatId);
  if (sock) {
    try { await sock.logout(); } catch (e) { /* قد يكون مغلقاً بالفعل */ }
  }
  activeSockets.delete(chatId);
}

module.exports = { startPairing, getSocket, logout, activeSockets };
