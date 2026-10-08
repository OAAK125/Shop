// Shared Telegram helpers: calling the API, formatting messages, building the status buttons.
const { KINDS } = require('./store');

const esc = (v) =>
  String(v ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

const when = (ts) =>
  new Date(ts).toLocaleString('en-GB', {
    timeZone: 'Africa/Accra',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

// Buttons under the message. The current status gets a • in front.
// callback_data looks like  o|SK-7KQ4MX|completed  (Telegram allows up to 64 bytes)
function keyboard(kind, rec) {
  const K = KINDS[kind];
  return {
    inline_keyboard: K.buttons.map((row) =>
      row.map((s) => ({
        text: (rec.status === s ? '• ' : '') + K.statuses[s],
        callback_data: `${K.code}|${rec.id}|${s}`,
      }))
    ),
  };
}

// The message body plus a status line at the bottom
function renderMessage(kind, rec) {
  const K = KINDS[kind];
  const last = (rec.history || []).slice(-1)[0];
  let t = `${rec.text}\n\n<b>Status:</b> ${K.statuses[rec.status]}`;
  if (last) t += ` — ${esc(last.by)}, ${when(last.at)}`;
  return t;
}

// One line per record for /orders, /pending, /complaints
function summaryLine(kind, r) {
  const K = KINDS[kind];
  const extra =
    kind === 'order'
      ? ` · GHS ${Number(r.total).toFixed(2)}`
      : ` · ${esc(String(r.message || '').slice(0, 40))}…`;
  return `${K.statuses[r.status]}  <code>${r.id}</code>${extra} · ${esc(r.customer.name)} · ${when(r.createdAt)}`;
}

module.exports = { esc, tg, when, keyboard, renderMessage, summaryLine };
