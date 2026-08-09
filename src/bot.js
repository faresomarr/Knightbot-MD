const TelegramBot = require('node-telegram-bot-api');
const { telegramBotToken, webhookPath } = require('./config');
const { getUser, saveUser, removeUser } = require('./storage');
const { sendTextMessage, formatAxiosError } = require('./whatsapp');

if (!telegramBotToken) {
  throw new Error('TELEGRAM_BOT_TOKEN غير موجود داخل ملف .env');
}

const commands = [
  { command: 'start', description: 'عرض البداية وجميع الأوامر' },
  { command: 'help', description: 'عرض المساعدة' },
  { command: 'connect', description: 'ربط حساب WhatsApp Business الرسمي' },
  { command: 'status', description: 'عرض حالة الربط الحالية' },
  { command: 'setemoji', description: 'تغيير إيموجي التفاعل التلقائي' },
  { command: 'autoreact', description: 'تشغيل أو إيقاف التفاعل التلقائي' },
  { command: 'send', description: 'إرسال رسالة واتساب' },
  { command: 'disconnect', description: 'فصل الحساب المرتبط' }
];

function startMessage() {
  return [
    '👋 <b>أهلًا بك في بوت تيليجرام + WhatsApp Business Cloud API</b>',
    '',
    'هذا المشروع يعمل بالطريقة الرسمية المتوافقة مع <b>WhatsApp Business Cloud API</b>.',
    'لا يعتمد على ربط أرقام واتساب الشخصية عبر كود اقتران من تيليجرام، لأن هذا غير متاح رسميًا عبر Cloud API.',
    '',
    '📌 <b>الأوامر المتاحة</b>',
    '1) <code>/connect phone_number_id|waba_id|access_token|verify_token</code>',
    'ربط رقم أعمالك الرسمي مع البوت.',
    '',
    '2) <code>/status</code>',
    'عرض بيانات الربط الحالية.',
    '',
    '3) <code>/setemoji 😀</code>',
    'تغيير إيموجي التفاعل التلقائي على الرسائل الواردة.',
    '',
    '4) <code>/autoreact on</code> أو <code>/autoreact off</code>',
    'تشغيل أو إيقاف التفاعل التلقائي على الرسائل الواردة.',
    '',
    '5) <code>/send 9665XXXXXXXX|مرحبا</code>',
    'إرسال رسالة واتساب من الرقم المرتبط.',
    '',
    '6) <code>/disconnect</code>',
    'حذف الربط الحالي نهائيًا من التخزين المحلي.',
    '',
    '7) <code>/help</code>',
    'إعادة عرض المساعدة.',
    '',
    '🔗 <b>تنبيه مهم</b>',
    `بعد الربط يجب ضبط Webhook في Meta على المسار: <code>${webhookPath}</code>`,
    'ثم استخدام verify_token نفسه الذي أدخلته في أمر /connect.',
    '',
    'ℹ️ الميزة الرسمية المتاحة هنا هي التفاعل مع <b>الرسائل الواردة</b> وتلقي <b>حالات الرسائل</b> داخل تيليجرام. أمّا التفاعل مع حالات Status الخاصة بواتساب الشخصي فليس ضمن Cloud API الرسمي.'
  ].join('\n');
}

function ensureConnected(chatId) {
  const user = getUser(chatId);
  if (!user?.phoneNumberId || !user?.accessToken) {
    return null;
  }
  return user;
}

function sanitizePhone(input) {
  return String(input || '').replace(/[^\d+]/g, '');
}

function createBot() {
  const bot = new TelegramBot(telegramBotToken, { polling: true });
  bot.setMyCommands(commands).catch(console.error);

  const sendHtml = (chatId, text) => bot.sendMessage(chatId, text, { parse_mode: 'HTML' });

  bot.onText(/^\/start$/, async (msg) => {
    await sendHtml(msg.chat.id, startMessage());
  });

  bot.onText(/^\/help$/, async (msg) => {
    await sendHtml(msg.chat.id, startMessage());
  });

  bot.onText(/^\/connect(?:\s+([\s\S]+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const raw = (match[1] || '').trim();

    if (!raw) {
      await sendHtml(chatId, 'صيغة الأمر الصحيحة:\n<code>/connect phone_number_id|waba_id|access_token|verify_token</code>');
      return;
    }

    const [phoneNumberId, wabaId, accessToken, verifyToken] = raw.split('|').map((item) => (item || '').trim());

    if (!phoneNumberId || !wabaId || !accessToken || !verifyToken) {
      await sendHtml(chatId, 'البيانات غير مكتملة. استخدم 4 قيم مفصولة بعلامة <code>|</code>.');
      return;
    }

    const user = saveUser(chatId, {
      phoneNumberId,
      wabaId,
      accessToken,
      verifyToken,
      connected: true
    });

    await sendHtml(
      chatId,
      [
        '✅ <b>تم حفظ بيانات الربط بنجاح</b>',
        `Phone Number ID: <code>${user.phoneNumberId}</code>`,
        `WABA ID: <code>${user.wabaId}</code>`,
        `Emoji: <code>${user.reactionEmoji}</code>`,
        `Auto React: <code>${user.autoReact ? 'ON' : 'OFF'}</code>`
      ].join('\n')
    );
  });

  bot.onText(/^\/status$/, async (msg) => {
    const chatId = msg.chat.id;
    const user = getUser(chatId);

    if (!user?.connected) {
      await sendHtml(chatId, '❌ لا يوجد أي رقم مربوط حاليًا.');
      return;
    }

    await sendHtml(
      chatId,
      [
        '📋 <b>حالة الربط</b>',
        `Phone Number ID: <code>${user.phoneNumberId}</code>`,
        `WABA ID: <code>${user.wabaId}</code>`,
        `Emoji: <code>${user.reactionEmoji || '❤️'}</code>`,
        `Auto React: <code>${user.autoReact ? 'ON' : 'OFF'}</code>`,
        `Notify Incoming: <code>${user.notifyIncoming ? 'ON' : 'OFF'}</code>`,
        `Notify Statuses: <code>${user.notifyStatuses ? 'ON' : 'OFF'}</code>`
      ].join('\n')
    );
  });

  bot.onText(/^\/setemoji(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = ensureConnected(chatId);

    if (!user) {
      await sendHtml(chatId, '❌ اربط حسابك أولًا باستخدام أمر <code>/connect</code>.');
      return;
    }

    const emoji = (match[1] || '').trim();
    if (!emoji) {
      await sendHtml(chatId, 'صيغة الأمر الصحيحة:\n<code>/setemoji 😀</code>');
      return;
    }

    saveUser(chatId, { reactionEmoji: emoji });
    await sendHtml(chatId, `✅ تم تحديث إيموجي التفاعل إلى: <code>${emoji}</code>`);
  });

  bot.onText(/^\/autoreact(?:\s+(on|off))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = ensureConnected(chatId);

    if (!user) {
      await sendHtml(chatId, '❌ اربط حسابك أولًا باستخدام أمر <code>/connect</code>.');
      return;
    }

    const mode = (match[1] || '').toLowerCase();
    if (!mode) {
      await sendHtml(chatId, 'صيغة الأمر الصحيحة:\n<code>/autoreact on</code> أو <code>/autoreact off</code>');
      return;
    }

    const enabled = mode === 'on';
    saveUser(chatId, { autoReact: enabled });
    await sendHtml(chatId, `✅ التفاعل التلقائي الآن: <code>${enabled ? 'ON' : 'OFF'}</code>`);
  });

  bot.onText(/^\/send(?:\s+([\s\S]+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = ensureConnected(chatId);

    if (!user) {
      await sendHtml(chatId, '❌ اربط حسابك أولًا باستخدام أمر <code>/connect</code>.');
      return;
    }

    const raw = (match[1] || '').trim();
    const separatorIndex = raw.indexOf('|');

    if (!raw || separatorIndex === -1) {
      await sendHtml(chatId, 'صيغة الأمر الصحيحة:\n<code>/send 9665XXXXXXXX|نص الرسالة</code>');
      return;
    }

    const to = sanitizePhone(raw.slice(0, separatorIndex).trim());
    const body = raw.slice(separatorIndex + 1).trim();

    if (!to || !body) {
      await sendHtml(chatId, 'الرقم أو نص الرسالة غير صالح.');
      return;
    }

    try {
      const result = await sendTextMessage({
        phoneNumberId: user.phoneNumberId,
        accessToken: user.accessToken,
        to,
        body
      });

      await sendHtml(
        chatId,
        [
          '✅ <b>تم إرسال الرسالة بنجاح</b>',
          `إلى: <code>${to}</code>`,
          `معرّف الرسالة: <code>${result.messages?.[0]?.id || '-'}</code>`
        ].join('\n')
      );
    } catch (error) {
      await sendHtml(chatId, `❌ فشل إرسال الرسالة:\n<code>${formatAxiosError(error)}</code>`);
    }
  });

  bot.onText(/^\/disconnect$/, async (msg) => {
    removeUser(msg.chat.id);
    await sendHtml(msg.chat.id, '🗑️ تم حذف الربط الحالي من التخزين المحلي.');
  });

  return bot;
}

module.exports = { createBot };
