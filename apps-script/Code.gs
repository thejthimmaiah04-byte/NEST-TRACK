/**
 * NestTrak — Google Apps Script sync backend (v4)
 *
 * Sheet tabs:  Species | Shelves | Trays | Birth | Removal
 * No UUIDs, no timestamps shown — only human-readable data.
 *
 * Deploy: Extensions › Apps Script › Deploy › New deployment
 *   Web app · Execute as "Me" · Access "Anyone" · Deploy
 * Paste the /exec URL into Settings › Apps Script URL in the app.
 *
 * After pasting this code, run  reformatSheets()  ONCE from the editor
 * (click the function name → Run) to rename & clean existing sheets.
 */

// ── Sheet tab names ───────────────────────────────────────────────────────────
var SHEET_NAMES = {
  species:  'Species',
  shelves:  'Shelves',
  trays:    'Trays',
  cohorts:  'Birth',
  removals: 'Removal'
};

// ── Internal schemas (column order — do NOT change) ───────────────────────────
var SCHEMAS = {
  species:  ['id', 'name', 'stages', 'lifespan', 'updatedAt', 'deleted', 'syncedAt'],
  shelves:  ['id', 'name', 'sortOrder', 'updatedAt', 'deleted', 'syncedAt'],
  trays:    ['id', 'shelfId', 'name', 'speciesId', 'gravidFemales', 'lactatingFemales', 'updatedAt', 'deleted', 'syncedAt'],
  cohorts:  ['id', 'trayId', 'speciesId', 'birthDate', 'initialCount', 'notes', 'males', 'females', 'updatedAt', 'deleted', 'syncedAt'],
  removals: ['id', 'cohortId', 'trayId', 'date', 'stage', 'count', 'males', 'females', 'updatedAt', 'deleted', 'syncedAt']
};
var ENTITIES = ['species', 'shelves', 'trays', 'cohorts', 'removals'];
var JSON_FIELDS = { stages: true };

// ── Column header labels  (_ prefix = will be hidden) ────────────────────────
var COL_LABELS = {
  id: '_ID', name: 'NAME', stages: '_STAGES_JSON', lifespan: 'LIFESPAN (DAYS)',
  sortOrder: '_ORDER', updatedAt: '_UPDATED', deleted: '_DELETED', syncedAt: '_SYNCED',
  shelfId: '_SHELF ID', speciesId: '_SPECIES ID', trayId: '_TRAY ID', cohortId: '_COHORT ID',
  birthDate: 'DATE', initialCount: 'COUNT', notes: 'NOTES',
  males: '♂', females: '♀', date: 'DATE', stage: 'STAGE', count: 'REMOVED',
  gravidFemales: 'GRAVID ♀', lactatingFemales: 'LACTATING ♀',
  adultMales: '♂ ADULTS', adultFemales: '♀ ADULTS'
};

// ── Extra human-readable columns (appended after schema cols) ─────────────────
// Species  : STAGES  = "Pinky 10d · Fuzzy 12d · Hopper 5d · Adult"
// Shelves  : TRAYS   = count of live trays on this shelf (computed)
// Trays    : SPECIES = 3-letter code e.g. MOU  (then dynamic stage cols follow)
// Birth    : TRAY    = tray name e.g. A-3
// Removal  : TRAY    = tray name
var EXTRA = {
  species:  ['STAGES'],
  shelves:  ['TRAYS'],
  trays:    ['SPECIES'],
  cohorts:  ['TRAY'],
  removals: ['TRAY']
};

// ── Which columns to HIDE (1-based) ──────────────────────────────────────────
// Species  cols: _ID(1) NAME(2) _JSON(3) LIFESPAN(4) _UPD(5) _DEL(6) _SYN(7) | STAGES(8)
// Shelves  cols: _ID(1) NAME(2) _ORD(3) _UPD(4) _DEL(5) _SYN(6)               | TRAYS(7)
// Trays    cols: _ID(1) _SHF(2) NAME(3) _SPID(4) GRAVID(5) LACT(6) _UPD(7) _DEL(8) _SYN(9) | SPECIES(10) ♂ADULTS(11) ♀ADULTS(12) stage_cols(13+)
// Birth    cols: _ID(1) _TRAY(2) _SP(3) DATE(4) COUNT(5) NOTES(6) ♂(7) ♀(8) _UPD(9) _DEL(10) _SYN(11) | TRAY(12)
// Removal  cols: _ID(1) _COH(2) _TRAY(3) DATE(4) STAGE(5) REMOVED(6) ♂(7) ♀(8) _UPD(9) _DEL(10) _SYN(11) | TRAY(12)
var HIDE = {
  species:  [1, 3, 5, 6, 7],       // show: NAME | LIFESPAN | STAGES
  shelves:  [1, 3, 4, 5, 6],       // show: NAME | TRAYS
  trays:    [1, 2, 4, 7, 8, 9],    // show: NAME | GRAVID ♀ | LACTATING ♀ | SPECIES | ♂ ADULTS | ♀ ADULTS | [stage cols]
  cohorts:  [1, 2, 3, 9, 10, 11],  // show: DATE | COUNT | NOTES | ♂ | ♀ | TRAY
  removals: [1, 2, 3, 9, 10, 11]   // show: DATE | STAGE | REMOVED | ♂ | ♀ | TRAY
};

// ── HTTP handlers ─────────────────────────────────────────────────────────────

function doGet(e) {
  var since = e && e.parameter && e.parameter.since ? Number(e.parameter.since) : 0;
  return json({ ok: true, serverTime: Date.now(), changes: pullChanges(since), accepted: {} });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var body     = JSON.parse(e.postData.contents || '{}');
    var since    = Number(body.since) || 0;
    var changes  = body.changes || {};
    var accepted = {};
    var serverNow = Date.now();

    ENTITIES.forEach(function(entity) {
      var incoming = changes[entity] || [];
      if (!incoming.length) return;
      accepted[entity] = upsertRecords(entity, incoming, serverNow);
    });

    updateTrayStageStats();
    updateShelfStats();

    return json({ ok: true, serverTime: serverNow, accepted: accepted, changes: pullChanges(since) });
  } catch (err) {
    return json({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function sheetFor(entity) {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = SHEET_NAMES[entity];
  var sh        = ss.getSheetByName(sheetName);
  if (!sh) {
    // Rename old-style sheet (e.g. 'trays' → 'Trays') if it exists
    var oldSh = ss.getSheetByName(entity);
    if (oldSh) {
      oldSh.setName(sheetName);
      sh = oldSh;
    } else {
      sh = ss.insertSheet(sheetName);
      setupSheet(sh, entity);
    }
  }
  return sh;
}

function setupSheet(sh, entity) {
  var cols    = SCHEMAS[entity];
  var extra   = EXTRA[entity] || [];
  var headers = cols.map(function(c) { return COL_LABELS[c] || c.toUpperCase(); }).concat(extra);
  var total   = headers.length;

  sh.appendRow(headers);
  sh.setFrozenRows(1);

  var hdr = sh.getRange(1, 1, 1, total);
  hdr.setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);

  (HIDE[entity] || []).forEach(function(col1) {
    if (col1 <= total) sh.hideColumns(col1);
  });
}

function readAll(entity) {
  var sh      = sheetFor(entity);
  var cols    = SCHEMAS[entity];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { sh: sh, cols: cols, rows: [], index: {} };
  var values  = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  var index   = {};
  var rows    = values.map(function(row, i) {
    var obj = {};
    cols.forEach(function(c, j) { obj[c] = row[j]; });
    index[String(obj.id)] = i + 2;
    return obj;
  });
  return { sh: sh, cols: cols, rows: rows, index: index };
}

// id→display-name maps used when writing extra resolved columns
function buildNameMaps() {
  var maps = { shelves: {}, species: {}, trays: {} };
  ['shelves', 'species', 'trays'].forEach(function(entity) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAMES[entity]);
    if (!sh || sh.getLastRow() < 2) return;
    var cols    = SCHEMAS[entity];
    var idIdx   = cols.indexOf('id');
    var nameIdx = cols.indexOf('name');
    if (idIdx < 0 || nameIdx < 0) return;
    sh.getRange(2, 1, sh.getLastRow() - 1, cols.length).getValues().forEach(function(row) {
      var id = String(row[idIdx] || '');
      if (!id) return;
      var nm = String(row[nameIdx] || '');
      // Species: use 3-letter code (MOU for Mouse, RAT for Rat, etc.)
      maps[entity][id] = entity === 'species'
        ? nm.replace(/[^A-Za-z]/g, '').substring(0, 3).toUpperCase() || nm
        : nm;
    });
  });

  // Fallback: if only one species exists, use it for any unresolved speciesId
  var speciesKeys = Object.keys(maps.species);
  var singleSpeciesCode = speciesKeys.length === 1 ? maps.species[speciesKeys[0]] : null;

  return {
    shelfName:   function(id) { return maps.shelves[String(id || '')] || ''; },
    speciesName: function(id) {
      return maps.species[String(id || '')] || singleSpeciesCode || '';
    },
    trayName:    function(id) { return maps.trays[String(id || '')] || ''; }
  };
}

// "Pinky 10d · Fuzzy 12d · Hopper 5d · Adult"
function formatStages(stages) {
  var arr;
  if (Array.isArray(stages)) { arr = stages; }
  else { try { arr = JSON.parse(stages || '[]'); } catch(e) { arr = []; } }
  if (!arr || !arr.length) return '';
  return arr.map(function(s) {
    return (s.name || '') + ' ' + (s.days || 0) + 'd';
  }).join(' · ');
}

function upsertRecords(entity, incoming, serverNow) {
  var data        = readAll(entity);
  var cols        = data.cols;
  var extra       = EXTRA[entity] || [];
  var ctx         = extra.length ? buildNameMaps() : null;
  var acceptedIds = [];

  incoming.forEach(function(r) {
    if (!r || !r.id) return;
    var existingRow = data.index[String(r.id)];
    var existing    = existingRow ? data.rows[existingRow - 2] : null;

    if (existing && Number(existing.updatedAt) > Number(r.updatedAt)) return;

    r.syncedAt = serverNow;
    var rowValues = cols.map(function(c) {
      var v = r[c];
      if (JSON_FIELDS[c]) return JSON.stringify(v == null ? [] : v);
      if (c === 'deleted')  return r.deleted ? true : false;
      return v == null ? '' : v;
    });

    if (ctx) {
      if (entity === 'species')  rowValues.push(formatStages(r.stages));
      if (entity === 'shelves')  rowValues.push('');  // computed by updateShelfStats
      if (entity === 'trays')    rowValues.push(ctx.speciesName(r.speciesId));
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
  var fullPull = (since === 0);
  ENTITIES.forEach(function(entity) {
    var data    = readAll(entity);
    var changed = [];
    data.rows.forEach(function(row) {
      if (fullPull || Number(row.syncedAt) > since) changed.push(hydrate(entity, row));
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
    } else if (['initialCount','count','sortOrder','males','females',
                'updatedAt','syncedAt','lifespan','gravidFemales','lactatingFemales'].indexOf(c) >= 0) {
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

// ── Computed stats ────────────────────────────────────────────────────────────

/**
 * After every sync: writes live stage counts into the Trays sheet.
 * Stage columns are auto-created at col 11+ (after 9 schema + 1 SPECIES col).
 * One row per tray — updated in place, never duplicated.
 */
function updateTrayStageStats() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAMES.trays);
  if (!sh || sh.getLastRow() < 2) return;

  var now = new Date();

  // Build speciesId → sorted stages map
  var speciesMap = {};
  var fallbackStages = null;
  readAll('species').rows.forEach(function(sp) {
    if (sp.deleted) return;
    var stages = [];
    try { stages = Array.isArray(sp.stages) ? sp.stages : JSON.parse(sp.stages || '[]'); } catch(e) {}
    stages = stages.slice().sort(function(a,b){ return (Number(a.days)||0)-(Number(b.days)||0); });
    speciesMap[sp.id] = stages;
    fallbackStages = stages; // last-one-wins fallback for ID-mismatch trays
  });

  var allStages = [], seenSt = {};
  Object.keys(speciesMap).forEach(function(sid) {
    speciesMap[sid].forEach(function(st) {
      if (st.name && !seenSt[st.name]) { seenSt[st.name] = true; allStages.push(st.name); }
    });
  });
  if (!allStages.length) return;

  // Sum removals per cohort (count, males, females)
  var remByCohort = {}, remMaleByCohort = {}, remFemByCohort = {};
  readAll('removals').rows.forEach(function(r) {
    if (r.deleted) return;
    remByCohort[r.cohortId]    = (remByCohort[r.cohortId]    || 0) + (Number(r.count)   || 0);
    remMaleByCohort[r.cohortId] = (remMaleByCohort[r.cohortId] || 0) + (Number(r.males)  || 0);
    remFemByCohort[r.cohortId]  = (remFemByCohort[r.cohortId]  || 0) + (Number(r.females)|| 0);
  });

  // Compute live stage counts and adult sex counts per tray
  var trayStats = {}, trayAdultM = {}, trayAdultF = {};
  readAll('cohorts').rows.forEach(function(c) {
    if (c.deleted) return;
    var net = (Number(c.initialCount) || 0) - (remByCohort[c.id] || 0);
    if (net <= 0) return;
    var stages = speciesMap[c.speciesId] || fallbackStages;
    if (!stages || !stages.length) return;

    var ageDays   = Math.floor((now - new Date(c.birthDate)) / 86400000);
    var stageName = stages[0].name;
    for (var i = stages.length - 1; i >= 0; i--) {
      if (ageDays >= (Number(stages[i].days) || stages[i].startDay || 0)) { stageName = stages[i].name; break; }
    }
    if (!trayStats[c.trayId]) trayStats[c.trayId] = {};
    trayStats[c.trayId][stageName] = (trayStats[c.trayId][stageName] || 0) + net;

    // Adult sex tracking (only last stage, only if sex was entered)
    var lastStageName = stages[stages.length - 1].name;
    if (stageName === lastStageName && (c.males !== '' && c.males != null || c.females !== '' && c.females != null)) {
      var m = Math.max(0, (Number(c.males) || 0) - (remMaleByCohort[c.id] || 0));
      var f = Math.max(0, (Number(c.females) || 0) - (remFemByCohort[c.id] || 0));
      trayAdultM[c.trayId] = (trayAdultM[c.trayId] || 0) + m;
      trayAdultF[c.trayId] = (trayAdultF[c.trayId] || 0) + f;
    }
  });

  // Stage cols start at fixedCols + 1  (schema=9, EXTRA=['SPECIES']=1 → fixed=10, stages at 11+)
  var fixedCols   = SCHEMAS.trays.length + (EXTRA.trays || []).length; // 10
  var lastCol     = sh.getLastColumn();
  var headerVals  = lastCol > fixedCols
    ? sh.getRange(1, fixedCols + 1, 1, lastCol - fixedCols).getValues()[0]
    : [];

  var stageColMap = {};
  headerVals.forEach(function(h, i) {
    if (h) stageColMap[String(h)] = fixedCols + 1 + i;
  });

  allStages.forEach(function(stageName) {
    if (!stageColMap[stageName]) {
      var newCol = sh.getLastColumn() + 1;
      var cell   = sh.getRange(1, newCol);
      cell.setValue(stageName);
      cell.setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
      stageColMap[stageName] = newCol;
    }
  });

  // ♂ ADULTS and ♀ ADULTS cols — find by header or create after stage cols
  var lastColNow = sh.getLastColumn();
  var mAdultsCol = 0, fAdultsCol = 0;
  if (lastColNow > 0) {
    var allHdrs = sh.getRange(1, 1, 1, lastColNow).getValues()[0];
    allHdrs.forEach(function(h, i) {
      if (String(h) === '♂ ADULTS') mAdultsCol = i + 1;
      if (String(h) === '♀ ADULTS') fAdultsCol = i + 1;
    });
  }
  if (!mAdultsCol) {
    mAdultsCol = sh.getLastColumn() + 1;
    sh.getRange(1, mAdultsCol).setValue('♂ ADULTS')
      .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
  }
  if (!fAdultsCol) {
    fAdultsCol = sh.getLastColumn() + 1;
    sh.getRange(1, fAdultsCol).setValue('♀ ADULTS')
      .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
  }

  var traysData = readAll('trays');
  traysData.rows.forEach(function(tray, i) {
    var rowNum = i + 2;
    var counts = tray.deleted ? {} : (trayStats[tray.id] || {});
    allStages.forEach(function(stageName) {
      var col = stageColMap[stageName];
      if (col) sh.getRange(rowNum, col).setValue(counts[stageName] || 0);
    });
    sh.getRange(rowNum, mAdultsCol).setValue(tray.deleted ? '' : (trayAdultM[tray.id] != null ? trayAdultM[tray.id] : ''));
    sh.getRange(rowNum, fAdultsCol).setValue(tray.deleted ? '' : (trayAdultF[tray.id] != null ? trayAdultF[tray.id] : ''));
  });
}

/**
 * After every sync: writes live tray count into the Shelves sheet (TRAYS col).
 */
function updateShelfStats() {
  var shelfData   = readAll('shelves');
  if (!shelfData.rows.length) return;
  var sh          = shelfData.sh;
  var traysColIdx = SCHEMAS.shelves.length + 1; // col 7

  var trayCounts = {};
  readAll('trays').rows.forEach(function(t) {
    if (!t.deleted) trayCounts[t.shelfId] = (trayCounts[t.shelfId] || 0) + 1;
  });

  shelfData.rows.forEach(function(shelf, i) {
    if (!shelf.deleted) sh.getRange(i + 2, traysColIdx).setValue(trayCounts[shelf.id] || 0);
  });
}

// ── One-time migration ────────────────────────────────────────────────────────

/**
 * Run ONCE from the Apps Script editor after pasting this v4 code.
 *
 * What it does:
 *  1. Renames tabs: species→Species, shelves→Shelves, trays→Trays,
 *                   cohorts→Birth, removals→Removal
 *  2. Removes the old SHELF extra column from Trays (was col 10; SPECIES shifts left)
 *  3. Refreshes the SPECIES code in col 10 for every tray row
 *  4. Re-applies HIDE on every sheet (hides all UUIDs and timestamps)
 *  5. Computes Shelves TRAYS count and Trays stage counts
 */
function reformatSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Rename tabs — if target already exists, delete the (empty) old-name sheet
  var renames = { species:'Species', shelves:'Shelves', trays:'Trays', cohorts:'Birth', removals:'Removal' };
  Object.keys(renames).forEach(function(oldName) {
    var oldSh  = ss.getSheetByName(oldName);
    var newSh  = ss.getSheetByName(renames[oldName]);
    if (!oldSh) return;          // nothing to rename
    if (newSh) {
      // Target already exists — delete the old-name duplicate if it has no data rows
      if (oldSh.getLastRow() <= 1) ss.deleteSheet(oldSh);
      // else keep it; user can merge manually
    } else {
      oldSh.setName(renames[oldName]);
    }
  });

  // 2. Remove old SHELF extra column from Trays if present
  var traysSh = ss.getSheetByName('Trays');
  if (traysSh && traysSh.getLastColumn() >= 10) {
    var h10 = String(traysSh.getRange(1, 10).getValue());
    if (h10 === 'SHELF') traysSh.deleteColumn(10); // SPECIES shifts 11→10, stages shift 12+→11+
  }

  // 3. Refresh SPECIES code in col 10 for all tray rows
  var traysSh2 = ss.getSheetByName('Trays');
  if (traysSh2 && traysSh2.getLastRow() > 1) {
    var ctx = buildNameMaps();
    var speciesColIdx = SCHEMAS.trays.length + 1; // col 10
    readAll('trays').rows.forEach(function(tray, i) {
      var code = ctx.speciesName(tray.speciesId);
      traysSh2.getRange(i + 2, speciesColIdx).setValue(code);
    });
  }

  // 4. Re-apply HIDE on all sheets
  ENTITIES.forEach(function(entity) {
    var sh = ss.getSheetByName(SHEET_NAMES[entity]);
    if (!sh || sh.getLastColumn() < 1) return;
    sh.showColumns(1, sh.getLastColumn());
    (HIDE[entity] || []).forEach(function(col1) {
      if (col1 <= sh.getLastColumn()) sh.hideColumns(col1);
    });
  });

  // 5. Recompute stats
  updateShelfStats();
  updateTrayStageStats();

  try {
    SpreadsheetApp.getUi().alert(
      'Done!\n\n' +
      'Sheets renamed: Species · Shelves · Trays · Birth · Removal\n' +
      'All UUID and timestamp columns hidden.\n\n' +
      'Trigger a sync from the app to refresh any data.'
    );
  } catch(e) {}
}
