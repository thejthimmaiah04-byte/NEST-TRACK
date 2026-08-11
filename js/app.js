/* =========================================================================
   Rodent Breeding Monitor — offline-first tracker with Google Sheets sync
   ========================================================================= */

'use strict';

/* ------------------------------------------------------------------ *
 *  Constants & helpers
 * ------------------------------------------------------------------ */
const LS_KEY          = 'rbm.state.v1';
const STAGE_COLORS    = ['--s0','--s1','--s2','--s3','--s4'];
const DEATH_CAUSES    = ['Unknown','Fight','Eaten','Disease','Flooding','Dystocia','Cannibalism','Hypothermia','Age/Natural','Culled'];
const STAGE_HEX       = ['#fb7185','#facc15','#94a3b8','#e2c97e','#fb923c'];
const SYNC_DEBOUNCE   = 1200;   // ms after last change before pushing
const AUTO_PULL_MS    = 15000;  // background pull interval when online
const SYNC_TIMEOUT_MS = 45000;  // Apps Script cold-start can take 30-40s

const $   = (sel, root = document) => root.querySelector(sel);
const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
const now = () => Date.now();
const _localYMDStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const todayISO = () => _localYMDStr(new Date());
// Store dates as yyyymmdd (e.g. "20260802")
const toYMD     = d  => _localYMDStr(d).replace(/-/g,'');
// Parse "20260802", "2026-08-02", or full ISO timestamp → Date
const parseYMD  = s  => { s=String(s||''); if(/^\d{8}$/.test(s)) s=s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8); if(s.length>10) s=s.slice(0,10); return new Date(s?s+'T00:00:00':NaN); };
// "20260802" → "2026-08-02" for <input type="date">
const ymdToInput = s => { s=String(s||''); return /^\d{8}$/.test(s)?s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8):s; };
// Normalize any date string to yyyymmdd for lexicographic comparison
const normYMD   = s  => toYMD(parseYMD(s));

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Returns true if dateStr (any supported format) is a plausible colony date (2015–2040)
function isValidDate(dateStr) {
  if (!dateStr) return false;
  const d = parseYMD(dateStr);
  if (isNaN(d.getTime())) return false;
  const y = d.getFullYear();
  return y >= 2015 && y <= 2040;
}

function daysBetween(fromDateStr, toDate = new Date()) {
  const a = parseYMD(fromDateStr); // handles both formats
  const b = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.floor((b - a) / 86400000);
}
function addDays(date, n) { const d = new Date(date); d.setDate(d.getDate() + n); return d; }
function fmtDate(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function fmtTimestamp(ms) {
  const d = new Date(ms);
  const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  const hm  = String(d.getHours()).padStart(2,'0') + '-' + String(d.getMinutes()).padStart(2,'0');
  return ymd + ': ' + hm;
}

// Returns { males, females } for the adult population of a tray.
// Source of truth: tray.adultMales / tray.adultFemales (set via Save in modal or auto-updated on transfer).
// Legacy fallback for trays not yet migrated: sum cohort males/females (no removal subtraction).
function trayAdultSex(trayId, sp) {
  const tray = byId('trays', trayId);
  if (!tray) return null;
  if (tray.adultMales != null || tray.adultFemales != null) {
    return { males: Number(tray.adultMales) || 0, females: Number(tray.adultFemales) || 0 };
  }
  if (!sp?.stages?.length) return null;
  const lastStage = [...sp.stages].sort((a, b) => (b.startDay||0) - (a.startDay||0))[0]?.name;
  if (!lastStage) return null;
  const today = new Date();
  let males = 0, females = 0, tracked = false;
  for (const c of live('cohorts')) {
    if (c.trayId !== trayId || cohortNet(c, today) <= 0) continue;
    if (stageIndexAt(c, today).name !== lastStage) continue;
    if (c.males == null && c.females == null) continue;
    tracked = true;
    males   += Number(c.males) || 0;
    females += Number(c.females) || 0;
  }
  return tracked ? { males, females } : null;
}

// One-time migration: promote cohort-level sex data → tray.adultMales/adultFemales
function migrateTraySexData() {
  let dirty = false;
  for (const tray of live('trays')) {
    if (tray.adultMales != null || tray.adultFemales != null) continue;
    const sp = byId('species', tray.speciesId);
    if (!sp?.stages?.length) continue;
    const lastStage = [...sp.stages].sort((a, b) => (b.startDay||0) - (a.startDay||0))[0]?.name;
    if (!lastStage) continue;
    const today = new Date();
    let males = 0, females = 0, tracked = false;
    for (const c of live('cohorts')) {
      if (c.trayId !== tray.id || cohortNet(c, today) <= 0) continue;
      if (stageIndexAt(c, today).name !== lastStage) continue;
      if (c.males == null && c.females == null) continue;
      tracked = true;
      const rems = live('removals').filter(r => r.cohortId === c.id);
      const remM = rems.reduce((s, r) => s + (Number(r.males) || 0), 0);
      const remF = rems.reduce((s, r) => s + (Number(r.females) || 0), 0);
      males   += Math.max(0, (Number(c.males) || 0) - remM);
      females += Math.max(0, (Number(c.females) || 0) - remF);
    }
    if (tracked) { tray.adultMales = males; tray.adultFemales = females; dirty = true; }
  }
  if (dirty) saveState();
}

// Returns current adult count for a tray.
// When sex is tracked (tray.adultMales/adultFemales set), sex sum IS the count.
// Falls back to cohort-based count otherwise.
function trayAdultCount(tray, sp) {
  if (!tray) return 0;
  if (tray.adultMales != null || tray.adultFemales != null) {
    return (Number(tray.adultMales) || 0) + (Number(tray.adultFemales) || 0);
  }
  if (!sp?.stages?.length) return 0;
  const lastStage = [...sp.stages].sort((a, b) => (b.startDay||0) - (a.startDay||0))[0]?.name;
  if (!lastStage) return 0;
  const today = new Date();
  let count = 0;
  for (const c of live('cohorts')) {
    if (c.trayId !== tray.id || cohortNet(c, today) <= 0) continue;
    if (stageIndexAt(c, today).name !== lastStage) continue;
    count += cohortNet(c, today);
  }
  return count;
}

// Returns Map<stage, count> of animals currently in the freezer
function frozenByStage() {
  const m = new Map();
  live('removals').filter(r => r.reason === 'Frozen' && r.stage).forEach(r => {
    m.set(r.stage, (m.get(r.stage) || 0) + (r.count || 0));
  });
  live('frozen_uses').filter(u => u.stage).forEach(u => {
    m.set(u.stage, (m.get(u.stage) || 0) - (u.count || 0));
  });
  // Remove zeroed/negative entries
  for (const [k, v] of m) if (v <= 0) m.delete(k);
  return m;
}

// Total frozen count across all stages
function totalFrozen() {
  let t = 0;
  frozenByStage().forEach(v => t += v);
  return t;
}

// Returns [{sp, count}] for species with a positive frozen balance (used in tray panel)
function frozenStock() {
  const totals = {};
  live('removals').filter(r => r.reason === 'Frozen').forEach(r => {
    const cohort = byId('cohorts', r.cohortId);
    const spId = cohort?.speciesId;
    if (!spId) return;
    totals[spId] = (totals[spId] || 0) + (r.count || 0);
  });
  live('frozen_uses').forEach(u => {
    if (!u.speciesId) return;
    totals[u.speciesId] = (totals[u.speciesId] || 0) - (u.count || 0);
  });
  return Object.entries(totals)
    .map(([spId, count]) => ({ sp: byId('species', spId), count }))
    .filter(x => x.count > 0);
}

// Green = ratio within 15% of target; Yellow = within 40%; Red = no males or ratio off
function ratioStatus(males, females, ratio) {
  if (males === 0) return 'off';
  if (!ratio) return 'ok';
  const targetRatio = ratio.females / (ratio.males || 1); // target females per male
  const actual = females / males;
  if (!females) return males > 0 ? 'close' : 'off';
  const dev = Math.abs(targetRatio - actual) / targetRatio;
  if (dev <= 0.15) return 'ok';
  if (dev <= 0.40) return 'close';
  return 'off';
}
function stageColor(i) { return `var(${STAGE_COLORS[i % STAGE_COLORS.length]})`; }

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */
const ENTITIES = ['species','shelves','trays','cohorts','removals','frozen_uses'];

let state = {
  species:[], shelves:[], trays:[], cohorts:[], removals:[], frozen_uses:[],
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
}

function saveState() {
  try {
    const serialized = JSON.stringify(state);
    if (serialized.length > 4_000_000) toast('⚠ Storage nearly full — export a backup now', true);
    localStorage.setItem(LS_KEY, serialized);
  }
  catch(e) {
    console.warn('save failed', e);
    toast('⚠ Storage full — export a backup immediately!', true);
  }
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
  return null; // Don't silently return wrong species in multi-species setups
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
  if (!cohort.birthDate) return { idx:0, name:'Unknown', species:sp, age:null, stages:[] };
  const stages = [...sp.stages].sort((a,b) => a.startDay - b.startDay);
  const age = daysBetween(cohort.birthDate, atDate);
  if (isNaN(age)) return { idx:0, name:'Unknown', species:sp, age:null, stages };
  let idx = 0;
  for (let i = 0; i < stages.length; i++) {
    if (age >= stages[i].startDay) idx = i; else break;
  }
  return { idx, name:stages[idx].name, species:sp, age, stages };
}

function stageTotalsAt(atDate = new Date(), filter = () => true, forecastMode = false) {
  // Build removal index once so cohortNet doesn't scan all removals per cohort call
  const removalsByCohort = new Map();
  for (const r of state.removals) {
    if (r.deleted) continue;
    if (!removalsByCohort.has(r.cohortId)) removalsByCohort.set(r.cohortId, []);
    removalsByCohort.get(r.cohortId).push(r);
  }

  const totals = new Map();
  let total = 0;

  // For adult-stage counts, use tray-level sex tally (authoritative) per tray, not per cohort
  // Exception: forecastMode uses cohort-based arithmetic so maturing animals project correctly
  const adultTraysCounted = new Set();

  for (const c of live('cohorts')) {
    if (!filter(c)) continue;
    const sp = speciesOf(c);
    if (!sp?.stages?.length) continue;
    const lastStage = [...sp.stages].sort((a, b) => (b.startDay||0) - (a.startDay||0))[0]?.name;
    const { name } = stageIndexAt(c, atDate);

    if (name === lastStage) {
      if (forecastMode) {
        // Forecast: count each cohort's net animals so adults maturing from sub-stages show up
        const rems = removalsByCohort.get(c.id) || [];
        const asYMD = toYMD(atDate);
        let removed = rems.reduce((s, r) => normYMD(r.date) <= asYMD ? s + (Number(r.count)||0) : s, 0);
        const net = Math.max(0, (Number(c.initialCount)||0) - removed);
        if (net <= 0) continue;
        if (sp?.lifespan && daysBetween(c.birthDate, atDate) >= sp.lifespan) continue;
        totals.set(lastStage, (totals.get(lastStage) || 0) + net);
        total += net;
      } else {
        // Current view: count once per tray via stored sex tally (authoritative)
        const tray = byId('trays', c.trayId);
        if (!tray || adultTraysCounted.has(tray.id)) continue;
        if (!filter({ ...c, trayId: tray.id })) continue;
        adultTraysCounted.add(tray.id);
        const adultCount = trayAdultCount(tray, sp);
        if (adultCount <= 0) continue;
        totals.set(lastStage, (totals.get(lastStage) || 0) + adultCount);
        total += adultCount;
      }
    } else {
      // Non-adult stages: use cohortNet with pre-built removal index
      const rems = removalsByCohort.get(c.id) || [];
      const asYMD = toYMD(atDate);
      let removed = rems.reduce((s, r) => normYMD(r.date) <= asYMD ? s + (Number(r.count)||0) : s, 0);
      const net = Math.max(0, (Number(c.initialCount)||0) - removed);
      if (net <= 0) continue;
      if (sp?.lifespan && daysBetween(c.birthDate, atDate) >= sp.lifespan) continue;
      totals.set(name, (totals.get(name) || 0) + net);
      total += net;
    }
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
    const { totals } = stageTotalsAt(d, filter, true);
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
  else if (activeTab === 'freezer')   renderFreezer();
  else if (activeTab === 'calendar')  renderCalendar();
  else if (activeTab === 'species')   renderSpecies();
  else if (activeTab === 'settings')  renderSettings();
  else if (activeTab === 'reports')   renderReports();
}

/* ---------- Shuffle Recommendations ---------- */
function computeShuffleRecommendations() {
  const now = new Date();
  const trayData = [];

  for (const tray of live('trays')) {
    const sp = speciesOf(tray);
    if (!sp?.stages?.length) continue;

    const sex = trayAdultSex(tray.id, sp);
    if (!sex || (sex.males === 0 && sex.females === 0)) continue;
    trayData.push({ tray, sp, males: sex.males, females: sex.females });
  }

  const recs = [];
  const usedDonors = new Map(); // trayId → males already pledged

  // Pass 1 — trays with females but no male → find a donor with ≥2 males
  const needsMale  = trayData.filter(t => t.males === 0 && t.females >= 1);
  const hasSurplus = trayData.filter(t => t.males >= 2);
  for (const need of needsMale) {
    const donor = hasSurplus.find(d =>
      d.sp.id === need.sp.id &&
      d.tray.id !== need.tray.id &&
      d.males - (usedDonors.get(d.tray.id) || 0) >= 2
    );
    if (!donor) continue;
    usedDonors.set(donor.tray.id, (usedDonors.get(donor.tray.id) || 0) + 1);
    recs.push({
      from: donor.tray, to: need.tray, count: 1, sex: '♂',
      detail: `${need.tray.name} has ${need.females} ♀ but no ♂ — ${donor.tray.name} has ${donor.males} ♂`
    });
  }

  // Pass 2 — ratio > 1:4 → suggest moving excess females to a roomier tray
  for (const t of trayData) {
    if (t.males === 0 || t.females / t.males <= 4) continue;
    const target = trayData.find(d =>
      d.sp.id === t.sp.id &&
      d.tray.id !== t.tray.id &&
      d.males > 0 &&
      d.females / d.males < 3 &&
      !recs.some(r => r.from?.id === t.tray.id && r.sex === '♀')
    );
    if (!target) continue;
    const excess = Math.floor(t.females - t.males * 3);
    if (excess < 1) continue;
    recs.push({
      from: t.tray, to: target.tray, count: excess, sex: '♀',
      detail: `${t.tray.name} ratio is 1:${Math.round(t.females / t.males)} (${t.males}♂ ${t.females}♀) — move ${excess}♀ to ${target.tray.name}`
    });
  }

  // Pass 3 — trays with adults approaching lifespan (≥ 85% of lifespan)
  for (const { tray, sp } of trayData) {
    if (!sp.lifespan) continue;
    const adultCohorts = live('cohorts').filter(c => c.trayId === tray.id && cohortNet(c, now) > 0 && stageIndexAt(c, now).name === [...sp.stages].sort((a,b)=>(b.startDay||0)-(a.startDay||0))[0]?.name);
    const oldest = adultCohorts.reduce((best, c) => {
      const age = daysBetween(c.birthDate, now);
      return (age > (best || 0)) ? age : best;
    }, null);
    if (oldest == null) continue;
    const pct = oldest / sp.lifespan;
    if (pct >= 0.85) {
      recs.push({
        from: null, to: tray, count: 0, sex: '⏰',
        detail: `${tray.name} adults are ${oldest}d old — ${sp.lifespan}d max lifespan (${Math.round(pct*100)}%). Plan replacement cohort.`,
        actionLabel: 'Plan replacement', noCheckbox: true
      });
    }
  }

  // Pass 4 — gravid females overdue (gravidSince + gestation < today)
  for (const tray of live('trays')) {
    if (!tray.gravidFemales || !tray.gravidSince) continue;
    const sp = speciesOf(tray);
    const gestation = sp?.gestation || 21;
    const dueDate = addDays(parseYMD(tray.gravidSince), gestation);
    if (dueDate < now) {
      const overdueDays = Math.floor((now - dueDate) / 86400000);
      recs.push({
        from: null, to: tray, count: 0, sex: '🤰',
        detail: `${tray.name}: ${tray.gravidFemales} gravid ♀ overdue by ${overdueDays}d (expected birth ${fmtDate(dueDate)}). Check tray.`,
        actionLabel: 'Check tray', noCheckbox: true
      });
    }
  }

  // Pass 5 — adult trays with no sex data entered
  for (const tray of live('trays')) {
    if (tray.adultMales != null || tray.adultFemales != null) continue;
    const sp = speciesOf(tray);
    if (!sp?.stages?.length) continue;
    const lastStage = [...sp.stages].sort((a,b)=>(b.startDay||0)-(a.startDay||0))[0]?.name;
    const hasAdults = live('cohorts').some(c => c.trayId === tray.id && cohortNet(c, now) > 0 && stageIndexAt(c, now).name === lastStage);
    if (!hasAdults) continue;
    recs.push({
      from: null, to: tray, count: 0, sex: '❓',
      detail: `${tray.name} has adults but no sex data entered — open tray details to record ♂/♀ counts.`,
      actionLabel: 'Open tray', noCheckbox: true, trayId: tray.id
    });
  }

  return recs;
}

/* ---------- Apply recommendation ---------- */
function applyRecommendation(el) {
  const fromId = el.dataset.from;
  const toId   = el.dataset.to;
  const count  = Number(el.dataset.count) || 1;
  const sex    = el.dataset.sex; // '♂' or '♀'

  // Find the latest adult cohort in the donor tray with the right sex data
  const now = new Date();
  const donorCohorts = live('cohorts')
    .filter(c => c.trayId === fromId && cohortNet(c, now) > 0)
    .sort((a, b) => (b.updatedAt || '') > (a.updatedAt || '') ? 1 : -1);

  // Accept any adult cohort — sex is now tracked at tray level, not cohort level
  const donor = donorCohorts[0];
  if (!donor) { toast('No live adult cohort found in source tray'); el.checked = false; return; }

  // Create a removal record on the donor cohort
  const remRec = rec('removals', {
    cohortId: donor.id,
    trayId:   fromId,
    date:     toYMD(now),
    stage:    stageIndexAt(donor, now)?.name || '',
    count,
    males:    sex === '♂' ? count : 0,
    females:  sex === '♀' ? count : 0,
    reason:   'Transfer'
  });
  upsertLocal('removals', remRec); touch('removals', remRec);

  // Add to destination tray — find or create an adult cohort
  const destCohorts = live('cohorts')
    .filter(c => c.trayId === toId && cohortNet(c, now) > 0)
    .sort((a, b) => (b.updatedAt || '') > (a.updatedAt || '') ? 1 : -1);

  const sp = byId('species', byId('trays', toId)?.speciesId);
  const lastStage = sp?.stages?.length
    ? [...sp.stages].sort((a, b) => b.startDay - a.startDay)[0].name
    : '';
  const destAdult = destCohorts.find(c => stageIndexAt(c, now)?.name === lastStage);

  // Update tray-level sex counts on source and destination
  const fromTray = byId('trays', fromId);
  if (fromTray) {
    // Initialize from computed sex if not yet explicitly set
    if (fromTray.adultMales == null && fromTray.adultFemales == null) {
      const fromSp = byId('species', fromTray.speciesId);
      const fromSex = trayAdultSex(fromId, fromSp);
      fromTray.adultMales   = fromSex?.males   ?? 0;
      fromTray.adultFemales = fromSex?.females ?? 0;
    }
    if (sex === '♂') fromTray.adultMales   = Math.max(0, (Number(fromTray.adultMales)   || 0) - count);
    else             fromTray.adultFemales  = Math.max(0, (Number(fromTray.adultFemales) || 0) - count);
    touch('trays', fromTray);
  }
  const toTray = byId('trays', toId);

  if (destAdult) {
    if (sex === '♂') destAdult.males   = (Number(destAdult.males)   || 0) + count;
    else              destAdult.females = (Number(destAdult.females) || 0) + count;
    touch('cohorts', destAdult);
  } else {
    // Create a new cohort entry for the transferred animals
    const newC = rec('cohorts', {
      trayId:       toId,
      speciesId:    sp?.id || '',
      birthDate:    toYMD(now),
      initialCount: count,
      males:        sex === '♂' ? count : 0,
      females:      sex === '♀' ? count : 0,
      notes:        `Transfer from ${byId('trays', fromId)?.name || fromId}`,
      type:         'intake'
    });
    upsertLocal('cohorts', newC); touch('cohorts', newC);
  }
  // Update destination tray-level sex counts
  if (toTray) {
    // Initialize from computed sex if not yet explicitly set
    if (toTray.adultMales == null && toTray.adultFemales == null) {
      const toSp = byId('species', toTray.speciesId);
      const toSex = trayAdultSex(toId, toSp);
      toTray.adultMales   = toSex?.males   ?? 0;
      toTray.adultFemales = toSex?.females ?? 0;
    }
    if (sex === '♂') toTray.adultMales   = (Number(toTray.adultMales)   || 0) + count;
    else             toTray.adultFemales  = (Number(toTray.adultFemales) || 0) + count;
    touch('trays', toTray);
  }
  toast(`Transferred ${count}${sex} — tray data updated`);

  // Visually strike through this recommendation row
  const row = el.closest('.rec-row');
  if (row) { row.style.opacity = '0.4'; row.style.pointerEvents = 'none'; }

  // Re-render dashboard after a short delay so state is saved
  setTimeout(renderDashboard, 600);
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
    const noSpecies = !live('species').length;
    const noShelves = !live('shelves').length;
    const noTrays   = !live('trays').length;
    if (noSpecies || noShelves || noTrays) {
      const step1Done = !noSpecies, step2Done = step1Done && !noShelves, step3Done = step2Done && !noTrays;
      el.innerHTML = `
        <h2 class="section-title" style="margin:4px 0 16px">Welcome to RAT-TRACK</h2>
        <div class="card" style="margin-bottom:16px">
          <p class="small" style="margin:0 0 14px;color:var(--muted)">Complete these steps to start tracking your colony:</p>
          <div class="onboarding-steps">
            <div class="onb-step ${step1Done?'done':'active'}">
              <span class="onb-num">${step1Done?'✓':'1'}</span>
              <div class="onb-body">
                <div class="onb-title">Add a species</div>
                <div class="onb-sub">Define stages (Pinky, Fuzzy, Hopper, Adult…), gestation, lifespan</div>
              </div>
              ${!step1Done ? `<button class="btn primary sm" data-act="add-species">Add species</button>` : ''}
            </div>
            <div class="onb-step ${step2Done?'done':step1Done?'active':'locked'}">
              <span class="onb-num">${step2Done?'✓':'2'}</span>
              <div class="onb-body">
                <div class="onb-title">Add a shelf</div>
                <div class="onb-sub">Group trays by shelf / rack location</div>
              </div>
              ${step1Done && !step2Done ? `<button class="btn primary sm" data-act="add-shelf">Add shelf</button>` : ''}
            </div>
            <div class="onb-step ${step3Done?'done':step2Done?'active':'locked'}">
              <span class="onb-num">${step3Done?'✓':'3'}</span>
              <div class="onb-body">
                <div class="onb-title">Add trays &amp; record first litter</div>
                <div class="onb-sub">Go to Trays tab → tap a shelf → Add tray → Born today</div>
              </div>
              ${step2Done && !step3Done ? `<button class="btn sm" onclick="switchTab('trays')">Go to Trays</button>` : ''}
            </div>
          </div>
        </div>`;
      return;
    }
    el.innerHTML = emptyState('🪹','No litters logged yet',
      'Go to the <b>Trays</b> tab and add a litter to a tray to start tracking.');
    return;
  }

  // Stat cards — tappable to open "remove by stage" modal
  const frozen = frozenByStage();
  const stageCards = names.map((nm, i) => {
    const v = totals.get(nm) || 0;
    const m = stageMales.get(nm) || 0;
    const f = stageFemales.get(nm) || 0;
    const fz = frozen.get(nm) || 0;
    const sexLine = (m || f)
      ? `<div class="sex-info"><span>♂ ${m}</span><span>♀ ${f}</span></div>`
      : '';
    const frozenBadge = fz > 0
      ? `<div class="stage-frozen-badge">❄ ${fz} frozen</div>`
      : '';
    return `<div class="stat-stage stat-stage-btn" data-s="${i}"
        data-act="remove-stage" data-stage="${esc(nm)}" data-sidx="${i}"
        role="button" tabindex="0" title="Remove ${esc(nm)}">
      <span class="stage-edge" style="background:${stageColor(i)}"></span>
      <div class="n">${v}</div>
      <div class="l">${esc(nm)}</div>
      ${sexLine}
      ${frozenBadge}
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

  const recs = computeShuffleRecommendations();
  const recsHtml = recs.length ? `
    <div class="rec-section-head">
      <h2 class="section-title" style="margin:0">Recommendations</h2>
      <span class="rec-count-badge">${recs.length}</span>
    </div>
    <div class="rec-rows">
    ${recs.map((r, i) => {
      const sexIcon = r.sex;
      const isTransfer = sexIcon === '♂' || sexIcon === '♀';
      const urgency = sexIcon === '♂' ? 'urgent' : sexIcon === '♀' ? 'moderate' : 'info';
      const urgencyLabel = sexIcon === '♂' ? 'Urgent' : sexIcon === '♀' ? 'Moderate' : sexIcon === '⏰' ? 'Aging' : sexIcon === '🤰' ? 'Overdue' : 'Action';
      if (r.noCheckbox) {
        const actAttr = r.trayId ? `data-act="open-tray-from-rec" data-trayid="${esc(r.trayId)}"` : '';
        return `
        <div class="rec-row ${urgency}">
          <div class="rec-row-body">
            <div class="rec-row-top">
              <span class="rec-pill ${urgency}">${urgencyLabel}</span>
              <span class="rec-row-action">${sexIcon} ${esc(r.to?.name || '')}</span>
            </div>
            <div class="rec-row-detail">${esc(r.detail)}</div>
            ${r.trayId ? `<button class="btn sm" style="margin-top:6px" ${actAttr}>${esc(r.actionLabel||'View')}</button>` : ''}
          </div>
        </div>`;
      }
      return `
      <label class="rec-row ${urgency}" title="Tick to apply — auto-updates tray data">
        <input type="checkbox" class="rec-chk" data-act="rec-done"
          data-from="${esc(r.from?.id||'')}" data-to="${esc(r.to?.id||'')}"
          data-count="${r.count}" data-sex="${esc(r.sex)}" data-idx="${i}" />
        <div class="rec-row-body">
          <div class="rec-row-top">
            <span class="rec-pill ${urgency}">${urgencyLabel}</span>
            <span class="rec-row-action">Move ${r.count}${r.sex}</span>
            <span class="rec-tray">${esc(r.from?.name||'')}</span>
            <span class="rec-arrow">→</span>
            <span class="rec-tray">${esc(r.to?.name||'')}</span>
          </div>
          <div class="rec-row-detail">${esc(r.detail)}</div>
        </div>
      </label>`;
    }).join('')}
    </div>` : '';

  el.innerHTML = `
    <div class="spread">
      <h2 class="section-title" style="margin:4px 0 0">Right now</h2>
      ${filterSel}
    </div>
    <div class="stats-grid mt">${stats}</div>
    <p class="small muted" style="margin-top:8px;text-align:center">Tap a stage card to record a removal</p>
    ${recsHtml}`;

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

function renderPopulationForecast(shelfId = 'all', trayId = 'all', cohortFilterOverride = null) {
  const DAYS = 90, STEP = 2; // sample every 2 days → 46 points
  const today = new Date(); today.setHours(0,0,0,0);

  // Build cohort filter matching current shelf/tray selection
  const trayIds = (() => {
    if (trayId !== 'all') return new Set([trayId]);
    if (shelfId !== 'all') return new Set(live('trays').filter(t => t.shelfId === shelfId).map(t => t.id));
    return null;
  })();
  const cohortFilter = cohortFilterOverride || (c => !trayIds || trayIds.has(c.trayId));

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
    const { totals } = stageTotalsAt(at, cohortFilter, true);
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

  // Population target line (if set and in range)
  if (state.meta.targetCount && state.meta.targetCount <= maxY * 1.5) {
    const ty = +yS(state.meta.targetCount).toFixed(1);
    const clampedTy = Math.max(PT, Math.min(H - PB, ty));
    lines += `<line x1="${PL}" y1="${clampedTy}" x2="${W-PR}" y2="${clampedTy}"
      stroke="#22c55e" stroke-width="1.8" stroke-dasharray="6,4" opacity=".9"/>`;
    lines += `<text x="${W-PR+2}" y="${clampedTy+4}" font-size="9" fill="#22c55e" font-weight="600">Target ${state.meta.targetCount}${state.meta.targetStage?' '+state.meta.targetStage:''}</text>`;
  }

  // Axes
  const axes = `
    <line x1="${PL}" y1="${PT}" x2="${PL}" y2="${H-PB}" stroke="var(--border)" stroke-width="1"/>
    <line x1="${PL}" y1="${H-PB}" x2="${W-PR}" y2="${H-PB}" stroke="var(--border)" stroke-width="1"/>
    <text x="${PL}" y="${PT-3}" font-size="9" fill="var(--text-2)">individuals</text>`;

  // Legend
  const legend = active.map(nm => {
    const color = STAGE_HEX[stageNames.indexOf(nm) % STAGE_HEX.length];
    return `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:20px">
      <span style="font-size:11px;font-weight:600;color:var(--text)">${esc(nm)}</span>
      <svg width="22" height="10" viewBox="0 0 22 10" style="flex-shrink:0">
        <line x1="0" y1="5" x2="22" y2="5" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    </span>`;
  }).join('') + (hasDeaths ? `
    <span style="display:inline-flex;align-items:center;gap:5px;margin-right:20px">
      <span style="font-size:11px;font-weight:600;color:var(--text)">Natural deaths</span>
      <svg width="22" height="10" viewBox="0 0 22 10" style="flex-shrink:0">
        <line x1="0" y1="5" x2="22" y2="5" stroke="#ef4444" stroke-width="2" stroke-dasharray="5,3" stroke-linecap="round"/>
      </svg>
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
      <div style="display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:8px;padding-left:${PL}px">${legend}</div>
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
    const dateStr = fmtDate(dateObj);
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

/* ---------- Remove by stage — 3-step flow ---------- */

// Step 1: ask how many + pick reason
/* Returns HTML for the "cause of death" selector + photo input, shown when reason=Dead */
function deathCauseHtml(hidden = true) {
  const style = hidden ? 'display:none;' : '';
  const causeBtns = DEATH_CAUSES.map((c, i) =>
    `<button type="button" class="reason-btn cause-btn${i === 0 ? ' active' : ''}" data-cause="${c}">${c}</button>`
  ).join('');
  return `
  <div class="field" id="cause-field" style="${style}margin-bottom:12px">
    <span class="small" style="display:block;margin-bottom:6px;font-weight:500">Cause of death</span>
    <div class="reason-btns cause-btns">${causeBtns}</div>
  </div>
  <div class="field" id="photo-field" style="${style}margin-bottom:16px">
    <span class="small" style="display:block;margin-bottom:6px;font-weight:500">Photo (optional)</span>
    <input type="file" id="death-photo" accept="image/*"
      style="width:100%;padding:6px;background:var(--surface);border:1px solid var(--border);
             border-radius:8px;color:var(--text);font-size:13px;cursor:pointer" />
  </div>`;
}

/* Wire cause buttons to stay mutually exclusive within root */
function wireCauseBtns(root) {
  $$('.cause-btn', root).forEach(b => b.onclick = () => {
    $$('.cause-btn', root).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
  });
}

/* Show/hide cause+photo when reason buttons are toggled */
function wireReasonDeathToggle(root) {
  $$('.reason-btn:not(.cause-btn)', root).forEach(b => b.onclick = () => {
    $$('.reason-btn:not(.cause-btn)', root).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const isDead = b.dataset.reason === 'Dead';
    const cf = $('#cause-field', root);
    const pf = $('#photo-field', root);
    if (cf) cf.style.display = isDead ? '' : 'none';
    if (pf) pf.style.display = isDead ? '' : 'none';
  });
}

/* Upload a death photo to Google Drive via Apps Script */
function uploadDeathPhoto(file, trayId, trayName, date, cause) {
  const url = state.meta?.scriptUrl;
  if (!file || !url) return;
  const reader = new FileReader();
  reader.onload = () => {
    const [header, b64] = reader.result.split(',');
    const mimeType = (header.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const safeName = String(trayName || trayId).replace(/[^a-zA-Z0-9_-]/g, '_');
    fetch(url, {
      method: 'POST',
      body: JSON.stringify({
        action: 'uploadImage',
        imageBase64: b64,
        mimeType,
        fileName: safeName + '_' + date,
        cause: (cause || 'Unknown').toLowerCase()
      })
    }).catch(() => {}); // fire-and-forget; failure is non-critical
  };
  reader.readAsDataURL(file);
}

function openRemoveByStage(stageName, stageIdx) {
  const today = new Date();
  const totalAvail = live('cohorts')
    .filter(c => cohortNet(c, today) > 0 && stageIndexAt(c, today).name === stageName)
    .reduce((s, c) => s + cohortNet(c, today), 0);

  if (totalAvail <= 0) return toast(`No active ${stageName} to remove`, true);

  openModal(`Remove ${esc(stageName)}`, `
    <p class="small muted" style="margin-bottom:14px">${totalAvail} ${esc(stageName)} available across all trays.</p>
    <div class="field-row" style="margin-bottom:14px">
      <label class="field" style="flex:1">
        <span>Date</span>
        <input id="rbs-date" type="date" value="${todayISO()}" />
      </label>
      <label class="field" style="flex:1">
        <span>How many to remove?</span>
        <input id="rbs-count" type="number" min="1" max="${totalAvail}" placeholder="e.g. 10" />
      </label>
    </div>
    <div class="field" style="margin-bottom:16px">
      <span class="small" style="display:block;margin-bottom:6px;font-weight:500">Reason for removal</span>
      <div class="reason-btns">
        <button class="reason-btn active" data-reason="Feeding">Feeding</button>
        <button class="reason-btn" data-reason="Frozen">Frozen</button>
      </div>
    </div>
    <button class="btn primary block" id="rbs-next">Find trays ›</button>
  `, root => {
    root.querySelectorAll('.reason-btn').forEach(b => {
      b.onclick = () => { root.querySelectorAll('.reason-btn').forEach(x => x.classList.remove('active')); b.classList.add('active'); };
    });
    $('#rbs-count', root).focus();

    const go = () => {
      const needed = parseInt($('#rbs-count', root).value, 10);
      const reason = $('.reason-btn.active', root)?.dataset.reason || 'Feeding';
      const date   = $('#rbs-date', root).value || todayISO();
      if (!isValidDate(date)) return toast('Invalid date — check year', true);
      if (!needed || needed < 1) return toast('Enter a count', true);
      _rbsShowTrays(stageName, stageIdx, needed, reason, undefined, date);
    };
    $('#rbs-next', root).onclick = go;
    $('#rbs-count', root).addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

// Step 2: harvest-search-style tray grid
function _rbsShowTrays(stageName, stageIdx, needed, reason, cause, date) {
  const today = new Date();
  const isAdult = live('species').some(sp => {
    if (!sp.stages?.length) return false;
    return [...sp.stages].sort((a, b) => (b.startDay||0) - (a.startDay||0))[0]?.name === stageName;
  });

  // Build tray list (same logic as refreshHarvestResults)
  const matches = [];
  for (const tray of live('trays')) {
    let count = 0, oldestDate = null;
    for (const c of live('cohorts')) {
      if (c.trayId !== tray.id) continue;
      const net = cohortNet(c, today);
      if (net <= 0) continue;
      if (stageIndexAt(c, today).name !== stageName) continue;
      count += net;
      const bd = parseYMD(c.birthDate);
      if (!oldestDate || bd < oldestDate) oldestDate = bd;
    }
    if (count <= 0) continue;
    const unavail  = isAdult ? ((tray.gravidFemales || 0) + (tray.lactatingFemales || 0)) : 0;
    const available = Math.max(0, count - unavail);
    matches.push({ tray, count, available, oldestDate });
  }
  matches.sort((a, b) => (a.oldestDate || 0) - (b.oldestDate || 0));

  // Greedy suggestion — oldest trays first
  let remaining = needed;
  const suggested = new Set();
  const takeMap   = new Map();
  for (const m of matches) {
    if (remaining <= 0) break;
    if (m.available <= 0) continue;
    suggested.add(m.tray.id);
    takeMap.set(m.tray.id, Math.min(m.available, remaining));
    remaining -= m.available;
  }
  const total   = matches.reduce((s, m) => s + m.available, 0);
  const canFill = remaining <= 0;

  const btns = matches.map(m => {
    const cls      = suggested.has(m.tray.id) ? 'harvest-btn suggested' : 'harvest-btn';
    const ageDays  = m.oldestDate ? Math.floor((today - m.oldestDate) / 86400000) : null;
    const sp       = live('species').find(s => live('cohorts').some(c => c.trayId === m.tray.id && c.speciesId === s.id));
    const urgent   = sp?.lifespan && ageDays != null && (sp.lifespan - ageDays) <= 30;
    const gravidN  = isAdult && (m.tray.gravidFemales  || 0) > 0
      ? `<span class="hb-status gravid">${m.tray.gravidFemales} gravid</span>` : '';
    const lactN    = isAdult && (m.tray.lactatingFemales || 0) > 0
      ? `<span class="hb-status lact">${m.tray.lactatingFemales} lactating</span>` : '';
    return `<button class="${cls}${urgent ? ' urgent' : ''}"
        data-rbs-tray="${esc(m.tray.id)}"
        data-take="${takeMap.get(m.tray.id) || 0}"
        data-avail="${m.available}" data-total="${m.count}">
      <span class="hb-name">${esc(m.tray.name)}</span>
      ${ageDays != null ? `<span class="hb-age${urgent ? ' hb-age-warn' : ''}">${ageDays}d old</span>` : ''}
      ${gravidN}${lactN}
      <span class="hb-count">${m.available}<span class="hb-total-sm">/${m.count}</span></span>
    </button>`;
  }).join('');

  const statusCls = canFill ? 'harvest-status ok' : 'harvest-status warn';
  const statusMsg = canFill
    ? `&#10003; Can fill ${needed} from ${suggested.size} tray${suggested.size !== 1 ? 's' : ''} &middot; ${total} available`
    : `&#9888; Only ${total} of ${needed} available across all trays`;

  openModal(`Remove ${esc(stageName)} — pick a tray`, `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      <span class="small muted">Removing <b>${needed} ${esc(stageName)}</b> &middot; reason: <b>${esc(reason)}</b> &middot; <b>${date || todayISO()}</b></span>
      <button class="btn sm" id="rbs-back" style="margin-left:auto">&#8592; Back</button>
    </div>
    <div class="harvest-btns">${btns}</div>
    <div class="${statusCls}" style="margin-top:10px">${statusMsg}</div>
  `, root => {
    $('#rbs-back', root).onclick = () => openRemoveByStage(stageName, stageIdx);

    $$('[data-rbs-tray]', root).forEach(btn => {
      btn.onclick = () => _rbsFromTray(
        stageName, stageIdx,
        btn.dataset.rbsTray,
        needed,
        Number(btn.dataset.avail),
        Number(btn.dataset.take),
        reason,
        isAdult,
        cause,
        date
      );
    });
  });
}

// Step 3: confirm count from one tray (+ optional sex split)
function _rbsFromTray(stageName, stageIdx, trayId, needed, avail, suggestTake, reason, isAdult, cause, date) {
  const tray      = byId('trays', trayId);
  const trayName  = tray ? tray.name : trayId;
  const today     = new Date();
  const defCount  = Math.max(1, Math.min(suggestTake || needed, avail));

  const causeLabel = reason === 'Dead' ? ` · ${cause || 'Unknown'}` : '';
  openModal(`Remove from ${esc(trayName)}`, `
    <p class="small muted" style="margin-bottom:14px">
      ${avail} ${esc(stageName)} available &middot; need ${needed} total &middot; <b>${esc(reason)}${esc(causeLabel)}</b>
    </p>
    <label class="field" style="margin-bottom:${isAdult ? '10px' : '16px'}">
      <span>How many from this tray?</span>
      <input id="rbst-count" type="number" min="1" max="${avail}" value="${defCount}" />
    </label>
    ${isAdult ? `
    <div class="gap" style="margin-bottom:16px">
      <label class="field" style="flex:1"><span>&#9794; removed</span>
        <input id="rbst-m" type="number" min="0" placeholder="—" /></label>
      <label class="field" style="flex:1"><span>&#9792; removed</span>
        <input id="rbst-f" type="number" min="0" placeholder="—" /></label>
    </div>` : ''}
    ${reason === 'Dead' ? `<div class="field" style="margin-bottom:16px">
      <span class="small" style="display:block;margin-bottom:6px;font-weight:500">Photo (optional)</span>
      <input type="file" id="rbst-photo" accept="image/*"
        style="width:100%;padding:6px;background:var(--surface);border:1px solid var(--border);
               border-radius:8px;color:var(--text);font-size:13px;cursor:pointer" />
    </div>` : ''}
    <div class="gap">
      <button class="btn" id="rbst-back">&#8592; Pick another tray</button>
      <button class="btn primary" id="rbst-save" style="flex:1">Confirm removal</button>
    </div>
  `, root => {
    $('#rbst-count', root).focus();
    $('#rbst-back', root).onclick = () => _rbsShowTrays(stageName, stageIdx, needed, reason, cause, date);

    $('#rbst-save', root).onclick = () => {
      const n = parseInt($('#rbst-count', root).value, 10);
      if (!n || n < 1)  return toast('Enter a count', true);
      if (n > avail)    return toast(`Max ${avail} available in this tray`, true);

      const mRaw = $('#rbst-m', root)?.value;
      const fRaw = $('#rbst-f', root)?.value;
      const males   = isAdult && mRaw !== '' && mRaw != null ? Number(mRaw) : null;
      const females = isAdult && fRaw !== '' && fRaw != null ? Number(fRaw) : null;
      const photoFile = reason === 'Dead' ? ($('#rbst-photo', root)?.files?.[0] || null) : null;

      // Distribute n across cohorts in this tray, oldest first
      const cohorts = live('cohorts')
        .filter(c => c.trayId === trayId && cohortNet(c, today) > 0 && stageIndexAt(c, today).name === stageName)
        .sort((a, b) => parseYMD(a.birthDate) - parseYMD(b.birthDate));

      let left = n, first = true;
      for (const c of cohorts) {
        if (left <= 0) break;
        const take = Math.min(left, cohortNet(c, today));
        const r = rec('removals', {
          cohortId: c.id, trayId,
          date: date || todayISO(), stage: stageName, count: take,
          males:   first ? males   : null,
          females: first ? females : null,
          reason, cause
        });
        upsertLocal('removals', r);
        touch('removals', r);
        left -= take;
        first = false;
      }

      closeModal();
      render();
      if (photoFile) uploadDeathPhoto(photoFile, trayId, trayName, normYMD(date || todayISO()), cause);
      toast(`${n} ${stageName} removed from ${trayName} · ${reason}${causeLabel}`);
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

/* ---------- Use frozen modal ---------- */
function useFrozenModal(stage) {
  const available = frozenByStage().get(stage) || 0;
  openModal(`Use frozen · ${esc(stage)}`, `
    <p class="small muted" style="margin-bottom:14px">${available} frozen available.</p>
    <label class="field"><span>Count to use</span>
      <input id="frozen-use-count" type="number" min="1" max="${available}" placeholder="1" /></label>
    <button class="btn primary block" style="margin-top:14px" data-save>Confirm</button>
  `, root => {
    $('#frozen-use-count', root).focus();
    $('[data-save]', root).onclick = () => {
      const n = Number($('#frozen-use-count', root).value);
      if (!n || n < 1) return toast('Enter a count', true);
      if (n > available) return toast(`Only ${available} frozen available`, true);
      // find a speciesId from any matching frozen removal
      const spId = live('removals').find(r => r.reason === 'Frozen' && r.stage === stage)
        ? byId('cohorts', live('removals').find(r => r.reason === 'Frozen' && r.stage === stage)?.cohortId)?.speciesId || null
        : null;
      const r = rec('frozen_uses', { speciesId: spId, stage, date: todayISO(), count: n });
      upsertLocal('frozen_uses', r); touch('frozen_uses', r);
      toast(`Used ${n} frozen ${stage}`);
      closeModal(); render();
    };
  });
}

/* ---------- Add to freezer modal (from Freezer tab — picks tray + stage) ---------- */
function addToFreezerModal() {
  const today = new Date();

  // Sex counts for a specific stage in a tray (like trayAdultSex but stage-generic)
  function stageSex(trayId, stage) {
    let males = 0, females = 0, tracked = false;
    for (const c of live('cohorts')) {
      if (c.trayId !== trayId || cohortNet(c) <= 0) continue;
      if (stageIndexAt(c, today).name !== stage) continue;
      if (c.males == null && c.females == null) continue;
      tracked = true;
      const rems = live('removals').filter(r => r.cohortId === c.id);
      const remM = rems.reduce((s, r) => s + (Number(r.males) || 0), 0);
      const remF = rems.reduce((s, r) => s + (Number(r.females) || 0), 0);
      males   += Math.max(0, (Number(c.males) || 0) - remM);
      females += Math.max(0, (Number(c.females) || 0) - remF);
    }
    return tracked ? { males, females } : null;
  }

  // Is this the last (adult) stage for the species in this tray?
  function isAdultStage(trayId, stage) {
    const c = live('cohorts').find(t => t.trayId === trayId && cohortNet(t) > 0);
    if (!c) return false;
    const sp = byId('species', c.speciesId);
    if (!sp?.stages?.length) return false;
    const last = [...sp.stages].sort((a, b) => (b.startDay || 0) - (a.startDay || 0))[0];
    return last?.name === stage;
  }

  function getMatches(stage, sex) {
    const map = new Map();
    live('cohorts').filter(c => cohortNet(c) > 0).forEach(c => {
      const tray = live('trays').find(t => t.id === c.trayId);
      if (!tray) return;
      if (stageIndexAt(c, today).name !== stage) return;
      const net = cohortNet(c);
      const bd  = parseYMD(c.birthDate);
      if (!map.has(tray.id)) map.set(tray.id, { tray, count: 0, oldestDate: null });
      const entry = map.get(tray.id);
      entry.count += net;
      if (!entry.oldestDate || bd < entry.oldestDate) entry.oldestDate = bd;
    });

    const results = [];
    for (const [trayId, entry] of map) {
      const adult     = isAdultStage(trayId, stage);
      const gravid    = adult ? (entry.tray.gravidFemales    || 0) : 0;
      const lactating = adult ? (entry.tray.lactatingFemales || 0) : 0;
      const sexData   = stageSex(trayId, stage);

      let available;
      if (sex === 'Male') {
        available = sexData ? sexData.males : entry.count;
      } else if (sex === 'Female') {
        const femTotal = sexData ? sexData.females : entry.count;
        available = Math.max(0, femTotal - gravid - lactating);
      } else {
        available = Math.max(0, entry.count - gravid - lactating);
      }

      if (available <= 0) continue;
      results.push({ tray: entry.tray, count: available, totalCount: entry.count,
                     oldestDate: entry.oldestDate, gravid, lactating, sexData });
    }
    return results.sort((a, b) => (a.oldestDate || 0) - (b.oldestDate || 0));
  }

  const allStages = orderedStageNames().filter(s =>
    live('cohorts').some(c => cohortNet(c) > 0 && stageIndexAt(c, today).name === s)
  );
  if (!allStages.length) return toast('No trays with live animals', true);

  const stageOpts = allStages.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

  openModal('Freeze from Tray', `
    <div class="reason-btns fz-sex-row">
      <button class="reason-btn" data-sex="Male">♂ Male</button>
      <button class="reason-btn active" data-sex="Both">Both</button>
      <button class="reason-btn" data-sex="Female">♀ Female</button>
    </div>
    <div class="fz-search-row">
      <select id="fz-stage">${stageOpts}</select>
      <input id="fz-count" type="number" min="1" placeholder="How many?" />
    </div>
    <div id="fz-results"></div>
  `, root => {
    let selectedSex = 'Both';

    root.querySelectorAll('[data-sex]').forEach(btn => {
      btn.onclick = () => {
        root.querySelectorAll('[data-sex]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedSex = btn.dataset.sex;
        refresh();
      };
    });

    function refresh() {
      const stage   = $('#fz-stage', root).value;
      const needed  = parseInt($('#fz-count', root).value, 10);
      const outEl   = $('#fz-results', root);
      const matches = getMatches(stage, selectedSex);

      if (!matches.length) {
        const sexNote = selectedSex !== 'Both' ? ` (${selectedSex})` : '';
        outEl.innerHTML = `<p class="harvest-none">No ${esc(stage)}${sexNote} available to freeze.</p>`;
        return;
      }

      const total    = matches.reduce((s, m) => s + m.count, 0);
      const countSet = !isNaN(needed) && needed >= 1;

      const suggested = new Set();
      if (countSet) {
        let rem = needed;
        for (const m of matches) {
          if (rem <= 0) break;
          suggested.add(m.tray.id);
          rem -= m.count;
        }
      }

      const btns = matches.map(m => {
        const cls       = suggested.has(m.tray.id) ? 'harvest-btn suggested' : 'harvest-btn';
        const ageDays   = m.oldestDate ? Math.floor((today - m.oldestDate) / 86400000) : null;
        const gravidNote  = m.gravid    > 0 ? `<span class="hb-status gravid">${m.gravid} gravid</span>`      : '';
        const lactNote    = m.lactating > 0 ? `<span class="hb-status lact">${m.lactating} lactating</span>` : '';
        const sexIcon   = selectedSex === 'Male' ? '♂ ' : selectedSex === 'Female' ? '♀ ' : '';
        return `<button class="${cls}" data-tray-id="${m.tray.id}">
          <span class="hb-name">${esc(m.tray.name)}</span>
          ${ageDays != null ? `<span class="hb-age">${ageDays}d old</span>` : ''}
          ${gravidNote}${lactNote}
          <span class="hb-count">${sexIcon}${m.count}<span class="hb-total-sm"> alive</span></span>
        </button>`;
      }).join('');

      let statusHtml = '';
      if (countSet) {
        const canFill   = total >= needed;
        const statusCls = canFill ? 'harvest-status ok' : 'harvest-status warn';
        const statusMsg = canFill
          ? `✓ Can freeze ${needed} from ${suggested.size} tray${suggested.size !== 1 ? 's' : ''} (${total} total available)`
          : `⚠ Only ${total} of ${needed} available across all trays`;
        statusHtml = `<div class="${statusCls}" style="margin-top:8px">${statusMsg}</div>`;
      }

      outEl.innerHTML = `<div class="harvest-btns">${btns}</div>${statusHtml}`;

      outEl.querySelectorAll('[data-tray-id]').forEach(btn => {
        btn.onclick = () => {
          const n = parseInt($('#fz-count', root).value, 10);
          if (!n || n < 1) return toast('Enter a count first', true);
          const trayId = btn.dataset.trayId;
          const match  = matches.find(m => m.tray.id === trayId);
          if (!match) return;
          if (n > match.count) return toast(`Only ${match.count} available in ${match.tray.name}`, true);
          const matchCohort = live('cohorts')
            .filter(c => c.trayId === trayId && cohortNet(c) > 0 && stageIndexAt(c, today).name === stage)[0];
          const males   = selectedSex === 'Male'   ? n : selectedSex === 'Female' ? 0   : null;
          const females = selectedSex === 'Female' ? n : selectedSex === 'Male'   ? 0   : null;
          const r = rec('removals', { cohortId: matchCohort?.id || '', trayId, date: todayISO(),
            stage, count: n, males, females, reason: 'Frozen' });
          upsertLocal('removals', r); touch('removals', r);
          const sexStr = selectedSex !== 'Both' ? ` ${selectedSex}` : '';
          toast(`❄ Frozen ${n}${sexStr} ${stage} from ${match.tray.name}`);
          closeModal(); render();
        };
      });
    }

    $('#fz-stage', root).onchange = refresh;
    $('#fz-count', root).oninput  = refresh;
    refresh();
  });
}

/* ---------- Freezer tab ---------- */
function renderFreezer() {
  const el = $('#tab-freezer');
  const frozen = frozenByStage();
  const names = orderedStageNames();

  // Show all stages that have frozen stock, plus any stage with live animals (so you can pre-freeze)
  const stagesWithStock = new Set([...frozen.keys()]);
  names.forEach(nm => stagesWithStock.add(nm));
  const stageList = [...stagesWithStock];

  const total = totalFrozen();

  let cards = '';
  for (const nm of stageList) {
    const count = frozen.get(nm) || 0;
    const i = names.indexOf(nm);
    const color = stageColor(i >= 0 ? i : 0);
    cards += `<div class="freezer-card">
      <span class="freezer-card-edge" style="background:${color}"></span>
      <div class="freezer-card-body">
        <div class="freezer-stage">${esc(nm)}</div>
        <div class="freezer-count">${count}</div>
        <div class="freezer-label">in freezer</div>
      </div>
      <div class="freezer-card-actions">
        <button class="btn sm primary" data-act="fz-use" data-stage="${esc(nm)}"
          ${count < 1 ? 'disabled' : ''}>Use</button>
      </div>
    </div>`;
  }

  if (!stageList.length) {
    el.innerHTML = emptyState('❄', 'Freezer is empty', 'Remove animals from a tray with reason <b>Frozen</b> to add them here.');
    return;
  }

  el.innerHTML = `
    <div class="spread">
      <h2 class="section-title" style="margin:4px 0 0">Freezer</h2>
      <button class="btn sm primary" data-act="fz-add">+ Add</button>
    </div>
    <p class="small muted" style="margin:4px 0 14px">${total} individual${total !== 1 ? 's' : ''} in stock</p>
    <div class="freezer-grid">${cards}</div>
    <p class="small muted" style="margin-top:14px;text-align:center">
      Tap <b>Use</b> to record feeding from the freezer.<br>
      To freeze from a specific tray, use Remove → Frozen inside that tray.
    </p>`;
}

/* ---------- Quick removal from tray card ---------- */
function quickTrayRemoval(trayId) {
  const tray = byId('trays', trayId);
  if (!tray) return;
  const today = new Date();
  const sp = speciesOf(tray);
  const lastStageName = sp?.stages?.length
    ? [...sp.stages].sort((a, b) => b.startDay - a.startDay)[0].name : null;

  const cohorts = live('cohorts').filter(c => c.trayId === trayId && cohortNet(c, today) > 0);
  const stageMap = new Map();
  for (const c of cohorts) {
    const { name } = stageIndexAt(c, today);
    if (name === lastStageName) continue; // adult stage handled via sex tally
    stageMap.set(name, (stageMap.get(name) || 0) + cohortNet(c, today));
  }
  // Adult count from sex tally (authoritative) or cohort fallback
  const adultRemCount = trayAdultCount(tray, sp);
  if (adultRemCount > 0 && lastStageName) stageMap.set(lastStageName, adultRemCount);
  if (!stageMap.size) return toast('No live animals in this tray', true);

  const stageOpts = [...stageMap.entries()]
    .map(([nm, cnt]) => `<option value="${esc(nm)}">${esc(nm)} (${cnt} available)</option>`)
    .join('');

  const sexRowHtml = lastStageName ? `
    <div id="qtr-sex-row" style="display:none;margin-bottom:14px">
      <p class="small" style="margin:0 0 8px;font-weight:500;color:var(--accent)">Which sex are you removing? (adults only)</p>
      <div style="display:flex;gap:12px">
        <label class="gravid-field" style="flex:1"><span>♂ Males</span>
          <input id="qtr-sex-m" type="number" min="0" placeholder="0" /></label>
        <label class="gravid-field" style="flex:1"><span>♀ Females</span>
          <input id="qtr-sex-f" type="number" min="0" placeholder="0" /></label>
      </div>
      <div class="small muted" style="margin-top:4px">♂ + ♀ must equal the count above</div>
    </div>` : '';

  openModal(`Record removal — ${esc(tray.name)}`, `
    <div class="field-row" style="margin-bottom:14px">
      <label class="field" style="flex:1">
        <span>Date</span>
        <input id="qtr-date" type="date" value="${todayISO()}" />
      </label>
      <label class="field" style="flex:1">
        <span>Stage</span>
        <select id="qtr-stage">${stageOpts}</select>
      </label>
    </div>
    <label class="field" style="margin-bottom:14px">
      <span>How many?</span>
      <input id="qtr-count" type="number" min="1" placeholder="e.g. 3" />
    </label>
    ${sexRowHtml}
    <div class="field" style="margin-bottom:12px">
      <span class="small" style="display:block;margin-bottom:6px;font-weight:500">Reason</span>
      <div class="reason-btns">
        <button class="reason-btn active" data-reason="Feeding">Feeding</button>
        <button class="reason-btn" data-reason="Frozen">Frozen</button>
        <button class="reason-btn" data-reason="Dead">Dead</button>
        <button class="reason-btn" data-reason="Other">Other</button>
      </div>
    </div>
    ${deathCauseHtml(true)}
    <button class="btn primary block" id="qtr-save">Confirm removal</button>
  `, root => {
    wireReasonDeathToggle(root);
    wireCauseBtns(root);
    $('#qtr-count', root).focus();

    const stageEl = $('#qtr-stage', root);
    const sexRow  = $('#qtr-sex-row', root);
    const toggleSexRow = () => {
      if (sexRow) sexRow.style.display = stageEl.value === lastStageName ? '' : 'none';
    };
    if (stageEl) { stageEl.addEventListener('change', toggleSexRow); toggleSexRow(); }

    $('#qtr-save', root).onclick = () => {
      const stageName = stageEl?.value || '';
      const n = parseInt($('#qtr-count', root).value, 10);
      const reason = $('.reason-btn:not(.cause-btn).active', root)?.dataset.reason || 'Dead';
      const cause  = reason === 'Dead' ? ($('.cause-btn.active', root)?.dataset.cause || 'Unknown') : undefined;
      const photoFile = reason === 'Dead' ? ($('#death-photo', root)?.files?.[0] || null) : null;
      const qDate = $('#qtr-date', root).value || todayISO();
      if (!isValidDate(qDate)) return toast('Invalid date — check year', true);
      const avail = stageMap.get(stageName) || 0;
      if (!n || n < 1) return toast('Enter a count', true);
      if (n > avail) return toast(`Only ${avail} available in this stage`, true);

      const isAdultRem = stageName === lastStageName;
      let sexMales = null, sexFemales = null;
      if (isAdultRem && sexRow) {
        const mVal = $('#qtr-sex-m', root)?.value;
        const fVal = $('#qtr-sex-f', root)?.value;
        sexMales   = mVal !== '' && mVal != null ? Number(mVal) : null;
        sexFemales = fVal !== '' && fVal != null ? Number(fVal) : null;
        if (sexMales !== null && sexFemales !== null && sexMales + sexFemales !== n)
          return toast(`♂ + ♀ (${sexMales + sexFemales}) must equal count (${n})`, true);
      }

      const matchCohorts = live('cohorts')
        .filter(c => c.trayId === trayId && cohortNet(c, today) > 0 && stageIndexAt(c, today).name === stageName)
        .sort((a, b) => parseYMD(a.birthDate) - parseYMD(b.birthDate));

      let left = n;
      for (const c of matchCohorts) {
        if (left <= 0) break;
        const take = Math.min(left, cohortNet(c, today));
        const r = rec('removals', { cohortId: c.id, trayId, date: qDate, stage: stageName, count: take,
          males: isAdultRem ? (sexMales ?? 0) : undefined,
          females: isAdultRem ? (sexFemales ?? 0) : undefined,
          reason, cause });
        upsertLocal('removals', r);
        touch('removals', r);
        left -= take;
      }

      // Update tray sex counts for adult removals
      if (isAdultRem && (sexMales !== null || sexFemales !== null)) {
        if (sexMales !== null) tray.adultMales = Math.max(0, (Number(tray.adultMales) || 0) - sexMales);
        if (sexFemales !== null) tray.adultFemales = Math.max(0, (Number(tray.adultFemales) || 0) - sexFemales);
        touch('trays', tray);
      }

      closeModal();
      render();
      if (photoFile) uploadDeathPhoto(photoFile, trayId, tray.name, normYMD(qDate), cause);
      toast(`${n} ${stageName} removed from ${esc(tray.name)} · ${reason}${cause ? ' · ' + cause : ''}`);
    };
  });
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
        <span class="harvest-label">Find &amp; Harvest</span>
      </div>
      <input id="tray-search" type="search" placeholder="Search tray by name (e.g. D-30)…"
        style="width:100%;margin-bottom:10px;padding:8px 10px;background:var(--surface-2,#242424);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;outline:none" />
      <div id="tray-search-results"></div>
      <hr class="hr" style="margin:10px 0" />
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
    const stock = frozenStock();
    if (stock.length) {
      html += `<div class="frozen-section">
        <h3 class="frozen-section-title">❄ Frozen Stock</h3>
        ${stock.map(({ sp, count }) => `
          <div class="frozen-card">
            <div class="frozen-card-info">
              <span class="frozen-species">${sp ? esc(sp.name) : 'Unknown'}</span>
              <span class="frozen-count">${count} frozen</span>
            </div>
            <button class="btn sm" data-act="use-frozen" data-spid="${sp?.id||''}">Use</button>
          </div>`).join('')}
      </div>`;
    }
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
      const lastStageName = sp?.stages?.length
        ? [...sp.stages].sort((a, b) => (b.startDay||0) - (a.startDay||0))[0]?.name : null;
      let total = 0;
      const stageCounts = new Map();
      for (const c of cohorts) {
        const net = cohortNet(c);
        if (net <= 0) continue;
        const { name } = stageIndexAt(c);
        if (name === lastStageName) continue; // adult stage handled below via sex tally
        total += net;
        stageCounts.set(name, (stageCounts.get(name)||0) + net);
      }
      // Adult count authoritative source: sex tally if set, else cohort fallback
      const adultTileCount = trayAdultCount(tray, sp);
      if (adultTileCount > 0 && lastStageName) {
        total += adultTileCount;
        stageCounts.set(lastStageName, adultTileCount);
      }
      let barSegs = '';
      names.forEach((nm,i) => {
        const v = stageCounts.get(nm) || 0;
        if (v > 0) barSegs += `<span style="flex:${v};background:${stageColor(i)}"></span>`;
      });
      const sex = trayAdultSex(tray.id, sp);
      const ratioDot = (() => {
        if (!sp) return '';
        const st = sex ? ratioStatus(sex.males, sex.females, sp.ratio) : null;
        if (st === null) return '<span class="ratio-dot ok" title="Sex ratio: no data yet"></span>';
        if (st === 'ok')    return `<span class="ratio-dot ok"    title="Sex ratio OK ♂${sex.males}:♀${sex.females}"></span>`;
        if (st === 'close') return `<span class="ratio-dot close" title="Sex ratio close ♂${sex.males}:♀${sex.females}"></span>`;
        return `<span class="ratio-dot off" title="Sex ratio off ♂${sex.males}:♀${sex.females}"></span>`;
      })();
      const gravid    = tray.gravidFemales    || 0;
      const lactating = tray.lactatingFemales || 0;
      const reproRow  = (gravid || lactating) ? `
        <div class="tray-repro-row">
          ${gravid    ? `<span class="repro-badge gravid"    title="Gravid females">${gravid}</span>`    : ''}
          ${lactating ? `<span class="repro-badge lactating" title="Lactating females">${lactating}</span>` : ''}
        </div>` : '';
      const sexBadge = sex
        ? `<span class="sex-badge" title="Adult sex breakdown">♂${sex.males} ♀${sex.females}</span>`
        : '';
      const birthBadge = (() => {
        if (!tray.gravidSince || !sp?.gestation || !tray.gravidFemales) return '';
        const d = new Date(tray.gravidSince);
        d.setDate(d.getDate() + sp.gestation);
        const dl = Math.round((d - new Date()) / 86400000);
        if (dl > 14) return '';
        if (dl > 0)  return `<span class="birth-tile-badge">🐣 in ${dl}d</span>`;
        return `<span class="birth-tile-badge birth-tile-due">🐣 due!</span>`;
      })();
      html += `<div class="tray" data-act="open-tray" data-id="${tray.id}">
        <div class="tray-top">
          <div class="tray-top-left">
            <span class="tray-name">${esc(tray.name)}</span>
            <span class="tray-species">${sp ? esc(sp.name) : '—'}</span>
          </div>
          <div class="tray-top-right">
            ${birthBadge}
            ${ratioDot}
            <span class="tray-chevron">›</span>
          </div>
        </div>
        <div class="tray-body-row">
          <div class="tray-total">${total} <small>alive</small></div>
          ${sexBadge}
          ${reproRow}
        </div>
        <div class="stagebar">${barSegs || '<span style="flex:1"></span>'}</div>
      </div>`;
    }
    html += `</div>`;
  }

  el.innerHTML = html;

  // Wire tray quick-search
  const traySearchEl = $('#tray-search', el);
  if (traySearchEl) {
    traySearchEl.addEventListener('input', () => {
      const q = traySearchEl.value.trim().toLowerCase();
      const resultsEl = $('#tray-search-results', el);
      if (!resultsEl) return;
      if (!q) { resultsEl.innerHTML = ''; return; }
      const today = new Date();
      const matches = live('trays').filter(t => t.name.toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) { resultsEl.innerHTML = `<p class="small muted" style="margin:4px 0">No trays match "${esc(q)}"</p>`; return; }
      const btns = matches.map(t => {
        const alive = live('cohorts').filter(c=>c.trayId===t.id).reduce((s,c)=>s+cohortNet(c,today),0);
        return `<button class="harvest-btn" data-act="open-tray" data-id="${esc(t.id)}">
          <span class="hb-name">${esc(t.name)}</span>
          <span class="hb-count">${alive}</span>
        </button>`;
      }).join('');
      resultsEl.innerHTML = `<div class="harvest-btns tray-search-grid">${btns}</div>`;
    });
  }

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
  const add = (date, ev) => { const k=ymdToInput(normYMD(date)); (map[k]=map[k]||[]).push(ev); };
  for (const c of live('cohorts')) {
    const tray = byId('trays', c.trayId);
    const sexParts = [];
    if (c.males != null)   sexParts.push('♂' + c.males);
    if (c.females != null) sexParts.push('♀' + c.females);
    const sexStr = sexParts.length ? ' · ' + sexParts.join(' ') : '';
    // Legacy: records without type — treat as intake if notes starts with 'Intake'
    const isBirth  = !c.type ? !String(c.notes||'').startsWith('Intake') : c.type === 'birth';
    if (isBirth) {
      add(c.birthDate, {
        type:  'birth',
        count: Number(c.initialCount) || 0,
        label: `${c.initialCount} pinkies born`,
        sub:   `${tray?.name || '—'}${sexStr}`,
        color: 'var(--ok)'
      });
    } else {
      // Intake — use birthDate (intake date) same as births use it
      const intakeDate = c.birthDate;
      const stageName = String(c.notes||'').replace('Intake · ','') || 'animal';
      add(intakeDate, {
        type:  'intake',
        count: Number(c.initialCount) || 0,
        label: `${c.initialCount} ${stageName.toLowerCase()}${c.initialCount !== 1 ? 's' : ''} added`,
        sub:   `${tray?.name || '—'}${sexStr}`,
        color: '#60a5fa'
      });
    }
  }
  for (const tray of live('trays')) {
    if (!tray.gravidSince || !tray.gravidFemales) continue;
    const sp = speciesOf(tray);
    if (!sp?.gestation) continue;
    const d = new Date(tray.gravidSince);
    d.setDate(d.getDate() + sp.gestation);
    add(toYMD(d), {
      type: 'predicted-birth',
      label: `${tray.gravidFemales} expected pinkies`,
      sub:   `${tray.name} · ${sp.name} · gestation ${sp.gestation}d`,
      color: '#a78bfa'
    });
  }

  for (const r of live('removals')) {
    const tray = byId('trays', r.trayId);
    const stageStr = r.stage ? r.stage.toLowerCase() + (r.count !== 1 ? 's' : '') : 'animal' + (r.count !== 1 ? 's' : '');
    const sexParts = [];
    if (r.males != null && r.males !== '') sexParts.push('♂' + r.males);
    if (r.females != null && r.females !== '') sexParts.push('♀' + r.females);
    const sexStr = sexParts.length ? ' · ' + sexParts.join(' ') : '';
    const trayName = tray?.name || r.trayId || '—';
    if (r.reason === 'Dead') {
      const namedCause = DEATH_CAUSES.includes(r.cause) ? r.cause : null;
      const causeStr = namedCause && namedCause !== 'Unknown' ? ` · ${namedCause}` : '';
      add(r.date, {
        type:  'death',
        count: Number(r.count) || 0,
        label: `${r.count} ${stageStr} died${causeStr}`,
        sub:   `${trayName}${sexStr}`,
        color: '#dc2626'
      });
    } else {
      add(r.date, {
        type:  'removal',
        count: Number(r.count) || 0,
        label: `${r.count} ${stageStr} ${r.reason === 'Transfer' ? 'transferred' : r.reason === 'Sold' ? 'sold' : 'removed'}${sexStr}`,
        sub:   `${trayName}`,
        color: '#f97316'
      });
    }
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
    const DOT_COLOR = { birth: 'var(--ok)', 'predicted-birth': '#a78bfa', removal: '#f97316', intake: '#60a5fa', death: '#dc2626' };
    const dots = dotTypes.map(t =>
      `<span class="cal-dot" style="background:${DOT_COLOR[t]||'var(--accent)'}"></span>`
    ).join('');

    cells += `<div class="cal-cell ${isToday?'today':''} ${isSel?'selected':''} ${evs.length?'has-ev':''}"
      data-act="cal-select" data-date="${dateStr}">
      <span class="cal-num">${d}</span>
      <div class="cal-dots">${dots}</div>
    </div>`;
  }

  // Selected day detail
  const selEvs = evMap[calSelected] || [];
  const fmtSel = calSelected; // already yyyy-mm-dd
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

  // Legend — count animals, not events
  const allEvs = Object.values(evMap).flat();
  const totalBirths    = allEvs.filter(e=>e.type==='birth').reduce((s,e)=>s+(e.count||0),0);
  const totalIntakes   = allEvs.filter(e=>e.type==='intake').reduce((s,e)=>s+(e.count||0),0);
  const totalDeaths    = allEvs.filter(e=>e.type==='death').reduce((s,e)=>s+(e.count||0),0);
  const totalRemovals  = allEvs.filter(e=>e.type==='removal').reduce((s,e)=>s+(e.count||0),0);
  const totalPredicted = allEvs.filter(e=>e.type==='predicted-birth').length;

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
      <span class="lg"><span class="sw" style="background:var(--ok)"></span>Births (${totalBirths})</span>
      ${totalIntakes > 0 ? `<span class="lg"><span class="sw" style="background:#60a5fa"></span>Intake (${totalIntakes})</span>` : ''}
      ${totalDeaths > 0 ? `<span class="lg"><span class="sw" style="background:#dc2626"></span>Deaths (${totalDeaths})</span>` : ''}
      ${totalRemovals > 0 ? `<span class="lg"><span class="sw" style="background:#f97316"></span>Removed (${totalRemovals})</span>` : ''}
      ${totalPredicted > 0 ? `<span class="lg"><span class="sw" style="background:#a78bfa"></span>Expected birth (${totalPredicted})</span>` : ''}
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
      <div class="sp-meta-row">
        ${sp.gestation ? `<span class="sp-meta-chip">Gestation: ${sp.gestation}d</span>` : ''}
        ${sp.lifespan  ? `<span class="sp-meta-chip">Lifespan: ${sp.lifespan}d</span>` : ''}
        ${sp.ratio     ? `<span class="sp-meta-chip">Ratio: ♂${sp.ratio.males}:♀${sp.ratio.females}</span>` : ''}
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

/* ---------- Settings ---------- */
function exportCSV(entity) {
  const rows = live(entity);
  if (!rows.length) return toast(`No ${entity} to export`, true);
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(k => k !== 'deleted');
  const escape = v => (v == null ? '' : String(v).includes(',') || String(v).includes('"') ? `"${String(v).replace(/"/g,'""')}"` : String(v));
  const csv = [keys.join(','), ...rows.map(r => keys.map(k => escape(r[k])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${entity}-${todayISO()}.csv`;
  a.click(); URL.revokeObjectURL(a.href);
}

function renderRecentlyDeleted() {
  const cutoff = Date.now() - 30 * 86400000;
  const deleted = [];
  for (const e of ENTITIES) {
    for (const r of state[e]) {
      if (r.deleted && (r.updatedAt || 0) >= cutoff) deleted.push({ entity: e, record: r });
    }
  }
  if (!deleted.length) return toast('No recently deleted records (within 30 days)', true);
  const rows = deleted.sort((a,b) => (b.record.updatedAt||0) - (a.record.updatedAt||0)).slice(0,20).map(({entity, record}) => {
    const label = record.name || record.id;
    const ts = record.updatedAt ? new Date(record.updatedAt).toLocaleDateString() : '—';
    return `<div class="deleted-row">
      <div><span class="deleted-entity">${entity}</span> <span class="deleted-label">${esc(label)}</span></div>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="small muted">${ts}</span>
        <button class="btn sm" data-act="restore-record" data-entity="${esc(entity)}" data-id="${esc(record.id)}">Restore</button>
      </div>
    </div>`;
  }).join('');
  openModal('Recently deleted', `
    <p class="small muted" style="margin-bottom:12px">Records deleted within the last 30 days. Restoring re-adds them to the live app.</p>
    <div class="deleted-list">${rows}</div>
  `);
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return toast('Notifications not supported in this browser', true);
  Notification.requestPermission().then(p => {
    state.meta.notificationsGranted = p === 'granted';
    saveState();
    if (p === 'granted') toast('Notifications enabled');
    else if (p === 'denied') toast('Notifications blocked — enable in browser settings', true);
    else toast('Notification permission dismissed');
    renderSettings();
  });
}

function checkDueNotifications() {
  if (!state.meta.notificationsGranted || Notification.permission !== 'granted') return;
  const today = new Date();
  for (const tray of live('trays')) {
    if (!tray.gravidSince || !tray.gravidFemales) continue;
    const sp = speciesOf(tray);
    const gestation = sp?.gestation || 21;
    const dueDate = addDays(parseYMD(tray.gravidSince), gestation);
    const daysUntil = Math.floor((dueDate - today) / 86400000);
    const key = 'notif-birth-' + tray.id + '-' + tray.gravidSince;
    if (daysUntil <= 1 && daysUntil >= -3 && !sessionStorage.getItem(key)) {
      sessionStorage.setItem(key, '1');
      new Notification(`RAT-TRACK: Birth due in ${tray.name}`, {
        body: `${tray.gravidFemales} gravid ♀ — expected birth ${fmtDate(dueDate)}`,
        icon: 'icons/icon.png'
      });
    }
  }
}

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
      <p class="small muted" style="margin:0 0 10px">Once set, all changes sync automatically. Data also saves locally on this device and uploads when back online.</p>
      <label class="field" style="margin-bottom:10px">
        <span>API key <span class="muted" style="font-weight:400;font-size:11px">(optional — matches API_KEY in Apps Script Script Properties)</span></span>
        <input id="script-apikey" type="password" placeholder="leave blank if not set" value="${esc(state.meta.scriptApiKey||'')}" autocomplete="off" />
      </label>
      <div class="gap">
        <button class="btn primary" data-act="save-url">Save</button>
        ${url ? `<button class="btn" data-act="sync-now">Sync now</button>` : ''}
        ${url ? `<button class="btn" data-act="full-sync" title="Re-pulls every record from the Sheet — use after editing dates or data directly in Google Sheets">Full re-sync from Sheet</button>` : ''}
      </div>
      ${syncError ? `<p class="sync-error-msg">⚠ Last sync error: ${esc(syncError)}</p>` : ''}
      <p class="small muted" style="margin:8px 0 0">Use <b>Full re-sync</b> after editing data directly in Google Sheets — the normal sync only picks up new changes.</p>
      <hr class="hr" />
      <div class="small muted">
        <div class="spread"><span>Sync status</span><span>${syncing?'Syncing…':syncError?'Error':pc>0?`${pc} queued`:url?'Up to date':'No URL set'}</span></div>
        <div class="spread mt"><span>Last sync</span><span>${last}</span></div>
        <div class="spread mt"><span>Network</span><span>${navigator.onLine?'Online':'Offline'}</span></div>
      </div>
    </div>

    <h2 class="section-title">Backup &amp; Export</h2>
    <div class="card">
      <div class="gap" style="flex-wrap:wrap">
        <button class="btn" data-act="export">Export JSON</button>
        <button class="btn" data-act="import">Import JSON</button>
        <button class="btn" data-act="export-csv-removals">CSV: Removals</button>
        <button class="btn" data-act="export-csv-cohorts">CSV: Cohorts</button>
        <button class="btn" data-act="recently-deleted">Recently deleted</button>
      </div>
      <p class="small muted mt">JSON = full backup for re-import. CSV = spreadsheet-friendly export for reporting.</p>
    </div>

    <h2 class="section-title">Notifications</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 10px">Get alerts when births are due or overdue. Requires browser permission.</p>
      <div class="gap">
        ${state.meta.notificationsGranted
          ? `<span class="small" style="color:var(--ok)">✓ Notifications enabled</span>
             <button class="btn sm" data-act="check-notifications">Check now</button>`
          : `<button class="btn primary" data-act="enable-notifications">Enable notifications</button>`
        }
      </div>
    </div>

    <h2 class="section-title">Population Target</h2>
    <div class="card">
      <p class="small muted" style="margin:0 0 12px">Set a target so the forecast chart shows whether you're on track.</p>
      <div class="field-row" style="flex-wrap:wrap;gap:10px">
        <label class="field" style="flex:1;min-width:120px">
          <span>Target count</span>
          <input id="set-target-count" type="number" min="1" value="${state.meta.targetCount||''}" placeholder="e.g. 200" />
        </label>
        <label class="field" style="flex:1;min-width:120px">
          <span>Stage</span>
          <select id="set-target-stage">
            <option value="">Any stage</option>
            ${orderedStageNames().map(nm => `<option value="${esc(nm)}" ${state.meta.targetStage===nm?'selected':''}>${esc(nm)}</option>`).join('')}
          </select>
        </label>
        <label class="field" style="flex:1;min-width:140px">
          <span>Target date</span>
          <input id="set-target-date" type="date" value="${ymdToInput(state.meta.targetDate||'')}" />
        </label>
      </div>
      <button class="btn primary" data-act="save-target" style="margin-top:8px">Save target</button>
      ${state.meta.targetCount ? `<button class="btn" data-act="clear-target" style="margin-top:8px">Clear target</button>` : ''}
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
  if ($('#modal-root').hidden) {
    history.pushState({ tab: activeTab, modal: true }, '');
    _modalPushed = true;
    // Attach Escape key handler on open; remove on close
    openModal._escHandler = e => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', openModal._escHandler);
  }
  $('#modal-root').hidden = false;
  if (onMount) onMount($('#modal-body'));
}

function closeModal() {
  if ($('#modal-root').hidden) return;
  $('#modal-root').hidden    = true;
  $('#modal-body').innerHTML = '';
  if (openModal._escHandler) {
    document.removeEventListener('keydown', openModal._escHandler);
    openModal._escHandler = null;
  }
  if (_modalPushed) {
    _modalPushed = false;
    history.back();
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
  const adultCount = trayAdultCount(tray, sp);
  const gravid      = tray.gravidFemales    || 0;
  const lactating   = tray.lactatingFemales || 0;
  const rows = cohorts.map(c => {
    const net = cohortNet(c);
    const { name } = stageIndexAt(c);
    const depleted = net <= 0;
    const isAdultRow = !depleted && lastStageName && name === lastStageName;
    const si = orderedStageNames().indexOf(name);
    const infoLine = `started ${c.initialCount}${c.notes?' · '+esc(c.notes):''}`;
    const sexInputs = ''; // sex tracked at tray level in Reproductive status section
    return `<div class="cohort-row" style="${depleted?'opacity:.45':''}">
      <div class="cohort-info">
        <div class="cn">${net}
          <span class="pill" style="background:${stageColor(si)}">${esc(name)}</span>
        </div>
        <div class="small muted">${infoLine}</div>
      </div>
      <div class="cohort-remove">
        ${sexInputs}
        <button class="icon-btn" data-act="edit-cohort" data-id="${c.id}" data-trayid="${trayId}" title="Edit">✎</button>
        <button class="icon-btn" data-act="del-cohort" data-id="${c.id}" title="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');

  const sex = trayAdultSex(trayId, sp);
  const maxFemales = sex ? sex.females : adultCount;
  const gravidSince = tray.gravidSince || '';
  const expectedBirthStr = (() => {
    if (!gravidSince || !sp?.gestation) return '';
    const d = new Date(gravidSince);
    d.setDate(d.getDate() + sp.gestation);
    const daysLeft = Math.round((d - new Date()) / 86400000);
    const label = d.toLocaleDateString(undefined, { month:'short', day:'numeric' });
    if (daysLeft > 0)   return `<div class="birth-prediction">🐣 Expected pinkies: <b>${label}</b> (in ${daysLeft}d)</div>`;
    if (daysLeft >= -3) return `<div class="birth-prediction birth-due">🐣 Birth due now! (${label})</div>`;
    return `<div class="birth-prediction birth-overdue">🐣 Birth overdue by ${Math.abs(daysLeft)}d — check tray</div>`;
  })();
  const gravidSection = adultCount > 0 ? `
    <div class="gravid-section">
      <div class="gravid-title">Reproductive status <span class="gravid-sub">(${adultCount} adults)</span></div>
      <div class="gravid-row" style="margin-bottom:8px;padding-bottom:10px;border-bottom:1px solid var(--border,#2a2a44)">
        <label class="gravid-field"><span>♂ Males</span>
          <input type="number" id="tray-sex-m" min="0" max="${adultCount}" value="${tray.adultMales??''}" placeholder="0" /></label>
        <label class="gravid-field"><span>♀ Females</span>
          <input type="number" id="tray-sex-f" min="0" max="${adultCount}" value="${tray.adultFemales??''}" placeholder="0" /></label>
        <button class="btn sm" data-save-sex="${trayId}">Save</button>
      </div>
      <div class="small muted" style="margin-bottom:10px">♂ + ♀ must equal ${adultCount} adults${sex ? ` · current: ♂${sex.males} ♀${sex.females}` : ''}</div>
      <div class="gravid-row">
        <label class="gravid-field">
          <span>Gravid ♀</span>
          <input type="number" id="f-gravid" min="0" max="${maxFemales}" value="${gravid}" placeholder="0" />
        </label>
        <label class="gravid-field">
          <span>Lactating ♀</span>
          <input type="number" id="f-lact" min="0" max="${maxFemales}" value="${lactating}" placeholder="0" />
        </label>
        <button class="btn sm" id="save-status">Save</button>
      </div>
      ${gravid > 0 ? `<label class="gravid-field" style="margin-top:8px;display:flex;flex-direction:column;gap:4px">
        <span>Mated / gravid since</span>
        <input type="date" id="f-gravid-since" value="${gravidSince}" style="max-width:160px" />
      </label>` : ''}
      ${sp?.gestation && gravid > 0 && !gravidSince ? `<div class="gravid-gestation">Gestation: ${sp.gestation}d — set date above to predict birth</div>` : ''}
      ${expectedBirthStr}
      ${gravid + lactating > 0 ? `<div class="gravid-warn">⚠ ${gravid+lactating} female${gravid+lactating!==1?'s':''} unavailable for harvest</div>` : ''}
    </div>` : '';

  const ratioSection = sp?.ratio && sex !== null ? (() => {
    const st = ratioStatus(sex.males, sex.females, sp.ratio);
    const total = sex.males + sex.females;
    if (!total) return '';
    const idealM = Math.round(total * sp.ratio.males / (sp.ratio.males + sp.ratio.females));
    const idealF = total - idealM;
    const statusHtml = st === 'ok'
      ? `<span class="ratio-status-ok">✓ on target</span>`
      : st === 'close'
        ? `<span class="ratio-status-close">~ close — ideal ♂${idealM} : ♀${idealF}</span>`
        : st === 'off'
          ? `<span class="ratio-status-warn">⚠ off target — ideal ♂${idealM} : ♀${idealF}</span>`
          : '';
    return `<div class="ratio-section">
      <span class="ratio-label">Sex ratio target ♂${sp.ratio.males}:♀${sp.ratio.females}</span>
      <span class="ratio-current">Current adults: ♂${sex.males} ♀${sex.females} ${statusHtml}</span>
    </div>`;
  })() : '';

  const mismatchBanner = speciesMismatch ? `
    <div class="species-mismatch-warn">
      ⚠ Species ID <code>${esc(tray.speciesId)}</code> not found.
      Tap <b>Edit tray / species</b> below to fix.
    </div>` : '';

  const notesSection = `
    <div class="tray-notes-section" style="margin-top:10px">
      <label class="field">
        <span style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Observations / Notes</span>
        <textarea id="tray-notes-input" rows="2" placeholder="Record observations, temperature issues, health notes…" style="resize:vertical;min-height:48px;font-size:13px">${esc(tray.notes || '')}</textarea>
      </label>
      <button class="btn sm" id="save-tray-notes" style="margin-top:4px">Save notes</button>
    </div>`;

  openModal(`${esc(tray.name)} · ${sp?esc(sp.name):'—'}`, `
    ${mismatchBanner}
    <div class="gap" style="margin-bottom:4px">
      <button class="btn primary" data-act="add-litter" data-id="${trayId}" style="flex:1">+ Born today</button>
      <button class="btn primary" data-act="add-intake" data-id="${trayId}" style="flex:1">+ Add by stage</button>
      <button class="btn danger" data-act="quick-tray-remove" data-id="${trayId}" style="flex:1">Remove</button>
    </div>
    <div class="mt">${cohorts.length ? rows : '<p class="muted small">No litters yet.</p>'}</div>
    ${ratioSection}
    ${gravidSection}
    ${notesSection}
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
        const isAdult = lastStageName && name === lastStageName;
        if (isAdult) {
          closeModal();
          setTimeout(() => openModal(`Remove ${esc(name)}`, `
            <p class="small muted" style="margin-bottom:14px">Removing <b>${n} ${esc(name)}</b> — record sex and reason.</p>
            <div style="display:flex;gap:12px;margin-bottom:16px">
              <label class="gravid-field" style="flex:1"><span>♂ Males</span>
                <input id="rmv-m" type="number" min="0" max="${n}" placeholder="0" /></label>
              <label class="gravid-field" style="flex:1"><span>♀ Females</span>
                <input id="rmv-f" type="number" min="0" max="${n}" placeholder="0" /></label>
            </div>
            <div class="field" style="margin-bottom:12px">
              <span class="small" style="display:block;margin-bottom:6px;font-weight:500">Reason for removal</span>
              <div class="reason-btns">
                <button class="reason-btn active" data-reason="Feeding">Feeding</button>
                <button class="reason-btn" data-reason="Dead">Dead</button>
                <button class="reason-btn" data-reason="Other">Other</button>
              </div>
            </div>
            ${deathCauseHtml()}
            <button class="btn primary block" data-save>Confirm removal</button>
          `, root2 => {
            $('#rmv-m', root2).focus();
            wireReasonDeathToggle(root2);
            wireCauseBtns(root2);
            $('[data-save]', root2).onclick = () => {
              const mRaw = $('#rmv-m', root2).value;
              const fRaw = $('#rmv-f', root2).value;
              const males   = mRaw !== '' ? Number(mRaw) : null;
              const females = fRaw !== '' ? Number(fRaw) : null;
              if (males !== null && females !== null && males + females > n)
                return toast(`♂ + ♀ (${males+females}) exceeds count (${n})`, true);
              const reason = $('.reason-btn:not(.cause-btn).active', root2)?.dataset.reason || 'Feeding';
              const cause  = reason === 'Dead' ? ($('.cause-btn.active', root2)?.dataset.cause || 'Unknown') : undefined;
              const photoFile = reason === 'Dead' ? ($('#death-photo', root2)?.files?.[0] || null) : null;
              const r = rec('removals', { cohortId:id, trayId, date:toYMD(new Date()), stage:name, count:n, males, females, reason, cause });
              upsertLocal('removals', r); touch('removals', r);
              // Update tray sex counts
              const t = byId('trays', trayId);
              if (t) {
                if (males !== null) t.adultMales = Math.max(0, (Number(t.adultMales) || 0) - males);
                if (females !== null) t.adultFemales = Math.max(0, (Number(t.adultFemales) || 0) - females);
                touch('trays', t);
              }
              closeModal(); trayDetailModal(trayId); render();
              if (photoFile) uploadDeathPhoto(photoFile, trayId, byId('trays',trayId)?.name||trayId, toYMD(new Date()), cause);
              toast(`Removed ${n} ${name} · ${reason}${cause ? ' · ' + cause : ''}`);
            };
          }), 10);
        } else {
          closeModal();
          setTimeout(() => openModal(`Remove ${esc(name)}`, `
            <p class="small muted" style="margin-bottom:14px">Removing <b>${n} ${esc(name)}</b> — select a reason.</p>
            <div class="field" style="margin-bottom:12px">
              <div class="reason-btns">
                <button class="reason-btn active" data-reason="Feeding">Feeding</button>
                <button class="reason-btn" data-reason="Dead">Dead</button>
                <button class="reason-btn" data-reason="Other">Other</button>
              </div>
            </div>
            ${deathCauseHtml()}
            <button class="btn primary block" data-save>Confirm removal</button>
          `, root2 => {
            wireReasonDeathToggle(root2);
            wireCauseBtns(root2);
            $('[data-save]', root2).onclick = () => {
              const reason = $('.reason-btn:not(.cause-btn).active', root2)?.dataset.reason || 'Feeding';
              const cause  = reason === 'Dead' ? ($('.cause-btn.active', root2)?.dataset.cause || 'Unknown') : undefined;
              const photoFile = reason === 'Dead' ? ($('#death-photo', root2)?.files?.[0] || null) : null;
              const r = rec('removals', { cohortId:id, trayId, date:toYMD(new Date()), stage:name, count:n, reason, cause });
              upsertLocal('removals', r); touch('removals', r);
              closeModal(); trayDetailModal(trayId); render();
              if (photoFile) uploadDeathPhoto(photoFile, trayId, byId('trays',trayId)?.name||trayId, toYMD(new Date()), cause);
              toast(`Removed ${n} ${name} · ${reason}${cause ? ' · ' + cause : ''}`);
            };
          }), 10);
        }
      };
    });

    const saveStatusBtn = $('#save-status', root);
    if (saveStatusBtn) {
      saveStatusBtn.onclick = () => {
        const g = Number($('#f-gravid', root).value) || 0;
        const l = Number($('#f-lact',   root).value) || 0;
        const sexNow = trayAdultSex(trayId, sp);
        const femalesMax = sexNow ? sexNow.females : adultCount;
        if (g + l > femalesMax) return toast(`Gravid + Lactating (${g+l}) exceeds females (${femalesMax})`, true);
        tray.gravidFemales    = g;
        tray.lactatingFemales = l;
        const sinceVal = $('#f-gravid-since', root)?.value || '';
        tray.gravidSince = g > 0 ? sinceVal : '';
        touch('trays', tray);
        toast('Status saved');
        closeModal(); trayDetailModal(trayId); render();
      };
    }
    // Tray notes save
    const saveNotesBtn = $('#save-tray-notes', root);
    if (saveNotesBtn) {
      saveNotesBtn.onclick = () => {
        tray.notes = $('#tray-notes-input', root).value.trim();
        touch('trays', tray);
        toast('Notes saved');
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
      const r = rec('cohorts',{trayId, speciesId:tray.speciesId, birthDate, initialCount, notes, type:'birth'});
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

  const lastStageIdx = stages.length - 1;
  const rows = stages.map((st, i) => {
    const hex = STAGE_HEX[i % STAGE_HEX.length];
    const isAdult = i === lastStageIdx;
    return `<div class="intake-row">
      <span class="intake-dot" style="background:${hex}"></span>
      <span class="intake-name">${esc(st.name)}</span>
      <span class="intake-day small muted">day ${st.startDay}+</span>
      <input type="number" class="intake-input" min="0" placeholder="0"
        data-startday="${st.startDay}" data-stage="${esc(st.name)}" data-row="${i}" data-adult="${isAdult?'1':'0'}" />
    </div>
    <div class="sex-sub" id="isex-${i}" style="display:none">
      <label class="sex-label">♂ <input type="number" class="sex-male" min="0" placeholder="—" data-row="${i}" /></label>
      <label class="sex-label">♀ <input type="number" class="sex-female" min="0" placeholder="—" data-row="${i}" /></label>
    </div>
    ${isAdult ? `<div class="sex-sub gravid-sub-intake" id="igrv-${i}" style="display:none">
      <label class="sex-label">Gravid ♀ <input type="number" class="grv-gravid" min="0" placeholder="0" /></label>
      <label class="sex-label">Lactating ♀ <input type="number" class="grv-lact" min="0" placeholder="0" /></label>
    </div>` : ''}`;
  }).join('');

  openModal(`Add to ${esc(tray.name)}`, `
    <label class="field" style="margin-bottom:14px">
      <span>Date added</span>
      <input id="intake-date" type="date" value="${todayISO()}" />
    </label>
    <p class="small muted" style="margin-bottom:14px">Enter how many to add at each stage. Birth date is back-calculated from the stage.</p>
    <div class="intake-list">${rows}</div>
    <button class="btn primary block" id="intake-save" style="margin-top:16px">Add animals</button>
  `, root => {
    $$('.intake-input', root).forEach(inp => {
      inp.addEventListener('input', () => {
        const hasCount = Number(inp.value) > 0;
        const sub = $(`#isex-${inp.dataset.row}`, root);
        if (sub) sub.style.display = hasCount ? 'flex' : 'none';
        if (inp.dataset.adult === '1') {
          const grv = $(`#igrv-${inp.dataset.row}`, root);
          if (grv) grv.style.display = hasCount ? 'flex' : 'none';
        }
      });
      // Auto-sum ♂+♀ → count whenever sex inputs change
      const ri = inp.dataset.row;
      const autoSum = () => {
        const m = Number($(`#isex-${ri} .sex-male`, root)?.value) || 0;
        const f = Number($(`#isex-${ri} .sex-female`, root)?.value) || 0;
        if (m || f) { inp.value = m + f; inp.dispatchEvent(new Event('input')); }
      };
      root.addEventListener('input', e => {
        if (e.target.closest(`#isex-${ri}`)) autoSum();
      });
    });

    $('#intake-save', root).onclick = () => {
      const inputs = $$('.intake-input', root);
      const intakeDate = parseYMD($('#intake-date', root).value || todayISO());
      let added = 0;
      for (const inp of inputs) {
        const n = Number(inp.value);
        if (!n || n <= 0) continue;
        const startDay  = Number(inp.dataset.startday);
        const stageName = inp.dataset.stage;
        const ri        = inp.dataset.row;
        const birthDate = _localYMDStr(addDays(intakeDate, -startDay));
        const mVal = $(`#isex-${ri} .sex-male`, root)?.value;
        const fVal = $(`#isex-${ri} .sex-female`, root)?.value;
        const males   = mVal !== '' && mVal != null ? Number(mVal) : null;
        const females = fVal !== '' && fVal != null ? Number(fVal) : null;
        if (males !== null && females !== null && males + females > n)
          return toast(`♂ + ♀ (${males + females}) exceeds count (${n})`, true);
        if (inp.dataset.adult === '1' && females !== null) {
          const gravidVal = $(`#igrv-${ri} .grv-gravid`, root)?.value;
          const lactVal   = $(`#igrv-${ri} .grv-lact`, root)?.value;
          const g = Number(gravidVal) || 0;
          const l = Number(lactVal) || 0;
          if (g + l > females) return toast(`Gravid + Lactating (${g+l}) exceeds females (${females})`, true);
          tray.gravidFemales    = g;
          tray.lactatingFemales = l;
          touch('trays', tray);
        }
        const r = rec('cohorts', {
          trayId, speciesId: tray.speciesId,
          birthDate, initialCount: n,
          males, females,
          notes: `Intake · ${stageName}`,
          type: 'intake'
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
    <label class="field"><span>Target sex ratio (adults) <span class="muted" style="font-weight:400;font-size:11px">♂ : ♀ per breeding group</span></span>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="small">♂</span>
        <input id="f-ratio-m" type="number" min="1" value="${sp.ratio?.males??1}" style="width:70px;text-align:center" />
        <span class="small muted">:</span>
        <span class="small">♀</span>
        <input id="f-ratio-f" type="number" min="1" value="${sp.ratio?.females??1}" style="width:70px;text-align:center" />
      </div>
    </label>
    <label class="field"><span>Gestation period (days)</span>
      <input id="f-gestation" type="number" min="1" value="${sp.gestation||''}" placeholder="e.g. 21" /></label>
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
      const ratioM   = parseInt($('#f-ratio-m', root).value, 10) || 1;
      const ratioF   = parseInt($('#f-ratio-f', root).value, 10) || 1;
      const ratio    = { males: ratioM, females: ratioF };
      const gestation = parseInt($('#f-gestation', root).value, 10) || null;
      const lifespan = parseInt($('#f-lifespan', root).value, 10) || null;
      let stages = collect().filter(s => s.name);
      if (!name) return toast('Enter a species name', true);
      if (!stages.length) return toast('Add at least one stage', true);
      stages.sort((a,b)=>a.startDay-b.startDay);
      if (existing) {
        const oldId = existing.id;
        existing.name = name; existing.stages = stages; existing.gestation = gestation; existing.lifespan = lifespan; existing.ratio = ratio;
        if (newId !== oldId) {
          existing.id = newId;
          // Update all tray and cohort references to the new ID
          live('trays').forEach(t => { if (t.speciesId === oldId) { t.speciesId = newId; touch('trays', t); } });
          live('cohorts').forEach(c => { if (c.speciesId === oldId) { c.speciesId = newId; touch('cohorts', c); } });
        }
        touch('species', existing);
      } else {
        const r = rec('species', {id: newId, name, stages, gestation, lifespan, ratio});
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

  const sexBtn = e.target.closest('[data-save-sex]');
  if (sexBtn) {
    const id = sexBtn.dataset.saveSex;
    const root = sexBtn.closest('.modal-body') || document;
    const tray = byId('trays', id);
    if (tray) {
      // New model: tray-level sex storage
      const mVal = root.querySelector('#tray-sex-m')?.value;
      const fVal = root.querySelector('#tray-sex-f')?.value;
      const m = mVal !== '' && mVal != null ? Number(mVal) : null;
      const f = fVal !== '' && fVal != null ? Number(fVal) : null;
      if (m !== null) tray.adultMales = m;
      if (f !== null) tray.adultFemales = f;
      saveState(); touch('trays', tray);
      toast('Sex counts saved');
      renderTrays();
      trayDetailModal(tray.id);
      return;
    }
    return;
  }

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
    case 'quick-tray-remove': { e.stopPropagation(); return quickTrayRemoval(id); }
    case 'use-frozen':  return useFrozenModal(el.dataset.spid);  // legacy tray panel
    case 'fz-use':      return useFrozenModal(el.dataset.stage);
    case 'fz-add':      return addToFreezerModal();
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
      const v = $('#script-url')?.value.trim() || '';
      const k = $('#script-apikey')?.value.trim() || '';
      state.meta.scriptUrl    = v;
      state.meta.scriptApiKey = k;
      saveState(); toast('Saved'); render();
      if (v && navigator.onLine) syncNow();
      return;
    }
    case 'rec-done': return applyRecommendation(el);
    case 'open-tray-from-rec': { const t = byId('trays', el.dataset.trayid); if (t) { switchTab('trays'); setTimeout(() => trayDetailModal(t.id), 120); } return; }
    case 'sync-now': syncNow(true); return;
    case 'full-sync':
      state.meta.lastSync = 0;
      saveState();
      toast('Full re-sync started — pulling all records from Sheet…');
      syncNow(true);
      return;
    case 'export': return exportJSON();
    case 'import': return importJSON();
    case 'export-csv-removals': return exportCSV('removals');
    case 'export-csv-cohorts':  return exportCSV('cohorts');
    case 'recently-deleted': return renderRecentlyDeleted();
    case 'restore-record': {
      const rec = byId(el.dataset.entity, el.dataset.id);
      if (rec) { rec.deleted = false; touch(el.dataset.entity, rec); toast('Restored'); closeModal(); render(); }
      return;
    }
    case 'enable-notifications': return requestNotificationPermission();
    case 'check-notifications':  checkDueNotifications(); toast('Checked birth notifications'); return;
    case 'save-target': {
      state.meta.targetCount = Number($('#set-target-count')?.value) || null;
      state.meta.targetStage = $('#set-target-stage')?.value || null;
      state.meta.targetDate  = normYMD($('#set-target-date')?.value || '');
      saveState(); toast('Target saved'); render(); return;
    }
    case 'clear-target': {
      state.meta.targetCount = null; state.meta.targetStage = null; state.meta.targetDate = null;
      saveState(); toast('Target cleared'); render(); return;
    }
    case 'wipe':   return confirmDelete('ALL local data', () => {
      localStorage.removeItem(LS_KEY); location.reload();
    });

    // Reports
    case 'rpt-save-emails': return _rptSaveSettings();
    case 'rpt-send-now':    return _rptSendNow(el);
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
        // Schema validation: each entity must be an array
        const invalid = ENTITIES.filter(e => e in data && !Array.isArray(data[e]));
        if (invalid.length) { toast(`Import failed: ${invalid.join(', ')} not an array`, true); return; }
        // Spot-check required fields
        for (const e of ENTITIES) {
          const arr = data[e] || [];
          const badRow = arr.find(r => typeof r !== 'object' || !r.id);
          if (badRow) { toast(`Import failed: ${e} row missing id`, true); return; }
        }
        // Backup current state before overwriting
        try { localStorage.setItem(LS_KEY + '.pre-import', localStorage.getItem(LS_KEY)); } catch {}
        for (const e of ENTITIES) if (Array.isArray(data[e])) state[e] = data[e];
        if (data.meta) state.meta = Object.assign(state.meta, data.meta);
        saveState(); toast('Imported — previous data saved as backup'); render();
      } catch { toast('Invalid JSON file', true); }
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
  const syncStartTime = now(); // capture before fetch so mid-sync edits are detectable

  const changes = {};
  if (manual) {
    for (const e of ENTITIES) {
      const recs = live(e);
      if (recs.length) changes[e] = recs;
    }
  } else {
    for (const e of ENTITIES) {
      const ids = Object.keys(state.pending[e] || {});
      if (ids.length) changes[e] = ids.map(id => byId(e, id)).filter(Boolean);
    }
  }
  // Snapshot sent IDs with their updatedAt timestamps so we can safely clear only those
  const sentSnapshot = {};
  for (const e of ENTITIES) {
    sentSnapshot[e] = {};
    for (const r of (changes[e] || [])) sentSnapshot[e][r.id] = r.updatedAt || 0;
  }

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT_MS);

  // Manual sync: full pull (since=0) so direct Sheet edits are always picked up
  const pullSince = manual ? 0 : (state.meta.lastSync || 0);

  try {
    const res = await fetch(state.meta.scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ since: pullSince, changes, key: state.meta.scriptApiKey || undefined }),
      signal: ctrl.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    // Merge remote changes — full pull always wins (sheet is truth on manual sync)
    for (const e of ENTITIES) {
      for (const remote of (data.changes?.[e] || [])) {
        if (!remote.id) remote.id = 'sheet-' + btoa(JSON.stringify([e, remote.date||'', remote.trayId||'', remote.cohortId||'', remote.count||0, remote.reason||'', remote.stage||''])).replace(/[^a-zA-Z0-9]/g,'').slice(0,20);
        const local = byId(e, remote.id);
        if (!local || manual || (remote.updatedAt||0) >= (local.updatedAt||0)) upsertLocal(e, Object.assign({}, local || {}, remote));
      }
    }
    // Clear pending only for records whose updatedAt hasn't changed since we sent them
    // (guards against edits made during the fetch overwriting their own pending marker)
    for (const e of ENTITIES) {
      for (const [id, sentAt] of Object.entries(sentSnapshot[e] || {})) {
        const current = byId(e, id);
        if (current && (current.updatedAt || 0) > sentAt) continue; // re-edited during sync
        if (state.pending[e]) delete state.pending[e][id];
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
 *  Reports
 * ------------------------------------------------------------------ */
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
let _reportHTML = '';

function renderReports() {
  const el  = $('#tab-reports');
  const now = new Date();
  const curYear  = now.getFullYear();
  const curMonth = now.getMonth(); // 0-based

  if (!live('cohorts').length) {
    el.innerHTML = `<h2 class="section-title" style="margin:4px 0 20px">Reports</h2>` +
      emptyState('&#128202;', 'No data yet', 'Add species and litters first, then come back here for your colony summary.');
    return;
  }

  /* ── Colony snapshot ─────────────────────────────────────────── */
  const { totals, total } = stageTotalsAt(now);
  const names = orderedStageNames();

  const monthStartYMD = toYMD(new Date(curYear, curMonth, 1));
  const todayYMD      = toYMD(now);

  const monthRems = live('removals').filter(r => {
    const d = normYMD(r.date);
    return d >= monthStartYMD && d <= todayYMD;
  });
  const birthsThisMonth = live('cohorts')
    .filter(c => { const d = normYMD(c.birthDate); return d >= monthStartYMD && d <= todayYMD; })
    .reduce((s, c) => s + (Number(c.initialCount) || 0), 0);
  const deaths    = monthRems.filter(r => r.reason === 'Dead')
    .reduce((s, r) => s + (Number(r.count) || 0), 0);
  const harvested = monthRems.filter(r => r.reason === 'Feeding' || r.reason === 'Harvest' || r.reason === 'Harvested')
    .reduce((s, r) => s + (Number(r.count) || 0), 0);
  const frozenThisMonth = monthRems.filter(r => r.reason === 'Frozen')
    .reduce((s, r) => s + (Number(r.count) || 0), 0);

  // Overall tracked sex counts — read from authoritative tray-level fields
  let totalMales = 0, totalFemales = 0;
  for (const tray of live('trays')) {
    const tSp = speciesOf(tray);
    const sex = trayAdultSex(tray.id, tSp);
    if (!sex) continue;
    totalMales   += sex.males;
    totalFemales += sex.females;
  }
  const sexRatioLine = (totalMales + totalFemales > 0)
    ? `<div class="spread rpt-sex-row">
         <span class="small muted">Overall sex ratio</span>
         <span class="small">&#9794; ${totalMales} &nbsp;&#9792; ${totalFemales}
           ${totalMales && totalFemales ? `<span class="muted"> &nbsp;1 : ${(totalFemales/totalMales).toFixed(1)}</span>` : ''}</span>
       </div>` : '';

  const stagePills = names.map((nm, i) => {
    const count = totals.get(nm) || 0;
    if (!count) return '';
    return `<div class="rpt-pill" style="border-color:${STAGE_HEX[i%STAGE_HEX.length]}66;background:${STAGE_HEX[i%STAGE_HEX.length]}14">
      <span class="rpt-pill-n" style="color:${STAGE_HEX[i%STAGE_HEX.length]}">${count.toLocaleString()}</span>
      <span class="rpt-pill-l">${esc(nm)}</span>
    </div>`;
  }).filter(Boolean).join('');

  /* ── Recent removals table ────────────────────────────────────── */
  const allRems = live('removals')
    .filter(r => r.count > 0 && r.reason !== 'Transfer')
    .sort((a, b) => normYMD(b.date).localeCompare(normYMD(a.date)))
    .slice(0, 20);

  const remRows = allRems.map(r => {
    const tray = byId('trays', r.trayId);
    const reasonColor = r.reason === 'Dead' ? 'var(--danger)'
      : r.reason === 'Feeding' ? 'var(--accent)'
      : r.reason === 'Frozen'  ? '#2dd4bf'
      : 'var(--text-2)';
    const validCause = DEATH_CAUSES.includes(r.cause) ? r.cause : null;
    const causeCell = r.reason === 'Dead' && validCause ? `<span class="rpt-cause-tag">${esc(validCause)}</span>` : '';
    return `<tr class="rpt-rem-row">
      <td>${ymdToInput(normYMD(r.date))}</td>
      <td>${esc(tray?.name || r.trayId || '—')}</td>
      <td>${esc(r.stage || '—')}</td>
      <td class="rpt-rem-count">${r.count}</td>
      <td style="color:${reasonColor};font-weight:600">${esc(r.reason || '—')} ${causeCell}</td>
    </tr>`;
  }).join('');

  const remTable = allRems.length
    ? `<div style="overflow-x:auto"><table class="rpt-rem-table">
        <thead><tr><th>Date</th><th>Tray</th><th>Stage</th><th>Count</th><th>Reason</th></tr></thead>
        <tbody>${remRows}</tbody>
       </table></div>`
    : `<p class="small muted" style="margin:0">No removals recorded yet. Use the Trays tab or Dashboard to record deaths and removals.</p>`;

  /* ── Deaths by cause (this month) ──────────────────────────────── */
  const thisMonthDeaths = monthRems.filter(r => r.reason === 'Dead');
  const deathsByCauseNow = {};
  const deathsByStageNow = {};
  for (const r of thisMonthDeaths) {
    const cause = DEATH_CAUSES.includes(r.cause) ? r.cause : 'Unknown';
    const stage = r.stage || '—';
    const cnt   = Number(r.count) || 0;
    deathsByCauseNow[cause] = (deathsByCauseNow[cause] || 0) + cnt;
    if (!deathsByStageNow[stage]) deathsByStageNow[stage] = {};
    deathsByStageNow[stage][cause] = (deathsByStageNow[stage][cause] || 0) + cnt;
  }
  const causesPresent = [...new Set(thisMonthDeaths.map(r => DEATH_CAUSES.includes(r.cause) ? r.cause : 'Unknown'))];
  const stagesPresent = Object.keys(deathsByStageNow).sort();
  const deathTable = stagesPresent.length ? (() => {
    const headerCells = causesPresent.map(c => `<th>${esc(c)}</th>`).join('');
    const dataRows = stagesPresent.map(st => {
      const cells = causesPresent.map(c => `<td>${deathsByStageNow[st][c] || '—'}</td>`).join('');
      const rowTotal = causesPresent.reduce((s, c) => s + (deathsByStageNow[st][c] || 0), 0);
      return `<tr><td><b>${esc(st)}</b></td>${cells}<td class="rpt-rem-count">${rowTotal}</td></tr>`;
    }).join('');
    const totalRow = `<tr style="font-weight:700;border-top:2px solid var(--border)">
      <td>Total</td>${causesPresent.map(c => `<td>${deathsByCauseNow[c] || 0}</td>`).join('')}
      <td class="rpt-rem-count">${Object.values(deathsByCauseNow).reduce((a, b) => a + b, 0)}</td></tr>`;
    return `<div style="overflow-x:auto"><table class="rpt-rem-table">
      <thead><tr><th>Stage</th>${headerCells}<th>Total</th></tr></thead>
      <tbody>${dataRows}${totalRow}</tbody>
    </table></div>`;
  })() : `<p class="small muted" style="margin:0">No deaths recorded this month.</p>`;

  /* ── Productivity metrics ────────────────────────────────────── */
  const birthCohorts = live('cohorts')
    .filter(c => { const d = normYMD(c.birthDate); return d >= monthStartYMD && d <= todayYMD && !String(c.notes||'').startsWith('Transfer'); });
  const avgLitterSize = birthCohorts.length
    ? (birthCohorts.reduce((s, c) => s + (Number(c.initialCount)||0), 0) / birthCohorts.length)
    : null;

  // Yield rate: animals fed as % of current population
  const yieldRate = total > 0 ? (harvested / total * 100) : null;

  // Freezer current stock (all-time frozen minus used)
  const totalFrozenStock = Object.values(frozenByStage()).reduce((s, v) => s + Math.max(0, v), 0);

  // Avg age at harvest: for feeding removals this month that have a known birthDate via cohort
  let harvestAgeSum = 0, harvestAgeCount = 0;
  for (const r of monthRems.filter(x => x.reason === 'Feeding' || x.reason === 'Harvest' || x.reason === 'Harvested')) {
    const c = byId('cohorts', r.cohortId);
    if (!c?.birthDate) continue;
    const remDate = parseYMD(normYMD(r.date));
    const bd      = parseYMD(normYMD(c.birthDate));
    if (!remDate || !bd) continue;
    harvestAgeSum   += Math.round((remDate - bd) / 86400000);
    harvestAgeCount += Number(r.count) || 1;
  }
  const avgHarvestAge = harvestAgeCount > 0 ? Math.round(harvestAgeSum / harvestAgeCount) : null;

  const deathRate = total > 0 ? (deaths / total * 100) : 0;

  // Death rate bar width — capped at 5% = 100% of bar
  const deathBarPct = Math.min(100, deathRate / 5 * 100);
  const deathRateColor = deathRate < 1 ? 'var(--ok)' : deathRate < 3 ? 'var(--warn)' : 'var(--danger)';
  const deathRateLabel = deathRate < 1 ? 'excellent' : deathRate < 3 ? 'monitor' : 'high — investigate';

  const prodHtml = `
    <h2 class="section-title" style="margin:0 0 10px">Productivity</h2>
    <div class="card" style="margin-bottom:20px">
      <div class="rpt-prod-grid">
        ${avgLitterSize != null ? `
        <div class="rpt-prod-item">
          <span class="rpt-prod-n" style="color:var(--accent)">${avgLitterSize.toFixed(1)}</span>
          <span class="rpt-prod-l">Avg litter size</span>
          <div class="rpt-prod-bar"><div class="rpt-prod-fill" style="width:${Math.min(100, avgLitterSize/15*100).toFixed(0)}%;background:var(--accent)"></div></div>
        </div>` : ''}
        ${yieldRate != null ? `
        <div class="rpt-prod-item">
          <span class="rpt-prod-n" style="color:var(--ok)">${yieldRate.toFixed(1)}<span style="font-size:14px;font-weight:500">%</span></span>
          <span class="rpt-prod-l">Yield rate (fed / alive)</span>
          <div class="rpt-prod-bar"><div class="rpt-prod-fill" style="width:${Math.min(100, yieldRate*3).toFixed(0)}%;background:var(--ok)"></div></div>
        </div>` : ''}
        <div class="rpt-prod-item">
          <span class="rpt-prod-n" style="color:#2dd4bf">${totalFrozenStock}</span>
          <span class="rpt-prod-l">Freezer stock</span>
          <div class="rpt-prod-bar"><div class="rpt-prod-fill" style="width:${Math.min(100, totalFrozenStock/200*100).toFixed(0)}%;background:#2dd4bf"></div></div>
        </div>
        ${avgHarvestAge != null ? `
        <div class="rpt-prod-item">
          <span class="rpt-prod-n" style="color:var(--info,#818cf8)">${avgHarvestAge}<span style="font-size:14px;font-weight:500">d</span></span>
          <span class="rpt-prod-l">Avg age at harvest</span>
          <div class="rpt-prod-bar"><div class="rpt-prod-fill" style="width:${Math.min(100, avgHarvestAge/90*100).toFixed(0)}%;background:var(--info,#818cf8)"></div></div>
        </div>` : ''}
      </div>
      <hr class="hr" style="margin:14px 0" />
      <div style="display:flex;align-items:center;gap:10px">
        <span class="small" style="color:var(--muted);white-space:nowrap;min-width:70px">Death rate</span>
        <div style="flex:1;background:var(--surface-2);border-radius:4px;height:8px;overflow:hidden">
          <div style="width:${deathBarPct.toFixed(1)}%;background:${deathRateColor};height:100%;border-radius:4px;transition:width .4s"></div>
        </div>
        <span class="small" style="color:${deathRateColor};font-weight:700;white-space:nowrap">${deathRate.toFixed(2)}% <span style="color:var(--muted);font-weight:400">— ${deathRateLabel}</span></span>
      </div>
    </div>`;

  /* ── Per-species cards ────────────────────────────────────────── */
  const spCards = live('species').map(sp => {
    const { totals: spTot, total: spTotal } = stageTotalsAt(now, c => speciesOf(c)?.id === sp.id);
    if (!spTotal) return '';

    const stages = [...(sp.stages || [])].sort((a, b) => (a.startDay||0) - (b.startDay||0));
    const spPills = stages.map((st, i) => {
      const cnt = spTot.get(st.name) || 0;
      if (!cnt) return '';
      return `<span class="rpt-sp-pill" style="background:${STAGE_HEX[i%STAGE_HEX.length]}22;color:${STAGE_HEX[i%STAGE_HEX.length]};border:1px solid ${STAGE_HEX[i%STAGE_HEX.length]}55">${esc(st.name)}: ${cnt}</span>`;
    }).filter(Boolean).join('');

    let spM = 0, spF = 0;
    for (const tray of live('trays').filter(t => t.speciesId === sp.id)) {
      const sex = trayAdultSex(tray.id, sp);
      if (!sex) continue;
      spM += sex.males; spF += sex.females;
    }
    const spSex = (spM || spF)
      ? `<span class="rpt-sp-meta-item">&#9794; ${spM} &middot; &#9792; ${spF}${spM&&spF?` <span class="muted">(1:${(spF/spM).toFixed(1)})</span>`:''}</span>`
      : '';

    const trayCount  = live('trays').filter(t => t.speciesId === sp.id).length;
    const spBirths   = live('cohorts')
      .filter(c => c.speciesId === sp.id && normYMD(c.birthDate) >= monthStartYMD && normYMD(c.birthDate) <= todayYMD)
      .reduce((s, c) => s + (Number(c.initialCount)||0), 0);
    const spDeaths   = live('removals')
      .filter(r => {
        const d = normYMD(r.date); if (d < monthStartYMD || d > todayYMD || r.reason !== 'Dead') return false;
        const c = byId('cohorts', r.cohortId); return speciesOf(c)?.id === sp.id;
      }).reduce((s, r) => s + (Number(r.count)||0), 0);

    // Population forecast line chart for this species (same SVG chart as Charts tab)
    const spFcChart = renderPopulationForecast('all', 'all', c => speciesOf(c)?.id === sp.id);

    return `<div class="card rpt-sp-card">
      <div class="rpt-sp-header">
        <span class="rpt-sp-name">${esc(sp.name)}</span>
        <span class="rpt-sp-total">${spTotal.toLocaleString()} alive</span>
      </div>
      <div class="rpt-sp-pills">${spPills || '<span class="small muted">No stage data</span>'}</div>
      <div class="rpt-sp-meta">
        ${spSex}
        <span class="rpt-sp-meta-item muted">${trayCount} tray${trayCount!==1?'s':''}</span>
        ${spBirths ? `<span class="rpt-sp-meta-item" style="color:var(--ok)">+${spBirths} born this month</span>` : ''}
        ${spDeaths ? `<span class="rpt-sp-meta-item" style="color:var(--danger)">${spDeaths} died this month</span>` : ''}
      </div>
      <div class="rpt-sp-fc">${spFcChart}</div>
    </div>`;
  }).filter(Boolean).join('');

  /* ── Email / schedule ─────────────────────────────────────────── */
  const savedEmails   = state.meta.reportEmails   || '';
  const savedSchedule = state.meta.reportSchedule || 'off';
  const lastSentTs    = state.meta.reportLastSent;
  const lastSentLabel = lastSentTs
    ? new Date(lastSentTs).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})
    : 'Never';
  const nextDueLabel  = _reportNextDueLabel();

  /* ── Render ───────────────────────────────────────────────────── */
  el.innerHTML = `
    <!-- ① Colony Snapshot -->
    <h2 class="section-title" style="margin:4px 0 14px">Colony Snapshot &mdash; ${MONTH_NAMES[curMonth]} ${curYear}</h2>
    <div class="card" style="margin-bottom:20px">
      <div class="rpt-total-row">
        <span class="rpt-total-n">${total.toLocaleString()}</span>
        <span class="small muted">total alive</span>
      </div>
      <div class="rpt-pills-grid">${stagePills}</div>
      <hr class="hr" />
      <div class="rpt-month-grid">
        <div class="rpt-mstat"><span class="rpt-mstat-n ok">${birthsThisMonth}</span><span class="rpt-mstat-l">Births</span></div>
        <div class="rpt-mstat"><span class="rpt-mstat-n danger">${deaths}</span><span class="rpt-mstat-l">Deaths</span></div>
        <div class="rpt-mstat"><span class="rpt-mstat-n" style="color:var(--accent)">${harvested}</span><span class="rpt-mstat-l">Harvested</span></div>
        <div class="rpt-mstat"><span class="rpt-mstat-n" style="color:#2dd4bf">${frozenThisMonth}</span><span class="rpt-mstat-l">Frozen</span></div>
      </div>
      ${sexRatioLine ? `<hr class="hr" />${sexRatioLine}` : ''}
    </div>

    <!-- ② Productivity -->
    ${prodHtml}

    <!-- ③ Removals & Deaths -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin:0 0 12px">
      <h2 class="section-title" style="margin:0">Removals &amp; Deaths</h2>
      ${state.meta.scriptUrl ? `<button class="btn sm" data-act="sync-now" style="flex-shrink:0">&#8635; Pull from sheet</button>` : ''}
    </div>
    <div class="card" style="margin-bottom:16px">${remTable}</div>

    <!-- ② Deaths by Cause (this month) -->
    <h2 class="section-title" style="margin:0 0 10px">Deaths by Cause — ${MONTH_NAMES[curMonth]}</h2>
    <div class="card" style="margin-bottom:20px">${deathTable}</div>

    <!-- ③ Species Breakdown -->
    ${live('species').length ? `
    <h2 class="section-title" style="margin:0 0 12px">Species Breakdown</h2>
    <div class="rpt-sp-grid" style="margin-bottom:20px">${spCards || '<div class="card"><p class="small muted" style="margin:0">No live animals.</p></div>'}</div>` : ''}

    <!-- ④ Auto-Reports & Email -->
    <h2 class="section-title" style="margin:0 0 12px">Auto-Reports &amp; Email</h2>
    <div class="card">
      <label class="field" style="margin-bottom:6px">
        <span>Email recipients</span>
        <input id="rpt-emails" type="text"
          placeholder="alice@example.com, bob@example.com"
          value="${esc(savedEmails)}" />
      </label>
      <p class="small muted" style="margin:0 0 14px">Comma-separated. Sent via the Apps Script URL in Settings.</p>
      <label class="field" style="margin-bottom:14px">
        <span>Auto-send schedule</span>
        <select id="rpt-schedule">
          <option value="off"    ${savedSchedule==='off'    ?'selected':''}>Off &mdash; manual only</option>
          <option value="weekly" ${savedSchedule==='weekly' ?'selected':''}>Weekly (every 7 days)</option>
          <option value="monthly"${savedSchedule==='monthly'?'selected':''}>Monthly (every 30 days)</option>
          <option value="yearly" ${savedSchedule==='yearly' ?'selected':''}>Yearly (every 365 days)</option>
        </select>
      </label>
      <div class="rpt-schedule-info small muted" style="margin-bottom:16px">
        <div class="spread mt"><span>Last sent</span><span>${lastSentLabel}</span></div>
        ${nextDueLabel ? `<div class="spread mt"><span>Next due</span><span>${nextDueLabel}</span></div>` : ''}
      </div>
      <div class="gap">
        <button class="btn primary" data-act="rpt-save-emails">Save settings</button>
        <button class="btn" data-act="rpt-send-now">&#9993; Send now</button>
      </div>
    </div>`;
}

/* --- Data builders --- */

function buildMonthlyData(year, month) {
  const startDate = new Date(year, month - 1, 1);
  const endDate   = new Date(year, month, 0, 23, 59, 59);
  const startYMD  = toYMD(startDate);
  const endYMD    = toYMD(endDate);

  const { total: popStart } = stageTotalsAt(startDate);
  const { total: popEnd, totals: distEnd } = stageTotalsAt(endDate);

  // Births and intakes this month
  const newCohorts = live('cohorts').filter(c => {
    const d = normYMD(c.birthDate);
    return d >= startYMD && d <= endYMD;
  });
  const birthCohorts  = newCohorts.filter(c => !c.type ? !String(c.notes||'').startsWith('Intake') : c.type === 'birth');
  const intakeCohorts = newCohorts.filter(c => !c.type ? String(c.notes||'').startsWith('Intake')  : c.type === 'intake');
  const births  = birthCohorts.reduce((s, c)  => s + (Number(c.initialCount) || 0), 0);
  const intakes = intakeCohorts.reduce((s, c) => s + (Number(c.initialCount) || 0), 0);

  // Removals this month
  const monthRemovals = live('removals').filter(r => {
    const d = normYMD(r.date);
    return d >= startYMD && d <= endYMD;
  });
  const byReason = {};
  let totalRemoved = 0;
  for (const r of monthRemovals) {
    const reason = r.reason || 'Other';
    const cnt = Number(r.count) || 0;
    byReason[reason] = (byReason[reason] || 0) + cnt;
    totalRemoved += cnt;
  }
  const frozenCount  = byReason['Frozen'] || 0;
  const harvestCount = byReason['Harvest'] || byReason['Harvested'] || 0;

  // Deaths by cause and by stage
  const deathsByCause = {};
  const deathsByStage = {};
  for (const r of monthRemovals.filter(x => x.reason === 'Dead')) {
    const cause = r.cause || 'Unknown';
    const stage = r.stage || '—';
    const cnt   = Number(r.count) || 0;
    deathsByCause[cause] = (deathsByCause[cause] || 0) + cnt;
    if (!deathsByStage[stage]) deathsByStage[stage] = {};
    deathsByStage[stage][cause] = (deathsByStage[stage][cause] || 0) + cnt;
  }

  // Stage distribution at end of month
  const stageNames = orderedStageNames();
  const stageData  = stageNames.map((nm, i) => ({
    name:  nm,
    count: distEnd.get(nm) || 0,
    color: STAGE_HEX[i % STAGE_HEX.length]
  })).filter(x => x.count > 0);

  // Top 5 trays by removal count this month
  const trayAct = {};
  for (const r of monthRemovals) {
    if (!r.trayId) continue;
    const t = byId('trays', r.trayId);
    const nm = t ? t.name : r.trayId;
    if (!trayAct[r.trayId]) trayAct[r.trayId] = { name: nm, count: 0 };
    trayAct[r.trayId].count += Number(r.count) || 0;
  }
  const topTrays = Object.values(trayAct).sort((a, b) => b.count - a.count).slice(0, 5);

  // Species breakdown at end of month
  const speciesBreakdown = live('species').map(sp => {
    const { total } = stageTotalsAt(endDate, c => speciesOf(c)?.id === sp.id);
    return { name: sp.name, count: total };
  }).filter(x => x.count > 0).sort((a, b) => b.count - a.count);

  const growth    = popEnd - popStart;
  const growthPct = popStart > 0 ? Math.round((growth / popStart) * 100) : 0;

  return {
    type: 'monthly', year, month,
    monthName: MONTH_NAMES[month - 1],
    popStart, popEnd, births, intakes,
    totalRemoved, byReason, frozenCount, harvestCount,
    deathsByCause, deathsByStage,
    stageData, topTrays, speciesBreakdown,
    growth, growthPct
  };
}

function buildAnnualData(year) {
  const now = new Date();
  const lastMonth = (year === now.getFullYear()) ? now.getMonth() + 1 : 12;
  const months = [];
  let totalBirths = 0, totalRemoved = 0, totalFrozen = 0;

  for (let m = 1; m <= lastMonth; m++) {
    const d = buildMonthlyData(year, m);
    months.push(d);
    totalBirths   += d.births;
    totalRemoved  += d.totalRemoved;
    totalFrozen   += d.frozenCount;
  }

  const peakMonth       = months.reduce((a, b) => b.popEnd > a.popEnd ? b : a);
  const mostActiveMonth = months.reduce((a, b) => b.totalRemoved > a.totalRemoved ? b : a);
  const currentPop      = months[months.length - 1].popEnd;

  return {
    type: 'annual', year, months,
    totalBirths, totalRemoved, totalFrozen,
    peakMonth, mostActiveMonth, currentPop
  };
}

/* --- HTML generators --- */

function generateMonthlyReportHTML(d) {
  const growth      = d.growth >= 0 ? `+${d.growth}` : `${d.growth}`;
  const growthColor = d.growth > 0 ? '#22c55e' : d.growth < 0 ? '#ef4444' : '#94a3b8';
  const maxCount    = Math.max(...d.stageData.map(s => s.count), 1);

  const stageBars = d.stageData.map(s => {
    const pct = Math.round((s.count / maxCount) * 100);
    return `
      <tr>
        <td style="padding:5px 10px 5px 0;color:#94a3b8;font-size:12px;white-space:nowrap;width:72px">${s.name}</td>
        <td style="padding:5px 0;width:100%">
          <div style="background:#1e2035;border-radius:4px;overflow:hidden;height:18px">
            <div style="background:${s.color};height:100%;width:${pct}%;min-width:3px"></div>
          </div>
        </td>
        <td style="padding:5px 0 5px 12px;color:#e2e8f0;font-size:13px;font-weight:700;white-space:nowrap;text-align:right">${s.count.toLocaleString()}</td>
      </tr>`;
  }).join('');

  const reasonRows = Object.entries(d.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `
      <tr>
        <td style="padding:9px 14px;color:#94a3b8;font-size:13px;border-bottom:1px solid #1e2035">${reason}</td>
        <td style="padding:9px 14px;color:#e2e8f0;font-size:13px;font-weight:700;text-align:right;border-bottom:1px solid #1e2035">${count.toLocaleString()}</td>
      </tr>`).join('');

  const trayRows = d.topTrays.map((t, i) => `
    <tr>
      <td style="padding:9px 14px;color:#64748b;font-size:12px;border-bottom:1px solid #1e2035">#${i+1}</td>
      <td style="padding:9px 14px;color:#e2e8f0;font-size:13px;font-weight:600;border-bottom:1px solid #1e2035">${t.name}</td>
      <td style="padding:9px 14px;color:#a78bfa;font-size:13px;font-weight:700;text-align:right;border-bottom:1px solid #1e2035">${t.count.toLocaleString()}</td>
    </tr>`).join('');

  const insights = [];
  if (d.growthPct > 10)       insights.push(`Your colony grew strongly by <b>${d.growthPct}%</b> — excellent breeding activity this month.`);
  else if (d.growthPct < -10) insights.push(`Your colony contracted by <b>${Math.abs(d.growthPct)}%</b> — removals exceeded new births this month.`);
  else                        insights.push(`Your colony held steady with a <b>${d.growthPct >= 0 ? '+' : ''}${d.growthPct}%</b> net population change.`);
  if (d.births > 0)      insights.push(`<b>${d.births.toLocaleString()} pinkies born</b> here across ${newCohortCount(d)} litter${newCohortCount(d)!==1?'s':''}.`);
  if (d.intakes > 0)    insights.push(`<b>${d.intakes.toLocaleString()} animals added</b> via intake (external stock).`);
  if (d.frozenCount > 0) insights.push(`<b>${d.frozenCount.toLocaleString()} animals</b> frozen this month.`);
  if (d.harvestCount > 0) insights.push(`<b>${d.harvestCount.toLocaleString()} animals</b> harvested for sale or use.`);

  const insightItems = insights.map(i => `<li style="margin:7px 0;color:#cbd5e1;line-height:1.65;font-size:14px">${i}</li>`).join('');

  const speciesSection = d.speciesBreakdown.length > 1 ? `
    <tr><td style="background:#0f0f1e;padding:24px 28px 28px">
      <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#128060; Species Breakdown</h2>
      <table width="100%" cellpadding="0" cellspacing="0">
        ${d.speciesBreakdown.map(s => `
          <tr>
            <td style="padding:4px 0;color:#94a3b8;font-size:13px">${s.name}</td>
            <td style="padding:4px 0;color:#e2e8f0;font-size:13px;font-weight:700;text-align:right">${s.count.toLocaleString()}</td>
          </tr>`).join('')}
      </table>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NestTrak Report &mdash; ${d.monthName} ${d.year}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a14">
  <tr><td align="center" style="padding:28px 16px">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#7c3aed 0%,#db2777 100%);border-radius:16px 16px 0 0;padding:44px 32px 36px;text-align:center">
        <div style="font-size:52px;line-height:1;margin-bottom:12px">&#x1F400;</div>
        <h1 style="margin:0 0 8px;color:#fff;font-size:26px;font-weight:800;letter-spacing:-0.5px">NestTrak Colony Report</h1>
        <p style="margin:0;color:rgba(255,255,255,0.8);font-size:15px">${d.monthName} ${d.year} &middot; Monthly Summary</p>
      </td></tr>

      <!-- Key metrics -->
      <tr><td style="background:#111127;padding:0">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="25%" style="padding:22px 10px;text-align:center;border-right:1px solid #1e2035">
              <div style="font-size:28px;font-weight:800;color:#a78bfa;font-variant-numeric:tabular-nums">${d.popEnd.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Live Animals</div>
            </td>
            <td width="25%" style="padding:22px 10px;text-align:center;border-right:1px solid #1e2035">
              <div style="font-size:28px;font-weight:800;color:#34d399;font-variant-numeric:tabular-nums">${d.births.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Born Here</div>
              ${d.intakes > 0 ? `<div style="font-size:12px;color:#60a5fa;margin-top:6px;font-weight:600">+${d.intakes.toLocaleString()} intake</div>` : ''}
            </td>
            <td width="25%" style="padding:22px 10px;text-align:center;border-right:1px solid #1e2035">
              <div style="font-size:28px;font-weight:800;color:#fb923c;font-variant-numeric:tabular-nums">${d.totalRemoved.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Removed</div>
            </td>
            <td width="25%" style="padding:22px 10px;text-align:center">
              <div style="font-size:28px;font-weight:800;color:${growthColor};font-variant-numeric:tabular-nums">${growth}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Net Change</div>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Insights -->
      <tr><td style="background:#0f0f1e;padding:24px 28px">
        <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#128161; Monthly Insights</h2>
        <ul style="margin:0;padding-left:18px">${insightItems}</ul>
      </td></tr>

      ${d.stageData.length ? `
      <!-- Stage distribution -->
      <tr><td style="background:#111127;padding:24px 28px">
        <h2 style="margin:0 0 14px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#128200; Stage Distribution</h2>
        <table width="100%" cellpadding="0" cellspacing="0">${stageBars}</table>
      </td></tr>` : ''}

      ${d.totalRemoved > 0 ? `
      <!-- Removal breakdown -->
      <tr><td style="background:#0f0f1e;padding:24px 28px">
        <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#9660; Removal Breakdown</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1e2035;border-radius:8px;overflow:hidden">${reasonRows}</table>
      </td></tr>` : ''}

      ${Object.keys(d.deathsByStage||{}).length ? (() => {
        const causes = [...new Set(Object.values(d.deathsByStage).flatMap(o => Object.keys(o)))];
        const stages = Object.keys(d.deathsByStage);
        const hdr = causes.map(c => `<td style="padding:7px 10px;color:#94a3b8;font-size:11px;font-weight:700;text-align:center;text-transform:uppercase;border-bottom:1px solid #1e2035">${c}</td>`).join('');
        const rows = stages.map(st => {
          const cells = causes.map(c => `<td style="padding:7px 10px;color:#e2e8f0;font-size:12px;font-weight:700;text-align:center;border-bottom:1px solid #1e2035">${d.deathsByStage[st][c]||'—'}</td>`).join('');
          return `<tr><td style="padding:7px 10px;color:#94a3b8;font-size:12px;border-bottom:1px solid #1e2035;white-space:nowrap"><b>${st}</b></td>${cells}</tr>`;
        }).join('');
        return `<!-- Deaths by cause -->
      <tr><td style="background:#111127;padding:24px 28px">
        <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#128700; Deaths by Cause &amp; Stage</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1e2035;border-radius:8px;overflow:hidden">
          <thead><tr><td style="padding:7px 10px;color:#94a3b8;font-size:11px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #1e2035">Stage</td>${hdr}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </td></tr>`;
      })() : ''}

      ${d.topTrays.length ? `
      <!-- Top trays -->
      <tr><td style="background:#111127;padding:24px 28px">
        <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#127942; Most Active Trays</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1e2035;border-radius:8px;overflow:hidden">${trayRows}</table>
      </td></tr>` : ''}

      ${speciesSection}

      <!-- Footer -->
      <tr><td style="background:#060610;border-radius:0 0 16px 16px;padding:22px 28px;text-align:center">
        <p style="margin:0 0 4px;color:#475569;font-size:12px">Generated by <b style="color:#7c3aed">NestTrak</b> &middot; ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</p>
        <p style="margin:0;color:#334155;font-size:11px">Precision colony management for professional breeders</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function newCohortCount(d) {
  const startYMD = toYMD(new Date(d.year, d.month - 1, 1));
  const endYMD   = toYMD(new Date(d.year, d.month, 0));
  return live('cohorts').filter(c => { const dt = normYMD(c.birthDate); return dt >= startYMD && dt <= endYMD; }).length;
}

function generateAnnualReportHTML(d) {
  const maxPop = Math.max(...d.months.map(m => m.popEnd), 1);

  const barCells = d.months.map((m, i) => {
    const h = Math.max(4, Math.round((m.popEnd / maxPop) * 80));
    const isPeak = m.popEnd === d.peakMonth.popEnd;
    return `
      <td style="vertical-align:bottom;text-align:center;padding:0 2px">
        <div style="background:${isPeak?'#a78bfa':'#312e81'};height:${h}px;border-radius:3px 3px 0 0;min-width:28px"></div>
        <div style="color:#64748b;font-size:9px;margin-top:4px;white-space:nowrap">${MONTH_SHORT[i]}</div>
        ${m.popEnd > 0 ? `<div style="color:${isPeak?'#a78bfa':'#475569'};font-size:9px;font-weight:700">${m.popEnd.toLocaleString()}</div>` : '<div style="font-size:9px">&nbsp;</div>'}
      </td>`;
  }).join('');

  const monthRows = d.months.map(m => {
    const netColor = m.growth > 0 ? '#22c55e' : m.growth < 0 ? '#ef4444' : '#94a3b8';
    return `
      <tr>
        <td style="padding:8px 12px;color:#94a3b8;font-size:12px;border-bottom:1px solid #1e2035;white-space:nowrap">${m.monthName}</td>
        <td style="padding:8px 12px;color:#34d399;font-size:12px;text-align:right;border-bottom:1px solid #1e2035;font-weight:600">${m.births||'—'}${m.intakes>0?`<span style="color:#60a5fa;font-size:10px;margin-left:4px">(+${m.intakes}i)</span>`:''}</td>
        <td style="padding:8px 12px;color:#fb923c;font-size:12px;text-align:right;border-bottom:1px solid #1e2035;font-weight:600">${m.totalRemoved||'—'}</td>
        <td style="padding:8px 12px;color:#2dd4bf;font-size:12px;text-align:right;border-bottom:1px solid #1e2035;font-weight:600">${m.frozenCount||'—'}</td>
        <td style="padding:8px 12px;font-size:12px;text-align:right;border-bottom:1px solid #1e2035;font-weight:700;color:${netColor}">${m.growth>=0?'+':''}${m.growth}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NestTrak Annual Summary &mdash; ${d.year}</title>
</head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a14">
  <tr><td align="center" style="padding:28px 16px">
    <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">

      <!-- Header -->
      <tr><td style="background:linear-gradient(135deg,#1e40af 0%,#7c3aed 50%,#db2777 100%);border-radius:16px 16px 0 0;padding:44px 32px 36px;text-align:center">
        <div style="font-size:52px;line-height:1;margin-bottom:12px">&#x1F4CA;</div>
        <h1 style="margin:0 0 8px;color:#fff;font-size:26px;font-weight:800;letter-spacing:-0.5px">Annual Colony Summary</h1>
        <p style="margin:0;color:rgba(255,255,255,0.85);font-size:15px">${d.year} &middot; Full Year Overview</p>
      </td></tr>

      <!-- Annual totals -->
      <tr><td style="background:#111127;padding:0">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="25%" style="padding:22px 10px;text-align:center;border-right:1px solid #1e2035">
              <div style="font-size:28px;font-weight:800;color:#a78bfa;font-variant-numeric:tabular-nums">${d.currentPop.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Current Pop.</div>
            </td>
            <td width="25%" style="padding:22px 10px;text-align:center;border-right:1px solid #1e2035">
              <div style="font-size:28px;font-weight:800;color:#34d399;font-variant-numeric:tabular-nums">${d.totalBirths.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Total Born</div>
            </td>
            <td width="25%" style="padding:22px 10px;text-align:center;border-right:1px solid #1e2035">
              <div style="font-size:28px;font-weight:800;color:#fb923c;font-variant-numeric:tabular-nums">${d.totalRemoved.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Total Removed</div>
            </td>
            <td width="25%" style="padding:22px 10px;text-align:center">
              <div style="font-size:28px;font-weight:800;color:#2dd4bf;font-variant-numeric:tabular-nums">${d.totalFrozen.toLocaleString()}</div>
              <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.07em;margin-top:5px">Frozen</div>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Population chart -->
      <tr><td style="background:#0f0f1e;padding:24px 28px">
        <h2 style="margin:0 0 16px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#128200; Population by Month</h2>
        <div style="overflow-x:auto">
          <table cellpadding="0" cellspacing="0" style="min-width:100%">
            <tr style="vertical-align:bottom;height:92px">${barCells}</tr>
          </table>
        </div>
      </td></tr>

      <!-- Year highlights -->
      <tr><td style="background:#111127;padding:24px 28px">
        <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#127942; Year Highlights</h2>
        <ul style="margin:0;padding-left:18px">
          <li style="margin:7px 0;color:#cbd5e1;line-height:1.65;font-size:14px">Peak population of <b style="color:#a78bfa">${d.peakMonth.popEnd.toLocaleString()}</b> in <b>${d.peakMonth.monthName}</b></li>
          <li style="margin:7px 0;color:#cbd5e1;line-height:1.65;font-size:14px">Most active month: <b>${d.mostActiveMonth.monthName}</b> with <b style="color:#fb923c">${d.mostActiveMonth.totalRemoved.toLocaleString()}</b> removals</li>
          <li style="margin:7px 0;color:#cbd5e1;line-height:1.65;font-size:14px">Total throughput — <b style="color:#34d399">${d.totalBirths.toLocaleString()} born</b> &middot; <b style="color:#fb923c">${d.totalRemoved.toLocaleString()} removed</b></li>
          ${d.totalFrozen > 0 ? `<li style="margin:7px 0;color:#cbd5e1;line-height:1.65;font-size:14px"><b style="color:#2dd4bf">${d.totalFrozen.toLocaleString()}</b> animals added to freezer across the year</li>` : ''}
        </ul>
      </td></tr>

      <!-- Month-by-month table -->
      <tr><td style="background:#0f0f1e;padding:24px 28px">
        <h2 style="margin:0 0 12px;color:#e2e8f0;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em">&#128197; Month-by-Month</h2>
        <div style="overflow-x:auto">
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #1e2035;border-radius:8px;overflow:hidden;min-width:420px">
            <tr style="background:#1e2035">
              <th style="padding:9px 12px;color:#64748b;font-size:10px;text-align:left;text-transform:uppercase;letter-spacing:.07em">Month</th>
              <th style="padding:9px 12px;color:#64748b;font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:.07em">Born</th>
              <th style="padding:9px 12px;color:#64748b;font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:.07em">Removed</th>
              <th style="padding:9px 12px;color:#64748b;font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:.07em">Frozen</th>
              <th style="padding:9px 12px;color:#64748b;font-size:10px;text-align:right;text-transform:uppercase;letter-spacing:.07em">Net</th>
            </tr>
            ${monthRows}
          </table>
        </div>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#060610;border-radius:0 0 16px 16px;padding:22px 28px;text-align:center">
        <p style="margin:0 0 4px;color:#475569;font-size:12px">Generated by <b style="color:#7c3aed">NestTrak</b> &middot; ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</p>
        <p style="margin:0;color:#334155;font-size:11px">Precision colony management for professional breeders</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

/* --- Actions --- */

function generateAndPreviewReport() {
  const type  = $('#rpt-type')?.value || 'monthly';
  const month = parseInt($('#rpt-month')?.value || new Date().getMonth() + 1, 10);
  const year  = parseInt(
    type === 'annual'
      ? ($('#rpt-year2')?.value || new Date().getFullYear())
      : ($('#rpt-year')?.value  || new Date().getFullYear()),
    10
  );

  const emailsVal = $('#rpt-emails')?.value?.trim();
  if (emailsVal) { state.meta.reportEmails = emailsVal; saveState(); }

  const data = type === 'annual' ? buildAnnualData(year) : buildMonthlyData(year, month);
  _reportHTML = type === 'annual' ? generateAnnualReportHTML(data) : generateMonthlyReportHTML(data);

  const frame = $('#rpt-frame');
  if (frame) {
    frame.srcdoc = _reportHTML;
  }
  $('#rpt-preview-wrap').style.display = '';

  const sb = $('#rpt-send-btn');
  if (sb) { sb.style.opacity = '1'; sb.style.pointerEvents = ''; }
  toast('Report generated');
}

function sendReportEmail(triggerEl) {
  if (!_reportHTML) return toast('Generate a report first', true);
  const emailsRaw = ($('#rpt-emails')?.value || '').trim();
  if (!emailsRaw) return toast('Enter at least one email address', true);
  const emails = emailsRaw.split(',').map(e => e.trim()).filter(Boolean);
  if (!emails.length) return toast('Enter valid email addresses', true);

  const type  = $('#rpt-type')?.value || 'monthly';
  const month = parseInt($('#rpt-month')?.value || new Date().getMonth() + 1, 10);
  const year  = parseInt(
    type === 'annual'
      ? ($('#rpt-year2')?.value || new Date().getFullYear())
      : ($('#rpt-year')?.value  || new Date().getFullYear()),
    10
  );
  const subject = type === 'annual'
    ? `NestTrak Annual Summary — ${year}`
    : `NestTrak Colony Report — ${MONTH_NAMES[month - 1]} ${year}`;

  if (!state.meta.scriptUrl) {
    const body = encodeURIComponent('This report is best viewed in HTML. Please use NestTrak to regenerate.');
    window.open(`mailto:${emails.join(',')}?subject=${encodeURIComponent(subject)}&body=${body}`);
    return toast('No Apps Script URL — opened mailto instead');
  }

  if (triggerEl) { triggerEl.textContent = 'Sending…'; triggerEl.style.pointerEvents = 'none'; }

  fetch(state.meta.scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify({ action: 'sendReport', to: emails, subject, html: _reportHTML })
  })
  .then(r => r.json())
  .then(resp => {
    if (resp.ok) toast(`&#9993; Report sent to ${emails.join(', ')}`);
    else throw new Error(resp.error || 'Unknown error');
  })
  .catch(err => toast(`Send failed: ${err.message}`, true))
  .finally(() => {
    if (triggerEl) { triggerEl.textContent = '✉ Send Report'; triggerEl.style.pointerEvents = ''; }
  });
}

/* ------------------------------------------------------------------ *
 *  Report schedule helpers
 * ------------------------------------------------------------------ */
const SCHEDULE_MS = { weekly: 7*86400000, monthly: 30*86400000, yearly: 365*86400000 };

function _reportNextDueLabel() {
  const s = state.meta.reportSchedule;
  if (!s || s === 'off') return null;
  const ms   = SCHEDULE_MS[s];
  const last = state.meta.reportLastSent || 0;
  const due  = new Date(last + ms);
  return due <= new Date() ? 'Overdue — will send on next open' : due.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

function _rptSaveSettings() {
  const emails   = $('#rpt-emails')?.value?.trim()   || '';
  const schedule = $('#rpt-schedule')?.value          || 'off';
  state.meta.reportEmails   = emails;
  state.meta.reportSchedule = schedule;
  saveState();
  toast('Report settings saved');
  renderReports();
}

function _rptSendNow(btn) {
  const emailsRaw = ($('#rpt-emails')?.value || state.meta.reportEmails || '').trim();
  if (emailsRaw) { state.meta.reportEmails = emailsRaw; saveState(); }
  const emails = emailsRaw.split(',').map(e => e.trim()).filter(Boolean);
  if (!emails.length) return toast('Enter at least one email address', true);

  const now = new Date();
  const d   = buildMonthlyData(now.getFullYear(), now.getMonth() + 1);
  const html = generateMonthlyReportHTML(d);
  const subject = `NestTrak Colony Report — ${d.monthName} ${d.year}`;

  if (btn) { btn.textContent = 'Sending…'; btn.style.pointerEvents = 'none'; }

  _sendReportHtml(emails, subject, html)
    .then(() => {
      state.meta.reportLastSent = Date.now();
      saveState();
      toast(`Report sent to ${emails.join(', ')}`);
      renderReports();
    })
    .catch(err => toast(`Send failed: ${err.message}`, true))
    .finally(() => { if (btn) { btn.textContent = '✉ Send now'; btn.style.pointerEvents = ''; } });
}

function _sendReportHtml(emails, subject, html) {
  if (!state.meta.scriptUrl) {
    const body = encodeURIComponent('This report is best viewed in HTML. Please use NestTrak to regenerate.');
    window.open(`mailto:${emails.join(',')}?subject=${encodeURIComponent(subject)}&body=${body}`);
    return Promise.resolve();
  }
  return fetch(state.meta.scriptUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify({ action: 'sendReport', to: emails, subject, html })
  }).then(r => r.json()).then(resp => {
    if (!resp.ok) throw new Error(resp.error || 'Unknown error');
  });
}

function checkAutoReport() {
  const s = state.meta.reportSchedule;
  if (!s || s === 'off') return;
  const emails = (state.meta.reportEmails || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!emails.length) return;
  const ms   = SCHEDULE_MS[s];
  const last = state.meta.reportLastSent || 0;
  if ((Date.now() - last) < ms) return;

  const now  = new Date();
  const d    = buildMonthlyData(now.getFullYear(), now.getMonth() + 1);
  const html = generateMonthlyReportHTML(d);
  const subject = `NestTrak Auto-Report — ${d.monthName} ${d.year}`;

  _sendReportHtml(emails, subject, html).then(() => {
    state.meta.reportLastSent = Date.now();
    saveState();
    console.log('Auto-report sent');
  }).catch(err => console.warn('Auto-report failed:', err));
}

/* ------------------------------------------------------------------ *
 *  Boot
 * ------------------------------------------------------------------ */
function init() {
  loadState();
  migrateTraySexData();
  // Run notification check shortly after boot (non-blocking)
  setTimeout(checkDueNotifications, 2000);
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
  setTimeout(checkAutoReport, 5000); // check after initial sync settles

  // Floating action button — quick add
  const fab = document.createElement('button');
  fab.className = 'fab'; fab.title = 'Quick add'; fab.textContent = '+';
  fab.onclick = () => { showTrayFabMenu(); };
  fab.style.display = activeTab === 'trays' ? '' : 'none';
  document.body.appendChild(fab);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
}

document.addEventListener('DOMContentLoaded', init);
