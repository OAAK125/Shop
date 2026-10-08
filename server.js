require('dotenv').config();

const express = require('express');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3000);
const botToken = process.env.BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function formatOrderMessage(order) {
  const customer = order.customer || {};
  const items = Array.isArray(order.items) ? order.items : [];
  const lines = items.map((item) => {
    const addons = Array.isArray(item.addons) && item.addons.length
      ? item.addons.map((addon) => `${addon.name} (${addon.price} GH₵)`).join(', ')
      : 'No add-ons';

    return `• ${item.name} — ${item.base} GH₵${addons !== 'No add-ons' ? ` | Add-ons: ${addons}` : ''}`;
  });

  return [
    '🛍️ New Sohan Kitchen order',
    '',
    `Customer: ${customer.name || 'N/A'}`,
    `Phone: ${customer.phone || 'N/A'}`,
    `Delivery: ${customer.location || 'N/A'}`,
    `Notes: ${customer.notes || 'None'}`,
    '',
    'Items:',
    ...lines,
    '',
    `Total: ${Number(order.total || 0)} GH₵`,
    `Placed at: ${order.placedAt || new Date().toISOString()}`
  ].join('\n');
}

async function sendToTelegram(text) {
  if (!botToken || !chatId) {
    throw new Error('Telegram bot is not configured. Set BOT_TOKEN and TELEGRAM_CHAT_ID.');
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    })
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload.ok) {
    const message = payload.description || 'Telegram send failed.';
    throw new Error(message);
  }

  return payload;
}

app.post('/api/send-order', async (req, res) => {
  try {
    const order = req.body || {};
    if (!order.customer || !order.items || !Array.isArray(order.items) || order.items.length === 0) {
      return res.status(400).json({ error: 'Order payload is missing required details.' });
    }

    const message = formatOrderMessage(order);
    await sendToTelegram(message);
    res.json({ ok: true, message: 'Order sent to Telegram.' });
  } catch (error) {
    console.error('Order send failed:', error);
    res.status(500).json({ error: error.message || 'Could not send order to Telegram.' });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
  console.log(`Sohan Kitchen app running on http://localhost:${port}`);
});
