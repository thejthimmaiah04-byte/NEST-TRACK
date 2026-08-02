/**
 * Rodent Breeding Monitor — Google Apps Script sync backend
 * -------------------------------------------------------------------------
 * Deploy this attached to a Google Sheet (Extensions ▸ Apps Script), then
 * Deploy ▸ New deployment ▸ Web app ▸ Execute as "Me", access "Anyone".
 * Paste the resulting /exec URL into the app's Settings ▸ Apps Script URL.
 *
 * The app pushes changed records and pulls everyone else's changes in one
 * POST. Records are stored one-per-row in a sheet per entity. Conflicts are
 * resolved last-write-wins using the client-set `updatedAt`. The server adds
 * a `syncedAt` (server clock) column so pulls are consistent across devices
 * regardless of each phone/laptop's own clock.
 * -------------------------------------------------------------------------
 */

var SCHEMAS = {
  species:  ['id', 'name', 'stages', 'updatedAt', 'deleted', 'syncedAt'],
  shelves:  ['id', 'name', 'sortOrder', 'updatedAt', 'deleted', 'syncedAt'],
  trays:    ['id', 'shelfId', 'name', 'speciesId', 'updatedAt', 'deleted', 'syncedAt'],
  cohorts:  ['id', 'trayId', 'speciesId', 'birthDate', 'initialCount', 'notes', 'updatedAt', 'deleted', 'syncedAt'],
  removals: ['id', 'cohortId', 'trayId', 'date', 'stage', 'count', 'updatedAt', 'deleted', 'syncedAt']
};
var ENTITIES = ['species', 'shelves', 'trays', 'cohorts', 'removals'];
var JSON_FIELDS = { stages: true }; // fields stored as JSON text in a cell

function doGet(e) {
  // Health check + optional pull via ?since=NUMBER
  var since = e && e.parameter && e.parameter.since ? Number(e.parameter.since) : 0;
  return json({ ok: true, serverTime: Date.now(), changes: pullChanges(since), accepted: {} });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    var since = Number(body.since) || 0;
    var changes = body.changes || {};
    var accepted = {};
    var serverNow = Date.now();

    ENTITIES.forEach(function (entity) {
      var incoming = changes[entity] || [];
      if (!incoming.length) return;
      accepted[entity] = upsertRecords(entity, incoming, serverNow);
    });

    return json({
      ok: true,
      serverTime: serverNow,
      accepted: accepted,
      changes: pullChanges(since)
    });
  } catch (err) {
    return json({ error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---- storage helpers ---- */

function sheetFor(entity) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(entity);
  if (!sh) {
    sh = ss.insertSheet(entity);
    sh.appendRow(SCHEMAS[entity]);
    sh.setFrozenRows(1);
  } else if (sh.getLastRow() === 0) {
    sh.appendRow(SCHEMAS[entity]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readAll(entity) {
  var sh = sheetFor(entity);
  var cols = SCHEMAS[entity];
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return { sh: sh, cols: cols, rows: [], index: {} };
  var values = sh.getRange(2, 1, lastRow - 1, cols.length).getValues();
  var index = {};
  var rows = values.map(function (row, i) {
    var obj = {};
    cols.forEach(function (c, j) { obj[c] = row[j]; });
    index[obj.id] = i + 2; // sheet row number
    return obj;
  });
  return { sh: sh, cols: cols, rows: rows, index: index };
}

function upsertRecords(entity, incoming, serverNow) {
  var data = readAll(entity);
  var cols = data.cols;
  var acceptedIds = [];

  incoming.forEach(function (r) {
    if (!r || !r.id) return;
    var existingRow = data.index[r.id];
    var existing = existingRow ? data.rows[existingRow - 2] : null;

    // last-write-wins by client updatedAt
    if (existing && Number(existing.updatedAt) > Number(r.updatedAt)) return;

    r.syncedAt = serverNow;
    var rowValues = cols.map(function (c) {
      var v = r[c];
      if (JSON_FIELDS[c]) return JSON.stringify(v == null ? [] : v);
      if (c === 'deleted') return r.deleted ? true : false;
      return v == null ? '' : v;
    });

    if (existingRow) {
      data.sh.getRange(existingRow, 1, 1, cols.length).setValues([rowValues]);
    } else {
      data.sh.appendRow(rowValues);
      data.index[r.id] = data.sh.getLastRow();
    }
    acceptedIds.push(r.id);
  });

  return acceptedIds;
}

function pullChanges(since) {
  var out = {};
  ENTITIES.forEach(function (entity) {
    var data = readAll(entity);
    var changed = [];
    data.rows.forEach(function (row) {
      if (Number(row.syncedAt) > since) changed.push(hydrate(entity, row));
    });
    if (changed.length) out[entity] = changed;
  });
  return out;
}

function hydrate(entity, row) {
  var obj = {};
  SCHEMAS[entity].forEach(function (c) {
    var v = row[c];
    if (JSON_FIELDS[c]) { try { v = JSON.parse(v || '[]'); } catch (e) { v = []; } }
    else if (c === 'deleted') { v = (v === true || v === 'true' || v === 'TRUE'); }
    else if (c === 'initialCount' || c === 'count' || c === 'sortOrder' || c === 'updatedAt' || c === 'syncedAt') {
      v = v === '' || v == null ? 0 : Number(v);
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
