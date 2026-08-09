const TelegramBot = require('node-telegram-bot-api');
const { telegramBotToken, mainKeyboard, backKeyboard, defaultReactionEmoji, callbackPrefix } = require('./config');
const {
  getMeta,
  setMeta,
  deleteMeta,
  listAllLinkedUsers,
  removeSessionFolder
} = require('./storage');
const { startPairing, logout } = require('./whatsapp');

if (!telegramBotToken) {
  throw new Error('TELEGRAM_BOT_TOKEN غير موجود داخل ملف .env');
}

// إعداد أوامر تيليجرام الجانبية
const commands = [
  { command: 'start', description: 'القائمة الرئيسية للربط وإدارة الأرقام' },
  { command: 'mynumbers', description: 'عرض أرقامك المربوطة' },
  { command: 'deletesession', description: 'حذف جلسة واتساب الحالية' },
  { command: 'setemoji', description: 'تغيير إيموجي التفاعل على الحالات' },
  { command: 'autoreact', description: 'تشغيل/إيقاف التفاعل التلقائي على الحالات' }
];

// مساعدة عامة
function helpText() {
  return [
    '🤖 <b>Knightbot-MD</b>',
    'بوت تيليجرام لربط أرقام <b>WhatsApp الشخصية</b> عبر <b>كود اقتران</b> 8 خانات.',
    '',
    '📌 <b>طريقة الاستخدام</b>',
    '1) اضغط <b>🔗 ربط رقم واتساب</b> من القائمة الرئيسية.',
    '2) أرسل الرقم بالصيغة الدولية بدون <code>+</code> أو مسافات، مثال: <code>967771163825</code>.',
    '3) سيُرسل لك البوت <b>كود الاقتران</b> المكوّن من 8 خانات، انسخه وأدخله في واتساب.',
    '4) بمجرد التأكيد سيتم الربط تلقائياً ويُفعّل التفاعل التلقائي مع الحالات.',
    '',
    '🧰 <b>الأوامر المتاحة</b>',
    '• <code>/start</code> – عرض القائمة الرئيسية.',
    '• <code>/mynumbers</code> – عرض الأرقام المربوطة بك.',
    '• <code>/deletesession</code> – حذف الجلسة الحالية.',
    '• <code>/setemoji 😀</code> – تغيير إيموجي التفاعل.',
    '• <code>/autoreact on|off</code> – تشغيل/إيقاف التفاعل.',
    '',
    '🔒 <b>أمان</b>',
    'جلسة الواتساب محفوظة <b>محلياً على هذا السيرفر</b> ضمن مجلد <code>data/sessions/&lt;chatId&gt;</code>.',
    'لا تُشارك الجلسة مع أحد آخر.'
  ].join('\n');
}

// رسائل الواجهة الشفافة
function startMessage() {
  return [
    '🤖 <b>أهلًا بك في Knightbot-MD</b>',
    'بوت لربط أرقام واتساب الشخصية عبر <b>كود اقتران</b> — لا حاجة لمسح QR من سطح المكتب.',
    '',
    '👇 اختر من القائمة أدناه ما يناسبك:'
  ].join('\n');
}

// تطهير الرقم: يبقى الحروف الإنجليزية فقط في الأرقام
function sanitizePhone(input) {
  return String(input || '').replace(/[^\d]/g, '');
}

// التحقق البسيط من الرقم الدولي
function isValidPhone(num) {
  return /^\d{10,15}$/.test(num);
}

function createBot() {
  const bot = new TelegramBot(telegramBotToken, { polling: true });
  bot.setMyCommands(commands).catch(() => {});

  // حالات وسطية لكل مستخدم: 0=لا شيء، 1=في انتظار الرقم للربط، 2=في انتظار الرقم لحذفه
  const awaiting = new Map(); // chatId -> 'link' | 'delete'

  const sendHtml = (chatId, text, extra = {}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });

  // إرسال/تعديل رسالة القائمة الرئيسية
  async function showHome(chatId, messageId = null) {
    const text = startMessage();
    const opts = { parse_mode: 'HTML', reply_markup: { inline_keyboard: mainKeyboard } };
    if (messageId) {
      try {
        await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts });
        return;
      } catch (err) {
        // قد لا يمكن تعديل الرسالة (نص طويل أو رسالة قديمة) -> ابعث من جديد
      }
    }
    await bot.sendMessage(chatId, text, opts);
  }

  // /start: القائمة الرئيسية الشفافة
  bot.onText(/^\/start$/, async (msg) => {
    await showHome(msg.chat.id);
  });

  // /help: المساعدة
  bot.onText(/^\/help$/, async (msg) => {
    await sendHtml(msg.chat.id, helpText());
  });

  // التعامل مع ضغط الأزرار الشفافة
  bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat?.id;
    const data = query.data || '';
    const messageId = query.message?.message_id;

    if (!chatId || !data.startsWith(callbackPrefix)) return;

    await bot.answerCallbackQuery(query.id).catch(() => {});
    const action = data.slice(callbackPrefix.length);

    if (action === 'home') {
      awaiting.delete(chatId);
      await showHome(chatId, messageId);
      return;
    }

    if (action === 'help') {
      try {
        await bot.editMessageText(helpText(), {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard }
        });
      } catch { await sendHtml(chatId, helpText(), { reply_markup: { inline_keyboard: backKeyboard } }); }
      return;
    }

    if (action === 'link') {
      awaiting.set(chatId, 'link');
      const text = [
        '🔗 <b>ربط رقم واتساب جديد</b>',
        'أرسل الرقم بالصيغة الدولية (بدون <code>+</code> ولا مسافات)، مثال:',
        '<code>967771163825</code>',
        '',
        '⚠️ تأكد أن الرقم يستقبل رسائل SMS، لأن واتساب سيرسل عليه كود الاقتران.'
      ].join('\n');
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard }
        });
      } catch {
        await sendHtml(chatId, text, { reply_markup: { inline_keyboard: backKeyboard } });
      }
      return;
    }

    if (action === 'delete') {
      const meta = await getMeta(chatId);
      if (!meta?.phoneNumber) {
        await sendHtml(chatId, '❌ لا توجد جلسة مربوطة بك أصلاً.', {
          reply_markup: { inline_keyboard: backKeyboard }
        });
        return;
      }

      try { await logout(chatId); } catch {}
      await deleteMeta(chatId).catch(() => {});
      await removeSessionFolder(chatId).catch(() => {});

      await sendHtml(
        chatId,
        `🗑️ <b>تم حذف الجلسة</b>\nالرقم: <code>${meta.phoneNumber}</code>\nكل بيانات الاعتماد حُذفت من هذا السيرفر.`,
        { reply_markup: { inline_keyboard: mainKeyboard } }
      );
      return;
    }

    if (action === 'list') {
      const list = (await listAllLinkedUsers()) || [];
      const mine = list.filter((u) => Number(u.chatId) === Number(chatId));
      if (mine.length === 0) {
        await sendHtml(
          chatId,
          '📱 <b>أرقامك المربوطة</b>\nلا يوجد أي رقم مربوط. اضغط <b>🔗 ربط رقم واتساب</b> للبدء.',
          { reply_markup: { inline_keyboard: backKeyboard } }
        );
        return;
      }

      const lines = ['📱 <b>أرقامك المربوطة</b>'];
      for (const item of mine) {
        const status = item.status === 'connected' ? '🟢 متصل' : '🔴 غير متصل';
        lines.push(`• <code>${item.phoneNumber || '-'}</code> — ${status}`);
        if (item.pairedAt) {
          lines.push(`   تاريخ الربط: <i>${new Date(item.pairedAt).toLocaleString()}</i>`);
        }
      }
      lines.push('\nلحذف الرقم اضغط <b>🗑️ حذف جلسة</b>.');

      try {
        await bot.editMessageText(lines.join('\n'), {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: backKeyboard }
        });
      } catch {
        await sendHtml(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: backKeyboard } });
      }
      return;
    }
  });

  // استقبال الرسائل النصية (لربط/حذف) وأي نص عادي
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    // أوامر رسمية نُعالجها في أون تكست أعلاه
    if (text.startsWith('/')) return;

    const mode = awaiting.get(chatId);
    if (!mode) return;

    const phone = sanitizePhone(text);

    if (mode === 'link') {
      if (!isValidPhone(phone)) {
        await sendHtml(
          chatId,
          '❌ صيغة الرقم غير صحيحة. أرسل أرقاماً فقط بدون <code>+</code> أو مسافات، 10 إلى 15 رقمًا.',
          { reply_markup: { inline_keyboard: backKeyboard } }
        );
        return;
      }

      // تأكيد بداية المحاولة قبل البدء الفعلي
      const progress = await sendHtml(
        chatId,
        `⏳ <b>جاري تجهيز كود الاقتران للرقم</b> <code>${phone}</code>…\nقد يستغرق ذلك حتى 30 ثانية.`
      );

      try {
        const result = await startPairing(chatId, phone);
        awaiting.delete(chatId);

        if (result.result?.ok === false) {
          if (result.result.restart) {
            await bot.sendMessage(
              chatId,
              '♻️ لم يستقر الاتصال بعد، حاول مرة أخرى خلال ثوانٍ قليلة.'
            );
            return;
          }
          await bot.sendMessage(
            chatId,
            `❌ تعذّر إكمال الاقتران (السبب: ${result.result.reason || 'غير معروف'}).\nحاول مرة أخرى باستخدام <code>/start</code>.`
          );
          return;
        }

        // إما الكود جاهز، أو السوكيت كان مسجلاً مسبقاً
        const code = result.result?.code;
        if (code) {
          const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
          await setMeta(chatId, {
            phoneNumber: phone,
            reactionEmoji: defaultReactionEmoji,
            statusReact: true,
            pairedAt: null,
            status: 'pending_pairing'
          }).catch(() => {});

          await bot.sendMessage(
            chatId,
            [
              '🔑 <b>كود الاقتران جاهز</b>',
              `الصيغة: <code>${formatted}</code>  (الكود الكامل: <code>${code}</code>)`,
              '',
              '📱 افتح واتساب على هاتفك المرتبط بالرقم <code>' + phone + '</code>،',
              'اذهب إلى: <b>الإعدادات → الأجهزة → ربط جهاز</b>، واختر <b>ربط بالرقم بدلاً من ذلك</b>،',
              'ثم أدخل الكود أعلاه. سيتم الربط تلقائياً ويُفعّل التفاعل التلقائي على الحالات.',
              '',
              '⏳ بمجرد التأكيد، ستصلك رسالة «تم الربط بنجاح» هنا تلقائياً.'
            ].join('\n'),
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: backKeyboard } }
          );
        } else if (result.result?.alreadyRegistered) {
          await setMeta(chatId, {
            phoneNumber: phone,
            reactionEmoji: defaultReactionEmoji,
            statusReact: true,
            pairedAt: new Date().toISOString(),
            status: 'connected'
          }).catch(() => {});

          await bot.sendMessage(
            chatId,
            '✅ هذا الرقم مربوط مسبقاً لدى هذا السيرفر، تم استعادة الجلسة بنجاح.',
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: mainKeyboard } }
          );
        }

        // حاول تعديل رسالة الانتظار الأصلية بإزالة لوحة المفاتيح
        if (progress?.message_id) {
          try {
            await bot.editMessageText(
              `⏳ <b>تم إرسال كود الاقتران للرقم</b> <code>${phone}</code>`,
              { chat_id: chatId, message_id: progress.message_id, parse_mode: 'HTML' }
            ).catch(() => {});
          } catch {}
        }
      } catch (err) {
        awaiting.delete(chatId);
        await bot.sendMessage(
          chatId,
          `❌ تعذّر توليد الكود: <code>${err && err.message ? err.message : err}</code>`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: mainKeyboard } }
        );
      }
      return;
    }
  });

  // /mynumbers: عرض الأرقام المربوطة كرسالة عادية
  bot.onText(/^\/mynumbers$/, async (msg) => {
    const chatId = msg.chat.id;
    const all = (await listAllLinkedUsers()) || [];
    const mine = all.filter((u) => Number(u.chatId) === Number(chatId));

    if (mine.length === 0) {
      await sendHtml(
        chatId,
        '📱 <b>أرقامك المربوطة</b>\nلا يوجد أي رقم مربوط. أرسل <code>/start</code> ثم اضغط <b>🔗 ربط رقم واتساب</b>.',
        { reply_markup: { inline_keyboard: mainKeyboard } }
      );
      return;
    }

    const lines = ['📱 <b>أرقامك المربوطة</b>'];
    for (const item of mine) {
      const status = item.status === 'connected' ? '🟢 متصل' : '🔴 غير متصل';
      lines.push(`• <code>${item.phoneNumber || '-'}</code> — ${status}`);
      if (item.pairedAt) {
        lines.push(`   تاريخ الربط: <i>${new Date(item.pairedAt).toLocaleString()}</i>`);
      }
    }
    await sendHtml(chatId, lines.join('\n'), { reply_markup: { inline_keyboard: mainKeyboard } });
  });

  // /deletesession: حذف الجلسة مباشرة
  bot.onText(/^\/deletesession$/, async (msg) => {
    const chatId = msg.chat.id;
    const meta = await getMeta(chatId);
    if (!meta?.phoneNumber) {
      await sendHtml(chatId, '❌ لا توجد جلسة مربوطة بك.', {
        reply_markup: { inline_keyboard: mainKeyboard }
      });
      return;
    }
    try { await logout(chatId); } catch {}
    await deleteMeta(chatId).catch(() => {});
    await removeSessionFolder(chatId).catch(() => {});

    await sendHtml(
      chatId,
      `🗑️ تم حذف جلسة الرقم <code>${meta.phoneNumber}</code> نهائياً.`,
      { reply_markup: { inline_keyboard: mainKeyboard } }
    );
  });

  // /setemoji 😀 : تغيير إيموجي التفاعل
  bot.onText(/^\/setemoji(?:\s+(.+))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const meta = await getMeta(chatId);
    if (!meta?.phoneNumber) {
      await sendHtml(chatId, '❌ اربط رقمك أولًا باستخدام <code>/start</code>.');
      return;
    }
    const emoji = (match[1] || '').trim();
    if (!emoji) {
      await sendHtml(chatId, 'صيغة الأمر الصحيحة:\n<code>/setemoji 😀</code>');
      return;
    }
    await setMeta(chatId, { reactionEmoji: emoji });
    await sendHtml(chatId, `✅ تم تحديث إيموجي التفاعل إلى: <code>${emoji}</code>`);
  });

  // /autoreact on|off : تشغيل/إيقاف التفاعل
  bot.onText(/^\/autoreact(?:\s+(on|off))?$/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const meta = await getMeta(chatId);
    if (!meta?.phoneNumber) {
      await sendHtml(chatId, '❌ اربط رقمك أولًا باستخدام <code>/start</code>.');
      return;
    }
    const mode = (match[1] || '').toLowerCase();
    if (!mode) {
      await sendHtml(chatId, 'صيغة الأمر الصحيحة:\n<code>/autoreact on</code> أو <code>/autoreact off</code>');
      return;
    }
    const enabled = mode === 'on';
    await setMeta(chatId, { statusReact: enabled });
    await sendHtml(chatId, `✅ التفاعل التلقائي مع الحالات الآن: <code>${enabled ? 'ON' : 'OFF'}</code>`);
  });

  return bot;
}

module.exports = { createBot };
