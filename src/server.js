// لم يعد هناك حاجة لخادم Webhook لأن البوت يستخدم Baileys مباشرة (وليس Cloud API)
// نُبقي على index.js بسيط يُشغل البوت فقط ويُقدّم فحص صحة بسيط عبر express.

const express = require('express');
const { sessionsDir } = require('./config');
const fs = require('fs');

function startWebhookServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);

  app.get('/', (_req, res) => {
    res.status(200).json({
      ok: true,
      service: 'Knightbot-MD (Baileys)',
      sessionsDir
    });
  });

  app.listen(port, () => {
    console.log(`Health server running on port ${port}`);
  });
}

module.exports = { startWebhookServer };
