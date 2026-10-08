require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const port = Number(process.env.PORT || 3000);
const botToken = process.env.BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

function makeOrderId() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let id = '';
  for (let i = 0; i < 6; i++) id += alphabet[bytes[i] % alphabet.length];
  return 'SK-' + id;
}

const esc = (v) =>
  String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

app.post('/api/send-order', async (req, res) => {
  try {
    const order = req.body || {};
    const customer = order.customer || {};
    const items = Array.isArray(order.items) ? order.items.slice(0, 50) : [];

    const name = clip(customer.name, 80);
    const phone = clip(customer.phone, 20);
    const location = clip(customer.location, 200);
    const notes = clip(customer.notes, 300);

    if (name.length < 2 || !/^[0-9+\s-]{9,15}$/.test(phone) || location.length < 4 || items.length === 0) {
      return res.status(400).json({ error: 'Invalid order.' });
    }

    const lines = items.map((item) => {
      const addons = Array.isArray(item.addons) ? item.addons : [];
      const lineTotal = Number(item.base || 0) + addons.reduce((sum, addon) => sum + Number(addon.price || 0), 0);
      return { name: clip(item.name, 80), addons, lineTotal };
    });

    const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const orderId = makeOrderId();
    const ghs = (n) => 'GHS ' + Number(n).toFixed(2);

    if (!botToken || !chatId) {
      return res.status(500).json({ error: 'Telegram bot is not configured. Set BOT_TOKEN and TELEGRAM_CHAT_ID.' });
    }

    const text = [
      '🍽 <b>New Sohan Kitchen order</b>',
      `<b>Order ID:</b> <code>${orderId}</code>`,
      '',
      ...lines.map((line) => {
        const extras = line.addons.length ? `\n   + ${line.addons.map((addon) => esc(clip(addon.name, 60))).join(', ')}` : '';
        return `• ${esc(line.name)} — ${ghs(line.lineTotal)}${extras}`;
      }),
      '',
      `<b>Total (cash on delivery):</b> ${ghs(total)}`,
      '',
      `<b>Name:</b> ${esc(name)}`,
      `<b>Phone:</b> ${esc(phone)}`,
      `<b>Deliver to:</b> ${esc(location)}`,
      notes ? `<b>Notes:</b> ${esc(notes)}` : null,
    ].filter(Boolean).join('\n');

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      const message = payload.description || 'Could not reach the kitchen. Please try again.';
      return res.status(502).json({ error: message });
    }

    res.status(200).json({ ok: true, orderId });
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
