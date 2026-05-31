/** DEV-ONLY preview harness — tree-shaken from prod. */
import type { BvSession } from "./bv-init";

const d = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
let ORDERS: any[] = [
  { id: "5001", reference_id: "A1B2C3", customer: "Maria Brown", email: "maria@example.com", total: 12500, currency: "JMD", status: "Paid", paid: true, created: d(1), lines: [{ title: "Consultation", qty: 1, price: 8000 }, { title: "Follow-up", qty: 1, price: 4500 }], receipted: false },
  { id: "5002", reference_id: "D4E5F6", customer: "Devon Clarke", email: "devon@example.com", total: 6000, currency: "JMD", status: "Paid", paid: true, created: d(2), lines: [{ title: "Service call", qty: 1, price: 6000 }], receipted: true },
  { id: "5003", reference_id: "G7H8I9", customer: "Aaliyah Wright", email: null, total: 22000, currency: "JMD", status: "Paid", paid: true, created: d(3), lines: [{ title: "Package deal", qty: 2, price: 11000 }], receipted: false },
  { id: "5004", reference_id: "J0K1L2", customer: "Kemar Lewis", email: "kemar@example.com", total: 3000, currency: "JMD", status: "Pending", paid: false, created: d(0), lines: [], receipted: false },
];
let RECEIPTS: any[] = [
  { id: 1, number: "RC-0001", order_id: "5002", reference_id: "D4E5F6", customer_name: "Devon Clarke", customer_email: "devon@example.com", amount: 6000, currency: "JMD", lines: [{ title: "Service call", qty: 1, price: 6000 }], subtotal: 5217, discount: 0, fees: 0, tax: 783, payment_method: "Card", voided: false, order_date: d(2), emailed_at: d(2), created_at: new Date(Date.now() - 2 * 864e5).toISOString(), public_url: location.origin + "/receipt/rc1tok" },
];
let SEQ = 1, RID = 1;
let SETTINGS: any = { business_name: "Harbour Clinic", address: "12 Harbour St, Kingston", tax_id: "TRN 123-456-789", footer: "Thank you for your visit.", logo: null, currency: "JMD", accent: "#0f766e", number_prefix: "RC", number_pad: 4, auto_issue: false, auto_email: false };
const tok = () => Math.random().toString(36).slice(2, 8);

function buildReceipt(body: any) {
  const total = Number(body.total) || 0; const tax = Math.round(total * 0.15 / 1.15);
  return { id: ++RID, number: `${SETTINGS.number_prefix}-${String(++SEQ).padStart(SETTINGS.number_pad, "0")}`, order_id: String(body.order_id), reference_id: body.reference_id,
    customer_name: body.customer, customer_email: body.email, amount: total, currency: body.currency || "JMD", lines: body.lines || [],
    subtotal: total - tax, discount: 0, fees: 0, tax, payment_method: "Card", voided: false, order_date: body.created, emailed_at: null, created_at: new Date().toISOString(), public_url: location.origin + "/receipt/" + tok() };
}

export function installMockFetch() {
  window.fetch = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const u = new URL(url, location.origin);
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (dd: any, s = 200) => new Response(JSON.stringify(dd), { status: s, headers: { "Content-Type": "application/json" } });
    await new Promise((r) => setTimeout(r, 80));
    const em = u.pathname.match(/\/api\/receipts\/(\d+)\/email/);
    const pm = u.pathname.match(/\/api\/receipts\/(\d+)\/pdf/);
    const vm = u.pathname.match(/\/api\/receipts\/(\d+)$/);

    if (u.pathname === "/api/status") return json({ realtime: true, webhook_registered: true, can_register: true, webhook_secret_configured: true });
    if (u.pathname === "/api/orders") { const page = Number(u.searchParams.get("page")) || 1; return json({ orders: ORDERS.map((o) => ({ ...o, receipted: RECEIPTS.some((r) => r.order_id === o.id) })), page, has_more: false }); }
    if (u.pathname === "/api/receipts.csv") return new Response("number,order_ref,status,total\nRC-0001,D4E5F6,issued,6000", { status: 200, headers: { "Content-Type": "text/csv" } });
    if (u.pathname === "/api/summary") { const live = RECEIPTS.filter((r) => !r.voided); const sum = (k: string) => Math.round(live.reduce((s, r) => s + (Number(r[k]) || 0), 0)); return json({ count: live.length, currency: "JMD", subtotal: sum("subtotal"), discount: sum("discount"), fees: sum("fees"), tax: sum("tax"), total: sum("amount") }); }
    if (u.pathname === "/api/receipts" && method === "GET") return json({ receipts: RECEIPTS });
    if (u.pathname === "/api/receipts/bulk" && method === "POST") { let issued = 0; for (const o of body.orders || []) { if (!RECEIPTS.some((r) => r.order_id === String(o.order_id))) { const r = buildReceipt(o); RECEIPTS.unshift(r); const ord = ORDERS.find((x) => x.id === String(o.order_id)); if (ord) ord.receipted = true; issued++; } } return json({ issued }); }
    if (u.pathname === "/api/receipts" && method === "POST") {
      const ex = RECEIPTS.find((r) => r.order_id === String(body.order_id)); if (ex) return json({ receipt: ex });
      const r = buildReceipt(body); RECEIPTS.unshift(r); const o = ORDERS.find((x) => x.id === String(body.order_id)); if (o) o.receipted = true;
      return json({ receipt: r }, 201);
    }
    if (em) { const r = RECEIPTS.find((x) => x.id === Number(em[1])); if (r) r.emailed_at = new Date().toISOString(); return json({ emailed: true }); }
    if (pm) return new Response(new Blob(["%PDF-1.4 mock"], { type: "application/pdf" }), { status: 200, headers: { "Content-Type": "application/pdf" } });
    if (vm && method === "PATCH") { const r = RECEIPTS.find((x) => x.id === Number(vm[1])); if (r && body.voided) r.voided = true; return json({ receipt: r }); }
    if (u.pathname === "/api/settings" && method === "GET") return json({ settings: SETTINGS });
    if (u.pathname === "/api/settings" && method === "PATCH") { SETTINGS = { ...SETTINGS, ...body }; return json({ ok: true }); }
    return new Response("{}", { status: 404 });
  };
}

export function mockSession(): BvSession {
  return {
    inkress: { notify: ({ message }: any) => console.log("[toast]", message) } as any,
    merchant: { id: 183, username: "harbour-clinic", name: "Harbour Clinic", currency_code: "JMD", email: "billing@harbourclinic.com", logo: null },
    user: { id: 90, name: "Front Desk", email: "desk@harbourclinic.com" },
    scopes: ["orders:read", "webhooks:manage", "offline_access"],
  };
}
