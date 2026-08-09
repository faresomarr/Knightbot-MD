const express = require('express');
const { port, webhookPath } = require('./config');
const { findUserByPhoneNumberId, findUserByVerifyToken } = require('./storage');
const { sendReactionMessage, formatAxiosError } = require('./whatsapp');

function formatIncomingMessage(message) {
  if (message.type === 'text') {
    return message.text?.body || '(رسالة نصية)';
  }

  return `(نوع الرسالة: ${message.type || 'unknown'})`;
}

function startWebhookServer(bot) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get(webhookPath, (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const user = findUserByVerifyToken(token);

    if (mode === 'subscribe' && user) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  });

  app.post(webhookPath, async (req, res) => {
    try {
      const entries = req.body.entry || [];

      for (const entry of entries) {
        for (const change of entry.changes || []) {
          const value = change.value || {};
          const phoneNumberId = value.metadata?.phone_number_id;
          const owner = findUserByPhoneNumberId(phoneNumberId);

          if (!owner) {
            continue;
          }

          for (const message of value.messages || []) {
            const body = [
              '📩 <b>رسالة واردة من واتساب</b>',
              `الرقم المرتبط: <code>${owner.phoneNumberId}</code>`,
              `من: <code>${message.from || '-'}</code>`,
              `النوع: <code>${message.type || '-'}</code>`,
              `المحتوى: ${formatIncomingMessage(message)}`
            ].join('\n');

            if (owner.notifyIncoming) {
              await bot.sendMessage(owner.telegramId, body, { parse_mode: 'HTML' });
            }

            if (owner.autoReact && message.id && message.from && owner.reactionEmoji) {
              try {
                await sendReactionMessage({
                  phoneNumberId: owner.phoneNumberId,
                  accessToken: owner.accessToken,
                  to: message.from,
                  messageId: message.id,
                  emoji: owner.reactionEmoji
                });
              } catch (error) {
                await bot.sendMessage(
                  owner.telegramId,
                  `⚠️ فشل إرسال التفاعل التلقائي: ${formatAxiosError(error)}`
                );
              }
            }
          }

          for (const status of value.statuses || []) {
            if (!owner.notifyStatuses) {
              continue;
            }

            const text = [
              '📊 <b>تحديث حالة رسالة واتساب</b>',
              `الرقم المرتبط: <code>${owner.phoneNumberId}</code>`,
              `إلى: <code>${status.recipient_id || '-'}</code>`,
              `الحالة: <code>${status.status || '-'}</code>`,
              `معرّف الرسالة: <code>${status.id || '-'}</code>`
            ].join('\n');

            await bot.sendMessage(owner.telegramId, text, { parse_mode: 'HTML' });
          }
        }
      }

      return res.sendStatus(200);
    } catch (error) {
      console.error('Webhook error:', error);
      return res.sendStatus(500);
    }
  });

  app.get('/', (_req, res) => {
    res.status(200).json({
      ok: true,
      message: 'Telegram + WhatsApp Business Cloud API bot is running.',
      webhookPath
    });
  });

  app.listen(port, () => {
    console.log(`Webhook server running on port ${port}`);
  });
}

module.exports = { startWebhookServer };
