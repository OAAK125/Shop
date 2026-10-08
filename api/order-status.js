// Vercel serverless function: POST /api/order-status
// Body: { orderId: "SK-7KQ4MX", phone: "024 123 4567" }
// Lets a customer check where their order is. They must give the order ID AND the phone number
// they ordered with. Only the status is returned - never the address, items or name.
// Uses the same Supabase env vars as the other functions (see lib/store.js).

const { getRecord } = require('../lib/store');

const digits = (v) => String(v ?? '').replace(/\D/g, '');
// 0241234567, 024 123 4567 and +233241234567 all end in the same 9 digits
const last9 = (v) => digits(v).slice(-9);

// What the customer sees for each internal status
const CUSTOMER_VIEW = {
  new:       { step: 0, label: 'Order received', message: "We've got your order and will call you shortly to confirm it." },
  confirmed: { step: 1, label: 'Confirmed', message: 'Your order is confirmed and is being prepared.' },
  out:       { step: 2, label: 'On the way', message: 'Your order is out for delivery. Please keep your phone close.' },
  completed: { step: 3, label: 'Delivered', message: 'Your order has been delivered. Enjoy your meal!' },
  cancelled: { step: -1, label: 'Cancelled', message: 'This order was cancelled. Please call us if you think this is a mistake.' },
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  let orderId = String(body.orderId ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z0-9]{6}$/.test(orderId)) orderId = 'SK-' + orderId;
  const phone = String(body.phone ?? '').trim();

  if (!/^SK-[A-Z0-9]{6}$/.test(orderId) || !/^[0-9+\s-]{9,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Please enter a valid order ID and phone number.' });
  }

  let rec;
  try {
    rec = await getRecord('order', orderId);
  } catch (err) {
    console.error('order-status lookup failed:', err);
    return res.status(502).json({ error: 'Could not check your order right now. Please try again.' });
  }

  // Same answer whether the ID is wrong or the phone is wrong, so nobody can probe for valid IDs
  if (!rec || last9(rec.customer.phone) !== last9(phone)) {
    return res.status(404).json({
      error: "We couldn't find an order with that ID and phone number. Please check both and try again.",
    });
  }

  const view = CUSTOMER_VIEW[rec.status] || CUSTOMER_VIEW.new;
  const last = (rec.history || []).slice(-1)[0];
  return res.status(200).json({
    ok: true,
    orderId: rec.id,
    status: rec.status,
    step: view.step,
    label: view.label,
    message: view.message,
    placedAt: rec.createdAt,
    updatedAt: last ? last.at : rec.createdAt,
  });
};
