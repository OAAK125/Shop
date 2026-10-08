// Database layer for orders + complaints, using Supabase (Postgres) through its REST API.
// No npm packages needed. Only used on the server - never put these keys in index.html.
//
// Env vars (Vercel -> Settings -> Environment Variables):
//   SUPABASE_URL                  e.g. https://abcdxyz.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY     the "service_role" (legacy) or "secret" key from Supabase -> Project Settings -> API
//
// Tables are created by supabase/schema.sql. Records older than 90 days are deleted automatically.

const crypto = require('crypto');

const TTL_DAYS = 90;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;

// Short, easy-to-read IDs (no 0/O/1/I): SK-7KQ4MX for orders, CP-4TH9ZA for complaints
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function makeId(prefix) {
  const bytes = crypto.randomBytes(6);
  let id = '';
  for (let i = 0; i < 6; i++) id += ALPHABET[bytes[i] % ALPHABET.length];
  return `${prefix}-${id}`;
}

// ---------- tiny PostgREST client ----------
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error('Database is not configured.');
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Legacy keys are JWTs and go in Authorization too; the newer sb_secret_ keys use apikey only.
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  if (prefer) headers.Prefer = prefer;
  const r = await fetch(`${base.replace(/\/$/, '')}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// ---------- what each kind of record looks like ----------
const KINDS = {
  order: {
    code: 'o',
    table: 'orders',
    statuses: {
      new: '🆕 New',
      confirmed: '✔️ Confirmed',
      out: '🚴 Out for delivery',
      completed: '✅ Completed',
      cancelled: '❌ Cancelled',
    },
    buttons: [['confirmed', 'out'], ['completed', 'cancelled']],
    open: ['new', 'confirmed', 'out'],
    toRow: (r) => ({
      id: r.id,
      created_at: new Date(r.createdAt).toISOString(),
      status: r.status,
      customer_name: r.customer.name,
      customer_phone: r.customer.phone,
      delivery_location: r.customer.location,
      notes: r.customer.notes || null,
      items: r.items,
      total: r.total,
      telegram_text: r.text,
      history: r.history || [],
    }),
    fromRow: (x) => ({
      id: x.id,
      createdAt: Date.parse(x.created_at),
      status: x.status,
      customer: { name: x.customer_name, phone: x.customer_phone, location: x.delivery_location, notes: x.notes || '' },
      items: x.items || [],
      total: Number(x.total),
      text: x.telegram_text || '',
      history: x.history || [],
    }),
  },
  complaint: {
    code: 'c',
    table: 'complaints',
    statuses: {
      open: '🆕 Open',
      reviewing: '🔎 In progress',
      resolved: '✅ Resolved',
      dismissed: '🚫 Dismissed',
    },
    buttons: [['reviewing', 'resolved'], ['dismissed']],
    open: ['open', 'reviewing'],
    toRow: (r) => ({
      id: r.id,
      created_at: new Date(r.createdAt).toISOString(),
      status: r.status,
      customer_name: r.customer.name,
      customer_phone: r.customer.phone,
      order_id: r.orderId || null,
      message: r.message,
      image_count: r.imageCount || 0,
      telegram_text: r.text,
      history: r.history || [],
    }),
    fromRow: (x) => ({
      id: x.id,
      createdAt: Date.parse(x.created_at),
      status: x.status,
      customer: { name: x.customer_name, phone: x.customer_phone },
      orderId: x.order_id || null,
      message: x.message,
      imageCount: x.image_count || 0,
      text: x.telegram_text || '',
      history: x.history || [],
    }),
  },
};
const KIND_BY_CODE = { o: 'order', c: 'complaint' };

// ---------- the functions the rest of the app uses ----------

// Save a new record, and quietly clear out anything older than 90 days.
async function saveRecord(kind, rec) {
  const K = KINDS[kind];
  await sb(K.table, { method: 'POST', body: K.toRow(rec), prefer: 'return=minimal' });
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  sb(`${K.table}?created_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE', prefer: 'return=minimal' }).catch((e) =>
    console.error('Purge failed:', e.message)
  );
}

async function getRecord(kind, id) {
  const K = KINDS[kind];
  const rows = await sb(`${K.table}?id=eq.${encodeURIComponent(id)}&select=*&limit=1`);
  return rows && rows[0] ? K.fromRow(rows[0]) : null;
}

// Change the status. Returns the updated record, or null if it no longer exists.
async function setStatus(kind, id, status, by) {
  const K = KINDS[kind];
  const rec = await getRecord(kind, id);
  if (!rec) return null;
  const history = [...(rec.history || []), { status, at: Date.now(), by: by || 'staff' }];
  const rows = await sb(`${K.table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { status, history },
    prefer: 'return=representation',
  });
  return rows && rows[0] ? K.fromRow(rows[0]) : null;
}

// Newest first. Optionally keep only some statuses.
async function listRecords(kind, { statuses, limit = 10 } = {}) {
  const K = KINDS[kind];
  let q = `${K.table}?select=*&order=created_at.desc&limit=${Number(limit) || 10}`;
  if (statuses && statuses.length) q += `&status=in.(${statuses.join(',')})`;
  const rows = await sb(q);
  return (rows || []).map(K.fromRow);
}

module.exports = { TTL_DAYS, KINDS, KIND_BY_CODE, makeId, saveRecord, getRecord, setStatus, listRecords };
