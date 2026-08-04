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
// Per-entity header overrides (applied on top of COL_LABELS for that entity only)
var COL_LABEL_OVERRIDES = {
  trays: { name: 'TRAY ID' }
};

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
// Species  : STAGES  = "Pinky 0d · Fuzzy 5d · Hopper 10d · Adult 21d"
//            SEX RATIO = "1♂ : 3♀"   PINKY / FUZZY / HOPPER / ADULT = start day
// Shelves  : TRAYS   = count of live trays on this shelf (computed)
// Trays    : SPECIES = 3-letter code e.g. MOU  (then dynamic stage cols follow)
// Birth    : TRAY    = tray name e.g. A-3 | SPECIES = 3-letter code
// Removal  : TRAY    = tray name
var EXTRA = {
  species:  ['STAGES', 'SEX RATIO', 'PINKY', 'FUZZY', 'HOPPER', 'ADULT'],
  shelves:  ['TRAYS'],
  trays:    ['SPECIES'],
  cohorts:  ['TRAY', 'SPECIES'],
  removals: ['TRAY']
};

// ── Which columns to HIDE (1-based) ──────────────────────────────────────────
// Species  cols: _ID(1) NAME(2) _JSON(3) LIFESPAN(4) _UPD(5) _DEL(6) _SYN(7) | STAGES(8) SEX RATIO(9) PINKY(10) FUZZY(11) HOPPER(12) ADULT(13)
// Shelves  cols: _ID(1) NAME(2) _ORD(3) _UPD(4) _DEL(5) _SYN(6)               | TRAYS(7)
// Trays    cols: _ID(1) _SHF(2) NAME(3) _SPID(4) GRAVID(5) LACT(6) _UPD(7) _DEL(8) _SYN(9) | SPECIES(10) ♂ADULTS(11) ♀ADULTS(12) stage_cols(13+)
// Birth    cols: _ID(1) _TRAY(2) _SP(3) DATE(4) COUNT(5) NOTES(6) ♂(7) ♀(8) _UPD(9) _DEL(10) _SYN(11) | TRAY(12) SPECIES(13)
// Removal  cols: _ID(1) _COH(2) _TRAY(3) DATE(4) STAGE(5) REMOVED(6) ♂(7) ♀(8) _UPD(9) _DEL(10) _SYN(11) | TRAY(12)
var HIDE = {
  species:  [1, 3, 5, 6, 7],           // show: NAME | LIFESPAN | STAGES | SEX RATIO | PINKY | FUZZY | HOPPER | ADULT
  shelves:  [1, 3, 4, 5, 6],           // show: NAME | TRAYS
  trays:    [1, 2, 4, 7, 8, 9],        // show: NAME | GRAVID ♀ | LACTATING ♀ | SPECIES | ♂ ADULTS | ♀ ADULTS | [stage cols]
  cohorts:  [1, 2, 3, 7, 8, 9, 10, 11], // show: DATE | COUNT | NOTES | TRAY | SPECIES (♂/♀ hidden — tracked in Trays sheet)
  removals: [1, 2, 3, 9, 10, 11]       // show: DATE | STAGE | REMOVED | ♂ | ♀ | TRAY
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
    var oldSh = ss.getSheetByName(entity);
    if (oldSh) {
      // Delete the old-name sheet if the target already exists (shouldn't reach here, but safety)
      try { oldSh.setName(sheetName); sh = oldSh; } catch(e) {
        if (oldSh.getLastRow() <= 1) ss.deleteSheet(oldSh);
        sh = ss.getSheetByName(sheetName);
        if (!sh) { sh = ss.insertSheet(sheetName); setupSheet(sh, entity); }
      }
    } else {
      sh = ss.insertSheet(sheetName);
      setupSheet(sh, entity);
    }
  }
  return sh;
}

function setupSheet(sh, entity) {
  var cols      = SCHEMAS[entity];
  var extra     = EXTRA[entity] || [];
  var overrides = COL_LABEL_OVERRIDES[entity] || {};
  var headers   = cols.map(function(c) { return overrides[c] || COL_LABELS[c] || c.toUpperCase(); }).concat(extra);
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

// "Pinky 0d · Fuzzy 5d · Hopper 10d · Adult 21d"
function formatStages(stages) {
  var arr;
  if (Array.isArray(stages)) { arr = stages; }
  else { try { arr = JSON.parse(stages || '[]'); } catch(e) { arr = []; } }
  if (!arr || !arr.length) return '';
  return arr.map(function(s) {
    return (s.name || '') + ' ' + (Number(s.startDay || s.days || 0)) + 'd';
  }).join(' · ');
}

// Extract per-stage start day value from a stages array, by stage name (case-insensitive)
function stageStartDay(stages, stageName) {
  for (var i = 0; i < stages.length; i++) {
    if ((stages[i].name || '').toLowerCase() === stageName.toLowerCase()) {
      return Number(stages[i].startDay || stages[i].days || 0);
    }
  }
  return null;
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
      if (entity === 'species') {
        var stagesArr = [];
        try { stagesArr = Array.isArray(r.stages) ? r.stages : JSON.parse(r.stages || '[]'); } catch(e) {}
        rowValues.push(formatStages(stagesArr)); // STAGES summary
        // SEX RATIO: "1♂ : 3♀"
        rowValues.push(r.ratio ? (r.ratio.males + '♂ : ' + r.ratio.females + '♀') : '');
        // Individual stage start-day cols
        var sd = function(name) { var d = stageStartDay(stagesArr, name); return d !== null ? d + 'd+' : ''; };
        rowValues.push(sd('Pinky'));
        rowValues.push(sd('Fuzzy'));
        rowValues.push(sd('Hopper'));
        rowValues.push(sd('Adult'));
      }
      if (entity === 'shelves')  rowValues.push('');  // computed by updateShelfStats
      if (entity === 'trays')    rowValues.push(ctx.speciesName(r.speciesId));
      if (entity === 'cohorts')  { rowValues.push(ctx.trayName(r.trayId)); rowValues.push(ctx.speciesName(r.speciesId)); }
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
  // Sum removals per cohort (count, males, females)
  var remByCohort = {}, remMaleByCohort = {}, remFemByCohort = {};
  readAll('removals').rows.forEach(function(r) {
    if (r.deleted) return;
    remByCohort[r.cohortId]     = (remByCohort[r.cohortId]     || 0) + (Number(r.count)   || 0);
    remMaleByCohort[r.cohortId] = (remMaleByCohort[r.cohortId] || 0) + (Number(r.males)   || 0);
    remFemByCohort[r.cohortId]  = (remFemByCohort[r.cohortId]  || 0) + (Number(r.females) || 0);
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

    var lastStageName = stages[stages.length - 1].name;
    if (stageName === lastStageName && (c.males !== '' && c.males != null || c.females !== '' && c.females != null)) {
      var m = Math.max(0, (Number(c.males) || 0) - (remMaleByCohort[c.id] || 0));
      var f = Math.max(0, (Number(c.females) || 0) - (remFemByCohort[c.id] || 0));
      trayAdultM[c.trayId] = (trayAdultM[c.trayId] || 0) + m;
      trayAdultF[c.trayId] = (trayAdultF[c.trayId] || 0) + f;
    }
  });

  // ── Always create ♂ ADULTS / ♀ ADULTS columns ──
  var fixedCols = SCHEMAS.trays.length + (EXTRA.trays || []).length; // 10
  function findOrCreateCol(label) {
    var lc = sh.getLastColumn();
    if (lc > 0) {
      var hdrs = sh.getRange(1, 1, 1, lc).getValues()[0];
      for (var hi = 0; hi < hdrs.length; hi++) {
        if (String(hdrs[hi]) === label) return hi + 1;
      }
    }
    var nc = sh.getLastColumn() + 1;
    sh.getRange(1, nc).setValue(label)
      .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
    return nc;
  }
  var mAdultsCol = findOrCreateCol('♂ ADULTS');
  var fAdultsCol = findOrCreateCol('♀ ADULTS');

  // ── Stage columns (only if species have stages defined) ──
  var stageColMap = {};
  if (allStages.length) {
    var lastCol    = sh.getLastColumn();
    var headerVals = lastCol > fixedCols
      ? sh.getRange(1, fixedCols + 1, 1, lastCol - fixedCols).getValues()[0]
      : [];
    headerVals.forEach(function(h, i) {
      if (h) stageColMap[String(h)] = fixedCols + 1 + i;
    });
    allStages.forEach(function(sn) {
      if (!stageColMap[sn]) {
        var newCol = sh.getLastColumn() + 1;
        sh.getRange(1, newCol).setValue(sn)
          .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
        stageColMap[sn] = newCol;
      }
    });
  }

  // ── Write all data rows ──
  var traysData = readAll('trays');
  traysData.rows.forEach(function(tray, i) {
    var rowNum = i + 2;
    if (tray.deleted) {
      sh.getRange(rowNum, mAdultsCol).setValue('');
      sh.getRange(rowNum, fAdultsCol).setValue('');
      return;
    }
    sh.getRange(rowNum, mAdultsCol).setValue(trayAdultM[tray.id] != null ? trayAdultM[tray.id] : 0);
    sh.getRange(rowNum, fAdultsCol).setValue(trayAdultF[tray.id] != null ? trayAdultF[tray.id] : 0);
    var counts = trayStats[tray.id] || {};
    allStages.forEach(function(sn) {
      var col = stageColMap[sn];
      if (col) sh.getRange(rowNum, col).setValue(counts[sn] || 0);
    });
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

  // 3. Refresh extra resolved columns: SPECIES in Trays (col 10) and TRAY+SPECIES in Birth
  var ctx2 = buildNameMaps();
  var traysSh2 = ss.getSheetByName('Trays');
  if (traysSh2 && traysSh2.getLastRow() > 1) {
    var traySpeciesCol = SCHEMAS.trays.length + 1; // col 10
    readAll('trays').rows.forEach(function(tray, i) {
      traysSh2.getRange(i + 2, traySpeciesCol).setValue(ctx2.speciesName(tray.speciesId));
    });
  }
  // Ensure Birth sheet has TRAY + SPECIES extra header cols and fill them
  var birthSh = ss.getSheetByName(SHEET_NAMES.cohorts);
  if (birthSh) {
    var birthFixedCols = SCHEMAS.cohorts.length; // 11
    var birthTrayCol    = birthFixedCols + 1;    // 12
    var birthSpeciesCol = birthFixedCols + 2;    // 13
    var birthLastCol = birthSh.getLastColumn();
    if (birthLastCol < birthTrayCol) {
      birthSh.getRange(1, birthTrayCol).setValue('TRAY')
        .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
    }
    if (birthLastCol < birthSpeciesCol) {
      birthSh.getRange(1, birthSpeciesCol).setValue('SPECIES')
        .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
    }
    if (birthSh.getLastRow() > 1) {
      readAll('cohorts').rows.forEach(function(c, i) {
        birthSh.getRange(i + 2, birthTrayCol).setValue(ctx2.trayName(c.trayId));
        birthSh.getRange(i + 2, birthSpeciesCol).setValue(ctx2.speciesName(c.speciesId));
      });
    }
  }

  // 3a. Ensure Species sheet has new extra columns (SEX RATIO, PINKY, FUZZY, HOPPER, ADULT)
  var speciesSh = ss.getSheetByName(SHEET_NAMES.species);
  if (speciesSh) {
    var spSchemaCols = SCHEMAS.species.length; // 7
    var spLastCol = speciesSh.getLastColumn();
    var spHdrs = spLastCol > 0 ? speciesSh.getRange(1, 1, 1, spLastCol).getValues()[0] : [];
    function ensureSpeciesCol(label) {
      for (var hi = 0; hi < spHdrs.length; hi++) {
        if (String(spHdrs[hi]) === label) return hi + 1; // 1-based
      }
      var nc = speciesSh.getLastColumn() + 1;
      speciesSh.getRange(1, nc).setValue(label)
        .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
      spHdrs.push(label);
      return nc;
    }
    ensureSpeciesCol('STAGES');
    var ratioCol   = ensureSpeciesCol('SEX RATIO');
    var pinkyCol   = ensureSpeciesCol('PINKY');
    var fuzzyCol   = ensureSpeciesCol('FUZZY');
    var hopperCol  = ensureSpeciesCol('HOPPER');
    var adultCol   = ensureSpeciesCol('ADULT');

    // Backfill existing rows from stored stages JSON (col 3) — ratio remains blank until app sync
    if (speciesSh.getLastRow() > 1) {
      var spRows = speciesSh.getRange(2, 1, speciesSh.getLastRow() - 1, spSchemaCols).getValues();
      spRows.forEach(function(row, idx) {
        var rowNum = idx + 2;
        var deleted = (row[5] === true || row[5] === 'true' || row[5] === 'TRUE');
        if (deleted) return;
        var stagesJson = String(row[2] || '[]');
        var stagesArr = [];
        try { stagesArr = JSON.parse(stagesJson); } catch(e) {}
        var stagesSummary = formatStages(stagesArr);
        var stageSummaryCol = spHdrs.indexOf('STAGES') + 1;
        if (stageSummaryCol > 0) speciesSh.getRange(rowNum, stageSummaryCol).setValue(stagesSummary);
        var sd = function(name) { var d = stageStartDay(stagesArr, name); return d !== null ? d + 'd+' : ''; };
        speciesSh.getRange(rowNum, pinkyCol).setValue(sd('Pinky'));
        speciesSh.getRange(rowNum, fuzzyCol).setValue(sd('Fuzzy'));
        speciesSh.getRange(rowNum, hopperCol).setValue(sd('Hopper'));
        speciesSh.getRange(rowNum, adultCol).setValue(sd('Adult'));
      });
    }
  }

  // 3b. Rename NAME → TRAY ID in Trays header
  var traysSh3 = ss.getSheetByName(SHEET_NAMES.trays);
  if (traysSh3) {
    var nameColIdx = SCHEMAS.trays.indexOf('name') + 1; // col 3
    if (nameColIdx > 0) {
      var hdrCell = traysSh3.getRange(1, nameColIdx);
      if (String(hdrCell.getValue()) === 'NAME') hdrCell.setValue('TRAY ID');
    }

    // 3c. Ensure SPECIES, ♂ ADULTS, ♀ ADULTS headers exist in Trays (created even before first sync)
    var fixedTrayCols = SCHEMAS.trays.length + (EXTRA.trays || []).length; // 10 (schema=9 + SPECIES=1)
    var traysLastCol  = traysSh3.getLastColumn();
    var traysHdrs     = traysLastCol > 0 ? traysSh3.getRange(1, 1, 1, traysLastCol).getValues()[0] : [];
    function ensureTrayCol(label) {
      for (var hi = 0; hi < traysHdrs.length; hi++) {
        if (String(traysHdrs[hi]) === label) return;
      }
      var nc = traysSh3.getLastColumn() + 1;
      traysSh3.getRange(1, nc).setValue(label)
        .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
      traysHdrs.push(label); // keep local list in sync
    }
    // Make sure SPECIES col exists at position fixedTrayCols (col 10)
    if (traysLastCol < fixedTrayCols) {
      traysSh3.getRange(1, fixedTrayCols).setValue('SPECIES')
        .setFontWeight('bold').setBackground('#1a1a2e').setFontColor('#ffffff').setFontSize(10);
      traysHdrs = traysSh3.getRange(1, 1, 1, traysSh3.getLastColumn()).getValues()[0];
    }
    ensureTrayCol('♂ ADULTS');
    ensureTrayCol('♀ ADULTS');
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
