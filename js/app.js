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
const AUTO_PULL_MS    = 45000;  // background pull interval when online

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const now = () => Date.now();
const todayISO = () => new Date().toISOString().slice(0,10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function daysBetween(fromISO, toDate = new Date()) {
  const a = new Date(fromISO + 'T00:00:00');
  const b = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.floor((b - a) / 86400000);
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtDate(d) { return d.toLocaleDateString(undefined, { month:'short', day:'numeric' }); }
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
const speciesOf = obj => byId('species', obj.speciesId);

/* ------------------------------------------------------------------ *
 *  Domain calculations
 * ------------------------------------------------------------------ */
function cohortNet(cohort, asOf = new Date()) {
  const asISO = asOf.toISOString().slice(0,10);
  let removed = 0;
  for (const r of state.removals) {
    if (r.deleted || r.cohortId !== cohort.id) continue;
    if (r.date <= asISO) removed += Number(r.count) || 0;
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
  const recent = live('removals').filter(r => r.count > 0 && new Date(r.date) >= cutoff);
  const byStage = new Map();
  for (const r of recent) {
    const cohort = live('cohorts').find(c => c.id === r.cohortId);
    if (!cohort) continue;
    const { name } = stageIndexAt(cohort, new Date(r.date + 'T00:00:00'));
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

function renderCohortTimeline(filter = () => true) {
  const cohorts = live('cohorts').filter(c => filter(c) && cohortNet(c) > 0);
  if (!cohorts.length) return '';

  const PAST  = 14;
  const FUT   = 70;
  const TOTAL = PAST + FUT;
  const LW    = 108; // label column width
  const DPX   = 5;   // px per day
  const RH    = 30;  // row height
  const RG    = 5;   // row gap
  const HDR   = 32;  // header height
  const PAD_B = 12;
  const today     = new Date();
  const startDate = addDays(today, -PAST);

  cohorts.sort((a, b) => new Date(a.birthDate) - new Date(b.birthDate));

  const W = LW + TOTAL * DPX;
  const H = HDR + cohorts.length * (RH + RG) + PAD_B;
  const todayX = LW + PAST * DPX;

  // Week gridlines + date labels (skip any label too close to today)
  let grid = '', hdates = '';
  for (let d = 0; d <= TOTAL; d += 7) {
    const x = LW + d * DPX;
    const dt = addDays(startDate, d);
    grid += `<line x1="${x}" y1="${HDR - 4}" x2="${x}" y2="${H - PAD_B}" class="g-grid"/>`;
    if (Math.abs(x - todayX) > 22)
      hdates += `<text x="${x}" y="18" class="g-dt" text-anchor="middle">${fmtDate(dt)}</text>`;
  }

  // Cohort rows
  let rows = '';
  cohorts.forEach((cohort, ri) => {
    const y    = HDR + ri * (RH + RG);
    const sp   = speciesOf(cohort);
    const tray = byId('trays', cohort.trayId);
    const label = tray ? tray.name : (cohort.name || 'Cohort');
    const net  = cohortNet(cohort);
    const stages = sp?.stages ? [...sp.stages].sort((a,b) => a.startDay - b.startDay) : [];
    const birth = new Date(cohort.birthDate + 'T00:00:00');

    rows += `<rect x="${LW}" y="${y + 2}" width="${TOTAL * DPX}" height="${RH - 4}" rx="4" class="g-row-bg"/>`;

    if (stages.length) {
      stages.forEach((st, si) => {
        const nextSt = stages[si + 1];
        const segStart = new Date(Math.max(addDays(birth, st.startDay), startDate));
        const segEnd   = nextSt
          ? new Date(Math.min(addDays(birth, nextSt.startDay), addDays(today, FUT)))
          : addDays(today, FUT);
        if (segStart >= segEnd) return;
        const dx = Math.floor((segStart - startDate) / 86400000);
        const dw = Math.ceil((segEnd - segStart) / 86400000);
        const sx = LW + dx * DPX;
        const sw = dw * DPX;
        const hex = STAGE_HEX[si % STAGE_HEX.length];
        const past = segEnd <= today;
        rows += `<rect x="${sx}" y="${y + 5}" width="${sw}" height="${RH - 10}" rx="3" fill="${hex}" opacity="${past ? .30 : .75}">
          <title>${esc(st.name)}</title></rect>`;
        // stage transition tick
        if (si > 0) {
          const tx = LW + dx * DPX;
          rows += `<line x1="${tx}" y1="${y + 2}" x2="${tx}" y2="${y + RH - 2}" stroke="${hex}" stroke-width="2" opacity=".55"/>`;
        }
      });
    } else {
      // No stages: single bar from birth to today
      const dx = Math.max(0, Math.floor((birth - startDate) / 86400000));
      const sw = Math.max(DPX, (PAST - dx) * DPX);
      rows += `<rect x="${LW + dx * DPX}" y="${y + 5}" width="${sw}" height="${RH - 10}" rx="3" fill="#94a3b8" opacity=".35"/>`;
    }

    rows += `<text x="${LW - 6}" y="${y + RH/2 + 4}" class="g-lbl" text-anchor="end">${esc(label)}</text>`;
    rows += `<text x="${LW + TOTAL * DPX - 4}" y="${y + RH/2 + 4}" class="g-cnt" text-anchor="end">${net}</text>`;
  });

  // Today line — label at header row height, replacing the suppressed date label
  const todayLine = `
    <line x1="${todayX}" y1="${HDR - 4}" x2="${todayX}" y2="${H - PAD_B}" class="g-today"/>
    <text x="${todayX}" y="18" class="g-today-lbl" text-anchor="middle">Today</text>`;

  return `<div class="gantt-wrap">
    <svg class="gantt-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
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

// Warn on page exit if changes are pending
window.addEventListener('beforeunload', e => {
  if (pendingCount() > 0 && state.meta.scriptUrl) {
    e.preventDefault();
    e.returnValue = 'You have unsynced changes. Leave anyway?';
  }
});

/* ------------------------------------------------------------------ *
 *  Rendering
 * ------------------------------------------------------------------ */
let dashFilterSpecies = 'all';
let fcVisibleStages  = null; // null = all visible; Set of stage names when filtered

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

  if (live('cohorts').length === 0) {
    el.innerHTML = emptyState('🥚','No litters logged yet',
      'Go to the <b>Trays</b> tab and add a litter to a tray to start tracking.');
    return;
  }

  // Stat cards — tappable to open "remove by stage" modal
  const stageCards = names.map((nm, i) => {
    const v = totals.get(nm) || 0;
    return `<div class="stat-stage stat-stage-btn" data-s="${i}"
        data-act="remove-stage" data-stage="${esc(nm)}" data-sidx="${i}"
        role="button" tabindex="0" title="Remove ${esc(nm)}">
      <span class="stage-edge" style="background:${stageColor(i)}"></span>
      <div class="n">${v}</div>
      <div class="l">${esc(nm)}</div>
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

  return `<svg class="donut-svg" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
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

function renderCharts() {
  const el = $('#tab-charts');
  if (live('cohorts').length === 0) {
    el.innerHTML = emptyState('📊', 'No data yet',
      'Add animals to your trays to start seeing charts.');
    return;
  }

  const { totals } = stageTotalsAt(new Date());
  const names = orderedStageNames();
  const timeline = renderCohortTimeline();
  const removalRates = computeRemovalInsights();
  const insights = renderRemovalInsights(removalRates);

  el.innerHTML = `
    <h2 class="section-title" style="margin-bottom:10px">Stage distribution</h2>
    <div class="card" style="padding:14px">
      <div class="dist-combined">
        ${renderDonutChart(totals, names)}
        ${renderStageDistributionGrid(totals, names)}
      </div>
    </div>

    <h2 class="section-title" style="margin-top:26px;margin-bottom:10px">Cohort timeline</h2>
    <div class="card" style="padding:14px 10px 10px">
      ${timeline || '<p class="small muted">No active cohorts.</p>'}
      ${insights}
    </div>`;
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

  const rows = [...byTray.values()].map(({ tray, entries }) => {
    const trayTotal = entries.reduce((s, e) => s + e.net, 0);
    const trayLabel = tray ? esc(tray.name) : '(unknown tray)';
    const cohortRows = entries.map(({ cohort, net }) =>
      `<div class="rs-cohort">
        <span class="rs-info">Born ${esc(cohort.birthDate)} · <b>${net}</b> available</span>
        <input type="number" class="rs-input" min="0" max="${net}" placeholder="0"
          data-cohort-id="${cohort.id}" data-tray-id="${cohort.trayId}" data-max="${net}" />
      </div>`
    ).join('');
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
    $('#rs-save', root).onclick = () => {
      const inputs = $$('.rs-input', root);
      let recorded = 0;
      for (const inp of inputs) {
        const n = Number(inp.value);
        if (!n || n <= 0) continue;
        const cohortId = inp.dataset.cohortId;
        const trayId   = inp.dataset.trayId;
        const max      = Number(inp.dataset.max);
        if (n > max) return toast(`Max available is ${max}`, true);
        const r = rec('removals', { cohortId, trayId, date: todayISO(), stage: stageName, count: n });
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

/* ---------- Trays ---------- */
function renderTrays() {
  const el = $('#tab-trays');
  const shelves = live('shelves').sort((a,b) => (a.sortOrder||0)-(b.sortOrder||0));
  const names = orderedStageNames();

  let html = `<div class="spread"><h2 class="section-title" style="margin:4px 0 0">Shelves & trays</h2>
    <button class="btn sm primary" data-act="add-shelf">+ Shelf</button></div>`;

  if (!shelves.length) html += emptyState('🗄️','No shelves yet','Add a shelf, then trays inside it.');

  for (const shelf of shelves) {
    const trays = live('trays').filter(t => t.shelfId === shelf.id);
    html += `<div class="shelf">
      <div class="shelf-head">
        <h3>${esc(shelf.name)}</h3>
        <div class="row-actions">
          <button class="btn sm" data-act="add-tray" data-id="${shelf.id}">+ Tray</button>
          <button class="icon-btn" data-act="edit-shelf" data-id="${shelf.id}" title="Rename">✎</button>
          <button class="icon-btn" data-act="del-shelf" data-id="${shelf.id}" title="Delete">🗑</button>
        </div>
      </div>
      <div class="tray-grid">`;

    if (!trays.length) html += `<p class="muted small">No trays. Add one above.</p>`;

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
    html += `</div></div>`;
  }
  el.innerHTML = html;
}

/* ---------- Calendar ---------- */
let calYear  = new Date().getFullYear();
let calMonth = new Date().getMonth();
let calSelected = todayISO();

function getCalEvents() {
  const map = {};
  const add = (date, ev) => { (map[date] = map[date] || []).push(ev); };
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
      <div class="spread"><b>${esc(sp.name)}</b>
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
  const last = state.meta.lastSync ? new Date(state.meta.lastSync).toLocaleString() : 'never';
  const pc   = pendingCount();

  el.innerHTML = `
    <h2 class="section-title" style="margin:4px 0 10px">Google Sheet sync</h2>
    <div class="card">
      <label class="field">
        <span>Apps Script Web App URL</span>
        <input id="script-url" type="url" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(url)}" />
      </label>
      <p class="small muted" style="margin:0 0 14px">Once set, all changes sync automatically. Data also saves locally on this device and uploads when back online.</p>
      <button class="btn primary" data-act="save-url">Save URL</button>
      <hr class="hr" />
      <div class="small muted">
        <div class="spread"><span>Sync status</span><span>${pc>0?`${pc} changes queued`:(url?'Up to date':'No URL set')}</span></div>
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
  const s = existing || {};
  openModal(existing?'Rename shelf':'Add shelf', `
    <label class="field"><span>Shelf name</span>
      <input id="f-name" value="${esc(s.name||'')}" placeholder="e.g. Shelf A / Top rack" /></label>
    <button class="btn primary block" data-save>Save</button>
  `, root => {
    $('#f-name', root).focus();
    $('[data-save]', root).onclick = () => {
      const name = $('#f-name', root).value.trim();
      if (!name) return toast('Enter a name', true);
      if (existing) { existing.name = name; touch('shelves', existing); }
      else { const r = rec('shelves',{name, sortOrder:live('shelves').length}); upsertLocal('shelves',r); touch('shelves',r); }
      closeModal(); render();
    };
  });
}

/* ----- Tray ----- */
function trayModal(shelfId, existing) {
  const speciesList = live('species');
  if (!speciesList.length) return toast('Add a species first', true);
  const t = existing || {};
  const opts = speciesList.map(s =>
    `<option value="${s.id}" ${s.id===t.speciesId?'selected':''}>${esc(s.name)}</option>`).join('');
  openModal(existing?'Edit tray':'Add tray', `
    <label class="field"><span>Tray name</span>
      <input id="f-name" value="${esc(t.name||'')}" placeholder="e.g. Tray 3 / B2" /></label>
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
      else { const r=rec('trays',{shelfId,name,speciesId}); upsertLocal('trays',r); touch('trays',r); }
      closeModal(); render();
    };
  });
}

/* ----- Tray detail ----- */
function trayDetailModal(trayId) {
  const tray = byId('trays', trayId);
  if (!tray) return;
  const sp = speciesOf(tray);
  const cohorts = live('cohorts').filter(c => c.trayId === trayId)
    .sort((a,b) => a.birthDate < b.birthDate ? 1 : -1);

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
        <div class="small muted">Born ${esc(c.birthDate)} · ${age}d old · started ${c.initialCount}${c.notes?' · '+esc(c.notes):''}</div>
      </div>
      <div class="cohort-remove">
        ${depleted?'':`<input type="number" min="1" max="${net}" placeholder="0" data-remove="${c.id}" />
        <button class="btn sm" data-act="do-remove" data-id="${c.id}">Remove</button>`}
        <button class="icon-btn" data-act="edit-cohort" data-id="${c.id}" data-trayid="${trayId}" title="Edit">✎</button>
        <button class="icon-btn" data-act="del-cohort" data-id="${c.id}" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');

  openModal(`${esc(tray.name)} · ${sp?esc(sp.name):''}`, `
    <div class="gap" style="margin-bottom:4px">
      <button class="btn primary" data-act="add-litter" data-id="${trayId}" style="flex:1">+ Born today</button>
      <button class="btn primary" data-act="add-intake" data-id="${trayId}" style="flex:1">+ Add by stage</button>
    </div>
    <div class="mt">${cohorts.length ? rows : '<p class="muted small">No litters yet.</p>'}</div>
    <hr class="hr" />
    <button class="btn danger" data-act="del-tray" data-id="${trayId}">Delete tray</button>
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
        const r = rec('removals',{ cohortId:id, trayId, date:todayISO(), stage:name, count:n });
        upsertLocal('removals',r); touch('removals',r);
        toast(`Removed ${n} ${name}`);
        closeModal(); trayDetailModal(trayId); render();
      };
    });
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
        data-startday="${st.startDay}" data-stage="${esc(st.name)}" />
    </div>`;
  }).join('');

  openModal(`Add to ${esc(tray.name)}`, `
    <p class="small muted" style="margin-bottom:14px">Enter how many to add at each stage. Birth date is calculated automatically.</p>
    <div class="intake-list">${rows}</div>
    <button class="btn primary block" id="intake-save" style="margin-top:16px">Add animals</button>
  `, root => {
    $('#intake-save', root).onclick = () => {
      const inputs = $$('.intake-input', root);
      let added = 0;
      for (const inp of inputs) {
        const n = Number(inp.value);
        if (!n || n <= 0) continue;
        const startDay  = Number(inp.dataset.startday);
        const stageName = inp.dataset.stage;
        const birthDate = addDays(new Date(), -startDay).toISOString().slice(0, 10);
        const r = rec('cohorts', {
          trayId, speciesId: tray.speciesId,
          birthDate, initialCount: n,
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
        <input id="f-date" type="date" value="${esc(c.birthDate)}" /></label>
      <label class="field"><span>Initial count</span>
        <input id="f-count" type="number" min="${Math.max(1, alreadyRemoved)}" value="${c.initialCount}" /></label>
    </div>
    <label class="field"><span>Notes (optional)</span>
      <input id="f-notes" value="${esc(c.notes || '')}" placeholder="e.g. dam #4" /></label>
    <button class="btn primary block" data-save>Save changes</button>
  `, root => {
    $('[data-save]', root).onclick = () => {
      const birthDate = $('#f-date', root).value;
      const initialCount = Number($('#f-count', root).value);
      const notes = $('#f-notes', root).value.trim();
      if (!birthDate) return toast('Pick a birth date', true);
      if (!initialCount || initialCount <= 0) return toast('Enter a count', true);
      if (initialCount < alreadyRemoved) return toast(`${alreadyRemoved} already removed — count must be at least ${alreadyRemoved}`, true);
      c.birthDate = birthDate;
      c.initialCount = initialCount;
      c.notes = notes;
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
      const name = $('#f-name', root).value.trim();
      let stages = collect().filter(s => s.name);
      if (!name) return toast('Enter a species name', true);
      if (!stages.length) return toast('Add at least one stage', true);
      stages.sort((a,b)=>a.startDay-b.startDay);
      if (existing) { existing.name=name; existing.stages=stages; touch('species',existing); }
      else { const r=rec('species',{name,stages}); upsertLocal('species',r); touch('species',r); }
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
    case 'add-shelf':   return shelfModal();
    case 'edit-shelf':  return shelfModal(byId('shelves',id));
    case 'del-shelf':   return confirmDelete('shelf', () => {
      live('trays').filter(t=>t.shelfId===id).forEach(t=>cascadeDeleteTray(t.id));
      removeRecord('shelves',id); render();
    });
    case 'add-tray':    return trayModal(id);
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

  try {
    const res = await fetch(state.meta.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ since: state.meta.lastSync || 0, changes })
    });
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
    // Clear successfully pushed pending entries
    for (const e of ENTITIES) {
      for (const r of (changes[e] || [])) {
        const remote = (data.changes?.[e]||[]).find(x=>x.id===r.id);
        if (!remote || (remote.updatedAt||0) <= r.updatedAt) {
          if (state.pending[e]) delete state.pending[e][r.id];
        }
      }
    }
    state.meta.lastSync = data.serverTime || now();
    saveState();
    syncing = false; renderSync(); render();
    if (manual) toast('Synced');
  } catch(err) {
    syncing = false; renderSync();
    console.warn('sync failed', err);
    if (manual) toast('Sync failed: ' + err.message, true);
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
  else if (pc > 0)            { cls+=' pending';  label=`Syncing…`; }
  else                        { cls+=' ok';       label='Synced'; }
  dot.className=cls; txt.textContent=label;
  if (syncEl) syncEl.classList.toggle('local-only', !state.meta.scriptUrl);
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
    if (document.visibilityState === 'visible' && navigator.onLine && state.meta.scriptUrl) syncNow();
  });
  setInterval(() => {
    if (navigator.onLine && state.meta.scriptUrl && !syncing) syncNow();
  }, AUTO_PULL_MS);

  render();
  if (state.meta.scriptUrl && navigator.onLine) syncNow();

  // Floating action button — quick add
  const fab = document.createElement('button');
  fab.className = 'fab'; fab.title = 'Quick add'; fab.textContent = '+';
  fab.onclick = () => {
    const shelves = live('shelves');
    if (!shelves.length) { switchTab('trays'); toast('Add a shelf first, then a tray'); return; }
    const trays = live('trays');
    if (!trays.length) {
      switchTab('trays');
      onClick({ target: document.querySelector('[data-act="add-tray"]') });
      return;
    }
    // Open add-litter on the first available tray
    switchTab('trays');
    trayDetailModal(trays[0].id);
  };
  document.body.appendChild(fab);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}

document.addEventListener('DOMContentLoaded', init);
