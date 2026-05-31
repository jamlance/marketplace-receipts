import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import { mountAppCore, inkressApi, getInkressOrder, orderStatusName, isPaidStatus } from "@inkress/apps-core";
import { openPg } from "@inkress/apps-core/pgdb";
import { openMerchantTokens } from "@inkress/apps-core/merchant-tokens";
import { sendEmail, sesConfigured } from "@inkress/apps-core/ses";
import { documentPdf } from "@inkress/apps-core/pdf";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const WEBHOOK_SECRET = process.env.INKRESS_WEBHOOK_SECRET || "";
for (const k of ["OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "INKRESS_API_BASE"]) {
  if (!process.env[k]) { console.error(`[receipts] Missing env: ${k}`); process.exit(1); }
}

const db = await openPg("receipts", `
  CREATE TABLE IF NOT EXISTS settings (
    merchant_id BIGINT PRIMARY KEY, business_name TEXT, address TEXT, tax_id TEXT, footer TEXT,
    logo TEXT, currency TEXT NOT NULL DEFAULT 'JMD', updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS accent TEXT;
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS number_prefix TEXT NOT NULL DEFAULT 'RC';
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS number_pad INTEGER NOT NULL DEFAULT 4;
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_issue BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE settings ADD COLUMN IF NOT EXISTS auto_email BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE IF NOT EXISTS receipts (
    id BIGSERIAL PRIMARY KEY, merchant_id BIGINT NOT NULL, seq INTEGER NOT NULL, number TEXT NOT NULL,
    order_id TEXT, reference_id TEXT, token TEXT, customer_name TEXT, customer_email TEXT,
    amount NUMERIC NOT NULL, currency TEXT NOT NULL, lines JSONB NOT NULL DEFAULT '[]',
    order_date DATE, emailed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (merchant_id, order_id)
  );
  ALTER TABLE receipts ADD COLUMN IF NOT EXISTS subtotal NUMERIC;
  ALTER TABLE receipts ADD COLUMN IF NOT EXISTS discount NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE receipts ADD COLUMN IF NOT EXISTS fees NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tax NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method TEXT;
  ALTER TABLE receipts ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT false;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_rc_token ON receipts (token) WHERE token IS NOT NULL;
  CREATE TABLE IF NOT EXISTS webhook_subs (merchant_id BIGINT PRIMARY KEY, url TEXT NOT NULL, registered_at TIMESTAMPTZ NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS webhook_seen (webhook_id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ NOT NULL DEFAULT now());
`);

const app = express();
app.use("/webhooks/inkress", express.raw({ type: () => true, limit: "1mb" }));
const core = mountAppCore(app, {
  clientId: process.env.OAUTH_CLIENT_ID, clientSecret: process.env.OAUTH_CLIENT_SECRET,
  apiBaseUrl: process.env.INKRESS_API_BASE, frameAncestors: process.env.FRAME_ANCESTORS,
  staticDir: path.join(__dirname, "dist"),
  onBootstrap: (entry) => { tokens.save(entry.merchantId, entry.refreshToken).catch(() => {}); },
});
const tokens = await openMerchantTokens("receipts", core.cfg);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (...vals) => { for (const v of vals) { const n = Number(v); if (Number.isFinite(n) && n !== 0) return n; } return 0; };
const PUBLIC_BASE = (req) => process.env.PUBLIC_BASE_URL || `https://${req.get("host")}`;
const token = () => crypto.randomBytes(9).toString("base64url");

async function getSettings(mid, fallback = {}) {
  const s = await db.one(`SELECT * FROM settings WHERE merchant_id=$1`, [mid]).catch(() => null);
  return s || { merchant_id: mid, business_name: fallback.name || null, address: null, tax_id: null, footer: null, logo: fallback.logo || null, currency: fallback.currency_code || "JMD",
    accent: "#0f766e", number_prefix: "RC", number_pad: 4, auto_issue: false, auto_email: false };
}
const serializeReceipt = (r, req) => ({
  id: r.id, number: r.number, order_id: r.order_id, reference_id: r.reference_id, customer_name: r.customer_name, customer_email: r.customer_email,
  amount: Number(r.amount), currency: r.currency, lines: r.lines || [], subtotal: r.subtotal != null ? Number(r.subtotal) : null,
  discount: Number(r.discount || 0), fees: Number(r.fees || 0), tax: Number(r.tax || 0), payment_method: r.payment_method, voided: !!r.voided,
  order_date: r.order_date, emailed_at: r.emailed_at, created_at: r.created_at, public_url: r.token ? `${PUBLIC_BASE(req)}/receipt/${r.token}` : null,
  pdf_url: `${PUBLIC_BASE(req)}/api/receipts/${r.id}/pdf`,
});

// Pull the FULL native breakdown from an order: subtotal -> discount -> fees -> tax -> total.
function extractBreakdown(o) {
  const lines = (o.order_lines || o.lines || []).map((l) => ({
    title: l.title || l.name || l.product?.title || l.product_variant?.title || "Item",
    qty: Number(l.quantity || l.qty || 1),
    price: round2(num(l.price, l.unit_price, l.product_variant_total_frozen, l.product_variant?.price)),
  }));
  const total = round2(num(o.total, o.total_frozen, o.amount));
  const lineSum = round2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  const subtotal = round2(num(o.subtotal, o.subtotal_frozen, o.products_total, o.products_total_frozen, lineSum, total));
  const discount = round2(num(o.discount_total, o.discount_total_frozen, o.discount));
  const tax = round2(num(o.tax_total, o.tax_total_frozen, o.tax));
  const fulfillment = round2(num(o.fulfillment_total, o.fulfillment_total_frozen, o.delivery_total));
  const processor = round2(num(o.fees, o.fees_total, o.processing_total, o.service_total));
  const fees = round2(fulfillment + processor);
  const pmRaw = o.payment_method ?? o.payment?.method ?? o.transactions?.[0]?.payment_method ?? null;
  const method = typeof pmRaw === "string" ? pmRaw : (pmRaw?.name || pmRaw?.payment_provider?.name || pmRaw?.code || null);
  return { lines, subtotal, discount, fees, tax, total, payment_method: method ? String(method).slice(0, 60) : null };
}

async function buildReceiptFromOrder(mid, accessToken, orderId, fallback = {}) {
  let bd = null;
  try { const full = await getInkressOrder(core.cfg, accessToken, orderId); if (full) bd = extractBreakdown(full); } catch { /* */ }
  if (!bd) bd = { lines: fallback.lines || [], subtotal: round2(fallback.total), discount: 0, fees: 0, tax: 0, total: round2(fallback.total), payment_method: null };
  return bd;
}

async function issueReceipt(req, mid, accessToken, o) {
  const existing = await db.one(`SELECT * FROM receipts WHERE merchant_id=$1 AND order_id=$2`, [mid, String(o.id)]).catch(() => null);
  if (existing) return existing;
  const st = await getSettings(mid);
  const bd = await buildReceiptFromOrder(mid, accessToken, String(o.id), { lines: o.lines, total: o.total });
  const seqRow = await db.one(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM receipts WHERE merchant_id=$1`, [mid]);
  const number = `${st.number_prefix || "RC"}-${String(seqRow.s).padStart(Math.max(1, st.number_pad || 4), "0")}`;
  const row = await db.one(`INSERT INTO receipts (merchant_id, seq, number, order_id, reference_id, token, customer_name, customer_email, amount, currency, lines, order_date, subtotal, discount, fees, tax, payment_method)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [mid, seqRow.s, number, String(o.id), o.reference_id || null, token(), o.customer || null, o.email || null, round2(bd.total || o.total), o.currency || st.currency || "JMD",
      JSON.stringify(bd.lines), /^\d{4}-\d{2}-\d{2}$/.test(o.created) ? o.created : (o.created ? String(o.created).slice(0, 10) : null), bd.subtotal, bd.discount, bd.fees, bd.tax, bd.payment_method]);
  return row;
}

app.get("/api/settings", core.requireSession, async (req, res) => {
  const m = req.session.data?.merchant || {};
  const s = await getSettings(req.session.merchantId, m);
  res.json({ settings: { business_name: s.business_name, address: s.address, tax_id: s.tax_id, footer: s.footer, logo: s.logo, currency: s.currency,
    accent: s.accent || "#0f766e", number_prefix: s.number_prefix || "RC", number_pad: s.number_pad || 4, auto_issue: !!s.auto_issue, auto_email: !!s.auto_email } });
});
app.patch("/api/settings", core.requireSession, async (req, res) => {
  const b = req.body || {}; const m = req.session.data?.merchant || {};
  await db.run(`INSERT INTO settings (merchant_id, business_name, address, tax_id, footer, logo, currency, accent, number_prefix, number_pad, auto_issue, auto_email)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (merchant_id) DO UPDATE SET business_name=$2, address=$3, tax_id=$4, footer=$5, logo=$6, currency=$7, accent=$8, number_prefix=$9, number_pad=$10, auto_issue=$11, auto_email=$12, updated_at=now()`,
    [req.session.merchantId, b.business_name || m.name || null, b.address || null, b.tax_id || null, b.footer || null, b.logo || m.logo || null, m.currency_code || "JMD",
      /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : "#0f766e", String(b.number_prefix || "RC").replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "RC",
      Math.max(1, Math.min(8, Number(b.number_pad) || 4)), !!b.auto_issue, !!b.auto_email]);
  res.json({ ok: true });
});

// Paid orders with windowing + search
app.get("/api/orders", core.requireSession, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const q = String(req.query.q || "").trim();
  let orders = [], hasMore = false;
  try {
    const r = await inkressApi(core.cfg, req.session.accessToken, `orders?limit=50&page=${page}&order=id desc${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const entries = r?.result?.entries || [];
    hasMore = entries.length >= 50;
    orders = entries.map((o) => ({
      id: String(o.id), reference_id: o.reference_id || String(o.id),
      customer: o.customer?.full_name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || o.customer?.email || "Customer",
      email: o.customer?.email || null,
      total: Number(o.total || 0), currency: o.currency?.code || o.currency_code || "JMD",
      status: orderStatusName(o), paid: isPaidStatus(o), created: (o.inserted_at || "").slice(0, 10),
      lines: (o.order_lines || o.lines || []).map((l) => ({ title: l.title || l.name || l.product?.title || "Item", qty: Number(l.quantity || l.qty || 1), price: Number(l.price || l.unit_price || 0) })),
    }));
  } catch (err) { return res.status(502).json({ error: "orders_failed", message: err?.message }); }
  const issued = await db.q(`SELECT order_id FROM receipts WHERE merchant_id=$1`, [req.session.merchantId]);
  const issuedSet = new Set(issued.map((r) => r.order_id));
  res.json({ orders: orders.map((o) => ({ ...o, receipted: issuedSet.has(o.id) })), page, has_more: hasMore });
});

app.post("/api/receipts", core.requireSession, async (req, res) => {
  const b = req.body || {};
  const orderId = String(b.order_id || "");
  if (!orderId) return res.status(400).json({ error: "no_order" });
  const row = await issueReceipt(req, req.session.merchantId, req.session.accessToken,
    { id: orderId, reference_id: b.reference_id, customer: b.customer, email: b.email, total: b.total, currency: b.currency, lines: b.lines, created: b.created });
  res.status(201).json({ receipt: serializeReceipt(row, req) });
});

// Bulk-issue receipts for a list of order_ids
app.post("/api/receipts/bulk", core.requireSession, async (req, res) => {
  const ids = Array.isArray(req.body?.orders) ? req.body.orders.slice(0, 100) : [];
  if (!ids.length) return res.status(400).json({ error: "no_orders" });
  let issued = 0;
  for (const o of ids) {
    try { await issueReceipt(req, req.session.merchantId, req.session.accessToken, { id: String(o.order_id || o.id), reference_id: o.reference_id, customer: o.customer, email: o.email, total: o.total, currency: o.currency, lines: o.lines, created: o.created }); issued++; }
    catch { /* */ }
  }
  res.json({ issued });
});

app.get("/api/receipts", core.requireSession, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  let rows = await db.q(`SELECT * FROM receipts WHERE merchant_id=$1 ORDER BY created_at DESC`, [req.session.merchantId]);
  if (from) rows = rows.filter((r) => (r.order_date || r.created_at?.toISOString?.()?.slice(0, 10) || "") >= from);
  if (to) rows = rows.filter((r) => (r.order_date || r.created_at?.toISOString?.()?.slice(0, 10) || "") <= to);
  if (q) rows = rows.filter((r) => [r.number, r.customer_name, r.customer_email, r.reference_id].some((s) => (s || "").toLowerCase().includes(q)));
  res.json({ receipts: rows.map((r) => serializeReceipt(r, req)) });
});

// Tax / fees collected summary for a period
app.get("/api/summary", core.requireSession, async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : null;
  let rows = await db.q(`SELECT * FROM receipts WHERE merchant_id=$1 AND voided=false`, [req.session.merchantId]);
  if (from) rows = rows.filter((r) => (r.order_date || "") >= from);
  if (to) rows = rows.filter((r) => (r.order_date || "") <= to);
  const sum = (k) => round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));
  res.json({ count: rows.length, currency: rows[0]?.currency || "JMD", subtotal: sum("subtotal"), discount: sum("discount"), fees: sum("fees"), tax: sum("tax"), total: sum("amount") });
});

// Void (financial docs: void + reissue, never silent edit)
app.patch("/api/receipts/:id", core.requireSession, async (req, res) => {
  const r = await db.one(`SELECT * FROM receipts WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!r) return res.status(404).json({ error: "not_found" });
  if (req.body?.voided === true) { const u = await db.one(`UPDATE receipts SET voided=true WHERE id=$1 RETURNING *`, [r.id]); return res.json({ receipt: serializeReceipt(u, req) }); }
  res.status(400).json({ error: "unsupported", message: "Receipts can only be voided, not edited — re-issue from the order." });
});

app.post("/api/receipts/:id/email", core.requireSession, async (req, res) => {
  const r = await db.one(`SELECT * FROM receipts WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!r) return res.status(404).json({ error: "not_found" });
  if (!r.customer_email) return res.status(400).json({ error: "no_email", message: "This order has no customer email." });
  if (!sesConfigured()) return res.json({ emailed: false });
  const s = await getSettings(req.session.merchantId);
  await sendEmail({ to: r.customer_email, subject: `Receipt ${r.number} from ${s.business_name || "us"}`, html: receiptEmail(s, r, `${PUBLIC_BASE(req)}/receipt/${r.token}`) }).catch(() => {});
  await db.run(`UPDATE receipts SET emailed_at=now() WHERE id=$1`, [r.id]);
  res.json({ emailed: true });
});

// PDF (merchant)
app.get("/api/receipts/:id/pdf", core.requireSession, async (req, res) => {
  const r = await db.one(`SELECT * FROM receipts WHERE id=$1 AND merchant_id=$2`, [req.params.id, req.session.merchantId]);
  if (!r) return res.status(404).json({ error: "not_found" });
  const s = await getSettings(r.merchant_id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${r.number}.pdf"`);
  res.send(Buffer.from(await receiptPdf(s, r)));
});

// CSV export
app.get("/api/receipts.csv", core.requireSession, async (req, res) => {
  const rows = await db.q(`SELECT * FROM receipts WHERE merchant_id=$1 ORDER BY created_at DESC`, [req.session.merchantId]);
  const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const head = ["number", "order_ref", "status", "customer", "email", "currency", "subtotal", "discount", "fees", "tax", "total", "order_date", "created_at"];
  const lines = rows.map((r) => [r.number, r.reference_id, r.voided ? "void" : "issued", r.customer_name, r.customer_email, r.currency, r.subtotal, r.discount, r.fees, r.tax, r.amount, r.order_date || "", r.created_at?.toISOString?.() || r.created_at].map(esc).join(","));
  res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", `attachment; filename="receipts.csv"`);
  res.send([head.join(","), ...lines].join("\n"));
});

// Webhook self-registration status
app.get("/api/status", core.requireSession, async (req, res) => {
  const mid = req.session.merchantId;
  let sub = await db.one(`SELECT * FROM webhook_subs WHERE merchant_id=$1`, [mid]);
  const canRegister = WEBHOOK_SECRET && (req.session.scope || []).includes("webhooks:manage");
  if (!sub && canRegister) {
    const url = `${PUBLIC_BASE(req)}/webhooks/inkress/${mid}`;
    try {
      await inkressApi(core.cfg, req.session.accessToken, `webhook_urls`, { method: "POST", body: JSON.stringify({ url, event: "orders" }) });
      await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET url=$2`, [mid, url]); sub = { merchant_id: mid, url };
    } catch (err) { if (String(err?.message || "").match(/already|unique|exist|422/i)) { await db.run(`INSERT INTO webhook_subs (merchant_id, url) VALUES ($1,$2) ON CONFLICT (merchant_id) DO NOTHING`, [mid, url]); sub = { merchant_id: mid, url }; } }
  }
  res.json({ realtime: Boolean(sub) && Boolean(WEBHOOK_SECRET), webhook_registered: Boolean(sub), can_register: Boolean(canRegister), webhook_secret_configured: Boolean(WEBHOOK_SECRET) });
});

// Public receipt page + PDF
app.get("/receipt/:token", async (req, res) => {
  const r = await db.one(`SELECT * FROM receipts WHERE token=$1`, [req.params.token]).catch(() => null);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (!r || r.voided) return res.status(404).send(publicShell("Not found", `<div class="pad"><h1>Receipt not found</h1></div>`));
  const s = await getSettings(r.merchant_id);
  res.send(receiptPage(s, r));
});
app.get("/receipt/:token/pdf", async (req, res) => {
  const r = await db.one(`SELECT * FROM receipts WHERE token=$1`, [req.params.token]).catch(() => null);
  if (!r || r.voided) return res.status(404).send("Not found");
  const s = await getSettings(r.merchant_id);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${r.number}.pdf"`);
  res.send(Buffer.from(await receiptPdf(s, r)));
});

// Webhook receiver — auto-issue receipt on payment (+ optional auto-email)
app.post("/webhooks/inkress/:merchantId", async (req, res) => {
  const merchantId = Number(req.params.merchantId);
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
  if (WEBHOOK_SECRET) {
    const expected = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("base64");
    const got = String(req.get("x-inkress-webhook-signature") || "");
    const a = Buffer.from(expected), b = Buffer.from(got);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "bad_signature" });
  }
  res.json({ received: true });
  try {
    const evt = JSON.parse(raw.toString("utf8"));
    const o = evt?.order || evt?.data?.order;
    if (!o || !merchantId || String(o.status || "").toLowerCase() !== "paid") return;
    const wid = String(req.get("x-inkress-webhook-id") || `${o.id}.${o.status}`);
    if (await db.one(`SELECT 1 FROM webhook_seen WHERE webhook_id=$1`, [wid])) return;
    await db.run(`INSERT INTO webhook_seen (webhook_id) VALUES ($1) ON CONFLICT DO NOTHING`, [wid]);
    const st = await getSettings(merchantId);
    if (!st.auto_issue) return;
    let accessToken;
    try { accessToken = await tokens.accessTokenFor(merchantId); } catch { return; }
    const order = {
      id: String(o.id), reference_id: o.reference_id || String(o.id),
      customer: o.customer?.full_name || [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ") || o.customer?.email || "Customer",
      email: o.customer?.email || null, total: Number(o.total || 0), currency: o.currency?.code || o.currency_code || st.currency || "JMD",
      created: (o.inserted_at || new Date().toISOString()).slice(0, 10), lines: [],
    };
    const row = await issueReceipt({ get: () => process.env.PUBLIC_BASE_URL?.replace(/^https?:\/\//, "") }, merchantId, accessToken, order);
    if (st.auto_email && row?.customer_email && sesConfigured() && process.env.PUBLIC_BASE_URL) {
      await sendEmail({ to: row.customer_email, subject: `Receipt ${row.number} from ${st.business_name || "us"}`, html: receiptEmail(st, row, `${process.env.PUBLIC_BASE_URL}/receipt/${row.token}`) }).catch(() => {});
      await db.run(`UPDATE receipts SET emailed_at=now() WHERE id=$1`, [row.id]);
    }
  } catch (err) { console.error(`[receipts] webhook failed: ${err?.message}`); }
});

core.mountSpaFallback();
app.listen(PORT, HOST, () => console.log(`[receipts] listening on ${HOST}:${PORT}`));

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function money(n, c) { try { return new Intl.NumberFormat("en-JM", { style: "currency", currency: c, minimumFractionDigits: 0 }).format(n); } catch { return `${c} ${n}`; } }
function breakdownRows(r) {
  const rows = [];
  const sub = r.subtotal != null ? Number(r.subtotal) : null, disc = Number(r.discount || 0), fees = Number(r.fees || 0), tax = Number(r.tax || 0);
  if (sub != null && (disc > 0 || fees > 0 || tax > 0)) {
    rows.push(["Subtotal", sub]);
    if (disc > 0) rows.push(["Discount", -disc]);
    if (fees > 0) rows.push(["Fees", fees]);
    if (tax > 0) rows.push(["Tax", tax]);
  }
  return rows;
}
function linesHtml(r) {
  const items = r.lines || [];
  if (!items.length) return `<tr><td>Order ${esc(r.reference_id || r.order_id || "")}</td><td class="r">${money(Number(r.amount), r.currency)}</td></tr>`;
  return items.map((l) => `<tr><td>${esc(l.title)} <span class="qty">× ${l.qty}</span></td><td class="r">${money(l.qty * l.price, r.currency)}</td></tr>`).join("");
}
function receiptEmail(s, r, url) {
  const accent = (s?.accent && /^#[0-9a-fA-F]{6}$/.test(s.accent)) ? s.accent : "#0f766e";
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#1a1a1a;">
    <h2 style="margin:0 0 4px;">Receipt ${esc(r.number)}</h2>
    <p style="color:#666;margin:0 0 12px;">${esc(s.business_name || "")}</p>
    <div style="font-size:22px;font-weight:800;margin:0 0 12px;">${money(Number(r.amount), r.currency)} — Paid</div>
    <a href="${esc(url)}" style="display:inline-block;padding:12px 24px;background:${accent};color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">View receipt</a>
    <p style="color:#aaa;font-size:12px;margin-top:16px;">${esc(s.footer || "via Marketplace")}</p></div>`;
}
function publicShell(title, inner, accent = "#0f766e") {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f4f7f6;color:#1f2430;display:grid;place-items:center;min-height:100vh;padding:20px}
  .card{background:#fff;border:1px solid #e3eae8;border-radius:18px;box-shadow:0 14px 44px rgba(15,60,50,.1);max-width:460px;width:100%;overflow:hidden}
  .accent{height:4px;background:${accent}} .pad{padding:28px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px}
  .logo{width:48px;height:48px;border-radius:12px;object-fit:cover;border:1px solid #eee}
  h1{font-size:1.3rem;margin:0}.muted{color:#6b7280;font-size:.88rem;margin:2px 0 0;white-space:pre-line}
  .badge{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:4px 10px;border-radius:20px;background:#dcfce7;color:#166534}
  table{width:100%;border-collapse:collapse;margin:10px 0 4px}td{padding:9px 0;border-bottom:1px solid #eef2f1;font-size:.95rem}
  td.r{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.qty{color:#9aa4b2;font-size:.85rem}
  .brk td{border:none;padding:3px 0;color:#6b7280;font-size:.9rem}.brk td.r{color:#1f2430}
  .total{display:flex;justify-content:space-between;align-items:center;margin-top:12px;font-size:1.25rem;font-weight:800;border-top:2px solid #eef2f1;padding-top:12px}
  .meta{color:#6b7280;font-size:.82rem;margin-top:8px}
  .foot{color:#8a99a6;font-size:.8rem;margin-top:16px;white-space:pre-line;border-top:1px solid #eef2f1;padding-top:12px}
  a.dl{display:block;text-align:center;margin-top:14px;color:${accent};text-decoration:none;font-weight:600;font-size:.9rem}
  .pb{text-align:center;color:#aab;font-size:12px;padding:14px}</style></head>
  <body><div class="card"><div class="accent"></div>${inner}<div class="pb">powered by Marketplace</div></div></body></html>`;
}
function receiptPage(s, r) {
  const accent = (s?.accent && /^#[0-9a-fA-F]{6}$/.test(s.accent)) ? s.accent : "#0f766e";
  const logo = s.logo ? `<img class="logo" src="${esc(s.logo)}" alt="">` : "";
  const brk = breakdownRows(r).map(([label, amt]) => `<tr class="brk"><td>${esc(label)}</td><td class="r">${amt < 0 ? "−" : ""}${money(Math.abs(amt), r.currency)}</td></tr>`).join("");
  return publicShell(`Receipt ${r.number}`, `<div class="pad">
    <div class="head"><div>${logo ? logo + "<br>" : ""}<h1>${esc(s.business_name || "Receipt")}</h1>
      ${s.address ? `<p class="muted">${esc(s.address)}</p>` : ""}${s.tax_id ? `<p class="muted">Tax ID: ${esc(s.tax_id)}</p>` : ""}</div>
      <span class="badge">Paid</span></div>
    <p class="muted">Receipt ${esc(r.number)}${r.order_date ? ` · ${esc(r.order_date)}` : ""}${r.customer_name ? ` · ${esc(r.customer_name)}` : ""}${r.payment_method ? ` · ${esc(r.payment_method)}` : ""}</p>
    <table>${linesHtml(r)}</table>
    ${brk ? `<table style="margin-top:0">${brk}</table>` : ""}
    <div class="total"><span>Total paid</span><span>${money(Number(r.amount), r.currency)}</span></div>
    <a class="dl" href="/receipt/${esc(r.token)}/pdf" target="_blank" rel="noopener">Download PDF</a>
    ${s.footer ? `<div class="foot">${esc(s.footer)}</div>` : ""}</div>`, accent);
}
async function receiptPdf(s, r) {
  const accent = (s?.accent && /^#[0-9a-fA-F]{6}$/.test(s.accent)) ? s.accent : "#0f766e";
  const items = (r.lines || []).map((l) => ({ description: l.title, qty: l.qty, amount: money(l.qty * l.price, r.currency) }));
  if (!items.length) items.push({ description: `Order ${r.reference_id || r.order_id || ""}`, amount: money(Number(r.amount), r.currency) });
  const totals = [];
  for (const [label, amt] of breakdownRows(r)) totals.push({ label, value: `${amt < 0 ? "−" : ""}${money(Math.abs(amt), r.currency)}` });
  totals.push({ label: "Total paid", value: money(Number(r.amount), r.currency), bold: true });
  const meta = [];
  if (r.customer_name) meta.push({ label: "Customer", value: r.customer_name });
  if (r.order_date) meta.push({ label: "Date", value: String(r.order_date).slice(0, 10) });
  if (r.reference_id) meta.push({ label: "Order", value: r.reference_id });
  if (r.payment_method) meta.push({ label: "Method", value: r.payment_method });
  if (s?.tax_id) meta.push({ label: "Tax ID", value: s.tax_id });
  return documentPdf({
    brand: { name: s.business_name || "Receipt", accent }, title: "Receipt", number: r.number, badge: "PAID",
    meta, items, totals, note: [s.address, s.footer].filter(Boolean).join("\n\n"), footer: s.footer || "Thank you for your business.",
  });
}
