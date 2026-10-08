// Vercel serverless function: POST /api/send-order
// Env vars (set in Vercel dashboard): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

// Also needs the database (Supabase) - see lib/store.js for its env vars.
const { makeId, saveRecord } = require('../lib/store');
const { esc, keyboard, renderMessage } = require('../lib/telegram');

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return res.status(500).json({ error: 'Server is not configured.' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const c = body.customer || {};
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];

  const name = clip(c.name, 80);
  const phone = clip(c.phone, 20);
  const location = clip(c.location, 200);
  const notes = clip(c.notes, 300);

  if (name.length < 2 || !/^[0-9+\s-]{9,15}$/.test(phone) || location.length < 4 || items.length === 0) {
    return res.status(400).json({ error: 'Invalid order.' });
  }

  const lines = items.map((i) => {
    const addons = Array.isArray(i.addons) ? i.addons : [];
    const lineTotal = Number(i.base || 0) + addons.reduce((s, a) => s + Number(a.price || 0), 0);
    return { name: clip(i.name, 80), addons, lineTotal };
  });
  const total = lines.reduce((s, l) => s + l.lineTotal, 0);
  const ghs = (n) => 'GHS ' + Number(n).toFixed(2);
  const orderId = makeId('SK'); // short ID like SK-7KQ4MX

  const text = [
    '🍽 <b>New Sohan Kitchen order</b>',
    `<b>Order ID:</b> <code>${orderId}</code>`,
    '',
    ...lines.map((l) => {
      const extras = l.addons.length ? `\n   + ${l.addons.map((a) => esc(clip(a.name, 60))).join(', ')}` : '';
      return `• ${esc(l.name)} — ${ghs(l.lineTotal)}${extras}`;
    }),
    '',
    `<b>Total (cash on delivery):</b> ${ghs(total)}`,
    '',
    `<b>Name:</b> ${esc(name)}`,
    `<b>Phone:</b> ${esc(phone)}`,
    `<b>Deliver to:</b> ${esc(location)}`,
    notes ? `<b>Notes:</b> ${esc(notes)}` : null,
  ]
    .filter((x) => x !== null)
    .join('\n');

  // 1) Save the order (kept 90 days, then deleted automatically)
  const rec = {
    id: orderId,
    createdAt: Date.now(),
    status: 'new',
    customer: { name, phone, location, notes },
    items: lines.map((l) => ({ name: l.name, addons: l.addons.map((a) => clip(a.name, 60)), lineTotal: l.lineTotal })),
    total,
    text,
    history: [],
  };
  let saved = true;
  try {
    await saveRecord('order', rec);
  } catch (err) {
    // Don't lose the order just because the database hiccuped - still tell the kitchen.
    saved = false;
    console.error('Could not save order:', err);
  }

  // 2) Send it to Telegram, with the status buttons if it was saved
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: saved ? renderMessage('order', rec) : `${text}\n\n⚠️ <i>Not saved to the database - no status buttons for this one.</i>`,
        parse_mode: 'HTML',
        ...(saved ? { reply_markup: keyboard('order', rec) } : {}),
      }),
    });
    if (!r.ok) {
      console.error('Telegram error:', r.status, JSON.stringify(r.data));
      return res.status(502).json({ error: 'Could not reach the kitchen. Please try again.' });
    }
    return res.status(200).json({ ok: true, orderId });
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Could not reach the kitchen. Please try again.' });
  }
};
