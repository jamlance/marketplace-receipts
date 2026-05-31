/**
 * Curated lucide-style line icons, inlined as SVG strings so apps need
 * no icon font or runtime dep. 1.5px stroke, round caps, 20px box,
 * currentColor. Call icon("calendar") → svg string; size via the
 * `size` arg or CSS on the wrapping element.
 */

const P = (paths: string) =>
  (size = 20) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS: Record<string, (size?: number) => string> = {
  calendar: P('<rect x="3" y="4.5" width="18" height="16" rx="2.5"/><path d="M3 9h18M8 2.5v4M16 2.5v4"/>'),
  clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>'),
  ticket: P('<path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"/><path d="M14 6v12" stroke-dasharray="1.5 2.5"/>'),
  tag: P('<path d="M3 7v4.6a2 2 0 0 0 .6 1.4l7.4 7.4a2 2 0 0 0 2.8 0l4.6-4.6a2 2 0 0 0 0-2.8L11 5.6A2 2 0 0 0 9.6 5H5a2 2 0 0 0-2 2Z"/><circle cx="7.5" cy="9.5" r="1.2"/>'),
  receipt: P('<path d="M5 3.5h14v17l-2.3-1.4-2.3 1.4-2.4-1.4-2.4 1.4L5 20.5Z"/><path d="M9 8h6M9 12h6"/>'),
  gift: P('<rect x="3.5" y="9" width="17" height="11" rx="1.5"/><path d="M3.5 13h17M12 9v11"/><path d="M12 9S10.5 4.5 8 4.5 5.5 8 8 8s4-.0 4-.0Zm0 0s1.5-4.5 4-4.5 2.5 3.5 0 4.5-4 0-4 0Z"/>'),
  coins: P('<ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v4c0 1.7 2.7 3 6 3"/><path d="M3 11v4c0 1.7 2.7 3 6 3"/><circle cx="16" cy="14" r="5"/>'),
  pie: P('<path d="M12 3a9 9 0 1 0 9 9h-9Z"/><path d="M12 3v9h9A9 9 0 0 0 12 3Z"/>'),
  wallet: P('<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1"/><path d="M3 8v8.5A2.5 2.5 0 0 0 5.5 19H19a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 1 3 8Z"/><circle cx="16.5" cy="13.5" r="1"/>'),
  box: P('<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>'),
  folder: P('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
  phone: P('<path d="M5 4h3l1.5 4-2 1.5a12 12 0 0 0 5 5L19 16l4 1.5V20a2 2 0 0 1-2 2A18 18 0 0 1 3 6a2 2 0 0 1 2-2Z"/>'),
  utensils: P('<path d="M5 3v7a2 2 0 0 0 2 2 2 2 0 0 0 2-2V3M7 3v18M17 3c-1.5 0-2.5 2-2.5 5s1 4 2.5 4 2.5-1 2.5-4-1-5-2.5-5Zm0 9v9"/>'),
  cake: P('<path d="M4 20h16M5 20v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7"/><path d="M5 14c1.3 0 1.3 1.2 2.6 1.2S9 14 10.3 14s1.4 1.2 2.7 1.2S14.4 14 15.7 14 17 15.2 19 15.2"/><path d="M12 7.5V11M12 4.5v.5"/>'),
  sunrise: P('<path d="M12 3v3M5.6 9.6l-1.4-1.4M18.4 9.6l1.4-1.4M3 16h3M18 16h3M2 20h20"/><path d="M8 16a4 4 0 0 1 8 0"/>'),
  bell: P('<path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/>'),
  message: P('<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.2A8 8 0 1 1 21 12Z"/>'),
  scissors: P('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="M8 7.5 20 18M8 16.5 20 6"/>'),
  car: P('<path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13"/><path d="M4 13h16v4a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H7v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1Z"/><circle cx="7.5" cy="15" r="0.5"/><circle cx="16.5" cy="15" r="0.5"/>'),
  book: P('<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H20v15H6.5A1.5 1.5 0 0 0 5 19.5Z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H20"/>'),
  dumbbell: P('<path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/>'),
  camera: P('<path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="12.5" r="3.2"/>'),
  sparkles: P('<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="M18 14l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8Z"/>'),
  chef: P('<path d="M7 14a4 4 0 0 1-1-7.9A4 4 0 0 1 13 5a4 4 0 0 1 5 4 4 4 0 0 1-1 5"/><path d="M7 14v4a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-4"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  check: P('<path d="M5 12.5 10 17 19 6.5"/>'),
  x: P('<path d="M6 6l12 12M18 6 6 18"/>'),
  trash: P('<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>'),
  edit: P('<path d="M4 20h4l11-11a2 2 0 0 0-3-3L5 17Z"/><path d="M13.5 6.5l3 3"/>'),
  eye: P('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  search: P('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  link: P('<path d="M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5"/>'),
  qr: P('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3M20 14v.01M14 20h.01M17 20h.01M20 17v3"/>'),
  send: P('<path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10Z"/>'),
  user: P('<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0Z"/>'),
  users: P('<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.4M21 20a6 6 0 0 0-4-5.6"/>'),
  package: P('<path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M7.5 5.5 16.5 10.5"/>'),
  heart: P('<path d="M12 20S3 14.5 3 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 9 2.5C21 14.5 12 20 12 20Z"/>'),
  wrench: P('<path d="M14.5 5.5a4 4 0 0 0 5 5L21 12a6 6 0 0 1-8 5.5L7 21a2.1 2.1 0 0 1-3-3l3.5-6A6 6 0 0 1 12 4Z"/>'),
  store: P('<path d="M4 9.5 5 5h14l1 4.5M4 9.5V20h16V9.5M4 9.5h16M9 20v-5h6v5"/><path d="M4 9.5a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0"/>'),
  chart: P('<path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-7"/>'),
  arrowRight: P('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  download: P('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
  inbox: P('<path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M4 13 6 5h12l2 8v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/>'),
  alert: P('<path d="M12 4 2.5 20h19Z"/><path d="M12 10v4M12 17.5v.01"/>'),
  list: P('<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>'),
  settings: P('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.9-1.5-1.8-3.1-2.3 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-3.6l-.5 2.4a7.6 7.6 0 0 0-2.6 1.5l-2.3-1-1.8 3.1 1.9 1.5a7.6 7.6 0 0 0 0 3l-1.9 1.5 1.8 3.1 2.3-1a7.6 7.6 0 0 0 2.6 1.5l.5 2.4H14l.5-2.4a7.6 7.6 0 0 0 2.6-1.5l2.3 1 1.8-3.1Z"/>'),
  "credit-card": P('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>'),
  cash: P('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>'),
  copy: P('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  external: P('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>'),
  default: P('<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M8 12h8"/>'),
};

export function icon(name: string, size = 20): string {
  const fn = ICONS[name] ?? ICONS.default;
  return fn ? fn(size) : "";
}
export const iconNames = Object.keys(ICONS);
