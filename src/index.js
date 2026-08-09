const { createBot } = require('./bot');
const { startWebhookServer } = require('./server');

(async () => {
  const bot = createBot();
  startWebhookServer();
  console.log('Knightbot-MD is up (Telegram + Baileys pairing).');
})();
