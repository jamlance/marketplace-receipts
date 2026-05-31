/**
 * Browser UI kit — vanilla TS, no framework. Gives apps a real
 * app-shell (top bar + tabs), stat tiles, data tables, modals, toasts,
 * and state blocks so every app is multi-view and consistent without
 * re-rolling innerHTML soup.
 */

import { icon } from "./icons.js";

export type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, any>;

/** Hyperscript-lite DOM builder. h("div", {class:"x", onClick}, ...kids) */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function")
        el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function iconEl(name: string, size = 20): HTMLSpanElement {
  const s = h("span", { class: "ic", html: icon(name, size) });
  s.style.display = "inline-grid";
  s.style.placeItems = "center";
  return s;
}

export interface Tab {
  id: string;
  label: string;
  icon?: string;
  render: (host: HTMLElement) => void;
}

export interface ShellOpts {
  brandIcon: string;
  brandLogo?: string; // optional URL/path to a per-app SVG logo (e.g. "/logo.svg"); overrides brandIcon
  title: string;
  subtitle?: string;
  poweredBy?: string; // "Bookerva" | "Marketplace"
  tabs: Tab[];
  initialTab?: string;
}

/** Render the app shell into <body>'s #root, wire tab switching, and
 *  call the active tab's render(). Returns helpers to switch tabs. */
export function mountShell(opts: ShellOpts) {
  const root = document.getElementById("root")!;
  root.innerHTML = "";
  const content = h("main", { class: "bv-content" });
  const tabEls = new Map<string, HTMLButtonElement>();

  let currentId: string | null = null;
  const select = (id: string) => {
    const tab = opts.tabs.find((t) => t.id === id) || opts.tabs[0];
    if (!tab) return;
    tabEls.forEach((el, tid) => el.setAttribute("aria-selected", String(tid === tab.id)));
    if (history.replaceState) {
      const u = new URL(location.href);
      u.hash = tab.id;
      history.replaceState(null, "", u.toString());
    }
    // Re-rendering the SAME tab (e.g. after an add/delete/save) is the common
    // "refresh" case. Rendering straight into `content` clears it first, so the
    // user sees a blank → "Loading…" → data flash. Instead, render into a
    // DETACHED buffer off-screen; the old content stays put until the new
    // content is ready, then swap atomically. Render fns are async (or sync),
    // so awaiting the returned promise tells us when the buffer is final.
    const sameTab = currentId === tab.id && content.childElementCount > 0;
    currentId = tab.id;
    if (!sameTab) {
      content.replaceChildren();
      tab.render(content);
      return;
    }
    const buffer = document.createElement("div");
    const swap = () => { if (currentId === tab.id) content.replaceChildren(...Array.from(buffer.childNodes)); };
    const done = tab.render(buffer) as unknown as Promise<void> | void;
    Promise.resolve(done).then(swap, swap);
  };

  const tabsBar = opts.tabs.length > 1
    ? h("nav", { class: "bv-tabs" },
        ...opts.tabs.map((t) => {
          const b = h("button", {
            class: "bv-tab", role: "tab", onClick: () => select(t.id),
          }, t.icon ? iconEl(t.icon, 16) : null, t.label) as HTMLButtonElement;
          tabEls.set(t.id, b);
          return b;
        }))
    : null;

  const shell = h("div", { class: "bv-app" },
    h("header", { class: "bv-topbar" },
      opts.brandLogo
        ? h("div", { class: "bv-brandmark is-logo" }, h("img", { src: opts.brandLogo, alt: "", width: 30, height: 30 }))
        : h("div", { class: "bv-brandmark", html: icon(opts.brandIcon, 18) }),
      h("div", null,
        h("h1", null, opts.title),
        opts.subtitle ? h("div", { class: "bv-sub" }, opts.subtitle) : null),
      h("div", { class: "bv-topbar-spacer" }),
      h("div", { class: "bv-poweredby" }, "by ", h("b", null, opts.poweredBy || "Bookerva"))),
    tabsBar,
    content);

  root.append(shell);
  select(opts.initialTab || location.hash.slice(1) || opts.tabs[0]?.id || "");
  return { select, content };
}

export interface StatOpts { k: string; v: string; d?: string; tone?: "accent" | "ok" | "bad"; icon?: string; }
export function statTile(o: StatOpts): HTMLElement {
  return h("div", { class: "bv-stat" + (o.tone ? ` is-${o.tone}` : "") },
    o.icon ? h("span", { class: "ic", html: icon(o.icon, 18) }) : null,
    h("div", { class: "k" }, o.k),
    h("div", { class: "v" }, o.v),
    o.d ? h("div", { class: "d" }, o.d) : null);
}
export function statRow(stats: StatOpts[]): HTMLElement {
  return h("div", { class: "bv-stats" }, ...stats.map(statTile));
}

export interface Column<T> { head: string; cell: (row: T) => Child | Node; num?: boolean; }
export interface TableOpts<T> {
  columns: Column<T>[];
  rows: T[];
  rowActions?: (row: T) => Node | null;
  onRowClick?: (row: T) => void;
  empty?: HTMLElement;
}
export function dataTable<T>(o: TableOpts<T>): HTMLElement {
  if (!o.rows.length && o.empty) return o.empty;
  const head = h("tr", null,
    ...o.columns.map((c) => h("th", { class: c.num ? "num" : null }, c.head)),
    o.rowActions ? h("th", null, "") : null);
  const body = o.rows.map((row) => {
    const tr = h("tr", o.onRowClick ? { onClick: () => o.onRowClick!(row), style: { cursor: "pointer" } } : null,
      ...o.columns.map((c) => h("td", { class: c.num ? "num" : null }, c.cell(row) as any)),
      o.rowActions ? h("td", { class: "actions", onClick: (e: Event) => e.stopPropagation() }, o.rowActions(row)) : null);
    return tr;
  });
  return h("div", { class: "bv-table-wrap" },
    h("table", { class: "bv-table" }, h("thead", null, head), h("tbody", null, ...body)));
}

export function emptyState(o: { icon: string; title: string; text?: string; action?: Node }): HTMLElement {
  return h("div", { class: "bv-empty" },
    h("div", { class: "ic", html: icon(o.icon, 24) }),
    h("h3", null, o.title),
    o.text ? h("p", null, o.text) : null,
    o.action || null);
}

export function skeleton(width = "70%", height = 12): HTMLElement {
  return h("div", { class: "bv-skeleton", style: { width, height: `${height}px` } });
}
export function skeletonCard(): HTMLElement {
  return h("div", { class: "bv-card" }, skeleton("40%"), h("div", { style: { height: "8px" } }), skeleton("70%"));
}

export function pill(text: string, tone?: string, ico?: string): HTMLElement {
  return h("span", { class: "bv-pill", dataset: tone ? { tone } : {} },
    ico ? h("span", { html: icon(ico, 12), style: { display: "inline-grid" } }) : null, text);
}

export function card(opts: { title?: string; action?: Node; body: Child[] | Child }): HTMLElement {
  const kids = Array.isArray(opts.body) ? opts.body : [opts.body];
  return h("section", { class: "bv-card" },
    opts.title || opts.action
      ? h("div", { class: "bv-card-head" }, h("h2", null, opts.title || ""), opts.action || null)
      : null,
    ...kids);
}

/** Local in-iframe modal (the host bridge can't render rich inputs). */
export function openModal(opts: { title: string; body: Node; actions?: { label: string; primary?: boolean; danger?: boolean; onClick?: () => void | boolean }[]; onClose?: () => void }): { close: () => void } {
  const scrim = h("div", { class: "bv-scrim" });
  const close = () => { scrim.remove(); opts.onClose?.(); };
  scrim.addEventListener("click", (e) => { if (e.target === scrim) close(); });
  const foot = opts.actions?.length
    ? h("div", { class: "bv-modal-foot" }, ...opts.actions.map((a) =>
        h("button", { class: a.primary ? "primary" : a.danger ? "danger" : "ghost", onClick: () => { const keep = a.onClick?.(); if (keep !== true) close(); } }, a.label)))
    : null;
  scrim.append(h("div", { class: "bv-modal" },
    h("div", { class: "bv-modal-head" }, h("h2", null, opts.title), h("button", { class: "ghost icon", html: icon("x", 18), onClick: close })),
    h("div", { class: "bv-modal-body" }, opts.body),
    foot));
  document.body.append(scrim);
  return { close };
}

/** Local toast (richer than the host bridge toast; use for in-app feedback). */
let toastRoot: HTMLElement | null = null;
export function flash(message: string, kind: "success" | "error" | "info" | "warning" = "info") {
  if (!toastRoot) { toastRoot = h("div", { class: "bv-toast-root" }); document.body.append(toastRoot); }
  const ic = kind === "success" ? "check" : kind === "error" ? "alert" : kind === "warning" ? "alert" : "bell";
  const t = h("div", { class: "bv-toast", dataset: { kind }, html: icon(ic, 16) + `<span>${escapeHtml(message)}</span>` });
  toastRoot.append(t);
  setTimeout(() => { t.style.transition = "opacity .2s, transform .2s"; t.style.opacity = "0"; t.style.transform = "translateY(8px)"; setTimeout(() => t.remove(), 220); }, 3200);
}

export function fmtMoney(n: number, currency: string): string {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, minimumFractionDigits: 2 }).format(n || 0); }
  catch { return `${(n || 0).toFixed(2)} ${currency}`; }
}
export function fmtDate(iso: string, withTime = false): string {
  try { return new Date(iso).toLocaleString(undefined, withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" }); }
  catch { return iso; }
}
export function relTime(iso: string): string {
  const d = new Date(iso).getTime(); const diff = Date.now() - d;
  const m = Math.round(diff / 60000); if (m < 1) return "just now"; if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60); if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24); if (days < 7) return `${days}d ago`;
  return fmtDate(iso);
}
export function initials(name: string): string {
  return (name || "?").split(/\s+/).map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}
export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}
export function avatar(name: string): HTMLElement {
  return h("span", { class: "bv-avatar", title: name }, initials(name));
}
export { icon } from "./icons.js";
