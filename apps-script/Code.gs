/**
 * NestTrak — Google Apps Script sync backend (v3)
 *
 * Sheets are clean and human-readable:
 *   • Internal sync columns (updatedAt, deleted, syncedAt) are hidden
 *   • Foreign-key ID columns are hidden; resolved names shown as extra columns
 *   • Headers are BOLD + ALL CAPS with a dark header row
 *   • Stages shown as readable text ("Pinky (0d) · Fuzzy (5d) · …")
 *
 * Deploy: Extensions › Apps Script › Deploy › New deployment ›
 *   Web app › Execute as "Me" › Access "Anyone" › Deploy
 * Paste the /exec URL into Settings › Apps Script URL.
 */

// ── schemas (internal field order — do NOT change) ──────────────────────────
var SCHEMAS = {
  species:  ['id', 'name', 'stages', 'lifespan', 'updatedAt', 'deleted', 'syncedAt'],
  shelves:  ['id', 'name', 'sortOrder', 'updatedAt', 'deleted', 'syncedAt'],
  trays:    ['id', 'shelfId', 'name', 'speciesId', 'gravidFemales', 'lactatingFemales', 'updatedAt', 'deleted', 'syncedAt'],
  cohorts:  ['id', 'trayId', 'speciesId', 'birthDate', 'initialCount', 'notes', 'males', 'females', 'updatedAt', 'deleted', 'syncedAt'],
  removals: ['id', 'cohortId', 'trayId', 'date', 'stage', 'count', 'males', 'females', 'updatedAt', 'deleted', 'syncedAt']
};
var ENTITIES = ['species', 'shelves', 'trays', 'cohorts', 'removals'];
var JSON_FIELDS = { stages: true };

// ── display configuration ────────────────────────────────────────────────────

// Human-readable caps label for each schema field
var COL_LABELS = {
  id: 'ID', name: 'NAME', stages: 'STAGES', lifespan: 'LIFESPAN (DAYS)', sortOrder: '_ORDER',
  updatedAt: '_UPDATED', deleted: '_DELETED', syncedAt: '_SYNCED',
  shelfId: '_SHELF ID', speciesId: '_SPECIES ID',
  trayId: '_TRAY ID', cohortId: '_COHORT ID',
  birthDate: 'BIRTH DATE', initialCount: 'COUNT', notes: 'NOTES',
  males: 'MALES', females: 'FEMALES', date: 'DATE', stage: 'STAGE', count: 'COUNT',
  gravidFemales: 'GRAVID ♀', lactatingFemales: 'LACTATING ♀'
};

// Extra resolved-name columns appended after the schema columns
var EXTRA = {
  species:  ['STAGE NAMES'],
  trays:    ['SHELF', 'SPECIES'],
  cohorts:  ['TRAY'],
  removals: ['TRAY']
};

// 1-based column indices to HIDE in each entity's sheet
// (data remains readable by the sync engine; users see only the clean columns)
var HIDE = {
  species:  [3, 5, 6, 7],              // STAGES(JSON), _UPDATED, _DELETED, _SYNCED
  shelves:  [1, 3, 4, 5, 6],           // ID(UUID), _ORDER, _UPDATED, _DELETED, _SYNCED
  trays:    [2, 7, 8, 9],              // _SHELF ID, _UPDATED, _DELETED, _SYNCED  (cols 5,6 = GRAVID/LACT visible)
  cohorts:  [1, 2, 3, 9, 10, 11],      // ID, _TRAY ID, _SPECIES ID, _UPDATED, _DELETED, _SYNCED
  removals: [1, 2, 3, 9, 10, 11]       // ID, _COHORT ID, _TRAY ID, _UPDATED, _DELETED, _SYNCED  (cols 7,8 = MALES/FEMALES visible)
};

// ── HTTP handlers ────────────────────────────────────────────────────────────

function doGet(e) {
  var since = e && e.parameter && e.parameter.since ? Number(e.parameter.since) : 0;
  return json({ ok: true, serverTime: Date.now(), changes: pullChanges(since), accepted: {} });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var body    = JSON.parse(e.postData.contents || '{}');
    var since   = Number(body.since) || 0;
    var changes = body.changes || {};
    var accepted = {};
    var serverNow = Date.now();

    ENTITIES.forEach(function(entity) {
      var incoming = changes[entity] || [];
      if (!incoming.length) return;
      accepted[entity] = upsertRecords(entity, incoming, serverNow);
    });

    updateTrayStageStats();

    return json({ ok: true, serverTime: serverNow, accepted: accepted, changes: pullChanges(since) });
  } catch (err) {
    return json({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ── sheet helpers ────────────────────────────────────────────────────────────

function sheetFor(entity) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(entity);
  if (!sh) {
    sh = ss.insertSheet(entity);
    setupSheet(sh, entity);
  } else {
    // Detect old-style sheets (headers were lowercase field names like 'id', 'name')
    var firstCell = sh.getLastRow() > 0 ? sh.getRange(1, 1).getValue() : '';
    if (firstCell !== 'ID') {
      sh.clear(); // wipe old data + formatting; app will re-sync from localStorage
      setupSheet(sh, entity);
    }
  }
  return sh;
}

function setupSheet(sh, entity) {
  var cols  = SCHEMAS[entity];
  var extra = EXTRA[entity] || [];
  var headers = cols.map(function(c) { return COL_LABELS[c] || c.toUpperCase(); }).concat(extra);
  var total = headers.length;

  sh.appendRow(headers);
  sh.setFrozenRows(1);

  // Bold, dark header row
  var hdr = sh.getRange(1, 1, 1, total);
  hdr.setFontWeight('bold');
  hdr.setBackground('#1a1a2e');
  hdr.setFontColor('#ffffff');
  hdr.setFontSize(10);

  // Hide internal columns so users see only meaningful data
  var hideCols = HIDE[entity] || [];
  hideCols.forEach(function(col1) {
    if (col1 <= total) sh.hideColumns(col1);
  });
}

function readAll(entity) {
  var sh   = sheetFor(entity);
  var cols = SCHEMAS[entity];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { sh: sh, cols: cols, rows: [], index: {} };
  // Read only the schema columns (extra display columns are beyond cols.length)
  var values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  var index  = {};
  var rows   = values.map(function(row, i) {
    var obj = {};
    cols.forEach(function(c, j) { obj[c] = row[j]; });
    index[String(obj.id)] = i + 2; // 1-based sheet row number
    return obj;
  });
  return { sh: sh, cols: cols, rows: rows, index: index };
}

// Build id→name maps for shelf/species/tray lookups when writing extra columns
function buildNameMaps() {
  var maps = { shelves: {}, species: {}, trays: {} };
  ['shelves', 'species', 'trays'].forEach(function(entity) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(entity);
    if (!sh || sh.getLastRow() < 2) return;
    var cols    = SCHEMAS[entity];
    var idIdx   = cols.indexOf('id');
    var nameIdx = cols.indexOf('name');
    if (idIdx < 0 || nameIdx < 0) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues().forEach(function(row) {
      var id = String(row[idIdx] || '');
      if (id) maps[entity][id] = row[nameIdx];
    });
  });
  return {
    shelfName:   function(id) { return maps.shelves[String(id || '')] || String(id || ''); },
    speciesName: function(id) { return maps.species[String(id || '')] || String(id || ''); },
    trayName:    function(id) { return maps.trays[String(id   || '')] || String(id || ''); }
  };
}

// Format stages array → "Pinky (0d) · Fuzzy (5d) · …"
function formatStages(stages) {
  var arr;
  if (Array.isArray(stages)) {
    arr = stages;
  } else {
    try { arr = JSON.parse(stages || '[]'); } catch(e) { arr = []; }
  }
  if (!arr || !arr.length) return '';
  return arr.map(function(s) {
    return (s.name || '') + ' (' + (s.days || 0) + 'd)';
  }).join(' · ');
}

function upsertRecords(entity, incoming, serverNow) {
  var data  = readAll(entity);
  var cols  = data.cols;
  var extra = EXTRA[entity] || [];
  var ctx   = extra.length ? buildNameMaps() : null;
  var acceptedIds = [];

  incoming.forEach(function(r) {
    if (!r || !r.id) return;
    var existingRow = data.index[String(r.id)];
    var existing    = existingRow ? data.rows[existingRow - 2] : null;

    // Last-write-wins by client-provided updatedAt
    if (existing && Number(existing.updatedAt) > Number(r.updatedAt)) return;

    r.syncedAt = serverNow;
    var rowValues = cols.map(function(c) {
      var v = r[c];
      if (JSON_FIELDS[c]) return JSON.stringify(v == null ? [] : v);
      if (c === 'deleted')  return r.deleted ? true : false;
      return v == null ? '' : v;
    });

    // Append resolved-name display columns
    if (ctx) {
      if (entity === 'species')  rowValues.push(formatStages(r.stages));
      if (entity === 'trays')    rowValues.push(ctx.shelfName(r.shelfId), ctx.speciesName(r.speciesId));
      if (entity === 'cohorts')  rowValues.push(ctx.trayName(r.trayId));
      if (entity === 'removals') rowValues.push(ctx.trayName(r.trayId));
    }

    if (existingRow) {
      data.sh.getRange(existingRow, 1, 1, rowValues.length).setValues([rowValues]);
    } else {
      data.sh.appendRow(rowValues);
      data.index[String(r.id)] = data.sh.getLastRow();
    }
    acceptedIds.push(r.id);
  });

  return acceptedIds;
}

function pullChanges(since) {
  var out = {};
  ENTITIES.forEach(function(entity) {
    var data    = readAll(entity);
    var changed = [];
    data.rows.forEach(function(row) {
      if (Number(row.syncedAt) > since) changed.push(hydrate(entity, row));
    });
    if (changed.length) out[entity] = changed;
  });
  return out;
}

function hydrate(entity, row) {
  var obj = {};
  SCHEMAS[entity].forEach(function(c) {
    var v = row[c];
    if (JSON_FIELDS[c]) {
      try { v = JSON.parse(v || '[]'); } catch(e) { v = []; }
    } else if (c === 'deleted') {
      v = (v === true || v === 'true' || v === 'TRUE');
    } else if (c === 'initialCount' || c === 'count' || c === 'sortOrder' ||
               c === 'males' || c === 'females' || c === 'updatedAt' || c === 'syncedAt' ||
               c === 'lifespan' || c === 'gravidFemales' || c === 'lactatingFemales') {
      v = (v === '' || v == null) ? 0 : Number(v);
    }
    obj[c] = v;
  });
  return obj;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Called after every POST sync. For each live tray row, writes the current
 * count of individuals in each stage into dedicated columns on the same row.
 * Adds missing stage columns automatically; never adds extra tray rows.
 */
function updateTrayStageStats() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var sh  = ss.getSheetByName('trays');
  if (!sh || sh.getLastRow() < 2) return;

  var now = new Date();

  // ── 1. Build species → ordered stages map ──────────────────────────────────
  var speciesMap = {}; // speciesId -> [{name, days}, ...]
  readAll('species').rows.forEach(function(sp) {
    if (sp.deleted) return;
    var stages = [];
    try { stages = Array.isArray(sp.stages) ? sp.stages : JSON.parse(sp.stages || '[]'); } catch(e) {}
    speciesMap[sp.id] = stages.slice().sort(function(a,b){ return (Number(a.days)||0)-(Number(b.days)||0); });
  });

  // Collect all stage names in day-order across all species (deduped)
  var allStages = [], seen = {};
  Object.values(speciesMap).forEach(function(stages) {
    stages.forEach(function(st) {
      if (st.name && !seen[st.name]) { seen[st.name] = true; allStages.push(st.name); }
    });
  });
  if (!allStages.length) return;

  // ── 2. Sum removals per cohort ─────────────────────────────────────────────
  var remByCohort = {};
  readAll('removals').rows.forEach(function(r) {
    if (r.deleted) return;
    remByCohort[r.cohortId] = (remByCohort[r.cohortId] || 0) + (Number(r.count) || 0);
  });

  // ── 3. Compute live stage counts per tray ──────────────────────────────────
  var trayStats = {}; // trayId -> { stageName -> count }
  readAll('cohorts').rows.forEach(function(c) {
    if (c.deleted) return;
    var net = (Number(c.initialCount) || 0) - (remByCohort[c.id] || 0);
    if (net <= 0) return;
    var stages = speciesMap[c.speciesId];
    if (!stages || !stages.length) return;

    var birthDate = new Date(c.birthDate);
    var ageDays   = Math.floor((now - birthDate) / 86400000);
    var stageName = stages[0].name;
    for (var i = stages.length - 1; i >= 0; i--) {
      if (ageDays >= (Number(stages[i].days) || 0)) { stageName = stages[i].name; break; }
    }

    if (!trayStats[c.trayId]) trayStats[c.trayId] = {};
    trayStats[c.trayId][stageName] = (trayStats[c.trayId][stageName] || 0) + net;
  });

  // ── 4. Find / add stage columns in the tray sheet ─────────────────────────
  // Stage count columns start right after schema + extra columns
  var fixedCols = SCHEMAS.trays.length + (EXTRA.trays || []).length; // 9
  var lastCol   = sh.getLastColumn();
  var headerVals = lastCol > fixedCols
    ? sh.getRange(1, fixedCols + 1, 1, lastCol - fixedCols).getValues()[0]
    : [];

  var stageColMap = {}; // stageName -> 1-based col index
  headerVals.forEach(function(h, i) {
    if (h) stageColMap[String(h)] = fixedCols + 1 + i;
  });

  // Add any stage columns that don't exist yet
  allStages.forEach(function(stageName) {
    if (!stageColMap[stageName]) {
      var newCol = sh.getLastColumn() + 1;
      var cell   = sh.getRange(1, newCol);
      cell.setValue(stageName);
      cell.setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
      stageColMap[stageName] = newCol;
    }
  });

  // ── 5. Write counts into each tray row (in-place, no new rows) ────────────
  var traysData = readAll('trays');
  traysData.rows.forEach(function(tray, i) {
    var rowNum = i + 2; // 1-based, +1 for header
    var counts = tray.deleted ? {} : (trayStats[tray.id] || {});
    allStages.forEach(function(stageName) {
      var col = stageColMap[stageName];
      if (col) sh.getRange(rowNum, col).setValue(counts[stageName] || 0);
    });
  });
}

/**
 * Run this ONCE from the Apps Script editor (Run › reformatSheets) after
 * updating HIDE to fix column visibility on existing sheets without losing data.
 */
function reformatSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  ENTITIES.forEach(function(entity) {
    var sh = ss.getSheetByName(entity);
    if (!sh) return;
    var cols  = SCHEMAS[entity];
    var extra = EXTRA[entity] || [];
    var total = cols.length + extra.length;
    // First show all columns, then re-hide according to updated HIDE config
    sh.showColumns(1, total);
    var hideCols = HIDE[entity] || [];
    hideCols.forEach(function(col1) {
      if (col1 <= total) sh.hideColumns(col1);
    });
  });
  SpreadsheetApp.getUi().alert('Done! Column visibility updated on all sheets.');
}
