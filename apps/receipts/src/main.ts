import "./index.css";
import {
  initBv, bvApi, makeToast, type BvToastFn,
  mountShell, statRow, dataTable, card, openModal, flash,
  fmtMoney, fmtDate, relTime, pill, emptyState, h, iconEl,
} from "./bv-init";

interface Order { id: string; reference_id: string; customer: string; email: string | null; total: number; currency: string; status: string; paid: boolean; created: string; lines: { title: string; qty: number; price: number }[]; receipted: boolean; }
interface Receipt { id: number; number: string; order_id: string | null; reference_id: string | null; customer_name: string | null; customer_email: string | null; amount: number; currency: string; lines: any[]; subtotal: number | null; discount: number; fees: number; tax: number; payment_method: string | null; voided: boolean; order_date: string | null; emailed_at: string | null; created_at: string; public_url: string | null; pdf_url: string; }
interface Settings { business_name: string | null; address: string | null; tax_id: string | null; footer: string | null; logo: string | null; currency: string; accent: string; number_prefix: string; number_pad: number; auto_issue: boolean; auto_email: boolean; }
interface Summary { count: number; currency: string; subtotal: number; discount: number; fees: number; tax: number; total: number; }

const root = document.getElementById("root")!;
let toast: BvToastFn;
let merchantName = "Merchant";
let currency = "JMD";
let shell: ReturnType<typeof mountShell>;
let webhookRealtime = false;
let ordersCache: Order[] = [];
let ordersPage = 1;
let ordersHasMore = false;
let ordersSearch = "";

(async () => {
  let session;
  if (import.meta.env.DEV && !new URLSearchParams(location.search).has("inkress_session")) {
    const m = await import("./dev-mock"); m.installMockFetch(); session = m.mockSession();
  } else {
    try { session = await initBv(); }
    catch (err: any) { root.innerHTML = ""; root.append(fatal(err?.message)); return; }
  }
  toast = makeToast(session.inkress);
  merchantName = session.merchant.name || session.merchant.username || "Merchant";
  currency = session.merchant.currency_code || "JMD";

  shell = mountShell({
    brandIcon: "receipt",
    brandLogo: "/logo.svg",
    title: "Receipts",
    subtitle: `${merchantName} · official branded receipts for paid orders`,
    poweredBy: "Marketplace",
    tabs: [
      { id: "orders", label: "Paid orders", icon: "coins", render: renderOrders },
      { id: "receipts", label: "Receipts", icon: "receipt", render: renderReceipts },
      { id: "settings", label: "Settings", icon: "settings", render: renderSettings },
    ],
  });
  bvApi<{ realtime: boolean }>(`/api/status`).then((s) => { webhookRealtime = s.realtime; }).catch(() => {});
})();

/* -------------------------------------------------------------------- Orders */
async function renderOrders(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading orders…"));
  try { const d = await bvApi<{ orders: Order[]; page: number; has_more: boolean }>(`/api/orders?page=1${ordersSearch ? `&q=${encodeURIComponent(ordersSearch)}` : ""}`); ordersCache = d.orders; ordersPage = d.page; ordersHasMore = d.has_more; }
  catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load orders", text: err?.message })); return; }
  host.innerHTML = "";
  const paid = ordersCache.filter((o) => o.paid);

  host.append(statRow([
    { k: "Paid orders", v: String(paid.length), tone: "ok", icon: "coins" },
    { k: "Receipts issued", v: String(ordersCache.filter((o) => o.receipted).length), tone: "accent", icon: "receipt" },
    { k: "Awaiting receipt", v: String(paid.filter((o) => !o.receipted).length), icon: "clock" },
  ]));

  const searchInput = h("input", { class: "rc-search", placeholder: "Search orders…", value: ordersSearch,
    onKeyDown: (e: any) => { if (e.key === "Enter") { ordersSearch = e.target.value; shell.select("orders"); } } }) as HTMLInputElement;
  const unreceipted = paid.filter((o) => !o.receipted);
  const bulkBtn = h("button", { class: "ghost sm", disabled: !unreceipted.length, onClick: () => bulkIssue(unreceipted) }, iconEl("receipt", 13), `Issue all (${unreceipted.length})`);

  host.append(card({ title: "Paid orders", action: h("div", { class: "rc-toolbar" }, searchInput, bulkBtn), body: paid.length ? dataTable<Order>({
    columns: [
      { head: "Order", cell: (o) => h("div", null, h("strong", { class: "rc-ref" }, `#${o.reference_id}`), o.created ? h("div", { class: "bv-muted" }, fmtDate(o.created)) : null) },
      { head: "Customer", cell: (o) => h("div", null, h("span", null, o.customer), o.email ? h("div", { class: "bv-muted" }, o.email) : null) },
      { head: "Total", num: true, cell: (o) => fmtMoney(o.total, o.currency) },
      { head: "", cell: (o) => o.receipted ? pill("receipted", "ok") : h("span", { class: "bv-muted" }, "—") },
    ],
    rows: paid,
    rowActions: (o) => o.receipted ? null : h("button", { class: "primary sm", onClick: () => issue(o) }, iconEl("receipt", 13), "Issue receipt"),
  }) : emptyState({ icon: "coins", title: "No paid orders yet", text: "Paid Inkress orders will appear here, ready to receipt." }) }));

  if (ordersHasMore) host.append(h("div", { style: { textAlign: "center", marginTop: "10px" } }, h("button", { class: "ghost", onClick: () => loadMore(host) }, "Load more orders")));
  if (webhookRealtime) host.append(h("div", { class: "rc-note bv-muted" }, iconEl("check", 14), "Auto-issue is available — enable it in Settings to receipt every paid order automatically."));
}

async function loadMore(host: HTMLElement) {
  try {
    const d = await bvApi<{ orders: Order[]; page: number; has_more: boolean }>(`/api/orders?page=${ordersPage + 1}${ordersSearch ? `&q=${encodeURIComponent(ordersSearch)}` : ""}`);
    ordersCache = [...ordersCache, ...d.orders]; ordersPage = d.page; ordersHasMore = d.has_more;
    host.innerHTML = ""; renderOrders(host);
  } catch (err: any) { toast(err?.message || "error", "error"); }
}

async function issue(o: Order) {
  try {
    const r = await bvApi<{ receipt: Receipt }>("/api/receipts", { method: "POST", body: JSON.stringify({ order_id: o.id, reference_id: o.reference_id, customer: o.customer, email: o.email, total: o.total, currency: o.currency, lines: o.lines, created: o.created }) });
    flash(`Receipt ${r.receipt.number} issued`, "success"); shell.select("receipts");
  } catch (err: any) { toast(err?.message || "error", "error"); }
}
async function bulkIssue(orders: Order[]) {
  if (!orders.length) return;
  try {
    const r = await bvApi<{ issued: number }>("/api/receipts/bulk", { method: "POST", body: JSON.stringify({ orders: orders.map((o) => ({ order_id: o.id, reference_id: o.reference_id, customer: o.customer, email: o.email, total: o.total, currency: o.currency, lines: o.lines, created: o.created })) }) });
    flash(`Issued ${r.issued} receipt${r.issued === 1 ? "" : "s"}`, "success"); shell.select("receipts");
  } catch (err: any) { toast(err?.message || "error", "error"); }
}

/* ------------------------------------------------------------------ Receipts */
let rcSearch = "", rcFrom = "", rcTo = "";
async function renderReceipts(host: HTMLElement) {
  host.append(h("div", { class: "bv-muted", style: { padding: "12px 2px" } }, "Loading…"));
  let rows: Receipt[]; let summary: Summary;
  const qs = `q=${encodeURIComponent(rcSearch)}${rcFrom ? `&from=${rcFrom}` : ""}${rcTo ? `&to=${rcTo}` : ""}`;
  try {
    rows = (await bvApi<{ receipts: Receipt[] }>(`/api/receipts?${qs}`)).receipts;
    summary = await bvApi<Summary>(`/api/summary?${rcFrom ? `from=${rcFrom}` : ""}${rcTo ? `&to=${rcTo}` : ""}`);
  } catch (err: any) { host.innerHTML = ""; host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }
  host.innerHTML = "";

  // tax/fees collected summary
  host.append(statRow([
    { k: "Receipts", v: String(summary.count), tone: "accent", icon: "receipt" },
    { k: "Subtotal", v: fmtMoney(summary.subtotal, summary.currency), icon: "coins" },
    { k: "Tax collected", v: fmtMoney(summary.tax, summary.currency), tone: "ok", icon: "chart" },
    { k: "Fees", v: fmtMoney(summary.fees, summary.currency), icon: "clock" },
  ]));

  const search = h("input", { class: "rc-search", placeholder: "Search receipts…", value: rcSearch,
    onKeyDown: (e: any) => { if (e.key === "Enter") { rcSearch = e.target.value; shell.select("receipts"); } } }) as HTMLInputElement;
  const from = h("input", { type: "date", value: rcFrom, onChange: (e: any) => { rcFrom = e.target.value; shell.select("receipts"); } }) as HTMLInputElement;
  const to = h("input", { type: "date", value: rcTo, onChange: (e: any) => { rcTo = e.target.value; shell.select("receipts"); } }) as HTMLInputElement;
  const csv = h("a", { class: "ghost sm", href: "/api/receipts.csv", onClick: (e: any) => downloadCsv(e) }, iconEl("download", 13), "CSV");
  const tools = h("div", { class: "rc-toolbar" }, search, h("span", { class: "bv-muted", style: { fontSize: "0.8rem" } }, "from"), from, h("span", { class: "bv-muted", style: { fontSize: "0.8rem" } }, "to"), to, csv);

  host.append(card({ title: "Issued receipts", action: tools, body: rows.length ? dataTable<Receipt>({
    columns: [
      { head: "Receipt", cell: (r) => h("div", null, h("strong", { class: "rc-ref" }, r.number), r.reference_id ? h("div", { class: "bv-muted" }, `order #${r.reference_id}`) : null) },
      { head: "Customer", cell: (r) => h("span", null, r.customer_name || r.customer_email || "—") },
      { head: "When", cell: (r) => h("span", { class: "bv-muted" }, relTime(r.created_at)) },
      { head: "Amount", num: true, cell: (r) => h("div", null, h("span", null, fmtMoney(r.amount, r.currency)), r.tax > 0 || r.fees > 0 || r.discount > 0 ? h("div", { class: "bv-muted" }, breakdownLabel(r)) : null) },
      { head: "", cell: (r) => r.voided ? pill("void", "bad") : pill("issued", "ok") },
    ],
    rows,
    rowActions: (r) => h("div", { class: "rc-row-actions" },
      r.public_url && !r.voided ? h("a", { class: "ghost sm", href: r.public_url, target: "_blank", rel: "noopener" }, iconEl("external", 13), "View") : null,
      !r.voided ? h("button", { class: "ghost sm", onClick: () => openPdf(r) }, iconEl("download", 13), "PDF") : null,
      r.public_url && !r.voided ? h("button", { class: "ghost sm", onClick: () => { navigator.clipboard?.writeText(r.public_url!); flash("Link copied", "success"); } }, iconEl("copy", 13)) : null,
      r.customer_email && !r.voided ? h("button", { class: "ghost sm", onClick: () => emailReceipt(r) }, iconEl("send", 13), r.emailed_at ? "Resend" : "Email") : null,
      !r.voided ? h("button", { class: "ghost sm", onClick: () => voidReceipt(r) }, iconEl("trash", 13)) : null),
  }) : emptyState({ icon: "receipt", title: "No receipts yet", text: "Issue a receipt from the Paid orders tab, or enable auto-issue in Settings." }) }));
}
function breakdownLabel(r: Receipt) {
  const parts: string[] = [];
  if (r.discount > 0) parts.push(`−${fmtMoney(r.discount, r.currency)}`);
  if (r.fees > 0) parts.push(`+${fmtMoney(r.fees, r.currency)} fees`);
  if (r.tax > 0) parts.push(`+${fmtMoney(r.tax, r.currency)} tax`);
  return parts.join(" · ");
}
async function emailReceipt(r: Receipt) {
  try { const res = await bvApi<{ emailed: boolean }>(`/api/receipts/${r.id}/email`, { method: "POST" }); flash(res.emailed ? "Receipt emailed" : "Email isn't configured", res.emailed ? "success" : "warning"); shell.select("receipts"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function voidReceipt(r: Receipt) {
  try { await bvApi(`/api/receipts/${r.id}`, { method: "PATCH", body: JSON.stringify({ voided: true }) }); flash(`Receipt ${r.number} voided`, "success"); shell.select("receipts"); }
  catch (err: any) { toast(err?.message || "error", "error"); }
}
async function openPdf(r: Receipt) {
  try {
    if (r.public_url) { window.open(`${r.public_url}/pdf`, "_blank", "noopener"); return; }
    const sid = sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";
    const res = await fetch(`/api/receipts/${r.id}/pdf`, { headers: { "X-BV-Session": sid } });
    if (!res.ok) throw new Error("PDF generation failed");
    const url = URL.createObjectURL(await res.blob()); window.open(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err: any) { toast(err?.message || "Couldn't open PDF", "error"); }
}
function downloadCsv(e: any) {
  e.preventDefault();
  const sid = sessionStorage.getItem("bv_app_session_id") || localStorage.getItem("bv_app_session_id") || "";
  fetch(`/api/receipts.csv`, { headers: { "X-BV-Session": sid } }).then((r) => r.blob()).then((b) => {
    const url = URL.createObjectURL(b); const a = document.createElement("a"); a.href = url; a.download = "receipts.csv"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }).catch(() => toast("Couldn't export", "error"));
}

/* ------------------------------------------------------------------ Settings */
async function renderSettings(host: HTMLElement) {
  let s: Settings;
  try { s = (await bvApi<{ settings: Settings }>("/api/settings")).settings; }
  catch (err: any) { host.append(emptyState({ icon: "alert", title: "Couldn't load", text: err?.message })); return; }

  const name = h("input", { value: s.business_name || merchantName, placeholder: "Business name" }) as HTMLInputElement;
  const address = h("textarea", { rows: "2", placeholder: "Business address (shown on receipts)" }) as HTMLTextAreaElement; address.value = s.address || "";
  const tax = h("input", { value: s.tax_id || "", placeholder: "Tax / TRN (optional)" }) as HTMLInputElement;
  const footer = h("textarea", { rows: "2", placeholder: "Footer note, e.g. Thank you for your business" }) as HTMLTextAreaElement; footer.value = s.footer || "";
  const accent = h("input", { type: "color", value: s.accent || "#0f766e" }) as HTMLInputElement;
  const prefix = h("input", { value: s.number_prefix || "RC", placeholder: "RC" }) as HTMLInputElement;
  const pad = h("input", { type: "number", min: "1", max: "8", value: String(s.number_pad || 4) }) as HTMLInputElement;
  const autoIssue = h("input", { type: "checkbox", checked: s.auto_issue }) as HTMLInputElement;
  const autoEmail = h("input", { type: "checkbox", checked: s.auto_email }) as HTMLInputElement;

  const preview = h("div", { class: "rc-preview" });
  const renderPreview = () => {
    preview.innerHTML = "";
    preview.style.setProperty("--ac", accent.value);
    const n = `${prefix.value || "RC"}-${"1".padStart(Math.max(1, Math.min(8, Number(pad.value) || 4)), "0")}`;
    preview.append(
      h("div", { class: "rc-pv-bar" }),
      h("div", { class: "rc-pv-body" },
        h("div", { class: "rc-pv-head" },
          h("div", null, h("strong", null, name.value || merchantName), h("div", { class: "rc-pv-addr" }, address.value), tax.value ? h("div", { class: "rc-pv-addr" }, `Tax ID: ${tax.value}`) : null),
          h("span", { class: "rc-pv-badge" }, "Paid")),
        h("div", { class: "rc-pv-meta" }, `Receipt ${n}`),
        h("div", { class: "rc-pv-line" }, h("span", null, "Consultation × 1"), h("span", null, fmtMoney(8000, currency))),
        h("div", { class: "rc-pv-brk" }, h("span", null, "Tax"), h("span", null, fmtMoney(1200, currency))),
        h("div", { class: "rc-pv-total" }, h("span", null, "Total paid"), h("span", null, fmtMoney(9200, currency))),
        footer.value ? h("div", { class: "rc-pv-foot" }, footer.value) : null));
  };
  [name, address, tax, footer, prefix, pad].forEach((el) => el.addEventListener("input", renderPreview));
  accent.addEventListener("input", renderPreview);
  renderPreview();

  const save = async () => {
    try {
      await bvApi("/api/settings", { method: "PATCH", body: JSON.stringify({ business_name: name.value, address: address.value, tax_id: tax.value, footer: footer.value,
        accent: accent.value, number_prefix: prefix.value || "RC", number_pad: Number(pad.value) || 4, auto_issue: autoIssue.checked, auto_email: autoEmail.checked }) });
      flash("Settings saved", "success");
    } catch (err: any) { toast(err?.message || "error", "error"); }
  };

  const formCard = card({ title: "Receipt details & branding", body: h("div", { class: "rc-form" },
    field("Business name", name),
    field("Address", address),
    h("div", { class: "rc-form-grid" }, field("Tax / TRN", tax), fieldColor("Accent colour", accent)),
    h("div", { class: "rc-form-grid" }, field("Receipt prefix", prefix), field("Number padding", pad)),
    field("Footer note", footer),
    h("label", { class: "rc-check" }, autoIssue, " Auto-issue a receipt the moment an order is paid"),
    h("label", { class: "rc-check" }, autoEmail, " Auto-email the receipt to the customer (requires auto-issue)"),
    h("div", { style: { marginTop: "6px" } }, h("button", { class: "primary", onClick: () => { void save(); } }, iconEl("check", 15), "Save settings"))) });

  host.append(h("div", { class: "rc-settings-cols" }, formCard, card({ title: "Live preview", body: preview })));
}

function field(label: string, el: HTMLElement) { return h("label", { class: "rc-field" }, h("span", { class: "bv-label" }, label), el); }
function fieldColor(label: string, el: HTMLElement) { return h("label", { class: "rc-field rc-field-color" }, h("span", { class: "bv-label" }, label), el); }
function fatal(msg?: string) { return h("div", { class: "bv-empty", style: { margin: "40px auto" } }, h("h3", null, "Receipts couldn't load"), h("p", null, msg || "Open this app from the Inkress dashboard.")); }
