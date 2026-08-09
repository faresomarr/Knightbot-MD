const axios = require('axios');
const { whatsappApiVersion } = require('./config');

function graphUrl(phoneNumberId) {
  return `https://graph.facebook.com/${whatsappApiVersion}/${phoneNumberId}/messages`;
}

async function sendTextMessage({ phoneNumberId, accessToken, to, body }) {
  const response = await axios.post(
    graphUrl(phoneNumberId),
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

async function sendReactionMessage({ phoneNumberId, accessToken, to, messageId, emoji }) {
  const response = await axios.post(
    graphUrl(phoneNumberId),
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'reaction',
      reaction: {
        message_id: messageId,
        emoji
      }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data;
}

function formatAxiosError(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.error?.error_user_msg ||
    error?.message ||
    'حدث خطأ غير معروف'
  );
}

module.exports = {
  sendTextMessage,
  sendReactionMessage,
  formatAxiosError
};
