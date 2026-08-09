const { createBot } = require('./bot');
const { startWebhookServer } = require('./server');

const bot = createBot();
startWebhookServer(bot);

console.log('Telegram bot started successfully.');
