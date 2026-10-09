// Shared Telegram helpers: calling the API, formatting messages, building the status buttons.
const { KINDS, getRecord, listComplaintsByOrder } = require('./store');

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

// "8 Oct, 14:05" - short, for lists
const when = (ts) =>
  new Date(ts).toLocaleString('en-GB', {
    timeZone: 'Africa/Accra',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

// "Thu, 8 Oct 2026, 14:05" - full date and time, for the order / complaint message
const whenFull = (ts) =>
  new Date(ts).toLocaleString('en-GB', {
    timeZone: 'Africa/Accra',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

// Buttons under the message. The current status gets a • in front.
// callback_data looks like  o|SK-7KQ4MX|completed  (Telegram allows up to 64 bytes)
// extraButtons are shortcut buttons to a linked order / complaint:  v|SK-7KQ4MX
function keyboard(kind, rec, extraButtons = []) {
  const K = KINDS[kind];
  const rows = K.buttons.map((row) =>
    row.map((s) => ({
      text: (rec.status === s ? '• ' : '') + K.statuses[s],
      callback_data: `${K.code}|${rec.id}|${s}`,
    }))
  );
  extraButtons.forEach((b) => rows.push([b]));
  return { inline_keyboard: rows };
}

// The message body, an optional linked-record block, then a status line at the bottom
function renderMessage(kind, rec, extra = '') {
  const K = KINDS[kind];
  const last = (rec.history || []).slice(-1)[0];
  let t = rec.text;
  if (extra) t += `\n\n${extra}`;
  t += `\n\n<b>Status:</b> ${K.statuses[rec.status]}`;
  if (last) t += ` — ${esc(last.by)}, ${when(last.at)}`;
  return t;
}

// One line per record for /orders, /pending, /complaints
function summaryLine(kind, r) {
  const K = KINDS[kind];
  const extra =
    kind === 'order'
      ? ` · GHS ${Number(r.total).toFixed(2)}`
      : `${r.orderId ? ` · order ${esc(r.orderId)}` : ''} · ${esc(String(r.message || '').slice(0, 40))}…`;
  return `${K.statuses[r.status]}  <code>${r.id}</code>${extra} · ${esc(r.customer.name)} · ${when(r.createdAt)}`;
}

// The link between the two:
//  - a complaint shows the order it is about (looked up live, so the status is current)
//  - an order shows any complaints made about it
async function linkInfo(kind, rec) {
  try {
    if (kind === 'complaint') {
      if (!rec.orderId) return { text: '', buttons: [] };
      const o = await getRecord('order', rec.orderId);
      if (!o) return { text: '', buttons: [] }; // (the complaint text already says if the order wasn't found)
      const items = (o.items || [])
        .map((i) => `• ${esc(i.name)}${i.addons && i.addons.length ? ' + ' + i.addons.map(esc).join(', ') : ''}`)
        .join('\n');
      const text = [
        `📦 <b>Linked order:</b> <code>${o.id}</code> — ${KINDS.order.statuses[o.status]}`,
        `Placed ${whenFull(o.createdAt)} · Total GHS ${Number(o.total).toFixed(2)}`,
        items,
        `Ordered by ${esc(o.customer.name)} (${esc(o.customer.phone)})`,
      ]
        .filter(Boolean)
        .join('\n');
      return { text, buttons: [{ text: `📦 Open order ${o.id}`, callback_data: `v|${o.id}` }] };
    }

    const list = await listComplaintsByOrder(rec.id);
    if (!list.length) return { text: '', buttons: [] };
    return {
      text: `⚠️ <b>Complaints about this order (${list.length}):</b>\n${list.map((c) => summaryLine('complaint', c)).join('\n')}`,
      buttons: list.slice(0, 3).map((c) => ({ text: `⚠️ Open ${c.id}`, callback_data: `v|${c.id}` })),
    };
  } catch (err) {
    console.error('linkInfo failed:', err);
    return { text: '', buttons: [] };
  }
}

// Message text + buttons including the linked order / complaints
async function renderFull(kind, rec) {
  const info = await linkInfo(kind, rec);
  let text = renderMessage(kind, rec, info.text);
  if (text.length > 4000) text = renderMessage(kind, rec); // Telegram's limit is 4096 characters
  return { text, reply_markup: keyboard(kind, rec, info.buttons) };
}

module.exports = { esc, tg, when, whenFull, keyboard, renderMessage, summaryLine, linkInfo, renderFull };
