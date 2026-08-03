/* =========================================================================
   Rodent Breeding Monitor — offline-first tracker with Google Sheets sync
   ========================================================================= */

'use strict';

/* ------------------------------------------------------------------ *
 *  Constants & helpers
 * ------------------------------------------------------------------ */
const LS_KEY          = 'rbm.state.v1';
const STAGE_COLORS    = ['--s0','--s1','--s2','--s3','--s4'];
const STAGE_HEX       = ['#fb7185','#facc15','#94a3b8','#e2c97e','#fb923c'];
const SYNC_DEBOUNCE   = 1200;   // ms after last change before pushing
const AUTO_PULL_MS    = 15000;  // background pull interval when online
const SYNC_TIMEOUT_MS = 45000;  // Apps Script cold-start can take 30-40s

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const now = () => Date.now();
const todayISO = () => new Date().toISOString().slice(0,10);
// Store dates as yyyymmdd (e.g. "20260802")
const toYMD     = d  => d.toISOString().slice(0,10).replace(/-/g,'');
// Parse "20260802", "2026-08-02", or full ISO timestamp → Date
const parseYMD  = s  => { s=String(s||''); if(/^\d{8}$/.test(s)) s=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); if(s.length>10) s=s.slice(0,10); return new Date(s?s+'T00:00:00':NaN); };
// "20260802" → "2026-08-02" for <input type="date">
const ymdToInput = s => { s=String(s||''); return /^\d{8}$/.test(s)?s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8):s; };
// Normalize any date string to yyyymmdd for lexicographic comparison
const normYMD   = s  => toYMD(parseYMD(s));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function daysBetween(fromDateStr, toDate = new Date()) {
  const a = parseYMD(fromDateStr); // handles both formats
  const b = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.floor((b - a) / 86400000);
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtDate(d) { return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
function fmtTimestamp(ms) {
  const d = new Date(ms);
  const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const hm  = String(d.getHours()).padStart(2,'0') + '-' + String(d.getMinutes()).padStart(2,'0');
  return ymd + ': ' + hm;
}
function stageColor(i) { return `var(${STAGE_COLORS[i % STAGE_COLORS.length]})`; }

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const ENTITIES = ['species','shelves','trays','cohorts','removals'];

let state = {
  species:[], shelves:[], trays:[], cohorts:[], removals:[],
  meta: { scriptUrl:'', lastSync:0, forecastWeeks:8 },
  pending: {}
};

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      state = Object.assign(state, p);
      for (const e of ENTITIES) state[e] = state[e] || [];
      state.meta   = Object.assign({ scriptUrl:'', lastSync:0, forecastWeeks:8 }, state.meta);
      state.pending = state.pending || {};
    }
  } catch(e) { console.warn('load failed', e); }
  if (state.species.length === 0 && state.shelves.length === 0) seedExample();
}

function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
  catch(e) { console.warn('save failed', e); }
}

function seedExample() {
  const mouse = rec('species', { name:'Mouse', stages:[
    {name:'Pinky', startDay:0},{name:'Fuzzy', startDay:5},
    {name:'Hopper', startDay:10},{name:'Adult', startDay:21}
  ]});
  state.species.push(mouse);
  const shelf = rec('shelves', { name:'Shelf 1', sortOrder:0 });
  state.shelves.push(shelf);
  state.trays.push(rec('trays', { shelfId:shelf.id, name:'Tray 1', speciesId:mouse.id }));
  clearPending();
}

function rec(entity, fields) {
  return Object.assign({ id:uid(), updatedAt:now(), deleted:false }, fields);
}

// Readable ID generators
function genTrayId(shelfId) {
  const shelf = byId('shelves', shelfId);
  const prefix = shelf ? shelf.name.trim()[0].toUpperCase() : 'T';
  let n = live('trays').filter(t => t.shelfId === shelfId).length + 1;
  while (live('trays').some(t => t.id === `${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
}
function genSpeciesId(name) {
  const base = name.trim().slice(0,3).toUpperCase().replace(/[^A-Z]/g,'') || 'SPP';
  if (!live('species').some(s => s.id === base)) return base;
  for (let i = 2; i < 20; i++) {
    const cand = base.slice(0,2) + i;
    if (!live('species').some(s => s.id === cand)) return cand;
  }
  return uid();
}

function touch(entity, record) {
  record.updatedAt = now();
  markPending(entity, record.id);
  saveState();
  scheduleSync();
}
function upsertLocal(entity, record) {
  const arr = state[entity];
  const i = arr.findIndex(r => r.id === record.id);
  if (i >= 0) arr[i] = record; else arr.push(record);
}
function removeRecord(entity, id) {
  const r = state[entity].find(x => x.id === id);
  if (!r) return;
  r.deleted = true;
  touch(entity, r);
}
function markPending(entity, id) {
  state.pending[entity] = state.pending[entity] || {};
  state.pending[entity][id] = true;
}
function clearPending() { state.pending = {}; }
function pendingCount() {
  return ENTITIES.reduce((n,e) => n + Object.keys(state.pending[e] || {}).length, 0);
}

const live  = entity => state[entity].filter(r => !r.deleted);
const byId  = (entity, id) => state[entity].find(r => r.id === id);
const speciesOf = obj => {
  if (!obj) return null;
  const exact = byId('species', obj.speciesId);
  if (exact && !exact.deleted) return exact;
  // Fallback: if only one live species exists, use it (handles ID-mismatch after re-sync)
  const all = live('species');
  return all.length === 1 ? all[0] : null;
};

/* ------------------------------------------------------------------ *
 *  Domain calculations
 * ------------------------------------------------------------------ */
function cohortNet(cohort, asOf = new Date()) {
  const asYMD = toYMD(asOf);
  let removed = 0;
  for (const r of state.removals) {
    if (r.deleted || r.cohortId !== cohort.id) continue;
    if (normYMD(r.date) <= asYMD) removed += Number(r.count) || 0;
  }
  return Math.max(0, (Number(cohort.initialCount) || 0) - removed);
}

function stageIndexAt(cohort, atDate = new Date()) {
  const sp = speciesOf(cohort);
  if (!sp || !sp.stages?.length) return { idx:0, name:'—', species:sp };
  const stages = [...sp.stages].sort((a,b) => a.startDay - b.startDay);
  const age = daysBetween(cohort.birthDate, atDate);
  let idx = 0;
  for (let i = 0; i < stages.length; i++) {
    if (age >= stages[i].startDay) idx = i; else break;
  }
  return { idx, name:stages[idx].name, species:sp, age, stages };
}

function stageTotalsAt(atDate = new Date(), filter = () => true) {
  const totals = new Map();
  let total = 0;
  for (const c of live('cohorts')) {
    if (!filter(c)) continue;
    const net = cohortNet(c, atDate);
    if (net <= 0) continue;
    const sp = speciesOf(c);
    if (sp?.lifespan && daysBetween(c.birthDate, atDate) >= sp.lifespan) continue;
    const { name } = stageIndexAt(c, atDate);
    totals.set(name, (totals.get(name) || 0) + net);
    total += net;
  }
  return { totals, total };
}

function orderedStageNames() {
  const first = new Map();
  for (const sp of live('species')) {
    for (const st of (sp.stages || [])) {
      if (!first.has(st.name) || st.startDay < first.get(st.name)) first.set(st.name, st.startDay);
    }
  }
  return [...first.entries()].sort((a,b) => a[1]-b[1]).map(e => e[0]);
}

function computeRemovalInsights() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const recent = live('removals').filter(r => r.count > 0 && parseYMD(r.date) >= cutoff);
  const byStage = new Map();
  for (const r of recent) {
    const cohort = live('cohorts').find(c => c.id === r.cohortId);
    if (!cohort) continue;
    const { name } = stageIndexAt(cohort, parseYMD(r.date));
    byStage.set(name, (byStage.get(name) || 0) + (Number(r.count) || 0));
  }
  const weeksObs = 30 / 7;
  const rates = new Map();
  for (const [name, total] of byStage) rates.set(name, total / weeksObs);
  return rates;
}

function forecast(weeks, filter = () => true) {
  const names = orderedStageNames();
  const rates = computeRemovalInsights();
  const points = [];
  for (let w = 0; w <= weeks; w++) {
    const d = addDays(new Date(), w * 7);
    const { totals } = stageTotalsAt(d, filter);
    const adjustedTotals = new Map();
    let total = 0;
    names.forEach(nm => {
      const base = totals.get(nm) || 0;
      const predicted = Math.round((rates.get(nm) || 0) * w);
      const adjusted = Math.max(0, base - predicted);
      adjustedTotals.set(nm, adjusted);
      total += adjusted;
    });
    points.push({ week:w, date:d, totals:adjustedTotals, total });
  }
  return { names, points };
}

function renderTrayStageBarChart(shelfId = 'all', trayId = 'all') {
  const today = new Date();
  const names = orderedStageNames();
  if (!names.length) return '';

  let trays = live('trays');
  if (shelfId !== 'all') trays = trays.filter(t => t.shelfId === shelfId);
  if (trayId  !== 'all') trays = trays.filter(t => t.id === trayId);

  // Aggregate counts across all trays — one total per stage
  const stageTotals = new Map();
  for (const tray of trays) {
    for (const c of live('cohorts').filter(c => c.trayId === tray.id && cohortNet(c) > 0)) {
      const { name } = stageIndexAt(c, today);
      stageTotals.set(name, (stageTotals.get(name) || 0) + cohortNet(c));
    }
  }

  const stageData = names.map((nm, i) => ({ nm, i, count: stageTotals.get(nm) || 0 }))
                         .filter(d => d.count > 0);
  if (!stageData.length) return '';

  // Dimensions
  const VW = 560, PT = 20, PL = 36, PR = 16;
  const drawW = VW - PL - PR;
  const drawH = 148;
  const xLabelH = 22;
  const VH = PT + drawH + xLabelH;

  const maxVal  = Math.max(1, ...stageData.map(d => d.count));
  const numBars = stageData.length;
  const groupW  = drawW / numBars;
  const barW    = Math.max(20, Math.min(72, groupW * 0.55));

  let bars = '', xLabels = '', yLines = '';

  // Y-axis baseline + gridlines
  yLines += `<line x1="${PL}" y1="${PT + drawH}" x2="${PL + drawW}" y2="${PT + drawH}" stroke="rgba(255,255,255,.15)" stroke-width="1"/>`;
  for (let t = 1; t <= 4; t++) {
    const frac = t / 4;
    const yy   = PT + drawH * (1 - frac);
    const val  = Math.round(maxVal * frac);
    yLines += `<line x1="${PL}" y1="${yy}" x2="${PL + drawW}" y2="${yy}" class="g-grid"/>`;
    yLines += `<text x="${PL - 5}" y="${yy + 4}" class="g-dt" text-anchor="end">${val}</text>`;
  }

  // One bar per stage
  stageData.forEach(({ nm, i, count }, idx) => {
    const bh    = (count / maxVal) * drawH;
    const cx    = PL + idx * groupW + groupW / 2;
    const bx    = cx - barW / 2;
    const by    = PT + drawH - bh;
    const color = STAGE_HEX[i % STAGE_HEX.length];
    bars += `<rect x="${bx}" y="${by}" width="${barW}" height="${bh}"
      rx="4" fill="${color}" opacity=".85">
      <title>${esc(nm)}: ${count}</title></rect>`;
    bars += `<text x="${cx}" y="${by - 6}" class="g-dt" text-anchor="middle" font-weight="700" fill="${color}">${count}</text>`;
    xLabels += `<text x="${cx}" y="${PT + drawH + xLabelH - 4}"
      class="g-dt" text-anchor="middle">${esc(nm)}</text>`;
  });

  return `<div class="gantt-wrap">
    <svg class="gantt-svg" viewBox="0 0 ${VW} ${VH}" xmlns="http://www.w3.org/2000/svg">
      <defs><style>
        .g-dt{font:10px Inter,sans-serif;fill:var(--text-2)}
        .g-grid{stroke:rgba(255,255,255,.07);stroke-width:1}
      </style></defs>
      ${yLines}${bars}${xLabels}
    </svg>
  </div>`;
}

function renderCohortTimeline(shelfId = 'all', trayId = 'all') {
  const PAST  = 14;
  const FUT   = 70;
  const TOTAL = PAST + FUT;
  const LW    = 116; // label column width
  const DPX   = 5;   // px per day
  const RH    = 34;  // row height
  const RG    = 4;   // row gap
  const HDR   = 32;  // header height
  const PAD_B = 12;
  const today     = new Date();
  const startDate = addDays(today, -PAST);

  // Collect trays to show, applying shelf / tray filters
  let trays = live('trays');
  if (shelfId !== 'all') trays = trays.filter(t => t.shelfId === shelfId);
  if (trayId  !== 'all') trays = trays.filter(t => t.id      === trayId);

  // Group active cohorts by tray — one row per tray
  const trayRows = [];
  for (const tray of trays) {
    const cohorts = live('cohorts')
      .filter(c => c.trayId === tray.id && cohortNet(c) > 0)
      .sort((a, b) => parseYMD(a.birthDate) - parseYMD(b.birthDate)); // oldest first
    if (!cohorts.length) continue;
    const netTotal = cohorts.reduce((s, c) => s + cohortNet(c), 0);
    trayRows.push({ tray, cohorts, netTotal });
  }

  if (!trayRows.length) return '';

  const W = LW + TOTAL * DPX;
  const H = HDR + trayRows.length * (RH + RG) + PAD_B;
  const todayX = LW + PAST * DPX;

  // Week gridlines + date labels
  let grid = '', hdates = '';
  for (let d = 0; d <= TOTAL; d += 7) {
    const x  = LW + d * DPX;
    const dt = addDays(startDate, d);
    grid += `<line x1="${x}" y1="${HDR - 4}" x2="${x}" y2="${H - PAD_B}" class="g-grid"/>`;
    if (Math.abs(x - todayX) > 22)
      hdates += `<text x="${x}" y="18" class="g-dt" text-anchor="middle">${fmtDate(dt)}</text>`;
  }

  // One row per tray; multiple cohorts draw layered bars within the row
  let rows = '';
  trayRows.forEach(({ tray, cohorts, netTotal }, ri) => {
    const y = HDR + ri * (RH + RG);

    // Row background stripe
    rows += `<rect x="${LW}" y="${y + 2}" width="${TOTAL * DPX}" height="${RH - 4}" rx="4" class="g-row-bg"/>`;

    // Draw each cohort's stage bars — oldest behind, newest in front
    cohorts.forEach((cohort, ci) => {
      const sp     = speciesOf(cohort);
      const stages = sp?.stages ? [...sp.stages].sort((a,b) => a.startDay - b.startDay) : [];
      const birth  = parseYMD(cohort.birthDate);
      // Newer cohorts get a slightly thinner bar so layering is visible
      const shrink = ci * 3;
      const barY   = y + 5 + shrink;
      const barH   = RH - 10 - shrink * 2;

      if (stages.length) {
        stages.forEach((st, si) => {
          const nextSt   = stages[si + 1];
          const segStart = new Date(Math.max(+addDays(birth, st.startDay), +startDate));
          const segEnd   = nextSt
            ? new Date(Math.min(+addDays(birth, nextSt.startDay), +addDays(today, FUT)))
            : addDays(today, FUT);
          if (segStart >= segEnd) return;
          const dx  = Math.floor((segStart - startDate) / 86400000);
          const dw  = Math.ceil((segEnd - segStart) / 86400000);
          const sx  = LW + dx * DPX;
          const sw  = dw * DPX;
          const hex = STAGE_HEX[si % STAGE_HEX.length];
          const past = segEnd <= today;
          rows += `<rect x="${sx}" y="${barY}" width="${sw}" height="${barH}" rx="3"
            fill="${hex}" opacity="${past ? .28 : .72}"><title>${esc(tray.name)} · ${esc(st.name)}</title></rect>`;
          if (si > 0)
            rows += `<line x1="${sx}" y1="${y + 3}" x2="${sx}" y2="${y + RH - 3}"
              stroke="${hex}" stroke-width="1.5" opacity=".4"/>`;
        });
      } else {
        const dx = Math.max(0, Math.floor((+birth - +startDate) / 86400000));
        const sw = Math.max(DPX, (PAST - dx) * DPX);
        rows += `<rect x="${LW + dx * DPX}" y="${barY}" width="${sw}" height="${barH}"
          rx="3" fill="#94a3b8" opacity=".35"/>`;
      }
    });

    // Cohort-count badge (when tray has >1 cohort)
    const badge = cohorts.length > 1
      ? ` <tspan style="font-size:9px;opacity:.65">(${cohorts.length})</tspan>` : '';
    rows += `<text x="${LW - 6}" y="${y + RH/2 + 4}" class="g-lbl" text-anchor="end">${esc(tray.name)}${badge}</text>`;
    rows += `<text x="${LW + TOTAL * DPX + 2}" y="${y + RH/2 + 4}" class="g-cnt" text-anchor="start">${netTotal}</text>`;
  });

  const todayLine = `
    <line x1="${todayX}" y1="${HDR - 4}" x2="${todayX}" y2="${H - PAD_B}" class="g-today"/>
    <text x="${todayX}" y="18" class="g-today-lbl" text-anchor="middle">Today</text>`;

  return `<div class="gantt-wrap">
    <svg class="gantt-svg" viewBox="0 0 ${W + 28} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><style>
        .g-dt{font:10px Inter,sans-serif;fill:var(--text-2)}
        .g-lbl{font:600 11px Inter,sans-serif;fill:var(--text)}
        .g-cnt{font:11px Inter,sans-serif;fill:var(--text-2)}
        .g-row-bg{fill:rgba(255,255,255,.04)}
        .g-grid{stroke:rgba(255,255,255,.07);stroke-width:1}
        .g-today{stroke:#f97316;stroke-width:2;stroke-dasharray:4 3}
        .g-today-lbl{font:600 9px Inter,sans-serif;fill:#f97316}
      </style></defs>
      ${grid}${rows}${hdates}${todayLine}
    </svg>
  </div>`;
}

function renderRemovalInsights(rates) {
  if (!rates || !rates.size) return '';
  const names = orderedStageNames();
  const chips = names
    .filter(nm => (rates.get(nm) || 0) >= 0.1)
    .map(nm => {
      const i = names.indexOf(nm);
      const hex = STAGE_HEX[i % STAGE_HEX.length];
      return `<span class="insight-chip">
        <span class="insight-dot" style="background:${hex}"></span>
        <span class="insight-stage">${esc(nm)}</span>
        <span class="insight-rate">~${rates.get(nm).toFixed(1)}/wk</span>
      </span>`;
    });
  if (!chips.length) return '';
  return `<div class="removal-insights">
    <div class="ri-head">Learned removal patterns <span class="ri-sub">30-day avg</span></div>
    <div class="ri-chips">${chips.join('')}</div>
  </div>`;
}

/* ------------------------------------------------------------------ *
 *  Navigation & history
 * ------------------------------------------------------------------ */
let activeTab = 'dashboard';
let _modalPushed = false;

function switchTab(name, pushHistory = true) {
  activeTab = name;
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  if (pushHistory) history.pushState({ tab: name }, '');
  const fab = document.querySelector('.fab');
  if (fab) fab.style.display = name === 'trays' ? '' : 'none';
  render();
}

function initHistory() {
  history.replaceState({ tab: activeTab }, '');
}

window.addEventListener('popstate', e => {
  // Back pressed while modal is open → close modal (already popped by browser)
  if (!$('#modal-root').hidden) {
    _modalPushed = false;
    $('#modal-root').hidden = true;
    $('#modal-body').innerHTML = '';
    return;
  }
  const tab = e.state?.tab;
  if (tab && tab !== activeTab) switchTab(tab, false);
});

// Desktop: warn before tab close / navigation if changes are pending
window.addEventListener('beforeunload', e => {
  if (pendingCount() > 0) {
    e.preventDefault();
    e.returnValue = 'You have unsynced changes that have not been uploaded to Google Sheet. Leave anyway?';
  }
});

// Mobile: fire-and-forget upload when app goes to background or page is hidden
function syncOnExit() {
  if (!pendingCount() || !navigator.onLine || !state.meta.scriptUrl) return;
  const changes = {};
  for (const e of ENTITIES) {
    const ids = Object.keys(state.pending[e] || {});
    if (ids.length) changes[e] = ids.map(id => byId(e, id)).filter(Boolean);
  }
  try {
    fetch(state.meta.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ since: state.meta.lastSync || 0, changes }),
      keepalive: true   // keeps request alive even after page is unloaded
    });
  } catch(_) {}
}
window.addEventListener('pagehide',         syncOnExit);

/* ------------------------------------------------------------------ *
 *  Rendering
 * ------------------------------------------------------------------ */
let dashFilterSpecies  = 'all';
let fcVisibleStages   = null; // null = all visible; Set of stage names when filtered
let chartFilterShelf  = 'all';
let chartFilterTray   = 'all';
let collapsedShelves  = new Set(); // shelf IDs currently collapsed in Trays tab
let selectedShelfId   = null;      // shelf being viewed in Trays tab (null = overview)

function render() {
  renderSync();
  if      (activeTab === 'dashboard') renderDashboard();
  else if (activeTab === 'trays')     renderTrays();
  else if (activeTab === 'charts')    renderCharts();
  else if (activeTab === 'calendar')  renderCalendar();
  else if (activeTab === 'species')   renderSpecies();
  else if (activeTab === 'settings')  renderSettings();
}

/* ---------- Dashboard ---------- */
function renderDashboard() {
  const el = $('#tab-dashboard');
  const speciesList = live('species');
  const filter = dashFilterSpecies === 'all'
    ? () => true
    : c => c.speciesId === dashFilterSpecies;

  const { totals, total } = stageTotalsAt(new Date(), filter);
  const names = orderedStageNames();

  // Sex totals per stage
  const stageMales = new Map(), stageFemales = new Map();
  for (const c of live('cohorts')) {
    if (!filter(c) || cohortNet(c) <= 0) continue;
    if (c.males == null && c.females == null) continue;
    const { name } = stageIndexAt(c, new Date());
    if (c.males)   stageMales.set(name,   (stageMales.get(name)   || 0) + Number(c.males));
    if (c.females) stageFemales.set(name, (stageFemales.get(name) || 0) + Number(c.females));
  }

  if (live('cohorts').length === 0) {
    el.innerHTML = emptyState('🪹','No litters logged yet',
      'Go to the <b>Trays</b> tab and add a litter to a tray to start tracking.');
    return;
  }

  // Stat cards — tappable to open "remove by stage" modal
  const stageCards = names.map((nm, i) => {
    const v = totals.get(nm) || 0;
    const m = stageMales.get(nm) || 0;
    const f = stageFemales.get(nm) || 0;
    const sexLine = (m || f)
      ? `<div class="sex-info"><span>♂ ${m}</span><span>♀ ${f}</span></div>`
      : '';
    return `<div class="stat-stage stat-stage-btn" data-s="${i}"
        data-act="remove-stage" data-stage="${esc(nm)}" data-sidx="${i}"
        role="button" tabindex="0" title="Remove ${esc(nm)}">
      <span class="stage-edge" style="background:${stageColor(i)}"></span>
      <div class="n">${v}</div>
      <div class="l">${esc(nm)}</div>
      ${sexLine}
      <div class="stat-stage-hint">tap to remove</div>
    </div>`;
  }).join('');

  const stats = `<div class="stat-hero">
      <div class="n">${total}</div><div class="l">Total alive</div>
    </div>${stageCards}`;

  let filterSel = '';
  if (speciesList.length > 1) {
    filterSel = `<select id="dash-filter" style="max-width:180px">
      <option value="all">All species</option>
      ${speciesList.map(s => `<option value="${s.id}" ${s.id===dashFilterSpecies?'selected':''}>${esc(s.name)}</option>`).join('')}
    </select>`;
  }

  el.innerHTML = `
    <div class="spread">
      <h2 class="section-title" style="margin:4px 0 0">Right now</h2>
      ${filterSel}
    </div>
    <div class="stats-grid mt">${stats}</div>
    <p class="small muted" style="margin-top:8px;text-align:center">Tap a stage card to record a removal</p>`;

  const df = $('#dash-filter');
  if (df) df.onchange = () => { dashFilterSpecies = df.value; renderDashboard(); };
}

function renderForecastChart(fc) {
  const vis = fcVisibleStages || new Set(fc.names);
  const visNames = fc.names.filter(nm => vis.has(nm));
  const max = Math.max(1, ...fc.points.map(p => {
    let t = 0; visNames.forEach(nm => { t += p.totals.get(nm) || 0; }); return t;
  }));
  const cols = fc.points.map(p => {
    let segs = '';
    let dominantColor = '';
    let dominantPct = 0;
    let total = 0;
    visNames.forEach(nm => {
      const i = fc.names.indexOf(nm);
      const v = p.totals.get(nm) || 0;
      if (v <= 0) return;
      total += v;
      const col = stageColor(i);
      const pct = (v / max) * 100;
      segs += `<span title="${esc(nm)}: ${v}" style="height:${pct}%;background:${col}"></span>`;
      if (pct > dominantPct) { dominantPct = pct; dominantColor = col; }
    });
    const isNow = p.week === 0;
    const glowStyle = dominantColor ? `background:${dominantColor};opacity:${isNow?'.7':'.35'}` : 'opacity:0';
    return `<div class="chart-col${isNow ? ' chart-col-now' : ''}" tabindex="0" role="button" aria-label="Week ${p.week}: ${total} animals">
      <div class="chart-tot">${total || ''}</div>
      <div class="bar" style="height:150px">${segs || '<span class="bar-empty"></span>'}<div class="bar-overlay"></div></div>
      <div class="chart-glow" style="${glowStyle}"></div>
      <div class="chart-x">${isNow ? 'Now' : fmtDate(p.date)}</div>
    </div>`;
  }).join('');
  return `<div class="chart-dark-wrap"><div class="chart-wrap"><div class="chart">${cols}</div></div></div>`;
}

function renderLegend(names) {
  const vis = fcVisibleStages || new Set(names);
  return `<div class="legend">${names.map((nm, i) => {
    const active = vis.has(nm);
    return `<button class="lg-btn${active ? ' active' : ''}" data-stage="${esc(nm)}" style="--sw:${stageColor(i)}">
      <span class="sw" style="background:${stageColor(i)}"></span>${esc(nm)}
    </button>`;
  }).join('')}</div>`;
}

function wireLegendBtns(fc) {
  $$('.lg-btn').forEach(btn => {
    btn.onclick = () => {
      const nm = btn.dataset.stage;
      if (!fcVisibleStages) fcVisibleStages = new Set(fc.names);
      if (fcVisibleStages.has(nm)) {
        if (fcVisibleStages.size > 1) fcVisibleStages.delete(nm);
      } else {
        fcVisibleStages.add(nm);
      }
      const area = $('#fc-chart-area');
      area.innerHTML = renderForecastChart(fc) + renderLegend(fc.names);
      wireLegendBtns(fc);
    };
  });
}

/* ---------- Charts ---------- */
function renderDonutChart(totals, names) {
  const vals = names.map(nm => totals.get(nm) || 0);
  const total = vals.reduce((s, v) => s + v, 0);
  if (!total) return '';

  const R = 68, ri = 44, CX = 84, CY = 84, SIZE = 168;
  const nonZero = vals.filter(v => v > 0).length;
  const GAP = nonZero > 1 ? 0.03 : 0;

  let slices = '';
  if (nonZero === 1) {
    const i = vals.findIndex(v => v > 0);
    slices = `<circle cx="${CX}" cy="${CY}" r="${R}" fill="${STAGE_HEX[i % STAGE_HEX.length]}" opacity=".88"/>
      <circle cx="${CX}" cy="${CY}" r="${ri}" fill="#1a1a1a"/>`;
  } else {
    let angle = -Math.PI / 2;
    vals.forEach((v, i) => {
      if (v <= 0) return;
      const sweep = (v / total) * 2 * Math.PI - GAP;
      if (sweep <= 0) return;
      const a1 = angle, a2 = angle + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const fmt = n => n.toFixed(2);
      slices += `<path d="M${fmt(CX+R*Math.cos(a1))},${fmt(CY+R*Math.sin(a1))} A${R},${R} 0 ${large},1 ${fmt(CX+R*Math.cos(a2))},${fmt(CY+R*Math.sin(a2))} L${fmt(CX+ri*Math.cos(a2))},${fmt(CY+ri*Math.sin(a2))} A${ri},${ri} 0 ${large},0 ${fmt(CX+ri*Math.cos(a1))},${fmt(CY+ri*Math.sin(a1))} Z" fill="${STAGE_HEX[i%STAGE_HEX.length]}" opacity=".88"/>`;
      angle += sweep + GAP;
    });
  }

  return `<svg class="donut-svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
    ${slices}
    <text x="${CX}" y="${CY}" text-anchor="middle" dominant-baseline="middle" style="font:800 26px Inter,sans-serif;fill:#f0f0f0">${total}</text>
    <text x="${CX}" y="${CY+22}" text-anchor="middle" style="font:500 11px Inter,sans-serif;fill:#a8a8a8">alive</text>
  </svg>`;
}

function renderStageDistributionGrid(totals, names) {
  const vals = names.map(nm => totals.get(nm) || 0);
  const total = vals.reduce((s, v) => s + v, 0);
  if (!total) return '<p class="small muted">No animals currently alive.</p>';

  const cells = names.map((nm, i) => {
    const v = vals[i];
    const pct = Math.round(v / total * 100);
    const hex = STAGE_HEX[i % STAGE_HEX.length];
    return `<div class="dist-cell" data-s="${i}">
      <span class="dist-edge" style="background:${hex}"></span>
      <div class="dist-n" style="color:${hex}">${v}</div>
      <div class="dist-name">${esc(nm)}</div>
      <div class="dist-bar-wrap">
        <div class="dist-bar" style="width:${pct}%;background:${hex}"></div>
      </div>
      <div class="dist-pct">${pct}%</div>
    </div>`;
  }).join('');

  return `<div class="dist-grid">${cells}</div>`;
}

function renderPopulationForecast(shelfId = 'all', trayId = 'all') {
  const DAYS = 90, STEP = 2; // sample every 2 days → 46 points
  const today = new Date(); today.setHours(0,0,0,0);

  // Build cohort filter matching current shelf/tray selection
  const trayIds = (() => {
    if (trayId !== 'all') return new Set([trayId]);
    if (shelfId !== 'all') return new Set(live('trays').filter(t => t.shelfId === shelfId).map(t => t.id));
    return null;
  })();
  const cohortFilter = c => !trayIds || trayIds.has(c.trayId);

  // Sample x-axis: day offsets
  const xDays = [];
  for (let d = 0; d <= DAYS; d += STEP) xDays.push(d);

  // All stage names in chronological order
  const stageNames = orderedStageNames();
  if (!stageNames.length) return '';

  // Collect counts per stage per day (assumes no future removals, which is correct)
  const series = new Map(); // stageName → number[]
  stageNames.forEach(nm => series.set(nm, []));
  const deathSeries = []; // projected natural deaths (cumulative alive animals past lifespan)

  for (const d of xDays) {
    const at = addDays(today, d);
    const { totals } = stageTotalsAt(at, cohortFilter);
    stageNames.forEach(nm => series.get(nm).push(totals.get(nm) || 0));

    // Count cohorts that will have exceeded lifespan by this date
    let deaths = 0;
    for (const c of live('cohorts')) {
      if (!cohortFilter(c)) continue;
      const sp = speciesOf(c);
      if (!sp?.lifespan) continue;
      if (daysBetween(c.birthDate, at) >= sp.lifespan) deaths += cohortNet(c);
    }
    deathSeries.push(deaths);
  }
  const hasDeaths = deathSeries.some(v => v > 0);

  // Only keep stages that have any animals during the window
  const active = stageNames.filter(nm => series.get(nm).some(v => v > 0));
  if (!active.length) return '';

  // Max Y with 10 % headroom, snapped to a nice number
  let maxY = 1;
  active.forEach(nm => { maxY = Math.max(maxY, ...series.get(nm)); });
  if (hasDeaths) maxY = Math.max(maxY, ...deathSeries);
  maxY = Math.ceil(maxY * 1.12);

  // SVG layout
  const W = 560, H = 220, PL = 38, PR = 14, PT = 16, PB = 36;
  const cw = W - PL - PR, ch = H - PT - PB;
  const xS = d  => PL + (d / DAYS) * cw;
  const yS = v  => PT + ch - (v / maxY) * ch;

  // Y-axis gridlines + labels (4 levels)
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = Math.round(maxY * i / 4);
    const y = +yS(v).toFixed(1);
    grid += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--border)" stroke-dasharray="3,3" opacity=".55"/>`;
    grid += `<text x="${PL-5}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--text-2)">${v}</text>`;
  }

  // X-axis ticks every 2 weeks
  let xAxis = '';
  for (let d = 0; d <= DAYS; d += 14) {
    const x = +xS(d).toFixed(1);
    const lbl = d === 0 ? 'Today' : '+' + d + 'd';
    xAxis += `<line x1="${x}" y1="${PT}" x2="${x}" y2="${H-PB}" stroke="var(--border)" stroke-dasharray="3,3" opacity=".35"/>`;
    xAxis += `<text x="${x}" y="${H-PB+15}" text-anchor="middle" font-size="10" fill="var(--text-2)">${lbl}</text>`;
  }

  // One line + area fill per active stage
  let lines = '';
  active.forEach(nm => {
    const color = STAGE_HEX[stageNames.indexOf(nm) % STAGE_HEX.length];
    const xyPts = xDays.map((d, j) => `${xS(d).toFixed(1)},${yS(series.get(nm)[j]).toFixed(1)}`);
    const polyPts = xyPts.join(' ');
    const baseY = +yS(0).toFixed(1);
    const area = `M${xS(xDays[0]).toFixed(1)},${baseY} ` +
      xDays.map((d, j) => `L${xS(d).toFixed(1)},${yS(series.get(nm)[j]).toFixed(1)}`).join(' ') +
      ` L${xS(xDays.at(-1)).toFixed(1)},${baseY} Z`;
    lines += `<path d="${area}" fill="${color}" fill-opacity=".1"/>`;
    lines += `<polyline points="${polyPts}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
    lines += `<circle cx="${xS(0).toFixed(1)}" cy="${yS(series.get(nm)[0]).toFixed(1)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>`;
  });

  // Natural death projection — dashed grey line
  if (hasDeaths) {
    const deathPts = xDays.map((d, j) => `${xS(d).toFixed(1)},${yS(deathSeries[j]).toFixed(1)}`).join(' ');
    lines += `<polyline points="${deathPts}" fill="none" stroke="#ef4444" stroke-width="1.8"
      stroke-dasharray="5,4" stroke-linejoin="round" stroke-linecap="round" opacity=".75"/>`;
  }

  // Axes
  const axes = `
    <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H-PB}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${PL}" y1="${H-PB}" x2="${W-PR}" y2="${H-PB}" stroke="var(--border)" stroke-width="1"/>
    <text x="${PL}" y="${PT-3}" font-size="9" fill="var(--text-2)">individuals</text>`;

  // Legend
  const legend = active.map(nm => {
    const color = STAGE_HEX[stageNames.indexOf(nm) % STAGE_HEX.length];
    return `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px">
      <svg width="22" height="10" viewBox="0 0 22 10" style="flex-shrink:0">
        <line x1="0" y1="5" x2="22" y2="5" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
      <span style="font-size:11px;font-weight:600;color:var(--text)">${esc(nm)}</span>
    </span>`;
  }).join('') + (hasDeaths ? `
    <span style="display:inline-flex;align-items:center;gap:5px;margin-right:12px">
      <svg width="22" height="10" viewBox="0 0 22 10" style="flex-shrink:0">
        <line x1="0" y1="5" x2="22" y2="5" stroke="#ef4444" stroke-width="2" stroke-dasharray="5,3" stroke-linecap="round"/>
      </svg>
      <span style="font-size:11px;font-weight:600;color:var(--text)">Natural deaths</span>
    </span>` : '');

  // Embed chart data for hover tooltip
  const chartData = JSON.stringify({
    xDays, STEP,
    stages: active.map(nm => ({
      name: nm,
      color: STAGE_HEX[stageNames.indexOf(nm) % STAGE_HEX.length],
      values: series.get(nm)
    })),
    deathValues: hasDeaths ? deathSeries : null,
    layout: { W, H, PL, PR, PT, PB, DAYS, maxY }
  });

  return `
    <div id="fc-wrap" style="position:relative">
      <script type="application/json" id="fc-data">${chartData}<\/script>
      <div class="fc-tt" id="fc-tooltip" style="display:none"></div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
        <svg id="fc-svg" width="100%" viewBox="0 0 ${W} ${H}" style="min-width:300px;overflow:visible">
          ${grid}${lines}${axes}${xAxis}
          <line id="fc-crosshair" x1="0" y1="${PT}" x2="0" y2="${H-PB}"
            stroke="rgba(255,255,255,.45)" stroke-width="1.5" stroke-dasharray="4,3"
            style="display:none" pointer-events="none"/>
          <rect id="fc-hit" x="${PL}" y="${PT}" width="${W-PL-PR}" height="${H-PT-PB}"
            fill="transparent" style="cursor:crosshair"/>
        </svg>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;padding-left:${PL}px">${legend}</div>
    </div>`;
}

function wireForeCastHover() {
  const wrap  = document.getElementById('fc-wrap');
  const dataEl = document.getElementById('fc-data');
  const svg   = document.getElementById('fc-svg');
  const tt    = document.getElementById('fc-tooltip');
  const ch    = document.getElementById('fc-crosshair');
  if (!wrap || !dataEl || !svg || !tt) return;

  const { xDays, STEP, stages, deathValues, layout } = JSON.parse(dataEl.textContent);
  const { W, H, PL, PR, PT, PB, DAYS, maxY } = layout;
  const cw = W - PL - PR, chwh = H - PT - PB;

  const xS = d => PL + (d / DAYS) * cw;
  const yS = v => PT + chwh - (v / maxY) * chwh;

  const hide = () => { tt.style.display = 'none'; if (ch) ch.style.display = 'none'; };

  svg.addEventListener('mousemove', e => {
    const rect  = svg.getBoundingClientRect();
    const svgX  = (e.clientX - rect.left) / rect.width * W;
    if (svgX < PL || svgX > W - PR) { hide(); return; }

    const frac = (svgX - PL) / cw;
    const j    = Math.max(0, Math.min(Math.round(frac * DAYS / STEP), xDays.length - 1));
    const day  = xDays[j];
    const cx   = +xS(day).toFixed(1);

    // Move crosshair
    if (ch) { ch.setAttribute('x1', cx); ch.setAttribute('x2', cx); ch.style.display = ''; }

    // Build tooltip
    const label   = day === 0 ? 'Today' : `+${day}d`;
    const dateObj = new Date(); dateObj.setDate(dateObj.getDate() + day);
    const dateStr = dateObj.toLocaleDateString(undefined, { month:'short', day:'numeric' });
    let html = `<div class="fc-tt-date">${label} · ${dateStr}</div>`;
    for (const st of stages) {
      const v = st.values[j] || 0;
      if (v === 0) continue;
      html += `<div class="fc-tt-row">
        <span class="fc-tt-dot" style="background:${st.color}"></span>
        <span class="fc-tt-nm">${esc(st.name)}</span>
        <span class="fc-tt-val">${v}</span>
      </div>`;
    }
    if (deathValues) {
      const d = deathValues[j] || 0;
      if (d > 0) html += `<div class="fc-tt-row">
        <span class="fc-tt-dot" style="background:#ef4444"></span>
        <span class="fc-tt-nm">Natural deaths</span>
        <span class="fc-tt-val">${d}</span>
      </div>`;
    }
    tt.innerHTML = html;
    tt.style.display = 'block';

    // Position tooltip: right of crosshair, flip left if near edge
    const wrapRect = wrap.getBoundingClientRect();
    const ttW = tt.offsetWidth || 150;
    let left = e.clientX - wrapRect.left + 14;
    if (left + ttW > wrapRect.width - 8) left = e.clientX - wrapRect.left - ttW - 14;
    const top = Math.max(4, e.clientY - wrapRect.top - 24);
    tt.style.left = left + 'px';
    tt.style.top  = top + 'px';
  });

  svg.addEventListener('mouseleave', hide);
}

function renderCharts() {
  const el = $('#tab-charts');
  if (live('cohorts').length === 0) {
    el.innerHTML = emptyState('📊', 'No data yet',
      'Add animals to your trays to start seeing charts.');
    return;
  }

  const shelves   = live('shelves');
  const allTrays  = live('trays');
  const shownTrays = chartFilterShelf === 'all'
    ? allTrays
    : allTrays.filter(t => t.shelfId === chartFilterShelf);

  const shelfOpts = shelves.map(s =>
    `<option value="${s.id}" ${s.id === chartFilterShelf ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  const trayOpts = shownTrays.map(t =>
    `<option value="${t.id}" ${t.id === chartFilterTray ? 'selected' : ''}>${esc(t.name)}</option>`
  ).join('');

  const { totals } = stageTotalsAt(new Date());
  const names = orderedStageNames();
  const barChart = renderTrayStageBarChart(chartFilterShelf, chartFilterTray);
  const removalRates = computeRemovalInsights();
  const insights = renderRemovalInsights(removalRates);
  const forecast = renderPopulationForecast(chartFilterShelf, chartFilterTray);

  el.innerHTML = `
    <h2 class="section-title" style="margin-bottom:10px">Stage distribution</h2>
    <div class="card" style="padding:14px">
      <div class="dist-combined">
        ${renderDonutChart(totals, names)}
        ${renderStageDistributionGrid(totals, names)}
      </div>
    </div>

    <h2 class="section-title" style="margin-top:26px;margin-bottom:10px">Individuals by stage</h2>
    <div class="card" style="padding:14px 10px 10px">
      <div class="chart-filter-row">
        <select id="cft-shelf">
          <option value="all" ${chartFilterShelf === 'all' ? 'selected' : ''}>All shelves</option>
          ${shelfOpts}
        </select>
        <select id="cft-tray">
          <option value="all" ${chartFilterTray === 'all' ? 'selected' : ''}>All trays</option>
          ${trayOpts}
        </select>
      </div>
      ${barChart || '<p class="small muted" style="padding:8px 0">No active cohorts in this view.</p>'}
      ${insights}
    </div>

    ${forecast ? `
    <h2 class="section-title" style="margin-top:26px;margin-bottom:4px">Population forecast — next 90 days</h2>
    <p class="small muted" style="margin:0 0 10px">Projects current animals through stages. Assumes no future removals.</p>
    <div class="card" style="padding:14px 10px 10px">
      ${forecast}
    </div>` : ''}`;

  wireForeCastHover();

  // Wire selectors — re-render charts on change
  const shelfSel = $('#cft-shelf', el);
  const traySel  = $('#cft-tray', el);
  if (shelfSel) shelfSel.onchange = () => {
    chartFilterShelf = shelfSel.value;
    chartFilterTray  = 'all';
    renderCharts();
  };
  if (traySel) traySel.onchange = () => {
    chartFilterTray = traySel.value;
    renderCharts();
  };
}

/* ---------- Remove by stage modal ---------- */
function openRemoveByStage(stageName, stageIdx) {
  const today = new Date();
  const matches = live('cohorts').filter(c => {
    if (cohortNet(c, today) <= 0) return false;
    return stageIndexAt(c, today).name === stageName;
  });

  if (!matches.length) return toast(`No active ${stageName} to remove`, true);

  // Group cohorts by tray
  const byTray = new Map();
  for (const c of matches) {
    const net = cohortNet(c, today);
    if (!byTray.has(c.trayId)) {
      byTray.set(c.trayId, { tray: byId('trays', c.trayId), entries: [] });
    }
    byTray.get(c.trayId).entries.push({ cohort: c, net });
  }

  const hex = STAGE_HEX[stageIdx % STAGE_HEX.length];

  let rowIdx = 0;
  const rows = [...byTray.values()].map(({ tray, entries }) => {
    const trayTotal = entries.reduce((s, e) => s + e.net, 0);
    const trayLabel = tray ? esc(tray.name) : '(unknown tray)';
    const cohortRows = entries.map(({ cohort, net }) => {
      const ri = rowIdx++;
      return `<div class="rs-cohort">
        <span class="rs-info">Born ${esc(cohort.birthDate)} · <b>${net}</b> available</span>
        <input type="number" class="rs-input" min="0" max="${net}" placeholder="0"
          data-cohort-id="${cohort.id}" data-tray-id="${cohort.trayId}" data-max="${net}" data-row="${ri}" />
      </div>
      <div class="sex-sub" id="rssex-${ri}" style="display:none">
        <label class="sex-label">♂ <input type="number" class="rs-male" min="0" placeholder="—" /></label>
        <label class="sex-label">♀ <input type="number" class="rs-female" min="0" placeholder="—" /></label>
      </div>`;
    }).join('');
    return `<div class="rs-tray">
      <div class="rs-tray-name">
        <span class="rs-dot" style="background:${hex}"></span>
        ${trayLabel}
        <span class="rs-tray-total">${trayTotal} ${stageName}</span>
      </div>
      ${cohortRows}
    </div>`;
  }).join('');

  openModal(`Remove ${esc(stageName)}`, `
    <p class="small muted" style="margin-bottom:14px">Enter how many to remove from each tray.</p>
    <div class="rs-list">${rows}</div>
    <button class="btn primary block" id="rs-save" style="margin-top:16px">Record removals</button>
  `, root => {
    $$('.rs-input', root).forEach(inp => {
      inp.addEventListener('input', () => {
        const sub = $(`#rssex-${inp.dataset.row}`, root);
        if (sub) sub.style.display = Number(inp.value) > 0 ? 'flex' : 'none';
      });
    });

    $('#rs-save', root).onclick = () => {
      const inputs = $$('.rs-input', root);
      let recorded = 0;
      for (const inp of inputs) {
        const n = Number(inp.value);
        if (!n || n <= 0) continue;
        const cohortId = inp.dataset.cohortId;
        const trayId   = inp.dataset.trayId;
        const max      = Number(inp.dataset.max);
        const ri       = inp.dataset.row;
        if (n > max) return toast(`Max available is ${max}`, true);
        const mVal = $(`#rssex-${ri} .rs-male`, root)?.value;
        const fVal = $(`#rssex-${ri} .rs-female`, root)?.value;
        const males   = mVal !== '' && mVal != null ? Number(mVal) : null;
        const females = fVal !== '' && fVal != null ? Number(fVal) : null;
        const r = rec('removals', { cohortId, trayId, date: todayISO(), stage: stageName, count: n, males, females });
        upsertLocal('removals', r);
        touch('removals', r);
        recorded += n;
      }
      if (!recorded) return toast('Enter at least one count', true);
      saveState();
      closeModal();
      render();
      toast(`${recorded} ${stageName} removed`);
    };
  });
}

/* ---------- Harvest Search ---------- */
function refreshHarvestResults() {
  const spEl    = $('#harvest-species');
  const stageEl = $('#harvest-stage');
  const countEl = $('#harvest-count');
  const outEl   = $('#harvest-results');
  if (!stageEl || !countEl || !outEl) return;

  const speciesId = spEl?.value || 'all';
  const stage     = stageEl.value;
  const needed    = parseInt(countEl.value, 10);
  if (!stage || isNaN(needed) || needed < 1) { outEl.innerHTML = ''; return; }

  const today = new Date();
  const matches = [];

  for (const tray of live('trays')) {
    let count = 0;
    let oldestDate = null; // earliest birth date of cohorts in this stage
    for (const c of live('cohorts')) {
      if (c.trayId !== tray.id) continue;
      if (speciesId !== 'all' && c.speciesId !== speciesId) continue;
      const net = cohortNet(c, today);
      if (net <= 0) continue;
      if (stageIndexAt(c, today).name !== stage) continue;
      count += net;
      // Track oldest cohort (smallest birth date = entered world earliest)
      const bd = parseYMD(c.birthDate);
      if (!oldestDate || bd < oldestDate) oldestDate = bd;
    }
    if (count > 0) matches.push({ tray, count, oldestDate });
  }

  // Sort oldest animals first — they should be used before they die naturally
  matches.sort((a, b) => a.oldestDate - b.oldestDate);

  if (!matches.length) {
    const spName = speciesId !== 'all' ? (byId('species', speciesId)?.name || '') : '';
    outEl.innerHTML = `<p class="harvest-none">No ${esc(stage)}${spName ? ' ('+esc(spName)+')' : ''} available in any tray.</p>`;
    return;
  }

  // Greedy: pick oldest trays first until needed count is met
  let remaining = needed;
  const suggested = new Set();
  for (const m of matches) {
    if (remaining <= 0) break;
    suggested.add(m.tray.id);
    remaining -= m.count;
  }
  const total  = matches.reduce((s, m) => s + m.count, 0);
  const canFill = remaining <= 0;

  // Determine if searched stage is the last (adult) stage for any species in results
  const isAdultStage = matches.some(m => {
    const sp = live('species').find(s => live('cohorts').some(c => c.trayId === m.tray.id && c.speciesId === s.id));
    if (!sp?.stages?.length) return false;
    const last = [...sp.stages].sort((a,b) => (b.startDay||b.days||0)-(a.startDay||a.days||0))[0];
    return last?.name === stage;
  });

  const btns = matches.map(m => {
    const cls = suggested.has(m.tray.id) ? 'harvest-btn suggested' : 'harvest-btn';
    const ageDays = m.oldestDate ? Math.floor((today - m.oldestDate) / 86400000) : null;
    const sp = speciesId !== 'all' ? byId('species', speciesId)
      : live('species').find(s => live('cohorts').some(c => c.trayId === m.tray.id && c.speciesId === s.id));
    const urgent = sp?.lifespan && ageDays != null && (sp.lifespan - ageDays) <= 30;

    const unavailable = isAdultStage ? ((m.tray.gravidFemales || 0) + (m.tray.lactatingFemales || 0)) : 0;
    const available   = Math.max(0, m.count - unavailable);
    const gravidNote  = isAdultStage && (m.tray.gravidFemales || 0) > 0
      ? `<span class="hb-status gravid">${m.tray.gravidFemales} gravid</span>` : '';
    const lactNote    = isAdultStage && (m.tray.lactatingFemales || 0) > 0
      ? `<span class="hb-status lact">${m.tray.lactatingFemales} lactating</span>` : '';

    return `<button class="${cls}${urgent ? ' urgent' : ''}" data-act="open-tray" data-id="${m.tray.id}">
      <span class="hb-name">${esc(m.tray.name)}</span>
      ${ageDays != null ? `<span class="hb-age${urgent ? ' hb-age-warn' : ''}">${ageDays}d old</span>` : ''}
      ${gravidNote}${lactNote}
      <span class="hb-count">${available}<span class="hb-total-sm">/${m.count}</span></span>
    </button>`;
  }).join('');

  const statusCls = canFill ? 'harvest-status ok' : 'harvest-status warn';
  const statusMsg = canFill
    ? `✓ Can fill ${needed} from ${suggested.size} tray${suggested.size !== 1 ? 's' : ''} (${total} total available)`
    : `⚠ Only ${total} of ${needed} available across all trays`;

  outEl.innerHTML = `<div class="harvest-btns">${btns}</div>
    <div class="${statusCls}">${statusMsg}</div>`;
}

/* ---------- Trays ---------- */
function renderTrays() {
  const el = $('#tab-trays');
  const shelves = live('shelves').sort((a,b) => (a.sortOrder||0)-(b.sortOrder||0));
  const names = orderedStageNames();

  // Harvest search card (always visible)
  const stageOpts   = names.map(nm => `<option value="${esc(nm)}">${esc(nm)}</option>`).join('');
  const speciesOpts = live('species').map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  let html = `
    <div class="harvest-card card">
      <div class="harvest-header">
        <span class="harvest-icon">🔍</span>
        <span class="harvest-label">Harvest search</span>
      </div>
      <div class="harvest-row">
        <select id="harvest-species">
          <option value="all">All species</option>
          ${speciesOpts}
        </select>
        <select id="harvest-stage">
          <option value="">Stage…</option>
          ${stageOpts}
        </select>
        <input id="harvest-count" type="number" min="1" placeholder="How many?" />
      </div>
      <div id="harvest-results"></div>
    </div>`;

  if (!shelves.length) {
    html += emptyState('🗄️', 'No shelves yet', 'Tap + to add your first shelf and trays.');
    el.innerHTML = html;
    const spEl2    = $('#harvest-species', el);
    const stageEl2 = $('#harvest-stage', el);
    const countEl2 = $('#harvest-count', el);
    if (spEl2)    spEl2.onchange    = refreshHarvestResults;
    if (stageEl2) stageEl2.onchange = refreshHarvestResults;
    if (countEl2) countEl2.oninput  = refreshHarvestResults;
    return;
  }

  // Validate selectedShelfId still exists
  if (selectedShelfId && !byId('shelves', selectedShelfId)) selectedShelfId = null;

  if (!selectedShelfId) {
    // ── SHELF OVERVIEW ──
    html += `<h2 class="section-title" style="margin:14px 0 10px">Shelves</h2>
      <div class="shelf-grid">`;
    for (const shelf of shelves) {
      const trays = live('trays').filter(t => t.shelfId === shelf.id);
      let totalAlive = 0;
      for (const t of trays) {
        for (const c of live('cohorts').filter(c => c.trayId === t.id)) {
          const net = cohortNet(c); if (net > 0) totalAlive += net;
        }
      }
      html += `<button class="shelf-card" data-act="select-shelf" data-id="${shelf.id}">
        <div class="sc-name">${esc(shelf.name)}</div>
        <div class="sc-meta">${trays.length} tray${trays.length !== 1 ? 's' : ''}</div>
        <div class="sc-alive">${totalAlive} alive</div>
      </button>`;
    }
    html += `</div>`;
  } else {
    // ── TRAY VIEW ──
    const shelf = byId('shelves', selectedShelfId);
    const trays = live('trays').filter(t => t.shelfId === selectedShelfId)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    html += `
    <div class="shelf-nav">
      <button class="back-btn" data-act="back-shelves">← Shelves</button>
      <span class="shelf-nav-name">${esc(shelf.name)}</span>
      <div class="shelf-nav-actions">
        <button class="icon-btn" data-act="edit-shelf" data-id="${selectedShelfId}" title="Rename">✎</button>
        <button class="icon-btn" data-act="del-shelf" data-id="${selectedShelfId}" title="Delete">🗑</button>
      </div>
    </div>
    <div class="tray-grid">`;

    if (!trays.length) {
      html += `<p class="muted small" style="grid-column:1/-1">No trays yet. Tap + to add trays to this shelf.</p>`;
    }

    for (const tray of trays) {
      const sp = speciesOf(tray);
      const cohorts = live('cohorts').filter(c => c.trayId === tray.id);
      let total = 0;
      const stageCounts = new Map();
      for (const c of cohorts) {
        const net = cohortNet(c);
        if (net <= 0) continue;
        total += net;
        const { name } = stageIndexAt(c);
        stageCounts.set(name, (stageCounts.get(name)||0) + net);
      }
      let barSegs = '';
      names.forEach((nm,i) => {
        const v = stageCounts.get(nm) || 0;
        if (v > 0) barSegs += `<span style="flex:${v};background:${stageColor(i)}"></span>`;
      });
      html += `<div class="tray" data-act="open-tray" data-id="${tray.id}">
        <div class="tray-top">
          <span class="tray-name">${esc(tray.name)}</span>
          <span class="tray-species">${sp ? esc(sp.name) : '—'}</span>
          <span class="tray-chevron">›</span>
        </div>
        <div class="tray-total">${total} <small>alive</small></div>
        <div class="stagebar">${barSegs || '<span style="flex:1"></span>'}</div>
      </div>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;

  // Wire harvest search inputs
  const spEl    = $('#harvest-species', el);
  const stageEl = $('#harvest-stage', el);
  const countEl = $('#harvest-count', el);
  if (spEl)    spEl.onchange    = refreshHarvestResults;
  if (stageEl) stageEl.onchange = refreshHarvestResults;
  if (countEl) countEl.oninput  = refreshHarvestResults;
}

/* ---------- Calendar ---------- */
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSelected = todayISO();

function getCalEvents() {
  const map = {};
  // Normalize to yyyy-mm-dd so stored yyyymmdd dates match the grid's keys
  const add = (date, ev) => { const k=ymdToInput(date); (map[k]=map[k]||[]).push(ev); };
  for (const c of live('cohorts')) {
    const tray = byId('trays', c.trayId);
    const sp   = speciesOf(c);
    add(c.birthDate, {
      type: 'birth',
      label: `${c.initialCount} born`,
      sub:   `${tray?.name || '—'} · ${sp?.name || '—'}`,
      color: 'var(--ok)'
    });
  }
  for (const r of live('removals')) {
    const tray = byId('trays', r.trayId);
    add(r.date, {
      type: 'removal',
      label: `${r.count} removed`,
      sub:   `${tray?.name || '—'} · ${r.stage}`,
      color: 'var(--danger)'
    });
  }
  return map;
}

function renderCalendar() {
  const el = $('#tab-calendar');
  const y = calYear, m = calMonth;
  const evMap = getCalEvents();

  const firstDay    = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const monthLabel  = firstDay.toLocaleDateString(undefined, { month:'long', year:'numeric' });
  const startDow    = (firstDay.getDay() + 6) % 7; // Monday = 0

  const DOW = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const dowCells = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < startDow; i++) cells += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const evs = evMap[dateStr] || [];
    const isToday = dateStr === todayISO();
    const isSel   = dateStr === calSelected;

    const dotTypes = [...new Set(evs.map(e => e.type))];
    const dots = dotTypes.map(t =>
      `<span class="cal-dot" style="background:${t==='birth'?'var(--ok)':'var(--danger)'}"></span>`
    ).join('');

    cells += `<div class="cal-cell ${isToday?'today':''} ${isSel?'selected':''} ${evs.length?'has-ev':''}"
      data-act="cal-select" data-date="${dateStr}">
      <span class="cal-num">${d}</span>
      <div class="cal-dots">${dots}</div>
    </div>`;
  }

  // Selected day detail
  const selEvs = evMap[calSelected] || [];
  const fmtSel = new Date(calSelected + 'T00:00:00').toLocaleDateString(undefined, {
    weekday:'long', month:'long', day:'numeric'
  });
  const evItems = selEvs.length
    ? selEvs.map(e => `
        <div class="cal-ev-item">
          <span class="cal-ev-dot" style="background:${e.color}"></span>
          <div>
            <div class="cal-ev-label">${esc(e.label)}</div>
            <div class="cal-ev-sub">${esc(e.sub)}</div>
          </div>
        </div>`).join('')
    : `<p class="muted small" style="margin:0;padding:6px 0">No events on this day.</p>`;

  // Legend
  const totalBirths   = Object.values(evMap).flat().filter(e=>e.type==='birth').length;
  const totalRemovals = Object.values(evMap).flat().filter(e=>e.type==='removal').length;

  el.innerHTML = `
    <div class="cal-nav">
      <button class="icon-btn" data-act="cal-prev">‹</button>
      <span class="cal-month">${monthLabel}</span>
      <button class="icon-btn" data-act="cal-next">›</button>
    </div>

    <div class="card cal-card">
      <div class="cal-dow-row">${dowCells}</div>
      <div class="cal-grid">${cells}</div>
    </div>

    <div class="cal-day-detail">
      <div class="cal-day-head">${fmtSel}</div>
      ${evItems}
    </div>

    <div class="legend" style="margin-top:14px">
      <span class="lg"><span class="sw" style="background:var(--ok)"></span>Birth (${totalBirths} total)</span>
      <span class="lg"><span class="sw" style="background:var(--danger)"></span>Removed (${totalRemovals} total)</span>
    </div>`;
}

/* ---------- Species ---------- */
function renderSpecies() {
  const el = $('#tab-species');
  const list = live('species');
  let html = `<div class="spread"><h2 class="section-title" style="margin:4px 0 0">Species & stage timing</h2>
    <button class="btn sm primary" data-act="add-species">+ Species</button></div>
    <p class="small muted">The age (in days) at which an animal <b>enters</b> each stage. All counts and forecasts are calculated from this.</p>`;

  if (!list.length) html += emptyState('🧬','No species defined','Add a species and its stage day-thresholds.');

  for (const sp of list) {
    const stages = [...(sp.stages||[])].sort((a,b)=>a.startDay-b.startDay);
    const rows = stages.map((st,i) => {
      const next = stages[i+1];
      return `<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${stageColor(i)};margin-right:7px;vertical-align:middle"></span>${esc(st.name)}</td>
        <td class="num">${next ? `${st.startDay}–${next.startDay-1} d` : `${st.startDay}+ d`}</td></tr>`;
    }).join('');
    html += `<div class="card">
      <div class="spread"><div><b>${esc(sp.name)}</b><div class="species-id-chip">ID: <code>${esc(sp.id)}</code></div></div>
        <div class="row-actions">
          <button class="btn sm" data-act="edit-species" data-id="${sp.id}">Edit</button>
          <button class="icon-btn" data-act="del-species" data-id="${sp.id}" title="Delete">🗑</button>
        </div>
      </div>
      <table class="tbl mt"><thead><tr><th>Stage</th><th class="num">Age range</th></tr></thead><tbody>${rows}</tbody></table>
    </div>`;
  }
  el.innerHTML = html;
}

/* ---------- Settings ---------- */
function renderSettings() {
  const el = $('#tab-settings');
  const url  = state.meta.scriptUrl || '';
  const last = state.meta.lastSync ? fmtTimestamp(state.meta.lastSync) : 'never';
  const pc   = pendingCount();

  el.innerHTML = `
    <h2 class="section-title" style="margin:4px 0 10px">Google Sheet sync</h2>
    <div class="card">
      <label class="field">
        <span>Apps Script Web App URL</span>
        <input id="script-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}" />
      </label>
      <p class="small muted" style="margin:0 0 14px">Once set, all changes sync automatically. Data also saves locally on this device and uploads when back online.</p>
      <div class="gap">
        <button class="btn primary" data-act="save-url">Save URL</button>
        ${url ? `<button class="btn" data-act="sync-now">Sync now</button>` : ''}
      </div>
      ${syncError ? `<p class="sync-error-msg">⚠ Last sync error: ${esc(syncError)}</p>` : ''}
      <hr class="hr" />
      <div class="small muted">
        <div class="spread"><span>Sync status</span><span>${syncing?'Syncing…':syncError?'Error':pc>0?`${pc} queued`:url?'Up to date':'No URL set'}</span></div>
        <div class="spread mt"><span>Last sync</span><span>${last}</span></div>
        <div class="spread mt"><span>Network</span><span>${navigator.onLine?'Online':'Offline'}</span></div>
      </div>
    </div>

    <h2 class="section-title">Backup</h2>
    <div class="card">
      <div class="gap">
        <button class="btn" data-act="export">Export JSON</button>
        <button class="btn" data-act="import">Import JSON</button>
      </div>
      <p class="small muted mt">Local backup of all data on this device.</p>
    </div>

    <h2 class="section-title">Danger zone</h2>
    <div class="card">
      <button class="btn danger" data-act="wipe">Erase all local data</button>
    </div>`;
}

function emptyState(icon, title, sub) {
  return `<div class="empty"><div class="big">${icon}</div><b>${title}</b><div class="small mt">${sub}</div></div>`;
}

/* ------------------------------------------------------------------ *
 *  Modals
 * ------------------------------------------------------------------ */
function openModal(title, bodyHtml, onMount) {
  $('#modal-title').innerHTML = title;
  $('#modal-body').innerHTML  = bodyHtml;
  // Only push history when opening fresh — replacing content keeps the same entry
  if ($('#modal-root').hidden) {
    history.pushState({ tab: activeTab, modal: true }, '');
    _modalPushed = true;
  }
  $('#modal-root').hidden = false;
  if (onMount) onMount($('#modal-body'));
}

function closeModal() {
  if ($('#modal-root').hidden) return;
  $('#modal-root').hidden    = true;
  $('#modal-body').innerHTML = '';
  if (_modalPushed) {
    _modalPushed = false;
    history.back(); // pop the modal history entry
  }
}

function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr?' err':'');
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ----- Shelf ----- */
function shelfModal(existing) {
  // rename-only — creation goes through newShelfModal()
  openModal('Rename shelf', `
    <label class="field"><span>Shelf name</span>
      <input id="f-name" value="${esc(existing.name||'')}" placeholder="e.g. A or Top Rack" /></label>
    <button class="btn primary block" data-save>Save</button>
  `, root => {
    $('#f-name', root).focus();
    $('[data-save]', root).onclick = () => {
      const name = $('#f-name', root).value.trim();
      if (!name) return toast('Enter a name', true);
      const duplicate = live('shelves').find(s => s.id !== existing.id && s.name.toLowerCase() === name.toLowerCase());
      if (duplicate) return toast(`A shelf named "${name}" already exists`, true);
      existing.name = name; touch('shelves', existing);
      closeModal(); render();
    };
  });
}

function newShelfModal() {
  const speciesList = live('species');
  const opts = speciesList.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const speciesField = speciesList.length
    ? `<label class="field"><span>Species for all trays</span><select id="f-species">${opts}</select></label>`
    : `<p class="small muted" style="margin:0 0 14px">No species yet — you can set species per tray later.</p>`;
  openModal('Add shelf', `
    <label class="field"><span>Shelf name</span>
      <input id="f-shelf-name" placeholder="e.g. A or Top Rack" /></label>
    ${speciesField}
    <label class="field"><span>Number of trays to create</span>
      <input id="f-tray-count" type="number" min="1" max="100" placeholder="e.g. 20" /></label>
    <button class="btn primary block" data-save>Create shelf + trays</button>
  `, root => {
    $('#f-shelf-name', root).focus();
    $('[data-save]', root).onclick = () => {
      const name = $('#f-shelf-name', root).value.trim();
      const speciesId = speciesList.length ? ($('#f-species', root)?.value || null) : null;
      const trayCount = parseInt($('#f-tray-count', root).value, 10);
      if (!name)                             return toast('Enter a shelf name', true);
      if (live('shelves').some(s => s.name.toLowerCase() === name.toLowerCase())) return toast(`A shelf named "${name}" already exists`, true);
      if (!trayCount || trayCount < 1 || trayCount > 100) return toast('Enter 1–100 trays', true);
      const shelf = rec('shelves', { name, sortOrder: live('shelves').length });
      upsertLocal('shelves', shelf); touch('shelves', shelf);
      for (let i = 0; i < trayCount; i++) {
        const trayId = genTrayId(shelf.id);
        const tray = rec('trays', { id: trayId, shelfId: shelf.id, name: trayId, speciesId });
        upsertLocal('trays', tray); touch('trays', tray);
      }
      selectedShelfId = shelf.id;
      closeModal(); render();
      toast(`Created "${name}" with ${trayCount} tray${trayCount !== 1 ? 's' : ''}`);
    };
  });
}

function addTraysToShelfModal(shelfId) {
  const shelf = byId('shelves', shelfId);
  if (!shelf) return;
  const speciesList = live('species');
  const existingTray = live('trays').find(t => t.shelfId === shelfId);
  const defaultSpeciesId = existingTray?.speciesId || speciesList[0]?.id || null;
  const opts = speciesList.map(s =>
    `<option value="${s.id}" ${s.id === defaultSpeciesId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
  const speciesField = speciesList.length
    ? `<label class="field"><span>Species</span><select id="f-species">${opts}</select></label>`
    : '';
  openModal(`Add trays to ${esc(shelf.name)}`, `
    <label class="field"><span>How many trays to add?</span>
      <input id="f-count" type="number" min="1" max="100" placeholder="e.g. 5" /></label>
    ${speciesField}
    <button class="btn primary block" data-save>Add trays</button>
  `, root => {
    $('#f-count', root).focus();
    $('[data-save]', root).onclick = () => {
      const count = parseInt($('#f-count', root).value, 10);
      const speciesId = speciesList.length ? ($('#f-species', root)?.value || null) : null;
      if (!count || count < 1 || count > 100) return toast('Enter 1–100', true);
      for (let i = 0; i < count; i++) {
        const trayId = genTrayId(shelfId);
        const tray = rec('trays', { id: trayId, shelfId, name: trayId, speciesId });
        upsertLocal('trays', tray); touch('trays', tray);
      }
      closeModal(); render();
      toast(`Added ${count} tray${count !== 1 ? 's' : ''} to ${shelf.name}`);
    };
  });
}

function showTrayFabMenu() {
  const existing = document.querySelector('.fab-menu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div');
  menu.className = 'fab-menu';
  const shelfName = selectedShelfId && byId('shelves', selectedShelfId)
    ? `Add trays to ${esc(byId('shelves', selectedShelfId).name)}`
    : 'Add trays (select a shelf first)';
  menu.innerHTML = `
    <button class="fab-menu-item" id="fmi-shelf">+ Add shelf</button>
    <button class="fab-menu-item" id="fmi-tray">${shelfName}</button>`;
  document.body.appendChild(menu);
  document.getElementById('fmi-shelf').onclick = () => { menu.remove(); newShelfModal(); };
  document.getElementById('fmi-tray').onclick  = () => {
    menu.remove();
    if (!selectedShelfId || !byId('shelves', selectedShelfId)) {
      toast('Select a shelf first', true); return;
    }
    addTraysToShelfModal(selectedShelfId);
  };
  // Dismiss on next outside click
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

/* ----- Tray ----- */
function trayModal(shelfId, existing) {
  const speciesList = live('species');
  if (!speciesList.length) return toast('Add a species first', true);
  const t = existing || {};
  const suggestedId = existing ? existing.id : genTrayId(shelfId); // e.g. "A-1"
  // If tray's speciesId doesn't match any live species, fall back to first
  const resolvedSpeciesId = speciesList.find(s => s.id === t.speciesId)?.id || speciesList[0]?.id;
  const opts = speciesList.map(s =>
    `<option value="${s.id}" ${s.id===resolvedSpeciesId?'selected':''}>${esc(s.name)} [${esc(s.id)}]</option>`).join('');
  openModal(existing?'Edit tray':'Add tray', `
    <label class="field"><span>Tray name</span>
      <input id="f-name" value="${esc(t.name || suggestedId)}" placeholder="e.g. A-1" /></label>
    <label class="field"><span>Species</span>
      <select id="f-species">${opts}</select></label>
    <button class="btn primary block" data-save>Save</button>
  `, root => {
    $('#f-name', root).focus();
    $('[data-save]', root).onclick = () => {
      const name = $('#f-name', root).value.trim();
      const speciesId = $('#f-species', root).value;
      if (!name) return toast('Enter a name', true);
      if (existing) { existing.name=name; existing.speciesId=speciesId; touch('trays',existing); }
      else { const r=rec('trays',{id:suggestedId, shelfId, name, speciesId}); upsertLocal('trays',r); touch('trays',r); }
      closeModal(); render();
    };
  });
}

/* ----- Tray detail ----- */
function trayDetailModal(trayId) {
  const tray = byId('trays', trayId);
  if (!tray) return;
  const exactSpecies = byId('species', tray.speciesId);
  const speciesMismatch = tray.speciesId && (!exactSpecies || exactSpecies.deleted);
  const sp = speciesOf(tray);
  const cohorts = live('cohorts').filter(c => c.trayId === trayId)
    .sort((a,b) => parseYMD(b.birthDate) - parseYMD(a.birthDate));

  // Check for adult-stage animals (last stage = highest startDay)
  const today = new Date();
  const lastStageName = sp?.stages?.length
    ? [...sp.stages].sort((a,b) => (b.startDay||b.days||0)-(a.startDay||a.days||0))[0]?.name
    : null;
  let adultCount = 0;
  if (lastStageName) {
    for (const c of cohorts) {
      if (cohortNet(c) > 0 && stageIndexAt(c, today).name === lastStageName) adultCount += cohortNet(c);
    }
  }
  const gravid    = tray.gravidFemales   || 0;
  const lactating = tray.lactatingFemales || 0;

  const rows = cohorts.map(c => {
    const net = cohortNet(c);
    const { name, age } = stageIndexAt(c);
    const depleted = net <= 0;
    const si = orderedStageNames().indexOf(name);
    return `<div class="cohort-row" style="${depleted?'opacity:.45':''}">
      <div class="cohort-info">
        <div class="cn">${net}
          <span class="pill" style="background:${stageColor(si)}">${esc(name)}</span>
        </div>
        <div class="small muted">Born ${ymdToInput(c.birthDate)} · ${age}d old · started ${c.initialCount}${(c.males!=null||c.females!=null)?' · ♂ '+(c.males??'?')+' ♀ '+(c.females??'?'):''}${c.notes?' · '+esc(c.notes):''}</div>
      </div>
      <div class="cohort-remove">
        ${depleted?'':`<input type="number" min="1" max="${net}" placeholder="0" data-remove="${c.id}" />
        <button class="btn sm" data-act="do-remove" data-id="${c.id}">Remove</button>`}
        <button class="icon-btn" data-act="edit-cohort" data-id="${c.id}" data-trayid="${trayId}" title="Edit">✎</button>
        <button class="icon-btn" data-act="del-cohort" data-id="${c.id}" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');

  const gravidSection = adultCount > 0 ? `
    <div class="gravid-section">
      <div class="gravid-title">♀ Female adult status <span class="gravid-sub">(${adultCount} adults in tray)</span></div>
      <div class="gravid-row">
        <label class="gravid-field">
          <span>Gravid</span>
          <input type="number" id="f-gravid" min="0" max="${adultCount}" value="${gravid}" placeholder="0" />
        </label>
        <label class="gravid-field">
          <span>Lactating</span>
          <input type="number" id="f-lact" min="0" max="${adultCount}" value="${lactating}" placeholder="0" />
        </label>
        <button class="btn sm" id="save-status">Save</button>
      </div>
      ${gravid + lactating > 0 ? `<div class="gravid-warn">⚠ ${gravid+lactating} female${gravid+lactating!==1?'s':''} unavailable for harvest (${gravid} gravid, ${lactating} lactating)</div>` : ''}
    </div>` : '';

  const mismatchBanner = speciesMismatch ? `
    <div class="species-mismatch-warn">
      ⚠ Species ID <code>${esc(tray.speciesId)}</code> not found.
      Tap <b>Edit tray / species</b> below to fix.
    </div>` : '';

  openModal(`${esc(tray.name)} · ${sp?esc(sp.name):'—'}`, `
    ${mismatchBanner}
    <div class="gap" style="margin-bottom:4px">
      <button class="btn primary" data-act="add-litter" data-id="${trayId}" style="flex:1">+ Born today</button>
      <button class="btn primary" data-act="add-intake" data-id="${trayId}" style="flex:1">+ Add by stage</button>
    </div>
    <div class="mt">${cohorts.length ? rows : '<p class="muted small">No litters yet.</p>'}</div>
    ${gravidSection}
    <hr class="hr" />
    <div class="gap">
      <button class="btn secondary" data-act="edit-tray" data-id="${trayId}" style="flex:1">✎ Edit tray / species</button>
      <button class="btn danger" data-act="del-tray" data-id="${trayId}" style="flex:1">Delete tray</button>
    </div>
  `, root => {
    $$('[data-act="do-remove"]', root).forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        const input = $(`[data-remove="${id}"]`, root);
        const n = Number(input.value);
        const c = byId('cohorts', id);
        const net = cohortNet(c);
        if (!n || n <= 0) return toast('Enter a count', true);
        if (n > net) return toast(`Only ${net} available`, true);
        const { name } = stageIndexAt(c);
        const r = rec('removals',{ cohortId:id, trayId, date:toYMD(new Date()), stage:name, count:n });
        upsertLocal('removals',r); touch('removals',r);
        toast(`Removed ${n} ${name}`);
        closeModal(); trayDetailModal(trayId); render();
      };
    });

    const saveStatusBtn = $('#save-status', root);
    if (saveStatusBtn) {
      saveStatusBtn.onclick = () => {
        tray.gravidFemales   = Number($('#f-gravid', root).value) || 0;
        tray.lactatingFemales = Number($('#f-lact',   root).value) || 0;
        touch('trays', tray);
        toast('Status saved');
        closeModal(); trayDetailModal(trayId);
      };
    }
  });
}

function litterModal(trayId) {
  const tray = byId('trays', trayId);
  const sp = speciesOf(tray);
  openModal('Add litter', `
    <p class="small muted">Into <b>${esc(tray.name)}</b> (${sp?esc(sp.name):'—'})</p>
    <div class="field-row">
      <label class="field"><span>Birth date</span><input id="f-date" type="date" value="${todayISO()}" /></label>

      <label class="field"><span>Count</span><input id="f-count" type="number" min="1" placeholder="e.g. 8" /></label>
    </div>
    <label class="field"><span>Notes (optional)</span><input id="f-notes" placeholder="e.g. dam #4" /></label>
    <button class="btn primary block" data-save>Add litter</button>
  `, root => {
    $('#f-count', root).focus();
    $('[data-save]', root).onclick = () => {
      const birthDate = $('#f-date', root).value;
      const initialCount = Number($('#f-count', root).value);
      const notes = $('#f-notes', root).value.trim();
      if (!birthDate) return toast('Pick a birth date', true);
      if (!initialCount || initialCount <= 0) return toast('Enter a count', true);
      const r = rec('cohorts',{trayId, speciesId:tray.speciesId, birthDate, initialCount, notes});
      upsertLocal('cohorts',r); touch('cohorts',r);
      toast('Litter added');
      closeModal(); trayDetailModal(trayId); render();
    };
  });
}

/* ----- Add by stage (intake) ----- */
function intakeModal(trayId) {
  const tray = byId('trays', trayId);
  if (!tray) return;
  const sp = speciesOf(tray);
  if (!sp?.stages?.length) return toast('No stages defined for this species', true);

  const stages = [...sp.stages].sort((a, b) => a.startDay - b.startDay);

  const rows = stages.map((st, i) => {
    const hex = STAGE_HEX[i % STAGE_HEX.length];
    return `<div class="intake-row">
      <span class="intake-dot" style="background:${hex}"></span>
      <span class="intake-name">${esc(st.name)}</span>
      <span class="intake-day small muted">day ${st.startDay}+</span>
      <input type="number" class="intake-input" min="0" placeholder="0"
        data-startday="${st.startDay}" data-stage="${esc(st.name)}" data-row="${i}" />
    </div>
    <div class="sex-sub" id="isex-${i}" style="display:none">
      <label class="sex-label">♂ <input type="number" class="sex-male" min="0" placeholder="—" data-row="${i}" /></label>
      <label class="sex-label">♀ <input type="number" class="sex-female" min="0" placeholder="—" data-row="${i}" /></label>
    </div>`;
  }).join('');

  openModal(`Add to ${esc(tray.name)}`, `
    <p class="small muted" style="margin-bottom:14px">Enter how many to add at each stage. Birth date is calculated automatically.</p>
    <div class="intake-list">${rows}</div>
    <button class="btn primary block" id="intake-save" style="margin-top:16px">Add animals</button>
  `, root => {
    $$('.intake-input', root).forEach(inp => {
      inp.addEventListener('input', () => {
        const sub = $(`#isex-${inp.dataset.row}`, root);
        if (sub) sub.style.display = Number(inp.value) > 0 ? 'flex' : 'none';
      });
    });

    $('#intake-save', root).onclick = () => {
      const inputs = $$('.intake-input', root);
      let added = 0;
      for (const inp of inputs) {
        const n = Number(inp.value);
        if (!n || n <= 0) continue;
        const startDay  = Number(inp.dataset.startday);
        const stageName = inp.dataset.stage;
        const ri        = inp.dataset.row;
        const birthDate = addDays(new Date(), -startDay).toISOString().slice(0, 10);
        const mVal = $(`#isex-${ri} .sex-male`, root)?.value;
        const fVal = $(`#isex-${ri} .sex-female`, root)?.value;
        const males   = mVal !== '' && mVal != null ? Number(mVal) : null;
        const females = fVal !== '' && fVal != null ? Number(fVal) : null;
        const r = rec('cohorts', {
          trayId, speciesId: tray.speciesId,
          birthDate, initialCount: n,
          males, females,
          notes: `Intake · ${stageName}`
        });
        upsertLocal('cohorts', r);
        touch('cohorts', r);
        added += n;
      }
      if (!added) return toast('Enter at least one count', true);
      saveState();
      toast(`${added} animals added`);
      closeModal();
      trayDetailModal(trayId);
      render();
    };
  });
}

/* ----- Edit cohort ----- */
function editCohortModal(cohortId, trayId) {
  const c = byId('cohorts', cohortId);
  if (!c) return;
  const tray = byId('trays', trayId);
  const net = cohortNet(c);
  const alreadyRemoved = (Number(c.initialCount) || 0) - net;
  openModal('Edit litter', `
    <p class="small muted" style="margin-bottom:14px">In <b>${esc(tray?.name || '')}</b></p>
    <div class="field-row">
      <label class="field"><span>Birth date</span>
        <input id="f-date" type="date" value="${ymdToInput(toYMD(parseYMD(c.birthDate)))}" /></label>
      <label class="field"><span>Initial count</span>
        <input id="f-count" type="number" min="${Math.max(1, alreadyRemoved)}" value="${c.initialCount}" /></label>
    </div>
    <div class="field-row">
      <label class="field"><span>♂ Males (optional)</span>
        <input id="f-males" type="number" min="0" value="${c.males ?? ''}" placeholder="—" /></label>
      <label class="field"><span>♀ Females (optional)</span>
        <input id="f-females" type="number" min="0" value="${c.females ?? ''}" placeholder="—" /></label>
    </div>
    <label class="field"><span>Notes (optional)</span>
      <input id="f-notes" value="${esc(c.notes || '')}" placeholder="e.g. dam #4" /></label>
    <button class="btn primary block" data-save>Save changes</button>
  `, root => {
    $('[data-save]', root).onclick = () => {
      const birthDate    = $('#f-date', root).value;
      const initialCount = Number($('#f-count', root).value);
      const notes        = $('#f-notes', root).value.trim();
      const mVal = $('#f-males', root).value;
      const fVal = $('#f-females', root).value;
      const males   = mVal !== '' ? Number(mVal) : null;
      const females = fVal !== '' ? Number(fVal) : null;
      if (!birthDate) return toast('Pick a birth date', true);
      if (!initialCount || initialCount <= 0) return toast('Enter a count', true);
      if (initialCount < alreadyRemoved) return toast(`${alreadyRemoved} already removed — count must be at least ${alreadyRemoved}`, true);
      if (males !== null && females !== null && males + females > initialCount)
        return toast(`♂ + ♀ (${males + females}) exceeds count (${initialCount})`, true);
      c.birthDate = birthDate; c.initialCount = initialCount; c.notes = notes;
      c.males = males; c.females = females;
      touch('cohorts', c);
      saveState();
      toast('Litter updated');
      closeModal();
      trayDetailModal(trayId);
      render();
    };
  });
}

/* ----- Species editor ----- */
function speciesModal(existing) {
  const sp = existing || { name:'', stages:[
    {name:'Pinky',startDay:0},{name:'Fuzzy',startDay:5},
    {name:'Hopper',startDay:10},{name:'Adult',startDay:21}
  ]};
  const stageRows = stages => stages.map((st,i) => `
    <div class="stage-row">
      <input type="text"   value="${esc(st.name)}"   data-sname placeholder="Stage name" />
      <input type="number" value="${st.startDay}" data-sday  placeholder="Start day" min="0" />
      <button class="icon-btn" data-del-stage="${i}">✕</button>
    </div>`).join('');

  openModal(existing?'Edit species':'Add species', `
    <label class="field"><span>Species name</span>
      <input id="f-name" value="${esc(sp.name)}" placeholder="e.g. Mouse, Rat, Quail" /></label>
    <label class="field"><span>Species ID <span class="muted" style="font-weight:400;font-size:11px">(used to link trays — edit only to fix a mismatch)</span></span>
      <input id="f-species-id" value="${esc(sp.id||'')}" placeholder="auto" style="font-family:monospace;font-size:13px" /></label>
    <label class="field"><span>Natural lifespan (days)</span>
      <input id="f-lifespan" type="number" min="1" value="${sp.lifespan||''}" placeholder="e.g. 730 = 2 years" /></label>
    <p class="small muted" style="margin:-8px 0 10px">Used to show a natural death curve on the forecast and to prioritise oldest animals in harvest search.</p>
    <span class="small muted">Stages — name and the age in days it enters that stage (0 = birth).</span>
    <div class="stage-rows mt" id="stage-rows">${stageRows(sp.stages)}</div>
    <button class="btn sm" id="add-stage">+ Add stage</button>
    <hr class="hr" />
    <button class="btn primary block" data-save>Save species</button>
  `, root => {
    const rowsEl = $('#stage-rows', root);
    const collect = () => $$('.stage-row', rowsEl).map(r => ({
      name: $('[data-sname]',r).value.trim(),
      startDay: Number($('[data-sday]',r).value)||0
    }));
    const rebind = () => $$('[data-del-stage]', rowsEl).forEach(b => b.onclick = () => {
      const cur = collect(); cur.splice(Number(b.dataset.delStage),1);
      rowsEl.innerHTML = stageRows(cur.length?cur:[{name:'',startDay:0}]); rebind();
    });
    rebind();
    $('#add-stage', root).onclick = () => {
      const cur = collect();
      cur.push({name:'', startDay:(cur.at(-1)?.startDay||0)+5});
      rowsEl.innerHTML = stageRows(cur); rebind();
    };
    $('[data-save]', root).onclick = () => {
      const name     = $('#f-name', root).value.trim();
      const newId    = $('#f-species-id', root).value.trim() || genSpeciesId(name);
      const lifespan = parseInt($('#f-lifespan', root).value, 10) || null;
      let stages = collect().filter(s => s.name);
      if (!name) return toast('Enter a species name', true);
      if (!stages.length) return toast('Add at least one stage', true);
      stages.sort((a,b)=>a.startDay-b.startDay);
      if (existing) {
        const oldId = existing.id;
        existing.name = name; existing.stages = stages; existing.lifespan = lifespan;
        if (newId !== oldId) {
          existing.id = newId;
          // Update all tray and cohort references to the new ID
          live('trays').forEach(t => { if (t.speciesId === oldId) { t.speciesId = newId; touch('trays', t); } });
          live('cohorts').forEach(c => { if (c.speciesId === oldId) { c.speciesId = newId; touch('cohorts', c); } });
        }
        touch('species', existing);
      } else {
        const r = rec('species', {id: newId, name, stages, lifespan});
        upsertLocal('species', r); touch('species', r);
      }
      closeModal(); render();
    };
  });
}

/* ------------------------------------------------------------------ *
 *  Global click routing
 * ------------------------------------------------------------------ */
function onClick(e) {
  if (e.target.closest('[data-close]')) return closeModal();

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id  = el.dataset.id;

  switch (act) {
    case 'select-shelf': selectedShelfId = id; renderTrays(); return;
    case 'back-shelves': selectedShelfId = null; renderTrays(); return;
    case 'add-shelf':   return newShelfModal();
    case 'edit-shelf':  return shelfModal(byId('shelves',id));
    case 'del-shelf':   return confirmDelete('shelf', () => {
      live('trays').filter(t=>t.shelfId===id).forEach(t=>cascadeDeleteTray(t.id));
      removeRecord('shelves',id);
      if (selectedShelfId === id) selectedShelfId = null;
      render();
    });
    case 'add-tray':    return trayModal(id);
    case 'edit-tray':   { const t = byId('trays', id); if (t) { closeModal(); setTimeout(() => trayModal(t.shelfId, t), 10); } return; }
    case 'open-tray':   return trayDetailModal(id);
    case 'del-tray':    closeModal(); return confirmDelete('tray and its litters', () => { cascadeDeleteTray(id); render(); });
    case 'add-litter':  return litterModal(id);
    case 'del-cohort':  return confirmDelete('litter', () => {
      const trayId = byId('cohorts',id)?.trayId;
      live('removals').filter(r=>r.cohortId===id).forEach(r=>removeRecord('removals',r.id));
      removeRecord('cohorts',id);
      render(); if (trayId) trayDetailModal(trayId);
    });
    case 'add-intake':   return intakeModal(id);
    case 'edit-cohort':  return editCohortModal(id, el.dataset.trayid);
    case 'remove-stage': return openRemoveByStage(el.dataset.stage, Number(el.dataset.sidx));
    case 'add-species': return speciesModal();
    case 'edit-species':return speciesModal(byId('species',id));
    case 'del-species': return confirmDelete('species', () => { removeRecord('species',id); render(); });

    // Calendar navigation
    case 'cal-prev':
      calMonth--; if (calMonth < 0) { calMonth=11; calYear--; }
      renderCalendar(); return;
    case 'cal-next':
      calMonth++; if (calMonth > 11) { calMonth=0; calYear++; }
      renderCalendar(); return;
    case 'cal-select':
      calSelected = el.dataset.date; renderCalendar(); return;

    // Settings
    case 'save-url': {
      const v = $('#script-url').value.trim();
      state.meta.scriptUrl = v; saveState(); toast('URL saved'); render();
      if (v && navigator.onLine) syncNow();
      return;
    }
    case 'sync-now': syncNow(true); return;
    case 'export': return exportJSON();
    case 'import': return importJSON();
    case 'wipe':   return confirmDelete('ALL local data', () => {
      localStorage.removeItem(LS_KEY); location.reload();
    });
  }
}

function cascadeDeleteTray(trayId) {
  live('cohorts').filter(c=>c.trayId===trayId).forEach(c => {
    live('removals').filter(r=>r.cohortId===c.id).forEach(r=>removeRecord('removals',r.id));
    removeRecord('cohorts',c.id);
  });
  removeRecord('trays',trayId);
}

function confirmDelete(what, fn) {
  openModal('Confirm delete', `
    <p>Delete this ${esc(what)}? This cannot be undone.</p>
    <div class="gap mt">
      <button class="btn danger" data-yes>Delete</button>
      <button class="btn" data-close>Cancel</button>
    </div>
  `, root => { $('[data-yes]',root).onclick = () => { closeModal(); fn(); }; });
}

/* ------------------------------------------------------------------ *
 *  Backup
 * ------------------------------------------------------------------ */
function exportJSON() {
  const blob = new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `breeding-backup-${todayISO()}.json`;
  a.click(); URL.revokeObjectURL(a.href);
}
function importJSON() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'application/json';
  input.onchange = () => {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        for (const e of ENTITIES) if (Array.isArray(data[e])) state[e] = data[e];
        if (data.meta) state.meta = Object.assign(state.meta, data.meta);
        saveState(); toast('Imported'); render();
      } catch { toast('Invalid file', true); }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ------------------------------------------------------------------ *
 *  Sync engine — fully automatic
 * ------------------------------------------------------------------ */
let syncTimer = null;
let syncing   = false;
let syncError = null; // last error message, cleared on success

function scheduleSync() {
  renderSync();
  if (!state.meta.scriptUrl || !navigator.onLine) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(), SYNC_DEBOUNCE);
}

async function syncNow(manual = false) {
  if (syncing) return;
  if (!state.meta.scriptUrl) return;
  if (!navigator.onLine) { renderSync(); return; }

  syncing = true; renderSync();

  const changes = {};
  for (const e of ENTITIES) {
    const ids = Object.keys(state.pending[e] || {});
    if (ids.length) changes[e] = ids.map(id => byId(e,id)).filter(Boolean);
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);

  try {
    const res = await fetch(state.meta.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ since: state.meta.lastSync || 0, changes }),
      signal: ctrl.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Merge remote changes (last-write-wins)
    for (const e of ENTITIES) {
      for (const remote of (data.changes?.[e] || [])) {
        const local = byId(e, remote.id);
        if (!local || (remote.updatedAt||0) >= (local.updatedAt||0)) upsertLocal(e, remote);
      }
    }
    // Clear pending for all records we successfully sent
    for (const e of ENTITIES) {
      for (const r of (changes[e] || [])) {
        if (state.pending[e]) delete state.pending[e][r.id];
      }
    }
    state.meta.lastSync = data.serverTime || now();
    syncError = null;
    saveState();
    const gotNewData = ENTITIES.some(e => (data.changes?.[e]?.length || 0) > 0);
    syncing = false; renderSync();
    if (gotNewData || manual) render();
    if (manual) toast('Synced');
  } catch(err) {
    clearTimeout(timeoutId);
    syncError = err.name === 'AbortError' ? 'Timed out — script took >25s' : err.message;
    syncing = false; renderSync();
    console.warn('sync failed', syncError);
    if (manual) toast('Sync failed: ' + syncError, true);
  }
}

function renderSync() {
  const dot = $('#sync-dot'), txt = $('#sync-text');
  if (!dot) return;
  const pc = pendingCount();
  let cls='dot', label;
  let syncEl = dot.closest('.sync') || txt.closest('.sync');
  if (!state.meta.scriptUrl) { cls+=' pending'; label='Local only'; }
  else if (syncing)           { cls+=' syncing'; label='Syncing…'; }
  else if (!navigator.onLine) { cls+=' offline';  label=pc?`Offline · ${pc} queued`:'Offline'; }
  else if (syncError)         { cls+=' error';    label='Sync error'; }
  else if (pc > 0)            { cls+=' pending';  label=`${pc} pending`; }
  else                        { cls+=' ok';       label='Synced'; }
  dot.className=cls; txt.textContent=label;
  if (syncEl) syncEl.classList.toggle('local-only', !state.meta.scriptUrl);

  // Pending banner — visible whenever there are changes not yet on the server
  const banner = $('#pending-banner');
  const bannerTxt = $('#pending-banner-text');
  if (banner && bannerTxt) {
    const showBanner = pc > 0 && state.meta.scriptUrl;
    banner.hidden = !showBanner;
    if (showBanner) {
      bannerTxt.textContent = `⚠ ${pc} change${pc !== 1 ? 's' : ''} not yet uploaded to Google Sheet`;
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */
function init() {
  loadState();
  initHistory();
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));
  document.addEventListener('click', onClick);

  // Auto-sync triggers
  window.addEventListener('online',  () => { renderSync(); syncNow(); });
  window.addEventListener('offline', renderSync);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      syncOnExit(); // attempt to push pending data before app is suspended
    } else if (navigator.onLine && state.meta.scriptUrl) {
      syncNow();   // pull latest when returning to app
    }
  });
  setInterval(() => {
    if (navigator.onLine && state.meta.scriptUrl && !syncing) syncNow();
  }, AUTO_PULL_MS);

  render();
  if (state.meta.scriptUrl && navigator.onLine) syncNow();

  // Floating action button — quick add
  const fab = document.createElement('button');
  fab.className = 'fab'; fab.title = 'Quick add'; fab.textContent = '+';
  fab.onclick = () => { showTrayFabMenu(); };
  fab.style.display = activeTab === 'trays' ? '' : 'none';
  document.body.appendChild(fab);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}

document.addEventListener('DOMContentLoaded', init);
