// Vercel serverless function: POST /api/telegram-webhook
// Telegram calls this when the owner taps a status button or sends a command to the bot.
// Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET
// Optional: TELEGRAM_ALLOWED_USER_IDS  (comma-separated Telegram user IDs; use this if the chat is a group)

const { KINDS, KIND_BY_CODE, setStatus, getRecord, listRecords, TTL_DAYS } = require('../lib/store');
const { esc, tg, summaryLine, renderFull } = require('../lib/telegram');

const isAllowed = (chatId, userId) => {
  if (String(chatId) !== String(process.env.TELEGRAM_CHAT_ID)) return false;
  const list = (process.env.TELEGRAM_ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(userId));
};

const personName = (u) => (u && (u.first_name || u.username)) || 'staff';

async function onCallback(cq) {
  const chatId = cq.message && cq.message.chat && cq.message.chat.id;
  if (!isAllowed(chatId, cq.from && cq.from.id)) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Not allowed.', show_alert: true });
  }

  const [code, id, status] = String(cq.data || '').split('|');

  // "Open order" / "Open complaint" shortcut buttons: send that record as a new message
  if (code === 'v') {
    const viewKind = String(id).startsWith('CP-') ? 'complaint' : String(id).startsWith('SK-') ? 'order' : null;
    const target = viewKind ? await getRecord(viewKind, id) : null;
    if (!target) {
      return tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `${id} is no longer stored (records are kept ${TTL_DAYS} days).`,
        show_alert: true,
      });
    }
    const view = await renderFull(viewKind, target);
    await tg('sendMessage', { chat_id: chatId, text: view.text, parse_mode: 'HTML', reply_markup: view.reply_markup });
    return tg('answerCallbackQuery', { callback_query_id: cq.id });
  }

  const kind = KIND_BY_CODE[code];
  if (!kind || !KINDS[kind].statuses[status] || !id) {
    return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Unknown action.' });
  }

  const rec = await setStatus(kind, id, status, personName(cq.from));
  if (!rec) {
    return tg('answerCallbackQuery', {
      callback_query_id: cq.id,
      text: `${id} is no longer stored (records are kept ${TTL_DAYS} days).`,
      show_alert: true,
    });
  }

  const full = await renderFull(kind, rec); // keeps the linked order / complaints on the message
  await tg('editMessageText', {
    chat_id: chatId,
    message_id: cq.message.message_id,
    text: full.text,
    parse_mode: 'HTML',
    reply_markup: full.reply_markup,
  }); // "message is not modified" (same button tapped twice) is harmless
  return tg('answerCallbackQuery', { callback_query_id: cq.id, text: `Marked: ${KINDS[kind].statuses[status]}` });
}

const HELP = [
  '<b>Sohan Kitchen bot</b>',
  '',
  '/pending – orders still to be done',
  '/orders – latest 10 orders',
  '/order SK-XXXXXX – open one order (with any complaints about it)',
  '/complaints – open complaints',
  '/complaint CP-XXXXXX – open one complaint (with the order it is about)',
  '',
  `Orders and complaints are kept for ${TTL_DAYS} days, then deleted automatically.`,
].join('\n');

async function onMessage(msg) {
  if (!isAllowed(msg.chat.id, msg.from && msg.from.id)) return;
  const parts = String(msg.text || '').trim().split(/\s+/);
  const cmd = parts[0].split('@')[0].toLowerCase();
  const arg = (parts[1] || '').toUpperCase();
  const reply = (text, extra = {}) =>
    tg('sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

  const showList = async (kind, title, opts) => {
    const rows = await listRecords(kind, opts);
    if (!rows.length) return reply(`${title}\n\nNothing here.`);
    const hint = kind === 'order' ? '/order SK-XXXXXX' : '/complaint CP-XXXXXX';
    return reply(`${title}\n\n${rows.map((r) => summaryLine(kind, r)).join('\n')}\n\nOpen one with ${hint}`);
  };

  const showOne = async (kind, id, example) => {
    if (!id) return reply(`Send it like this: ${example}`);
    const rec = await getRecord(kind, id);
    if (!rec) return reply(`Couldn't find <code>${esc(id)}</code>. It may be older than ${TTL_DAYS} days.`);
    const full = await renderFull(kind, rec);
    return reply(full.text, { reply_markup: full.reply_markup });
  };

  switch (cmd) {
    case '/start':
    case '/help':
      return reply(HELP);
    case '/pending':
      return showList('order', '<b>Orders to do</b>', { statuses: KINDS.order.open, limit: 15 });
    case '/orders':
      return showList('order', '<b>Latest orders</b>', { limit: 10 });
    case '/order':
      return showOne('order', arg, '/order SK-7KQ4MX');
    case '/complaints':
      return showList('complaint', '<b>Open complaints</b>', { statuses: KINDS.complaint.open, limit: 15 });
    case '/complaint':
      return showOne('complaint', arg, '/complaint CP-4TH9ZA');
    default:
      return; // ignore normal chat
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Only Telegram knows this secret (we give it to Telegram when setting the webhook)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let update;
  try {
    update = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    return res.status(200).json({ ok: true });
  }

  try {
    if (update.callback_query) await onCallback(update.callback_query);
    else if (update.message && update.message.text) await onMessage(update.message);
  } catch (err) {
    console.error('Webhook error:', err);
  }
  // Always answer 200, otherwise Telegram keeps re-sending the same update
  return res.status(200).json({ ok: true });
};
