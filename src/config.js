require('dotenv').config();
const path = require('path');
const fs = require('fs');

const rootDir = path.join(__dirname, '..');
const sessionsDir = path.join(rootDir, 'data', 'sessions');
if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

module.exports = {
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // المسار الذي يستعمله تيليجرام للبوت
  // المسار الذي يحفظ فيه البوت جلسات واتساب لكل مستخدم تيليجرام
  sessionsDir,
  // بادئة مفتاح الواجهة الشفافة
  callbackPrefix: 'knight:',
  // قيمة افتراضية لإيموجي التفاعل على الحالات
  defaultReactionEmoji: '❤️',
  // أزرار الواجهة الشفافة التي تظهر داخل /start
  mainKeyboard: [
    [{ text: '🔗 ربط رقم واتساب', callback_data: 'knight:link' }],
    [
      { text: '📱 أرقامي المربوطة', callback_data: 'knight:list' },
      { text: '🗑️ حذف جلسة', callback_data: 'knight:delete' }
    ],
    [{ text: '❓ المساعدة', callback_data: 'knight:help' }]
  ],
  backKeyboard: [[{ text: '🔙 رجوع للقائمة الرئيسية', callback_data: 'knight:home' }]]
};
