/* Interface : relève le compteur (via serveur.js), lit les CSV et trace le graphique interactif. */
const NS = "http://www.w3.org/2000/svg";
const DAY = 864e5;
const nf = new Intl.NumberFormat("fr-FR");
const compactNf = new Intl.NumberFormat("fr-FR", { notation: "compact" });
const num = n => nf.format(Math.round(n));
const signed = n => (n >= 0 ? "+" : "−") + num(Math.abs(n));
const dLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const dDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long" });
const dDayYear = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const dTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dMonth = new Intl.DateTimeFormat("fr-FR", { month: "short" });
const dRow = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const $ = id => document.getElementById(id);
const ui = {
  total: $("total"), delta: $("delta"), status: $("statut"), refresh: $("actualiser"),
  chart: $("graphique"), events: $("evenements"), table: $("releves"),
};
const tip = Object.assign(document.createElement("div"), { className: "infobulle", hidden: true });
ui.chart.append(tip);

const state = { points: [], events: [], cursor: null, view: null, loaded: false };

/* ---------- Données ---------- */

// CSV avec guillemets ; accepte « , » ou « ; » (export Excel français).
function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const sep = firstLine.includes(";") && !firstLine.includes(",") ? ";" : ",";
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(v => v.trim()));
  if (!head) return [];
  const keys = head.map(k => k.trim().toLowerCase());
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

// « 2026-06-07 », « 2026-06-07 18:30 » ou « 07/06/2026 » → Date locale.
function parseDate(s) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return new Date(+m[3], m[2] - 1, +m[1]);
  return null;
}

// N'accepte que http(s) ; un chemin relatif (img/affiche.jpg) pointe dans public/.
function safeUrl(s) {
  if (!s) return "";
  try { const u = new URL(s, location.href); return /^https?:$/.test(u.protocol) ? u.href : ""; }
  catch { return ""; }
}

async function getCSV(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url} : HTTP ${r.status}`);
  return parseCSV(await r.text());
}

const toPoints = rows => rows
  .map(r => ({ t: parseDate(r.date ?? ""), n: Number.parseInt(r.soutiens, 10) }))
  .filter(p => p.t && Number.isFinite(p.n))
  .sort((a, b) => a.t - b.t);

const toEvents = rows => rows
  .map(r => {
    const start = parseDate(r.date_debut || r.date || "");
    if (!start || !r.titre) return null;
    start.setHours(0, 0, 0, 0);
    let last = parseDate(r.date_fin || "") || new Date(start);
    last.setHours(0, 0, 0, 0);
    if (last < start) last = new Date(start);
    const end = new Date(last); end.setDate(end.getDate() + 1); // borne exclusive : lendemain 0 h
    return { start, last, end, title: r.titre, link: safeUrl(r.lien), image: safeUrl(r.illustration) };
  })
  .filter(Boolean)
  .sort((a, b) => a.start - b.start)
  .map((e, i) => ({ ...e, num: i + 1 }));

// Valeur interpolée entre deux relevés (null hors de la période relevée).
function valueAt(t) {
  const p = state.points;
  if (!p.length || t < p[0].t || t > p.at(-1).t) return null;
  const i = p.findIndex(q => q.t >= t);
  if (i === 0 || +p[i].t === +t) return p[i].n;
  const a = p[i - 1], b = p[i];
  return a.n + (b.n - a.n) * (t - a.t) / (b.t - a.t);
}

// Soutiens gagnés pendant l'événement et les 7 jours suivants, comparés aux 30 jours précédents.
function eventStats(e) {
  const p = state.points;
  if (!p.length) return null;
  const first = p[0].t, lastT = p.at(-1).t;
  if (e.start > lastT) return { upcoming: true };
  if (e.end < first) return null;
  const from = e.start < first ? first : e.start;
  const to = new Date(Math.min(+e.end + 7 * DAY, +lastT));
  const v0 = valueAt(from), gain = valueAt(to) - v0, days = (to - from) / DAY;
  const out = { from, to, gain, rate: days >= 1 ? gain / days : null };
  const before = new Date(+from - 30 * DAY);
  if (before >= first) out.before = (v0 - valueAt(before)) / 30;
  return out;
}

const rangeLabel = e => dDayYear.formatRange(e.start, e.last);
const nearest = (pts, t) => {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid].t < t) lo = mid; else hi = mid; }
  return t - pts[lo].t <= pts[hi].t - t ? lo : hi;
};
const duration = ms => ms < DAY ? `en ${Math.max(1, Math.round(ms / 36e5))} h` : `en ${Math.round(ms / DAY)} j`;

/* ---------- Petits utilitaires DOM (textContent uniquement : les CSV sont des données) ---------- */

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
// parts : chaînes ou { b: "texte en gras" }
function rich(tag, cls, parts) {
  const n = h(tag, cls);
  for (const p of parts) n.append(typeof p === "string" ? p : h("b", null, p.b));
  return n;
}
function s(tag, attrs, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.append(n);
  return n;
}

function statsLines(e) {
  const st = eventStats(e);
  if (!st) return [["Antérieur aux relevés"]];
  if (st.upcoming) return [["À venir"]];
  const lines = [[{ b: signed(st.gain) }, ` soutiens du ${dDay.format(st.from)} au ${dDay.format(new Date(+st.to - 1))}`]];
  if (st.rate != null) {
    const l = [`≈ ${num(st.rate)} / jour`];
    if (st.before != null) l.push(`, contre ≈ ${num(st.before)} / jour les 30 jours précédents`);
    lines.push(l);
  }
  return lines;
}

function setActive(nums) {
  document.querySelectorAll("[data-num].actif").forEach(n => n.classList.remove("actif"));
  for (const k of nums) document.querySelectorAll(`[data-num="${k}"]`).forEach(n => n.classList.add("actif"));
}

/* ---------- Graphique ---------- */

function niceStep(max, count) {
  const raw = max / count, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

function render() {
  const { points: pts, events: evs } = state;
  ui.chart.querySelector("svg")?.remove();
  hideTip();
  const W = ui.chart.clientWidth, H = ui.chart.clientHeight;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H });
  ui.chart.prepend(svg);
  if (!pts.length) {
    if (state.loaded) s("text",{ x: W / 2, y: H / 2, "text-anchor": "middle", class: "titre-evt" }, svg).textContent = "Aucun relevé pour l'instant";
    state.view = null;
    return;
  }

  const compact = W < 560;
  const R = 11, ROW = 28;
  const m = { l: compact ? 40 : 64, r: 12, b: 28 };
  const iw = W - m.l - m.r;
  const t0 = new Date(Math.min(+pts[0].t, ...evs.map(e => +e.start)));
  const t1 = new Date(Math.max(+pts.at(-1).t, ...evs.map(e => +e.end)));
  const x = t => m.l + (t - t0) / (t1 - t0 || 1) * iw;

  // Pastilles : une rangée de plus quand deux dates clefs sont trop proches.
  const rowEnds = [];
  const placed = evs.map(e => {
    const xa = x(e.start), xb = x(e.end), cx = (xa + xb) / 2;
    let row = rowEnds.findIndex(end => cx - end >= 2 * R + 4);
    if (row === -1) { row = rowEnds.length; rowEnds.push(cx); } else rowEnds[row] = cx;
    return { e, xa, xb, cx, row, cy: row * ROW + R + 2 };
  });
  m.t = evs.length ? rowEnds.length * ROW + 14 : 20;
  const ih = H - m.t - m.b;
  const maxN = Math.max(...pts.map(p => p.n), 1);
  const step = niceStep(maxN, 5);
  const yMax = Math.ceil(maxN / step) * step;
  const y = v => m.t + ih - v / yMax * ih;
  const yFmt = v => (compact ? compactNf : nf).format(v);

  const deco = s("g", { "aria-hidden": "true" }, svg);
  const grid = s("g", { class: "grille" }, deco), axis = s("g", { class: "axe" }, deco);
  for (let v = 0; v <= yMax + step / 2; v += step) {
    if (v) s("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, grid);
    s("text", { x: m.l - 8, y: y(v), dy: "0.32em", "text-anchor": "end" }, axis).textContent = yFmt(v);
  }
  const months = [];
  for (let d = new Date(t0.getFullYear(), t0.getMonth() + 1, 1); d <= t1; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d);
  const every = Math.max(1, Math.ceil(48 / (iw / Math.max(1, (t1 - t0) / (30.44 * DAY)))));
  months.forEach((d, i) => {
    if (i % every) return;
    const xm = x(d);
    s("line", { class: "axe-base", x1: xm, x2: xm, y1: m.t + ih, y2: m.t + ih + 5 }, deco);
    const label = dMonth.format(d) + (d.getMonth() === 0 ? ` ${d.getFullYear()}` : "");
    s("text", { x: xm, y: m.t + ih + 19, "text-anchor": "middle" }, axis).textContent = label;
  });

  // Bandes des dates clefs (sous la courbe)
  for (const P of placed) {
    const g = s("g", { class: "evt", "data-num": P.e.num, "aria-hidden": "true" }, svg);
    s("rect", { class: "bande", x: P.xa, y: m.t, width: Math.max(2, P.xb - P.xa), height: ih }, g);
    if (P.e.last <= P.e.start) s("line", { class: "repere", x1: P.cx, x2: P.cx, y1: m.t, y2: m.t + ih }, g);
  }

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.n).toFixed(1)}`).join("");
  const last = pts.at(-1), lx = x(last.t), ly = y(last.n);
  const curve = s("g", { "aria-hidden": "true" }, svg);
  s("path", { class: "aire", d: `${line}L${lx.toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z` }, curve);
  s("path", { class: "ligne", d: line }, curve);
  s("line", { class: "axe-base", x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }, curve);
  s("circle", { class: "point-fin", cx: lx, cy: ly, r: 4 }, curve);
  s("text", { class: "etiquette-fin", x: lx - 10, y: Math.max(m.t + 12, ly - 10), "text-anchor": "end" }, curve).textContent = num(last.n);

  const cross = s("g", { "aria-hidden": "true", visibility: "hidden" }, svg);
  const vline = s("line", { class: "reticule", y1: m.t, y2: m.t + ih }, cross);
  const dot = s("circle", { class: "point-actif", r: 5 }, cross);
  const overlay = s("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent", style: "touch-action: pan-y" }, svg);

  function showPoint(i) {
    state.cursor = i;
    const p = pts[i], prev = pts[i - 1], px = x(p.t), py = y(p.n);
    vline.setAttribute("x1", px); vline.setAttribute("x2", px);
    dot.setAttribute("cx", px); dot.setAttribute("cy", py);
    cross.setAttribute("visibility", "visible");
    const inside = evs.filter(e => e.start <= p.t && p.t < e.end);
    setActive(inside.map(e => e.num));

    tip.replaceChildren(
      h("span", "valeur", `${num(p.n)} soutiens`),
      h("span", "sec", `${cap(dLong.format(p.t))} · ${dTime.format(p.t)}`),
    );
    if (prev) {
      const dt = p.t - prev.t, parts = [{ b: signed(p.n - prev.n) }, ` ${duration(dt)}`];
      if (dt >= 1.5 * DAY) parts.push(` · ≈ ${num((p.n - prev.n) / (dt / DAY))} / jour`);
      tip.append(rich("span", "delta", parts));
    }
    for (const e of inside) {
      const box = h("span", "lien-evt");
      const txt = h("span");
      txt.append(h("span", "titre", e.title), h("span", "sec", rangeLabel(e)));
      box.append(txt);
      tip.append(box);
    }
    placeTip(px + 16, py, "side", px - 16);
  }

  function showEvent(P) {
    cross.setAttribute("visibility", "hidden");
    setActive([P.e.num]);
    tip.replaceChildren();
    if (P.e.image) tip.append(Object.assign(document.createElement("img"), { src: P.e.image, alt: "" }));
    tip.append(h("span", "sec", rangeLabel(P.e)), h("span", "titre", P.e.title));
    for (const l of statsLines(P.e)) tip.append(rich("span", "delta", l));
    tip.append(h("span", "indice", P.e.link ? "Cliquer pour ouvrir le lien" : "Cliquer pour voir la fiche"));
    placeTip(P.cx, P.cy + R + 10, "below");
  }

  function placeTip(ax, ay, mode, altX) {
    tip.hidden = false;
    const w = tip.offsetWidth, th = tip.offsetHeight;
    let left, top;
    if (mode === "below") { left = ax - w / 2; top = ay; }
    else { left = ax + w > W ? altX - w : ax; top = ay - th / 2; }
    tip.style.left = `${Math.max(0, Math.min(W - w, left))}px`;
    tip.style.top = `${Math.max(0, Math.min(H - th, top))}px`;
  }

  function hide() {
    cross.setAttribute("visibility", "hidden");
    hideTip();
    setActive([]);
  }

  const pick = ev => {
    const px = ev.clientX - svg.getBoundingClientRect().left;
    showPoint(nearest(pts, new Date(+t0 + (px - m.l) / iw * (t1 - t0))));
  };
  overlay.addEventListener("pointermove", pick);
  overlay.addEventListener("pointerdown", pick);
  overlay.addEventListener("pointerleave", hide);

  // Pastilles numérotées + titres quand la place le permet
  const top = s("g", {}, svg);
  for (const P of placed) {
    P.g = s("g", { class: "evt", "data-num": P.e.num }, top);
    s("line", { class: "repere", x1: P.cx, x2: P.cx, y1: P.cy + R, y2: m.t, "aria-hidden": "true" }, P.g);
    const b = s("g", { class: "pastille", tabindex: 0, role: "button", "aria-label": `${P.e.num}. ${P.e.title}, ${rangeLabel(P.e)}` }, P.g);
    s("circle", { class: "cible", cx: P.cx, cy: P.cy, r: R + 7 }, b);
    s("circle", { class: "disque", cx: P.cx, cy: P.cy, r: R }, b);
    s("text", { x: P.cx, y: P.cy, dy: "0.35em", "text-anchor": "middle" }, b).textContent = P.e.num;
    const open = () => {
      if (P.e.link) window.open(P.e.link, "_blank", "noopener");
      else document.getElementById(`evt-${P.e.num}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    b.addEventListener("pointerenter", () => showEvent(P));
    b.addEventListener("pointerleave", hide);
    b.addEventListener("focus", () => showEvent(P));
    b.addEventListener("blur", hide);
    b.addEventListener("click", open);
    b.addEventListener("keydown", ev => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
  }
  for (let row = 0; row < rowEnds.length; row++) {
    const list = placed.filter(P => P.row === row).sort((a, b) => a.cx - b.cx);
    let prevEnd = m.l;
    list.forEach((P, k) => {
      const next = list[k + 1], gap = R + 6;
      const t = s("text", { class: "titre-evt", x: P.cx + gap, y: P.cy, dy: "0.35em", "aria-hidden": "true" }, P.g);
      t.textContent = P.e.title;
      const right = (next ? next.cx - gap : W - m.r) - (P.cx + gap);
      const left = P.cx - gap - (prevEnd + 20); // un titre à gauche ne doit pas se lire comme la suite du précédent
      const w = t.getComputedTextLength();
      const useLeft = w > right && left > right;
      const room = useLeft ? left : right;
      if (w > room) {
        if (room < 72) { t.remove(); prevEnd = P.cx + R; return; }
        let txt = P.e.title;
        while (txt.length > 1 && t.getComputedTextLength() > room) { txt = txt.slice(0, -1); t.textContent = txt.trimEnd() + "…"; }
      }
      if (useLeft) { t.setAttribute("x", P.cx - gap); t.setAttribute("text-anchor", "end"); prevEnd = P.cx + R; }
      else prevEnd = P.cx + gap + t.getComputedTextLength();
    });
  }

  const n = evs.length;
  ui.chart.setAttribute("aria-label",
    `Courbe des soutiens du ${dDayYear.format(pts[0].t)} au ${dDayYear.format(last.t)} : de ${num(pts[0].n)} à ${num(last.n)}` +
    (n ? `, ${n} date${n > 1 ? "s" : ""} clef${n > 1 ? "s" : ""}.` : "."));
  state.view = { showPoint, hide };
}

function hideTip() { tip.hidden = true; }

// Clavier sur le graphique : ← → parcourent les relevés.
ui.chart.addEventListener("keydown", ev => {
  if (ev.target !== ui.chart || !state.view) return;
  const max = state.points.length - 1, i = state.cursor ?? max;
  const moves = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: max };
  if (ev.key === "Escape") return state.view.hide();
  if (!(ev.key in moves)) return;
  ev.preventDefault();
  state.view.showPoint(Math.max(0, Math.min(max, moves[ev.key])));
});
ui.chart.addEventListener("focus", ev => { if (ev.target === ui.chart && state.view) state.view.showPoint(state.cursor ?? state.points.length - 1); });
ui.chart.addEventListener("blur", ev => { if (ev.target === ui.chart) state.view?.hide(); });

/* ---------- Reste de la page ---------- */

function renderSummary() {
  const pts = state.points, last = pts.at(-1), prev = pts.at(-2);
  ui.total.textContent = last ? num(last.n) : "—";
  ui.delta.replaceChildren();
  if (last && prev) {
    ui.delta.append(rich("span", null, [{ b: signed(last.n - prev.n) }, ` depuis le relevé du ${dDay.format(prev.t)} à ${dTime.format(prev.t)}`]));
  }
}

function poster(e) {
  return h("div", "affiche", dDay.formatRange(e.start, e.last));
}

function renderEvents() {
  ui.events.replaceChildren();
  if (!state.events.length) {
    ui.events.append(h("li", "vide", "Aucune date clef : ajoutez des lignes dans evenements.csv."));
    return;
  }
  for (const e of state.events) {
    const li = h("li", "evenement");
    li.id = `evt-${e.num}`;
    li.dataset.num = e.num;
    const visual = h("div", "evenement-visuel");
    if (e.image) {
      const img = Object.assign(document.createElement("img"), { src: e.image, alt: "", loading: "lazy" });
      img.addEventListener("error", () => img.replaceWith(poster(e)));
      visual.append(img);
    } else visual.append(poster(e));
    visual.append(h("span", "evenement-num", e.num));

    const body = h("div", "evenement-corps");
    body.append(h("p", "evenement-date", cap(rangeLabel(e))), h("h3", null, e.title));
    for (const l of statsLines(e)) body.append(rich("p", "evenement-stats", l));
    if (e.link) {
      const a = h("a", null, "En savoir plus →");
      Object.assign(a, { href: e.link, target: "_blank", rel: "noopener" });
      body.append(a);
    }
    li.append(visual, body);
    li.addEventListener("pointerenter", () => setActive([e.num]));
    li.addEventListener("pointerleave", () => setActive([]));
    ui.events.append(li);
  }
}

function renderTable() {
  const pts = state.points;
  ui.table.replaceChildren(...pts.map((p, i) => {
    const tr = h("tr");
    tr.append(h("td", null, dRow.format(p.t)), h("td", null, num(p.n)), h("td", null, i ? signed(p.n - pts[i - 1].n) : "—"));
    return tr;
  }).reverse());
}

function setStatus(text, isError = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("erreur", isError);
}

async function refresh() {
  ui.refresh.disabled = true;
  ui.chart.classList.add("chargement");
  setStatus("Relevé en cours…");
  let error = null;
  try {
    const r = await fetch("api/releve", { method: "POST" });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.erreur || `HTTP ${r.status}`);
  } catch (e) { error = e.message; }
  try {
    const [rows, eventRows] = await Promise.all([getCSV("data/soutiens.csv"), getCSV("data/evenements.csv").catch(() => [])]);
    state.points = toPoints(rows);
    state.events = toEvents(eventRows);
    state.cursor = null;
    state.loaded = true;
  } catch (e) {
    setStatus(`Impossible de lire les données (${e.message}). Lancez l'interface avec « node serveur.js ».`, true);
    ui.refresh.disabled = false;
    ui.chart.classList.remove("chargement");
    return;
  }
  renderSummary(); renderEvents(); renderTable(); render();
  const last = state.points.at(-1);
  if (error) setStatus(`Relevé impossible (${error}) : historique existant affiché.`, true);
  else if (last) setStatus(`Dernier relevé : ${dLong.format(last.t)} à ${dTime.format(last.t)}`);
  ui.refresh.disabled = false;
  ui.chart.classList.remove("chargement");
}

let frame = 0;
new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(render); }).observe(ui.chart);
document.fonts?.ready.then(render); // les titres des pastilles sont mesurés : on retrace une fois les polices chargées
ui.refresh.addEventListener("click", refresh);
refresh();
