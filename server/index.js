import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();

// ===== ENV =====
const XENDIT_SECRET = process.env.XENDIT_SECRET || "xnd_development_b0CEzfjRaR1hLciZx1ugk8F0qj0Hi2JLdqVbMQSlgy4I7msYq0omp7QJOM6ahh";     // ex: xnd_development_...
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || "OsWXMrBsDDvLT6cNSqMxutJr7DjJHU347jboTXn01JoOsF6N";     // ex: OsWXMr...
const DEBUG_WEBHOOK_URL = process.env.DEBUG_WEBHOOK_URL || "https://webhook.site/94a2a1ba-af9a-4a55-ba21-5083f7bbf3dc"; // webhook.site (VIEW URL)

// ===== MID =====
app.use(helmet());
app.use(cors()); // boleh dibatasi origin kalau perlu
app.use(express.json({ limit: '1mb' })); // Xendit kirim JSON
app.use(morgan('tiny'));

// ===== HELPERS =====
const authHeader = "Basic " + Buffer.from(`${XENDIT_SECRET}:`).toString("base64");
const isPaid = s => ["PAID","SUCCEEDED"].includes(String(s||"").toUpperCase());

// Riwayat (in-memory dev). Untuk produksi, ganti DB.
const history = new Map(); // ref_id -> tx
const upsertTx = (ref, patch) => {
  const prev = history.get(ref) || { reference_id: ref, status: 'PENDING', created_at: new Date().toISOString() };
  history.set(ref, { ...prev, ...patch });
};
const listTx = (n=20) => Array.from(history.values())
  .sort((a,b)=>(b.created_at||"").localeCompare(a.created_at||""))
  .slice(0,n);

// ===== HEALTH =====
app.get('/', (_req, res) => res.type('text').send('LevPay API OK'));
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ===== CREATE QRIS (amount custom) =====
app.post('/api/payments', async (req, res) => {
  try {
    const { method = 'qris', amount, order_id, webhook_url } = req.body || {};

    if (method !== 'qris') return res.status(400).json({ error: "Only 'qris' supported" });

    const amt = Number(amount);
    if (!Number.isFinite(amt) || Math.floor(amt)!==amt || amt < 1000 || amt > 10_000_000) {
      return res.status(400).json({ error: "Amount harus integer 1.000–10.000.000" });
    }

    const reference_id = String(order_id || `ORD-${Date.now()}`);

    const r = await fetch('https://api.xendit.co/qr_codes', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reference_id,
        type: 'DYNAMIC',
        currency: 'IDR',
        amount: amt
        // NOTE: webhook QRIS pakai global Webhooks di dashboard; field callback_url tidak dipakai di sini.
      })
    });

    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'xendit_error', detail: d });

    // simpan riwayat lokal (dev)
    upsertTx(reference_id, {
      method: 'qris',
      amount: amt,
      status: 'PENDING',
      qr_id: d.id,
      webhook_url: webhook_url || null // untuk catatan saja
    });

    return res.json({
      ok: true,
      reference_id,
      amount: amt,
      qris: {
        id: d.id,
        status: d.status,
        qr_string: d.qr_string,
        image_url: d.image_url,
        expires_at: d.expires_at || null
      },
      links: { status: `/api/qris/${d.id}` }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ===== POLLING STATUS BY qr_id =====
app.get('/api/qris/:qr_id', async (req, res) => {
  try {
    const r = await fetch(`https://api.xendit.co/qr_codes/${req.params.qr_id}`, {
      headers: { 'Authorization': authHeader }
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json(d);

    const ref = d.reference_id;
    if (ref) {
      const patch = { status: (d.status||'').toUpperCase() };
      if (isPaid(d.status)) patch.paid_at = new Date().toISOString();
      upsertTx(ref, patch);
    }

    res.json({
      id: d.id,
      status: d.status,
      amount: d.amount,
      reference_id: d.reference_id,
      currency: d.currency,
      expires_at: d.expires_at || null,
      created: d.created || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal_error' });
  }
});

// ===== FALLBACK STATUS BY reference_id =====
app.get('/api/payments/:reference_id', (req, res) => {
  const tx = history.get(req.params.reference_id);
  if (!tx) return res.status(404).json({ error: 'not_found' });
  res.json(tx);
});

// ===== WEBHOOK (Xendit → server kamu) =====
app.post('/webhook/xendit', async (req, res) => {
  try {
    const token = req.headers['x-callback-token'];
    if (!WEBHOOK_TOKEN || token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ error: 'invalid_webhook_token' });
    }

    const body = req.body || {};
    const status = body.status || body.data?.status;
    const ref = body.reference_id || body.data?.reference_id || body.external_id || null;

    if (ref) {
      const patch = { status: (status||'').toUpperCase(), raw_webhook: body };
      if (isPaid(status)) patch.paid_at = new Date().toISOString();
      upsertTx(ref, patch);
    }

    // mirror ke webhook.site (debug) — optional
    if (DEBUG_WEBHOOK_URL) {
      try {
        await fetch(DEBUG_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ received_at: new Date().toISOString(), body })
        });
      } catch {}
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'webhook_error' });
  }
});

// ===== RIWAYAT =====
app.get('/api/history', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit) || 20);
  res.json(listTx(limit));
});

// ===== START =====
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 LevPay API on :${PORT}`));