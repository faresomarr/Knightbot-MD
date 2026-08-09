const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

module.exports = {
  port: Number(process.env.PORT || 3000),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  whatsappApiVersion: process.env.WHATSAPP_API_VERSION || 'v26.0',
  webhookPath: process.env.WEBHOOK_PATH || '/webhook/whatsapp'
};
