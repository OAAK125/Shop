// Vercel serverless function: POST /api/send-complaint
// Uses the same env vars as send-order: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// Sends the complaint as its own Telegram message, with any photos attached right below it.

// Also needs the database (Supabase) - see lib/store.js for its env vars.
const { makeId, saveRecord } = require('../lib/store');
const { esc, keyboard, renderMessage } = require('../lib/telegram');

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1024 * 1024; // 1 MB each (the browser compresses to ~900 KB or less)

function decodeImage(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  // JPEG files start with FF D8 FF
  if (buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return null;
  return buf;
}

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
  const name = clip(c.name, 80);
  const phone = clip(c.phone, 20);
  const message = clip(body.message, 1000);
  const orderId = clip(body.orderId, 12).toUpperCase();

  if (name.length < 2 || !/^[0-9+\s-]{9,15}$/.test(phone) || message.length < 10) {
    return res.status(400).json({ error: 'Invalid complaint.' });
  }
  if (orderId && !/^SK-[A-Z0-9]{6}$/.test(orderId)) {
    return res.status(400).json({ error: 'Invalid order ID.' });
  }

  const rawImages = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
  const images = rawImages.map(decodeImage);
  if (images.some((b) => b === null)) {
    return res.status(400).json({ error: 'One of the photos could not be used.' });
  }

  const complaintId = makeId('CP'); // short ID like CP-4TH9ZA

  const text = [
    '⚠️ <b>New complaint</b>',
    `<b>Complaint ID:</b> <code>${complaintId}</code>`,
    images.length ? `📎 ${images.length} photo${images.length > 1 ? 's' : ''} attached below` : null,
    '',
    `<b>Name:</b> ${esc(name)}`,
    `<b>Phone:</b> ${esc(phone)}`,
    `<b>Order ID:</b> ${orderId ? `<code>${orderId}</code>` : 'not provided'}`,
    '',
    '<b>Complaint:</b>',
    esc(message),
  ]
    .filter((x) => x !== null)
    .join('\n');

  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;

  // 1a) Save the complaint (kept 90 days, then deleted automatically)
  const rec = {
    id: complaintId,
    createdAt: Date.now(),
    status: 'open',
    customer: { name, phone },
    orderId: orderId || null,
    message,
    imageCount: images.length,
    text,
    history: [],
  };
  let saved = true;
  try {
    await saveRecord('complaint', rec);
  } catch (err) {
    saved = false; // still deliver it to the kitchen
    console.error('Could not save complaint:', err);
  }

  // 1b) The complaint text, as its own message (with status buttons if saved)
  let messageId;
  try {
    const r = await fetch(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: saved ? renderMessage('complaint', rec) : `${text}\n\n⚠️ <i>Not saved to the database - no status buttons for this one.</i>`,
        parse_mode: 'HTML',
        ...(saved ? { reply_markup: keyboard('complaint', rec) } : {}),
      }),
    });
    if (!r.ok) {
      console.error('Telegram sendMessage error:', r.status, await r.text());
      return res.status(502).json({ error: 'Could not send your complaint. Please try again.' });
    }
    messageId = (await r.json()).result.message_id;
  } catch (err) {
    console.error(err);
    return res.status(502).json({ error: 'Could not send your complaint. Please try again.' });
  }

  // 2) Photos (if any), posted as a reply to the complaint
  let imagesFailed = false;
  if (images.length) {
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('reply_parameters', JSON.stringify({ message_id: messageId }));

      let method;
      if (images.length === 1) {
        method = 'sendPhoto';
        form.append('photo', new Blob([images[0]], { type: 'image/jpeg' }), 'photo1.jpg');
      } else {
        method = 'sendMediaGroup';
        form.append(
          'media',
          JSON.stringify(images.map((_, i) => ({ type: 'photo', media: `attach://photo${i}` })))
        );
        images.forEach((buf, i) =>
          form.append(`photo${i}`, new Blob([buf], { type: 'image/jpeg' }), `photo${i + 1}.jpg`)
        );
      }

      const r = await fetch(api(method), { method: 'POST', body: form });
      if (!r.ok) {
        console.error('Telegram photo error:', r.status, await r.text());
        imagesFailed = true;
      }
    } catch (err) {
      console.error(err);
      imagesFailed = true;
    }
  }

  return res.status(200).json({ ok: true, imagesFailed });
};
