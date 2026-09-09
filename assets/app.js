"use strict";

// ---- helpers -------------------------------------------------------------
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const pct = (v) => (v == null ? "—" : (v * 100).toFixed(1) + " %");
const intf = (v) => (v == null ? "—" : Number(v).toLocaleString("fr-FR"));
// Audience totale d'une session : audience unique direct ∪ replay quand elle a été
// comptée (attendees_total), sinon le direct seul (repli). Base du taux de présence.
const attTotal = (s) => (s.attendees_total != null ? s.attendees_total : (s.attendees || 0));

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
function fmtDate(s) {
  const d = parseDate(s);
  return d ? d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—";
}
function fmtDateTime(s) {
  const d = parseDate(s);
  return d ? d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}
function fmtDateLong(s) {
  const d = parseDate(s);
  return d ? d.toLocaleString("fr-FR", { weekday: "long", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}
const ts = (s) => { const d = parseDate(s); return d ? d.getTime() : 0; };

const STATUS = {
  past: { label: "Terminée", cls: "past" },
  upcoming: { label: "À venir", cls: "upcoming" },
  live: { label: "En direct", cls: "live" },
};

// Moyenne CSAT pondérée par le nombre de réponses (null si aucune donnée).
function csatAvg(sessions) {
  let num = 0, den = 0, scale = 5;
  for (const s of sessions) {
    const c = s.csat;
    if (c && typeof c === "object" && c.score != null && c.responses) {
      num += c.score * c.responses;
      den += c.responses;
      scale = c.scale || scale;
    }
  }
  return den ? { score: Math.round((num / den) * 100) / 100, scale, responses: den } : null;
}

// Index session_id -> session, pour la modale de détail.
const byId = new Map();

// État global : données chargées + bornes du filtre par date (null = illimité).
const state = { data: null, from: null, to: null };

// ---- filtre par date -----------------------------------------------------
const sessionDate = (s) => s.started_at || s.estimated_started_at || "";

function filterByDate(sessions, from, to) {
  const lo = from ? new Date(from + "T00:00:00").getTime() : null;
  const hi = to ? new Date(to + "T23:59:59.999").getTime() : null;
  if (lo == null && hi == null) return sessions;
  return sessions.filter((s) => {
    const t = ts(sessionDate(s));
    if (!t) return false;                    // sans date → exclue quand un filtre est posé
    if (lo != null && t < lo) return false;
    if (hi != null && t > hi) return false;
    return true;
  });
}

// Barre de filtre, injectée une seule fois dans #controls (si l'élément existe).
function buildControls() {
  const host = document.getElementById("controls");
  if (!host || host.dataset.ready) return;
  host.dataset.ready = "1";
  host.innerHTML = `
    <div class="filterbar">
      <span class="fb-label">Filtrer par date</span>
      <label class="fb-field">Du <input type="date" id="f-from"></label>
      <label class="fb-field">au <input type="date" id="f-to"></label>
      <button type="button" id="f-reset" class="fb-reset">Réinitialiser</button>
      <span class="fb-count" id="f-count"></span>
    </div>`;
  const from = host.querySelector("#f-from");
  const to = host.querySelector("#f-to");
  const apply = () => { state.from = from.value || null; state.to = to.value || null; render(); };
  from.addEventListener("change", apply);
  to.addEventListener("change", apply);
  host.querySelector("#f-reset").addEventListener("click", () => {
    from.value = ""; to.value = ""; state.from = state.to = null; render();
  });
}

// ---- rendu (re-jouable : filtre par date, rechargement admin) ------------
function render() {
  const app = document.getElementById("app");
  const data = state.data || {};
  const webinars = data.webinars || [];
  const all = data.sessions || [];
  const sessions = filterByDate(all, state.from, state.to);

  byId.clear();
  for (const s of sessions) byId.set(s.session_id, s);

  const cnt = document.getElementById("f-count");
  if (cnt) cnt.textContent = (state.from || state.to)
    ? `${sessions.length} / ${all.length} session(s)`
    : `${all.length} session(s)`;

  if (!webinars.length) {
    app.innerHTML = `<div class="card">Aucun webinar suivi pour le moment.</div>`;
    return;
  }
  app.innerHTML = "";
  for (const w of webinars) {
    app.appendChild(renderWebinar(w, sessions.filter((s) => s.event_id === w.id)));
  }
}

// ---- load ----------------------------------------------------------------
async function main() {
  const app = document.getElementById("app");
  try {
    const res = await fetch("./data/sessions.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    state.data = await res.json();
  } catch (e) {
    app.innerHTML = `<div class="card error">Données indisponibles pour le moment.</div>`;
    return;
  }

  const upd = document.getElementById("updated");
  if (state.data.generated_at) upd.textContent = "Mis à jour le " + fmtDateTime(state.data.generated_at);

  buildControls();
  render();

  // Délégation : tout élément [data-sid] ouvre le détail de la session.
  app.addEventListener("click", (e) => {
    const el = e.target.closest("[data-sid]");
    if (!el) return;
    const s = byId.get(el.getAttribute("data-sid"));
    if (s) openDetail(s);
  });
}

// Recharge sessions.json puis re-rend (appelé par la page admin après une
// mise à jour / un recalcul / une suppression). Conserve le filtre en cours.
async function reload() {
  try {
    const res = await fetch("./data/sessions.json", { cache: "no-store" });
    if (res.ok) state.data = await res.json();
  } catch (e) { /* on garde l'état courant */ }
  const upd = document.getElementById("updated");
  if (state.data && state.data.generated_at)
    upd.textContent = "Mis à jour le " + fmtDateTime(state.data.generated_at);
  render();
}

// Exposé pour la page admin (site/admin.html), qui réutilise ce rendu.
window.DASH = { render, reload, state, filterByDate };

// ---- render --------------------------------------------------------------
function renderWebinar(w, sessions) {
  const past = sessions.filter((s) => s.status === "past")
    .sort((a, b) => ts(a.estimated_started_at) - ts(b.estimated_started_at));
  const upcoming = sessions.filter((s) => s.status === "upcoming")
    .sort((a, b) => ts(a.estimated_started_at) - ts(b.estimated_started_at));

  const totReg = past.reduce((n, s) => n + (s.registrants || 0), 0);
  const totAtt = past.reduce((n, s) => n + (s.attendees || 0), 0);
  const totTotal = past.reduce((n, s) => n + attTotal(s), 0);   // direct + replay (unique)
  const totQ = past.reduce((n, s) => n + (s.questions || 0), 0);
  const avg = totReg ? totTotal / totReg : null;   // taux = (direct + replay) / inscrits
  const csat = csatAvg(past);

  const sec = document.createElement("section");
  sec.className = "webinar";
  sec.innerHTML = `
    <div class="wh">
      <h2>${esc(w.title || w.id)}</h2>
      ${w.type ? `<span class="tag">${esc(w.type)}</span>` : ""}
    </div>
    <div class="kpis">
      ${kpi("Taux de présence moyen", pct(avg), "passé")}
      ${kpi("Inscrits (cumul passé)", intf(totReg))}
      ${kpi("Présents (cumul passé)", intf(totAtt))}
      ${kpi("Questions posées (cumul)", intf(totQ))}
      ${csat ? kpi("Satisfaction (CSAT)", `${csat.score}/${csat.scale}`, `${intf(csat.responses)} rép.`) : ""}
      ${kpi("Sessions passées", intf(past.length))}
      ${kpi("Sessions à venir", intf(upcoming.length))}
    </div>
    <h3>Taux de présence par session</h3>
    ${barChart(past)}
    <h3>Participants par session (direct + replay)</h3>
    ${attendeesChart(past)}
    ${csat ? `<h3>Évolution de la satisfaction (CSAT)</h3>${csatChart(past)}` : ""}
    ${upcoming.length ? `<h3>Sessions à venir</h3>${upcomingList(upcoming)}` : ""}
    <h3>Détail des sessions passées</h3>
    ${table(past.slice().reverse())}
  `;
  return sec;
}

function kpi(label, value, note) {
  return `<div class="kpi"><div class="kpi-v">${value}</div>` +
    `<div class="kpi-l">${esc(label)}${note ? ` <em>(${esc(note)})</em>` : ""}</div></div>`;
}

function barChart(past) {
  if (!past.length) return `<p class="muted">Aucune session passée pour l'instant.</p>`;
  const W = 820, H = 280, padL = 42, padR = 12, padT = 18, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = past.length, step = iw / n, bw = Math.max(6, Math.min(46, step - 10));

  let grid = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const y = padT + ih - ih * t;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ay">${t * 100}%</text>`;
  });

  let bars = "";
  past.forEach((s, i) => {
    const r = Math.max(0, Math.min(1, s.attendance_rate || 0));
    const h = ih * r;
    const x = padL + i * step + (step - bw) / 2;
    const y = padT + ih - h;
    const d = fmtDate(s.estimated_started_at);
    const cx = (x + bw / 2).toFixed(1);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" class="bar" data-sid="${esc(s.session_id)}">` +
      `<title>${esc(d)} — ${pct(s.attendance_rate)} (${intf(attTotal(s))}/${intf(s.registrants)}) · cliquer pour le détail</title></rect>`;
    if (bw >= 22 && h > 16) bars += `<text x="${cx}" y="${(y - 5).toFixed(1)}" class="bv">${Math.round(r * 100)}</text>`;
    const ly = padT + ih + 16;
    bars += `<text x="${cx}" y="${ly}" class="ax" transform="rotate(40 ${cx} ${ly})">${esc(d)}</text>`;
  });

  const defs = `<defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#00BD57"/><stop offset="100%" stop-color="#006666"/>` +
    `</linearGradient></defs>`;

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Taux de présence par session">${defs}${grid}${bars}</svg></div>`;
}

// Participants par session : audience TOTALE (présents en direct ∪ spectateurs
// replay), en valeurs absolues, tracée en COURBE (mêmes conventions que csatChart).
// On retombe sur les présents en direct quand le total n'a pas été calculé
// (attendees_total absent, ex. webinar non publié). Le tooltip détaille les deux
// chiffres + le total. Axe Y en entiers à partir de 0. Points cliquables.
function attendeesChart(past) {
  if (!past.length) return `<p class="muted">Aucune session passée pour l'instant.</p>`;
  const val = (s) => Math.max(0, attTotal(s));
  const maxV = Math.max(1, ...past.map(val));

  const W = 820, H = 280, padL = 52, padR = 12, padT = 22, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = past.length, step = iw / n;
  const cx = (i) => padL + step * i + step / 2;
  const cy = (v) => padT + ih - ih * (v / maxV);

  let grid = "";
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const y = padT + ih - ih * t;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ay">${intf(Math.round(maxV * t))}</text>`;
  });

  const linePath = past.map((s, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${cy(val(s)).toFixed(1)}`).join(" ");
  const areaPath = `M${cx(0).toFixed(1)},${(padT + ih).toFixed(1)} `
    + past.map((s, i) => `L${cx(i).toFixed(1)},${cy(val(s)).toFixed(1)}`).join(" ")
    + ` L${cx(n - 1).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  let dots = "";
  past.forEach((s, i) => {
    const v = val(s), x = cx(i), y = cy(v);
    const d = fmtDate(s.estimated_started_at);
    // Si le replay a été compté (replay non null) : les deux chiffres + le total ;
    // sinon on n'a que le direct.
    const tip = s.replay != null
      ? `${esc(d)} — ${intf(v)} au total (audience unique) · ${intf(s.attendees)} en direct · ${intf(s.replay)} ont vu le replay`
      : `${esc(d)} — ${intf(v)} présent(s) en direct`;
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="att-dot" data-sid="${esc(s.session_id)}">` +
      `<title>${tip} · cliquer pour le détail</title></circle>`;
    dots += `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" class="av">${intf(v)}</text>`;
    const ly = padT + ih + 16;
    dots += `<text x="${x.toFixed(1)}" y="${ly}" class="ax" transform="rotate(40 ${x.toFixed(1)} ${ly})">${esc(d)}</text>`;
  });

  const defs = `<defs><linearGradient id="attGrad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#3E86FF" stop-opacity=".22"/>` +
    `<stop offset="100%" stop-color="#3E86FF" stop-opacity="0"/></linearGradient></defs>`;
  const areaEl = n > 1 ? `<path d="${areaPath}" class="att-area"/>` : "";
  const lineEl = n > 1 ? `<path d="${linePath}" class="att-line"/>` : "";

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Participants (direct + replay) par session">${defs}${grid}${areaEl}${lineEl}${dots}</svg></div>`;
}

// Courbe d'évolution du CSAT par session (mêmes conventions que barChart).
// Seules les sessions notées sont tracées ; l'axe Y est borné [plancher, échelle]
// — on part d'un plancher propre sous la note la plus basse pour rendre la
// tendance lisible (les CSAT se tiennent en haut de l'échelle) sans jamais
// dépasser le maximum réel. Les points sont cliquables (détail de la session).
function csatChart(past) {
  const pts = past.filter((s) => s.csat && typeof s.csat === "object" && s.csat.score != null);
  if (!pts.length) return `<p class="muted">Pas encore de réponses de satisfaction.</p>`;
  const scale = pts[0].csat.scale || 5;
  const scores = pts.map((s) => s.csat.score);
  const dataMin = Math.min.apply(null, scores);

  const top = scale;
  let bottom = Math.max(0, Math.floor(dataMin - 0.5));
  if (top - bottom < 1) bottom = Math.max(0, top - 1);
  const range = (top - bottom) || 1;
  const tickStep = range <= 2 ? 0.5 : 1;
  const decimals = tickStep < 1 ? 1 : 0;

  const W = 820, H = 280, padL = 42, padR = 12, padT = 22, padB = 74;
  const iw = W - padL - padR, ih = H - padT - padB;
  const n = pts.length, step = iw / n;
  const cx = (i) => padL + step * i + step / 2;
  const cy = (v) => padT + ih - ih * ((v - bottom) / range);

  let grid = "";
  for (let t = bottom; t <= top + 1e-9; t += tickStep) {
    const y = cy(t);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" class="grid"/>`;
    grid += `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" class="ay">${t.toFixed(decimals)}</text>`;
  }

  const linePath = pts.map((s, i) => `${i ? "L" : "M"}${cx(i).toFixed(1)},${cy(s.csat.score).toFixed(1)}`).join(" ");
  const areaPath = `M${cx(0).toFixed(1)},${(padT + ih).toFixed(1)} `
    + pts.map((s, i) => `L${cx(i).toFixed(1)},${cy(s.csat.score).toFixed(1)}`).join(" ")
    + ` L${cx(n - 1).toFixed(1)},${(padT + ih).toFixed(1)} Z`;

  let dots = "";
  pts.forEach((s, i) => {
    const x = cx(i), y = cy(s.csat.score);
    const d = fmtDate(s.estimated_started_at);
    const resp = s.csat.responses != null ? ` · ${intf(s.csat.responses)} rép.` : "";
    dots += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" class="spark-dot" data-sid="${esc(s.session_id)}">` +
      `<title>${esc(d)} — ${String(s.csat.score).replace(".", ",")}/${scale}${resp} · cliquer pour le détail</title></circle>`;
    dots += `<text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" class="sv">${String(s.csat.score).replace(".", ",")}</text>`;
    const ly = padT + ih + 16;
    dots += `<text x="${x.toFixed(1)}" y="${ly}" class="ax" transform="rotate(40 ${x.toFixed(1)} ${ly})">${esc(d)}</text>`;
  });

  const defs = `<defs><linearGradient id="csatGrad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-color="#00BD57" stop-opacity=".25"/>` +
    `<stop offset="100%" stop-color="#00BD57" stop-opacity="0"/></linearGradient></defs>`;
  const areaEl = n > 1 ? `<path d="${areaPath}" class="spark-area"/>` : "";
  const lineEl = n > 1 ? `<path d="${linePath}" class="spark-line"/>` : "";

  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" ` +
    `aria-label="Évolution de la satisfaction CSAT par session">${defs}${grid}${areaEl}${lineEl}${dots}</svg></div>`;
}

function upcomingList(up) {
  return `<ul class="upcoming">` + up.map((s) =>
    `<li data-sid="${esc(s.session_id)}"><span class="u-date">${esc(fmtDateTime(s.estimated_started_at))}</span>` +
    `<span class="u-reg">${intf(s.registrants)} inscrits à ce jour</span></li>`
  ).join("") + `</ul>`;
}

function table(rows) {
  if (!rows.length) return `<p class="muted">—</p>`;
  const body = rows.map((s) => {
    const dur = s.duration_min != null
      ? intf(s.duration_min) + " min" + (s.duration_anomaly ? " ⚠️" : "")
      : "—";
    return `<tr data-sid="${esc(s.session_id)}">
      <td>${esc(fmtDateTime(s.estimated_started_at))}</td>
      <td class="num">${intf(s.registrants)}</td>
      <td class="num">${intf(s.attendees)}</td>
      <td class="num">${pct(s.attendance_rate)}</td>
      <td class="num">${dur}</td>
      <td class="num">${intf(s.questions)}</td>
      <td class="num"><span class="rowcta">voir →</span></td>
    </tr>`;
  }).join("");
  return `<div class="tablewrap"><table>
    <thead><tr><th>Session</th><th class="num">Inscrits</th><th class="num">Présents</th>` +
    `<th class="num">Taux</th><th class="num">Durée</th><th class="num">Questions</th><th class="num"></th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

// ---- modale de détail ----------------------------------------------------
let dlg = null;

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "detail";
  document.body.appendChild(dlg);
  // Fermeture au clic sur le fond (backdrop).
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  return dlg;
}

function stat(value, label, cls) {
  return `<div class="stat${cls ? " " + cls : ""}"><div class="stat-v">${value}</div>` +
    `<div class="stat-l">${esc(label)}</div></div>`;
}

function csatTile(s) {
  const c = s.csat;
  if (c == null || (typeof c === "object" && c.score == null)) {
    return `<div class="stat full soon"><div class="stat-v">Bientôt disponible</div>` +
      `<div class="stat-l">Satisfaction (CSAT) par session — collecte en cours de mise en place</div></div>`;
  }
  if (typeof c === "object") {
    const scale = c.scale || 5;
    const resp = c.responses != null ? ` · ${intf(c.responses)} réponse(s)` : "";
    return stat(`${c.score}/${scale}`, `Satisfaction (CSAT)${resp}`, "full");
  }
  return stat(`${(c * 100).toFixed(0)} %`, "Satisfaction (CSAT)", "full");
}

function openDetail(s) {
  const d = ensureDialog();
  const st = STATUS[s.status] || { label: s.status || "—", cls: "past" };
  const when = s.started_at || s.estimated_started_at;
  const dur = s.duration_min != null
    ? intf(s.duration_min) + " min" + (s.duration_anomaly ? " ⚠️" : "")
    : "—";
  const attLabel = s.status === "upcoming" ? "Inscrits à ce jour" : "Inscrits";
  // Détail replay : uniquement si le comptage a eu lieu (replay non null, càd
  // session terminée d'un webinar publié). Sinon on n'affiche que le direct.
  const hasReplay = s.replay != null;
  const replayTiles = hasReplay
    ? stat(intf(s.replay), "Ont vu le replay") +
      stat(intf(s.attendees_total), "Audience totale (direct + replay)")
    : "";

  d.innerHTML = `
    <div class="dlg-head">
      <button class="dlg-close" aria-label="Fermer" onclick="this.closest('dialog').close()">×</button>
      <h3>${esc(s.event_title || "Session")}</h3>
      <div class="dlg-sub">${esc(fmtDateLong(when))}</div>
      <span class="dlg-badge ${st.cls}">${esc(st.label)}</span>
    </div>
    <div class="dlg-body">
      <div class="stat-grid">
        ${stat(intf(s.registrants), attLabel)}
        ${stat(intf(s.attendees), hasReplay ? "Présents en direct" : "Présents")}
        ${replayTiles}
        ${stat(pct(s.attendance_rate), "Taux de présence")}
        ${stat(dur, "Durée")}
        ${stat(intf(s.questions), "Questions posées")}
        ${stat(esc(st.label), "Statut")}
        ${csatTile(s)}
      </div>
    </div>`;
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
}

document.addEventListener("DOMContentLoaded", main);
