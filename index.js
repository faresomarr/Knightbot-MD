import 'dotenv/config';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import P from 'pino';
import TelegramBot from 'node-telegram-bot-api';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

const APP_NAME = 'Telegram x WhatsApp Hub';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const DEFAULT_EMOJI = process.env.DEFAULT_EMOJI || '❤️';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = Number(process.env.PORT || 3000);

if (!TELEGRAM_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN in environment.');
  process.exit(1);
}

const logger = P({ level: LOG_LEVEL });

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

function formatPhone(raw) {
  return `+${String(raw || '').replace(/\D/g, '')}`;
}

function getTextFromMessage(message) {
  const msg = message?.message || {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.templateButtonReplyMessage?.selectedId ||
    ''
  ).trim();
}

function sanitizeEmoji(input) {
  return String(input || '').trim().slice(0, 8) || DEFAULT_EMOJI;
}

function sessionBadge(session) {
  const statusMap = {
    connected: '🟢',
    connecting: '🟡',
    disconnected: '🔴',
    logged_out: '⚫️',
    pairing_code_sent: '🟣',
  };
  return statusMap[session.status] || '⚪️';
}

function statusLabel(session) {
  const labels = {
    connected: 'متصل',
    connecting: 'جاري الاتصال',
    disconnected: 'مفصول',
    logged_out: 'تسجيل خروج',
    pairing_code_sent: 'تم إرسال الكود',
  };
  return labels[session.status] || 'غير معروف';
}

async function safeUnlink(target) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ err: error, target }, 'Failed to remove path');
  }
}

class JsonStore {
  constructor(file) {
    this.file = file;
    this.data = {
      sessions: {},
      users: {},
    };
  }

  async init() {
    await ensureDir(path.dirname(this.file));
    await ensureDir(SESSIONS_DIR);
    if (await pathExists(this.file)) {
      try {
        const raw = await fsp.readFile(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.data.sessions = parsed.sessions || {};
        this.data.users = parsed.users || {};
      } catch (error) {
        logger.warn({ err: error }, 'Store file invalid, rebuilding');
        await this.flush();
      }
    } else {
      await this.flush();
    }
  }

  async flush() {
    await ensureDir(path.dirname(this.file));
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }

  listSessions() {
    return Object.values(this.data.sessions).sort((a, b) => {
      return (b.updatedAt || '').localeCompare(a.updatedAt || '');
    });
  }

  listSessionsByTelegramId(telegramId) {
    return this.listSessions().filter((session) => String(session.ownerTelegramId || '') === String(telegramId));
  }

  getSession(phone) {
    return this.data.sessions[phone] || null;
  }

  findSessionByOwnerWaJid(ownerWaJid) {
    return this.listSessions().find((session) => session.ownerWaJid === ownerWaJid) || null;
  }

  findSessionByAnyOwnerMatch(ownerWaJid, ownerTelegramId) {
    return (
      this.listSessions().find((session) => {
        if (ownerWaJid && session.ownerWaJid === ownerWaJid) return true;
        if (ownerTelegramId && String(session.ownerTelegramId || '') === String(ownerTelegramId)) return true;
        return false;
      }) || null
    );
  }

  async upsertSession(phone, patch) {
    const current = this.getSession(phone) || {
      id: phone,
      phone,
      displayPhone: formatPhone(phone),
      ownerTelegramId: null,
      ownerWaJid: null,
      emoji: DEFAULT_EMOJI,
      autoReactStatus: true,
      status: 'disconnected',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    const next = {
      ...current,
      ...patch,
      phone,
      displayPhone: formatPhone(phone),
      updatedAt: nowIso(),
    };

    this.data.sessions[phone] = next;

    if (next.ownerTelegramId) {
      const userKey = String(next.ownerTelegramId);
      this.data.users[userKey] = this.data.users[userKey] || {
        telegramId: String(next.ownerTelegramId),
        createdAt: nowIso(),
      };
      this.data.users[userKey].updatedAt = nowIso();
    }

    await this.flush();
    return next;
  }

  async deleteSession(phone) {
    delete this.data.sessions[phone];
    await this.flush();
  }
}

class SessionManager {
  constructor({ store, telegramBot }) {
    this.store = store;
    this.telegramBot = telegramBot;
    this.sockets = new Map();
    this.runtime = new Map();
  }

  getAuthDir(phone) {
    return path.join(SESSIONS_DIR, phone);
  }

  async bootExistingSessions() {
    const sessions = this.store.listSessions();
    for (const session of sessions) {
      const authDir = this.getAuthDir(session.phone);
      if (await pathExists(authDir)) {
        await this.startOrResumeSession({
          phone: session.phone,
          ownerTelegramId: session.ownerTelegramId,
          ownerWaJid: session.ownerWaJid,
          source: null,
          reconnecting: true,
        });
      }
    }
  }

  async startOrResumeSession({ phone, ownerTelegramId = null, ownerWaJid = null, source = null, reconnecting = false }) {
    phone = normalizePhone(phone);
    if (!phone) throw new Error('رقم الهاتف غير صالح. استخدم صيغة دولية مثل 9665xxxxxxx');

    const existing = this.store.getSession(phone);
    const session = await this.store.upsertSession(phone, {
      ownerTelegramId: ownerTelegramId ?? existing?.ownerTelegramId ?? null,
      ownerWaJid: ownerWaJid ?? existing?.ownerWaJid ?? null,
      emoji: existing?.emoji || DEFAULT_EMOJI,
      autoReactStatus: typeof existing?.autoReactStatus === 'boolean' ? existing.autoReactStatus : true,
      status: reconnecting ? existing?.status || 'disconnected' : 'connecting',
    });

    if (this.sockets.has(phone)) {
      return session;
    }

    await this.connectSocket(session, source);
    return session;
  }

  async connectSocket(session, source) {
    const phone = session.phone;
    const authDir = this.getAuthDir(phone);
    await ensureDir(authDir);

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const sock = makeWASocket({
      logger: P({ level: 'silent' }),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' })),
      },
      browser: Browsers.macOS(APP_NAME),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      shouldIgnoreJid: () => false,
      defaultQueryTimeoutMs: 60_000,
      getMessage: async () => undefined,
    });

    this.sockets.set(phone, sock);
    this.runtime.set(phone, {
      saveCreds,
      source,
      pairingRequested: false,
      seenStatusKeys: new Set(),
      reconnectTimer: null,
    });

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        logger.error({ err: error, phone }, 'Failed to save creds');
      }
    });

    sock.ev.on('connection.update', async (update) => {
      await this.handleConnectionUpdate(phone, state, update);
    });

    sock.ev.on('messages.upsert', async (payload) => {
      await this.handleMessages(phone, payload);
    });
  }

  async handleConnectionUpdate(phone, state, update) {
    const rt = this.runtime.get(phone);
    const sock = this.sockets.get(phone);
    const session = this.store.getSession(phone);
    if (!rt || !sock || !session) return;

    const { connection, lastDisconnect, qr } = update;

    if (!state.creds.registered && (connection === 'connecting' || !!qr) && !rt.pairingRequested) {
      rt.pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(phone);
        await this.store.upsertSession(phone, { status: 'pairing_code_sent' });
        await this.deliverPairingCode(phone, code, rt.source);
      } catch (error) {
        rt.pairingRequested = false;
        logger.error({ err: error, phone }, 'Failed to request pairing code');
        await this.notifyOwner(session, `❌ تعذر استخراج كود الاقتران للرقم ${session.displayPhone}\nسبب الخطأ: ${error.message}`);
      }
    }

    if (connection === 'open') {
      const userJid = jidNormalizedUser(sock.user?.id || `${phone}@s.whatsapp.net`);
      const updated = await this.store.upsertSession(phone, {
        status: 'connected',
        ownerWaJid: userJid,
        lastConnectedAt: nowIso(),
      });

      logger.info({ phone, ownerWaJid: userJid }, 'WhatsApp connected');
      await this.notifyOwner(updated, `✅ تم ربط الرقم ${updated.displayPhone} بنجاح\n🎯 إيموجي التفاعل الحالي: ${updated.emoji}\n⚙️ تفاعل الحالات التلقائي: ${updated.autoReactStatus ? 'مفعل' : 'موقف'}`);
      return;
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;

      await this.store.upsertSession(phone, {
        status: shouldReconnect ? 'disconnected' : 'logged_out',
        lastDisconnectAt: nowIso(),
      });

      this.sockets.delete(phone);
      this.runtime.delete(phone);

      if (!shouldReconnect) {
        logger.warn({ phone }, 'WhatsApp session logged out');
        await this.notifyOwner(this.store.getSession(phone), `⚠️ تم تسجيل خروج الجلسة ${session.displayPhone}.\nأعد الربط بالأمر /link ${phone} من تيليجرام أو .pair ${phone} من واتس.`);
        await safeUnlink(this.getAuthDir(phone));
        return;
      }

      logger.warn({ phone, reasonCode: code }, 'WhatsApp disconnected, reconnecting');
      await this.store.upsertSession(phone, { status: 'connecting' });
      setTimeout(async () => {
        const latest = this.store.getSession(phone);
        if (!latest || this.sockets.has(phone)) return;
        await this.connectSocket(latest, null);
      }, 3_000);
    }
  }

  async deliverPairingCode(phone, code, source) {
    const session = this.store.getSession(phone);
    const message = [
      `🔐 *كود اقتران واتساب*`,
      `📱 الرقم: ${session?.displayPhone || formatPhone(phone)}`,
      `🧩 الكود: *${code}*`,
      '',
      'افتح واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف ثم أدخل الكود.',
    ].join('\n');

    if (!source) {
      await this.notifyOwner(session, message.replace(/\*/g, ''));
      return;
    }

    if (source.type === 'telegram' && source.chatId) {
      await this.telegramBot.sendMessage(source.chatId, message, { parse_mode: 'Markdown' });
      return;
    }

    if (source.type === 'whatsapp' && source.gatewayPhone && source.chatJid) {
      const gatewaySock = this.sockets.get(source.gatewayPhone);
      if (gatewaySock) {
        await gatewaySock.sendMessage(source.chatJid, { text: message.replace(/\*/g, '') }, source.quote ? { quoted: source.quote } : {});
        return;
      }
    }

    await this.notifyOwner(session, message.replace(/\*/g, ''));
  }

  async notifyOwner(session, text) {
    if (!session) return;
    if (session.ownerTelegramId) {
      try {
        await this.telegramBot.sendMessage(session.ownerTelegramId, text);
      } catch (error) {
        logger.warn({ err: error, session: session.phone }, 'Telegram owner notify failed');
      }
    }
  }

  isStatusMessage(msg) {
    return msg?.key?.remoteJid === 'status@broadcast';
  }

  async handleMessages(phone, payload) {
    const sock = this.sockets.get(phone);
    const session = this.store.getSession(phone);
    const rt = this.runtime.get(phone);
    if (!sock || !session || !rt) return;

    for (const msg of payload.messages || []) {
      if (!msg?.message) continue;

      if (this.isStatusMessage(msg)) {
        await this.handleIncomingStatus(phone, msg);
        continue;
      }

      const text = getTextFromMessage(msg);
      if (!text) continue;
      if (!(text.startsWith('.') || text.startsWith('/'))) continue;

      await this.handleWhatsAppCommand(phone, msg, text);
    }
  }

  async handleIncomingStatus(phone, msg) {
    const session = this.store.getSession(phone);
    const sock = this.sockets.get(phone);
    const rt = this.runtime.get(phone);
    if (!session?.autoReactStatus || !sock || !rt) return;

    const uniqueKey = `${msg.key?.id || 'no-id'}:${msg.key?.participant || msg.participant || 'unknown'}`;
    if (rt.seenStatusKeys.has(uniqueKey)) return;
    rt.seenStatusKeys.add(uniqueKey);
    if (rt.seenStatusKeys.size > 5000) {
      rt.seenStatusKeys = new Set(Array.from(rt.seenStatusKeys).slice(-2000));
      this.runtime.set(phone, rt);
    }

    const participant = msg.key?.participant || msg.participant;
    const me = session.ownerWaJid;
    if (!participant || participant === me) return;

    try {
      await sock.readMessages([msg.key]);
    } catch (error) {
      logger.debug({ err: error, phone }, 'Failed to mark status as read');
    }

    try {
      await sock.sendMessage(
        'status@broadcast',
        {
          react: {
            text: session.emoji || DEFAULT_EMOJI,
            key: msg.key,
          },
        },
        {
          broadcast: true,
          statusJidList: [participant],
        }
      );
      logger.debug({ phone, participant, emoji: session.emoji }, 'Status reaction sent');
    } catch (error) {
      logger.warn({ err: error, phone, participant }, 'Status reaction failed');
    }
  }

  async handleWhatsAppCommand(phone, msg, rawText) {
    const sock = this.sockets.get(phone);
    const gatewaySession = this.store.getSession(phone);
    if (!sock || !gatewaySession) return;

    const text = rawText.trim();
    const parts = text.split(/\s+/);
    const command = parts[0].replace(/^[./]/, '').toLowerCase();
    const args = parts.slice(1);

    const remoteJid = msg.key?.remoteJid;
    const senderJid = msg.key?.participant || remoteJid;
    const normalizedSender = jidNormalizedUser(senderJid || '');
    const normalizedOwner = jidNormalizedUser(gatewaySession.ownerWaJid || '');
    const isOwner = normalizedSender && normalizedOwner && normalizedSender === normalizedOwner;
    const isPrivateChat = !!remoteJid && !remoteJid.endsWith('@g.us');

    const reply = async (textBody) => {
      try {
        await sock.sendMessage(remoteJid, { text: textBody }, { quoted: msg });
      } catch (error) {
        logger.warn({ err: error, phone, remoteJid }, 'WA command reply failed');
      }
    };

    if (!isPrivateChat) return;

    if (['menu', 'help', 'start'].includes(command)) {
      if (isOwner) {
        await reply(this.ownerMenuText(gatewaySession));
      } else {
        await reply(this.publicMenuText());
      }
      return;
    }

    if (['pair', 'link', 'ربط'].includes(command)) {
      const phoneArg = normalizePhone(args[0]);
      if (!phoneArg) {
        await reply('❌ مثال الاستخدام الصحيح:\n.pair 9665xxxxxxx');
        return;
      }

      const ownedBySender = this.store.findSessionByOwnerWaJid(normalizedSender);
      const existing = this.store.getSession(phoneArg);
      const targetOwnerWaJid = ownedBySender?.ownerWaJid || normalizedSender;
      const targetTgId = ownedBySender?.ownerTelegramId || null;

      await this.startOrResumeSession({
        phone: phoneArg,
        ownerTelegramId: targetTgId,
        ownerWaJid: targetOwnerWaJid,
        source: {
          type: 'whatsapp',
          gatewayPhone: phone,
          chatJid: remoteJid,
          quote: msg,
        },
      });

      await reply(existing
        ? `⏳ تم استئناف تجهيز الجلسة للرقم ${formatPhone(phoneArg)}. إذا لم يكن مرتبطاً سيتم إرسال كود الاقتران هنا.`
        : `⏳ جاري إنشاء جلسة مستقلة للرقم ${formatPhone(phoneArg)} وسيصل كود الاقتران هنا بعد ثوانٍ.`);
      return;
    }

    if (['emoji', 'reactemoji', 'ايموجي'].includes(command)) {
      const emoji = sanitizeEmoji(args[0]);
      let targetSession = null;

      if (isOwner) {
        targetSession = gatewaySession;
      } else {
        targetSession = this.store.findSessionByOwnerWaJid(normalizedSender);
      }

      if (!targetSession) {
        await reply('❌ لا توجد جلسة مرتبطة بحسابك حتى يتم تغيير الإيموجي. اربط رقمك أولاً عبر .pair 9665xxxxxxx أو من تيليجرام.');
        return;
      }

      await this.store.upsertSession(targetSession.phone, { emoji });
      await reply(`✅ تم تغيير إيموجي التفاعل التلقائي إلى ${emoji} للرقم ${targetSession.displayPhone}`);
      return;
    }

    if (['status', 'autoreact', 'حالات'].includes(command)) {
      if (!isOwner) {
        const ownedBySender = this.store.findSessionByOwnerWaJid(normalizedSender);
        if (!ownedBySender) {
          await reply('❌ هذه الخاصية متاحة فقط لمالك الجلسة الخاصة برقمه.');
          return;
        }
        const mode = String(args[0] || '').toLowerCase();
        const enabled = ['on', '1', 'true', 'enable', 'start', 'تشغيل'].includes(mode);
        const disabled = ['off', '0', 'false', 'disable', 'stop', 'ايقاف', 'إيقاف'].includes(mode);
        if (!enabled && !disabled) {
          await reply('❌ استخدم: .status on أو .status off');
          return;
        }
        await this.store.upsertSession(ownedBySender.phone, { autoReactStatus: enabled });
        await reply(`✅ تم ${enabled ? 'تشغيل' : 'إيقاف'} التفاعل التلقائي للحالات للرقم ${ownedBySender.displayPhone}`);
        return;
      }

      const mode = String(args[0] || '').toLowerCase();
      const enabled = ['on', '1', 'true', 'enable', 'start', 'تشغيل'].includes(mode);
      const disabled = ['off', '0', 'false', 'disable', 'stop', 'ايقاف', 'إيقاف'].includes(mode);
      if (!enabled && !disabled) {
        await reply('❌ استخدم: .status on أو .status off');
        return;
      }
      await this.store.upsertSession(gatewaySession.phone, { autoReactStatus: enabled });
      await reply(`✅ تم ${enabled ? 'تشغيل' : 'إيقاف'} التفاعل التلقائي للحالات لهذا الرقم.`);
      return;
    }

    if (['me', 'whoami', 'حسابي'].includes(command)) {
      const mine = isOwner ? gatewaySession : this.store.findSessionByOwnerWaJid(normalizedSender);
      if (!mine) {
        await reply('ℹ️ لا توجد جلسة مرتبطة بهذا الحساب حالياً.');
        return;
      }
      await reply(this.sessionSummaryText(mine));
      return;
    }

    if (['logout', 'unlink', 'remove', 'خروج'].includes(command)) {
      if (!isOwner) {
        await reply('❌ أمر تسجيل الخروج متاح فقط لمالك هذا الرقم.');
        return;
      }
      await this.logoutSession(gatewaySession.phone);
      await reply(`✅ تم تسجيل خروج الجلسة ${gatewaySession.displayPhone} وحذف ملفات الربط.`);
      return;
    }

    if (isOwner) {
      await reply(this.ownerMenuText(gatewaySession));
      return;
    }

    await reply(this.publicMenuText());
  }

  ownerMenuText(session) {
    return [
      '✨ أوامر مالك الرقم من داخل واتساب',
      '',
      '.menu  — عرض القائمة',
      '.emoji 😍 — تغيير إيموجي التفاعل',
      '.status on/off — تشغيل أو إيقاف التفاعل التلقائي للحالات',
      '.me — عرض حالة جلستك',
      '.logout — تسجيل خروج هذا الرقم',
      '',
      '🌐 أوامر عامة لأي شخص:',
      '.pair 9665xxxxxxx — إنشاء جلسة مستقلة وإرسال كود الاقتران',
      '.emoji 😍 — تغيير إيموجي جلستك إذا كان رقمك مربوطاً مسبقاً',
      '',
      `📱 الرقم الحالي: ${session.displayPhone}`,
      `🎯 الإيموجي: ${session.emoji}`,
      `📡 التفاعل التلقائي: ${session.autoReactStatus ? 'مفعل' : 'موقف'}`,
    ].join('\n');
  }

  publicMenuText() {
    return [
      '🤖 أوامر الربط المتاحة من داخل واتساب',
      '',
      '.pair 9665xxxxxxx — إرسال كود اقتران لرقمك هنا',
      '.emoji 😍 — تغيير إيموجي جلستك إذا كان رقمك مربوطاً',
      '.status on/off — تشغيل أو إيقاف التفاعل التلقائي لجلستك',
      '.me — عرض بيانات جلستك الحالية',
      '',
      'إذا ما عندك جلسة بعد، ابدأ بـ .pair',
    ].join('\n');
  }

  sessionSummaryText(session) {
    return [
      `📱 الرقم: ${session.displayPhone}`,
      `🔌 الحالة: ${statusLabel(session)}`,
      `🎯 الإيموجي: ${session.emoji}`,
      `👁️‍🗨️ تفاعل الحالات: ${session.autoReactStatus ? 'مفعل' : 'موقف'}`,
      `🆔 مالك واتساب: ${session.ownerWaJid || 'لم يثبت بعد'}`,
      `📅 آخر تحديث: ${session.updatedAt}`,
    ].join('\n');
  }

  async setEmoji(phone, emoji) {
    const session = this.store.getSession(phone);
    if (!session) throw new Error('الجلسة غير موجودة');
    return this.store.upsertSession(phone, { emoji: sanitizeEmoji(emoji) });
  }

  async setAutoReact(phone, enabled) {
    const session = this.store.getSession(phone);
    if (!session) throw new Error('الجلسة غير موجودة');
    return this.store.upsertSession(phone, { autoReactStatus: !!enabled });
  }

  async logoutSession(phone) {
    const sock = this.sockets.get(phone);
    if (sock) {
      try {
        await sock.logout();
      } catch (error) {
        logger.warn({ err: error, phone }, 'Socket logout failed, forcing cleanup');
      }
    }
    this.sockets.delete(phone);
    this.runtime.delete(phone);
    await safeUnlink(this.getAuthDir(phone));
    const session = this.store.getSession(phone);
    if (session) {
      await this.store.upsertSession(phone, {
        status: 'logged_out',
        ownerWaJid: null,
      });
    }
  }
}

const store = new JsonStore(STORE_FILE);
await store.init();

const telegramBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const sessionManager = new SessionManager({ store, telegramBot });

function telegramMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '➕ ربط رقم', callback_data: 'menu_link' },
          { text: '📂 جلساتي', callback_data: 'menu_sessions' },
        ],
        [
          { text: '🎯 تغيير الإيموجي', callback_data: 'menu_emoji' },
          { text: '🛠 المساعدة', callback_data: 'menu_help' },
        ],
      ],
    },
  };
}

function botHelpText() {
  return [
    '✨ أوامر البوت',
    '',
    '/start — واجهة البداية',
    '/help — شرح الأوامر',
    '/link 9665xxxxxxx — إنشاء جلسة مستقلة وإرسال كود الاقتران',
    '/sessions — عرض كل جلساتك',
    '/emoji 9665xxxxxxx 😍 — تغيير إيموجي التفاعل لهذا الرقم',
    '/toggle 9665xxxxxxx on — تشغيل أو إيقاف التفاعل التلقائي للحالات',
    '/logout 9665xxxxxxx — تسجيل خروج جلسة محددة',
    '',
    'كل رقم له جلسة مستقلة داخل مجلد خاص به، ويمكن إدارة الرقم أيضاً من داخل واتساب نفسه بالأوامر .menu و .pair و .emoji و .status.',
  ].join('\n');
}

function renderSessions(sessions) {
  if (!sessions.length) {
    return '📭 ما عندك أي جلسات حالياً.\nاستخدم /link 9665xxxxxxx لبدء الربط.';
  }

  return [
    '📂 جلساتك الحالية',
    '',
    ...sessions.map((session, index) => {
      return [
        `${index + 1}) ${sessionBadge(session)} ${session.displayPhone}`,
        `الحالة: ${statusLabel(session)}`,
        `الإيموجي: ${session.emoji}`,
        `تفاعل الحالات: ${session.autoReactStatus ? 'مفعل' : 'موقف'}`,
        `آخر تحديث: ${session.updatedAt}`,
      ].join('\n');
    }),
  ].join('\n\n');
}

telegramBot.onText(/^\/start$/, async (msg) => {
  await telegramBot.sendMessage(
    msg.chat.id,
    [
      '🤖 أهلاً بك في بوت إدارة ربط واتساب',
      '',
      'هذا البوت يربط أرقام واتساب بكود اقتران، ويعطي كل رقم جلسة مستقلة، ويفعل أوامر الإدارة من تيليجرام ومن داخل واتساب نفسه.',
      '',
      'ابدأ الآن بالأمر:\n/link 9665xxxxxxx',
    ].join('\n'),
    telegramMenu()
  );
});

telegramBot.onText(/^\/help$/, async (msg) => {
  await telegramBot.sendMessage(msg.chat.id, botHelpText());
});

telegramBot.on('callback_query', async (query) => {
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  try {
    if (query.data === 'menu_link') {
      await telegramBot.sendMessage(chatId, '📌 صيغة الربط:\n/link 9665xxxxxxx');
    } else if (query.data === 'menu_sessions') {
      const sessions = store.listSessionsByTelegramId(query.from.id);
      await telegramBot.sendMessage(chatId, renderSessions(sessions));
    } else if (query.data === 'menu_emoji') {
      await telegramBot.sendMessage(chatId, '📌 صيغة تغيير الإيموجي:\n/emoji 9665xxxxxxx 😍');
    } else if (query.data === 'menu_help') {
      await telegramBot.sendMessage(chatId, botHelpText());
    }
  } finally {
    await telegramBot.answerCallbackQuery(query.id).catch(() => {});
  }
});

telegramBot.onText(/^\/sessions$/, async (msg) => {
  const sessions = store.listSessionsByTelegramId(msg.from.id);
  await telegramBot.sendMessage(msg.chat.id, renderSessions(sessions));
});

telegramBot.onText(/^\/link(?:\s+(.+))?$/i, async (msg, match) => {
  const phone = normalizePhone(match?.[1]);
  if (!phone) {
    await telegramBot.sendMessage(msg.chat.id, '❌ استخدم الصيغة التالية:\n/link 9665xxxxxxx');
    return;
  }

  const session = await sessionManager.startOrResumeSession({
    phone,
    ownerTelegramId: msg.from.id,
    source: { type: 'telegram', chatId: msg.chat.id },
  });

  await telegramBot.sendMessage(
    msg.chat.id,
    `⏳ تم تجهيز جلسة مستقلة للرقم ${session.displayPhone}.\nإذا لم يكن مرتبطاً سابقاً فسيصلك كود الاقتران هنا بعد ثوانٍ.`
  );
});

telegramBot.onText(/^\/emoji(?:\s+(\d+)\s+(.+))?$/i, async (msg, match) => {
  const phone = normalizePhone(match?.[1]);
  const emoji = sanitizeEmoji(match?.[2]);
  if (!phone || !match?.[2]) {
    await telegramBot.sendMessage(msg.chat.id, '❌ استخدم الصيغة التالية:\n/emoji 9665xxxxxxx 😍');
    return;
  }

  const session = store.getSession(phone);
  if (!session || String(session.ownerTelegramId || '') !== String(msg.from.id)) {
    await telegramBot.sendMessage(msg.chat.id, '❌ هذه الجلسة غير موجودة عندك أو لا تملك صلاحية تعديلها.');
    return;
  }

  await sessionManager.setEmoji(phone, emoji);
  await telegramBot.sendMessage(msg.chat.id, `✅ تم تحديث إيموجي التفاعل للرقم ${session.displayPhone} إلى ${emoji}`);
});

telegramBot.onText(/^\/toggle(?:\s+(\d+)\s+(on|off))?$/i, async (msg, match) => {
  const phone = normalizePhone(match?.[1]);
  const mode = String(match?.[2] || '').toLowerCase();
  if (!phone || !mode) {
    await telegramBot.sendMessage(msg.chat.id, '❌ استخدم الصيغة التالية:\n/toggle 9665xxxxxxx on');
    return;
  }

  const session = store.getSession(phone);
  if (!session || String(session.ownerTelegramId || '') !== String(msg.from.id)) {
    await telegramBot.sendMessage(msg.chat.id, '❌ هذه الجلسة غير موجودة عندك أو لا تملك صلاحية تعديلها.');
    return;
  }

  await sessionManager.setAutoReact(phone, mode === 'on');
  await telegramBot.sendMessage(msg.chat.id, `✅ تم ${mode === 'on' ? 'تشغيل' : 'إيقاف'} التفاعل التلقائي للحالات للرقم ${session.displayPhone}`);
});

telegramBot.onText(/^\/logout(?:\s+(\d+))?$/i, async (msg, match) => {
  const phone = normalizePhone(match?.[1]);
  if (!phone) {
    await telegramBot.sendMessage(msg.chat.id, '❌ استخدم الصيغة التالية:\n/logout 9665xxxxxxx');
    return;
  }

  const session = store.getSession(phone);
  if (!session || String(session.ownerTelegramId || '') !== String(msg.from.id)) {
    await telegramBot.sendMessage(msg.chat.id, '❌ هذه الجلسة غير موجودة عندك أو لا تملك صلاحية حذفها.');
    return;
  }

  await sessionManager.logoutSession(phone);
  await telegramBot.sendMessage(msg.chat.id, `✅ تم تسجيل خروج الجلسة ${session.displayPhone} وحذف ملفات الربط.`);
});

telegramBot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;

  const text = msg.text.trim().toLowerCase();
  if (text === 'جلساتي' || text === 'sessions') {
    const sessions = store.listSessionsByTelegramId(msg.from.id);
    await telegramBot.sendMessage(msg.chat.id, renderSessions(sessions));
  }
});

await sessionManager.bootExistingSessions();

if (!fs.existsSync(path.join(DATA_DIR, '.keep'))) {
  await fsp.writeFile(path.join(DATA_DIR, '.keep'), '', 'utf8').catch(() => {});
}

console.log(`${APP_NAME} is running on Node.js with Telegram polling.`);
console.log(`Data directory: ${DATA_DIR}`);

process.on('uncaughtException', (error) => {
  logger.error({ err: error }, 'Uncaught exception');
});

process.on('unhandledRejection', (error) => {
  logger.error({ err: error }, 'Unhandled rejection');
});

setInterval(() => {
  // keep process alive in some hosts
}, PORT * 0 + 60_000);
