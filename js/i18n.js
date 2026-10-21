'use strict';
/* ================================================================
   RAT-TRACK  — Internationalisation dictionary (English + ಕನ್ನಡ)
   Add new keys here; call t('key') anywhere in app.js.
   ================================================================ */
const I18N = {

  // ── Navigation tabs ──────────────────────────────────────────
  tab_dashboard:    { en: 'Dashboard',  kn: 'ಮುಖಪುಟ' },
  tab_trays:        { en: 'Trays',      kn: 'ತಟ್ಟೆಗಳು' },
  tab_charts:       { en: 'Charts',     kn: 'ಗ್ರಾಫ್‌ಗಳು' },
  tab_reports:      { en: 'Reports',    kn: 'ವರದಿಗಳು' },
  tab_freezer:      { en: 'Freezer',    kn: 'ಫ್ರೀಜರ್' },
  tab_calendar:     { en: 'Calendar',   kn: 'ಕ್ಯಾಲೆಂಡರ್' },
  tab_maturity:     { en: 'Maturity',   kn: 'ಪ್ರೌಢಾವಸ್ಥೆ' },
  tab_species:      { en: 'Species',    kn: 'ಪ್ರಭೇದಗಳು' },
  tab_settings:     { en: 'Settings',   kn: 'ಸೆಟ್ಟಿಂಗ್‌ಗಳು' },
  tab_more:         { en: 'More ···',   kn: 'ಇನ್ನಷ್ಟು ···' },
  more_sections:    { en: 'More sections', kn: 'ಹೆಚ್ಚಿನ ವಿಭಾಗಗಳು' },
  tab_notifications:{ en: 'Notifications', kn: 'ಅಧಿಸೂಚನೆಗಳು' },

  // ── Common actions ──────────────────────────────────────────
  save:             { en: 'Save',       kn: 'ಉಳಿಸು' },
  cancel:           { en: 'Cancel',     kn: 'ರದ್ದು' },
  delete:           { en: 'Delete',     kn: 'ಅಳಿಸು' },
  edit:             { en: 'Edit',       kn: 'ತಿದ್ದು' },
  close:            { en: 'Close',      kn: 'ಮುಚ್ಚು' },
  confirm:          { en: 'Confirm',    kn: 'ದೃಢಪಡಿಸು' },
  upload:           { en: 'Upload',     kn: 'ಅಪ್‌ಲೋಡ್' },
  sync:             { en: 'Sync',       kn: 'ಸಿಂಕ್' },
  export:           { en: 'Export',     kn: 'ರಫ್ತು' },
  back:             { en: 'Back',       kn: 'ಹಿಂದೆ' },
  search:           { en: 'Search',     kn: 'ಹುಡುಕು' },
  restore:          { en: 'Restore',    kn: 'ಮರುಸ್ಥಾಪಿಸು' },
  rename:           { en: 'Rename',     kn: 'ಮರುಹೆಸರು' },
  add:              { en: 'Add',        kn: 'ಸೇರಿಸು' },

  // ── Domain terms ────────────────────────────────────────────
  tray:             { en: 'Tray',       kn: 'ತಟ್ಟೆ' },
  trays:            { en: 'Trays',      kn: 'ತಟ್ಟೆಗಳು' },
  shelf:            { en: 'Shelf',      kn: 'ಕಪಾಟು' },
  shelves:          { en: 'Shelves',    kn: 'ಕಪಾಟುಗಳು' },
  litter:           { en: 'Litter',     kn: 'ಮರಿಗಳ ಗುಂಪು' },
  stage:            { en: 'Stage',      kn: 'ಹಂತ' },
  species:          { en: 'Species',    kn: 'ಪ್ರಭೇದ' },
  colony:           { en: 'Colony',     kn: 'ವಸಾಹತು' },
  cohort:           { en: 'Cohort',     kn: 'ಗುಂಪು' },
  removal:          { en: 'Removal',    kn: 'ತೆಗೆದ' },
  male:             { en: 'Male',       kn: 'ಗಂಡು' },
  female:           { en: 'Female',     kn: 'ಹೆಣ್ಣು' },
  count:            { en: 'Count',      kn: 'ಸಂಖ್ಯೆ' },
  total:            { en: 'Total',      kn: 'ಒಟ್ಟು' },
  alive:            { en: 'Alive',      kn: 'ಜೀವಂತ' },
  dead:             { en: 'Dead',       kn: 'ಮೃತ' },
  birth:            { en: 'Birth',      kn: 'ಜನನ' },
  death:            { en: 'Death',      kn: 'ಮರಣ' },

  // ── Field labels ────────────────────────────────────────────
  name_lbl:         { en: 'Name',             kn: 'ಹೆಸರು' },
  tray_name_lbl:    { en: 'Tray name',         kn: 'ತಟ್ಟೆ ಹೆಸರು' },
  shelf_name_lbl:   { en: 'Shelf name',        kn: 'ಕಪಾಟು ಹೆಸರು' },
  birth_date:       { en: 'Birth date',        kn: 'ಹುಟ್ಟಿದ ದಿನಾಂಕ' },
  date:             { en: 'Date',              kn: 'ದಿನಾಂಕ' },
  notes:            { en: 'Notes',             kn: 'ಟಿಪ್ಪಣಿಗಳು' },
  reason:           { en: 'Reason',            kn: 'ಕಾರಣ' },
  how_many_trays:   { en: 'How many trays',    kn: 'ಎಷ್ಟು ತಟ್ಟೆಗಳು' },
  num_trays:        { en: 'Number of trays (1–100)', kn: 'ತಟ್ಟೆಗಳ ಸಂಖ್ಯೆ (1–100)' },

  // ── Tray / shelf actions ─────────────────────────────────────
  add_tray:         { en: 'Add tray',          kn: 'ತಟ್ಟೆ ಸೇರಿಸಿ' },
  edit_tray:        { en: 'Edit tray',         kn: 'ತಟ್ಟೆ ತಿದ್ದಿ' },
  del_tray:         { en: 'Delete tray',       kn: 'ತಟ್ಟೆ ಅಳಿಸಿ' },
  edit_tray_btn:    { en: '✎ Edit tray',       kn: '✎ ತಟ್ಟೆ ತಿದ್ದಿ' },
  add_shelf:        { en: 'Add shelf',         kn: 'ಕಪಾಟು ಸೇರಿಸಿ' },
  rename_shelf:     { en: 'Rename shelf',      kn: 'ಕಪಾಟು ಮರುಹೆಸರಿಸಿ' },
  add_litter_btn:   { en: '+ Born today',      kn: '+ ಇಂದು ಜನಿಸಿದೆ' },
  add_intake_btn:   { en: '+ Add intake',      kn: '+ ಸೇರ್ಪಡೆ ಸೇರಿಸಿ' },
  add_litter_title: { en: 'Add litter',        kn: 'ಮರಿಗಳ ಗುಂಪು ಸೇರಿಸಿ' },
  add_intake_title: { en: 'Add intake',        kn: 'ಸೇರ್ಪಡೆ ಸೇರಿಸಿ' },
  edit_litter:      { en: 'Edit litter',       kn: 'ಮರಿ ತಿದ್ದು' },
  search_trays:     { en: 'Search trays…',     kn: 'ತಟ್ಟೆ ಹುಡುಕಿ…' },
  quick_actions:    { en: 'Quick actions',     kn: 'ತ್ವರಿತ ಕ್ರಿಯೆಗಳು' },
  open_tray_detail: { en: 'Open tray detail',  kn: 'ತಟ್ಟೆ ವಿವರ ತೆರೆಯಿರಿ' },

  // ── Species ──────────────────────────────────────────────────
  add_species:      { en: 'Add species',       kn: 'ಪ್ರಭೇದ ಸೇರಿಸಿ' },
  edit_species:     { en: 'Edit species',      kn: 'ಪ್ರಭೇದ ತಿದ್ದಿ' },

  // ── Modal titles ─────────────────────────────────────────────
  confirm_del:      { en: 'Confirm delete',    kn: 'ಅಳಿಸುವಿಕೆ ದೃಢಪಡಿಸಿ' },
  cannot_undo:      { en: 'This cannot be undone.', kn: 'ಇದನ್ನು ರದ್ದು ಮಾಡಲಾಗದು.' },
  freeze_from_tray: { en: 'Freeze from Tray',  kn: 'ತಟ್ಟೆಯಿಂದ ಫ್ರೀಜ್ ಮಾಡಿ' },
  recently_deleted: { en: 'Recently deleted',  kn: 'ಇತ್ತೀಚೆಗೆ ಅಳಿಸಲಾದವು' },

  // ── Sync / status ────────────────────────────────────────────
  local_only:       { en: 'Local only',        kn: 'ಸ್ಥಳೀಯ ಮಾತ್ರ' },
  syncing:          { en: 'Syncing…',          kn: 'ಸಿಂಕ್ ಆಗುತ್ತಿದೆ…' },
  sync_ok:          { en: 'Sync complete',     kn: 'ಸಿಂಕ್ ಪೂರ್ಣ' },
  up_to_date:       { en: 'Up to date',        kn: 'ನವೀಕೃತವಾಗಿದೆ' },
  offline:          { en: 'Offline',           kn: 'ಆಫ್‌ಲೈನ್' },
  sync_error:       { en: 'Sync error',        kn: 'ಸಿಂಕ್ ದೋಷ' },
  no_url_set:       { en: 'No URL set',        kn: 'URL ಹೊಂದಿಸಿಲ್ಲ' },
  offline_n_unsaved:{ en: 'Offline · {0} unsaved', kn: 'ಆಫ್‌ಲೈನ್ · {0} ಉಳಿಸಿಲ್ಲ' },
  n_unsaved:        { en: '{0} unsaved',       kn: '{0} ಉಳಿಸಿಲ್ಲ' },
  n_queued:         { en: '{0} queued',        kn: '{0} ಕ್ಯೂನಲ್ಲಿದೆ' },

  // ── Toast messages ───────────────────────────────────────────
  saved:            { en: 'Saved',             kn: 'ಉಳಿಸಲಾಯಿತು' },
  deleted:          { en: 'Deleted',           kn: 'ಅಳಿಸಲಾಯಿತು' },
  upload_ok:        { en: 'Upload complete',   kn: 'ಅಪ್‌ಲೋಡ್ ಪೂರ್ಣ' },
  upload_failed_t:  { en: 'Upload failed',     kn: 'ಅಪ್‌ಲೋಡ್ ವಿಫಲ' },
  litter_added:     { en: 'Litter added',      kn: 'ಮರಿಗಳ ಗುಂಪು ಸೇರಿಸಲಾಯಿತು' },
  status_saved:     { en: 'Status saved',      kn: 'ಸ್ಥಿತಿ ಉಳಿಸಲಾಯಿತು' },
  notes_saved:      { en: 'Notes saved',       kn: 'ಟಿಪ್ಪಣಿ ಉಳಿಸಲಾಯಿತು' },
  loading_sheets:   { en: 'Loading data from Google Sheets…', kn: 'Google Sheets ನಿಂದ ಮಾಹಿತಿ ಲೋಡ್ ಆಗುತ್ತಿದೆ…' },
  no_pending:       { en: 'No pending changes — refreshing from Google Sheets…', kn: 'ಬಾಕಿ ಬದಲಾವಣೆ ಇಲ್ಲ — Google Sheets ನಿಂದ ಮರುಲೋಡ್…' },
  enter_name:       { en: 'Enter a name',      kn: 'ಹೆಸರು ನಮೂದಿಸಿ' },
  enter_count:      { en: 'Enter a count',     kn: 'ಸಂಖ್ಯೆ ನಮೂದಿಸಿ' },
  enter_shelf_name: { en: 'Enter a shelf name', kn: 'ಕಪಾಟು ಹೆಸರು ನಮೂದಿಸಿ' },
  pick_birth_date:  { en: 'Pick a birth date', kn: 'ಹುಟ್ಟಿದ ದಿನಾಂಕ ಆಯ್ಕೆ ಮಾಡಿ' },
  invalid_date:     { en: 'Invalid date — check year', kn: 'ಅಮಾನ್ಯ ದಿನಾಂಕ — ವರ್ಷ ಪರಿಶೀಲಿಸಿ' },
  notif_enabled:    { en: 'Notifications enabled', kn: 'ಅಧಿಸೂಚನೆಗಳು ಸಕ್ರಿಯ' },
  notif_blocked:    { en: 'Notifications blocked — enable in browser settings', kn: 'ಅಧಿಸೂಚನೆಗಳು ನಿರ್ಬಂಧಿಸಲಾಗಿದೆ — ಬ್ರೌಸರ್ ಸೆಟ್ಟಿಂಗ್‌ನಲ್ಲಿ ಸಕ್ರಿಯಗೊಳಿಸಿ' },
  notif_dismissed:  { en: 'Notification permission dismissed', kn: 'ಅಧಿಸೂಚನೆ ಅನುಮತಿ ತಿರಸ್ಕರಿಸಲಾಯಿತು' },
  enter_1_100:      { en: 'Enter 1–100 trays', kn: '1–100 ತಟ್ಟೆಗಳ ಸಂಖ್ಯೆ ನಮೂದಿಸಿ' },
  enter_1_100_b:    { en: 'Enter 1–100',       kn: '1–100 ನಮೂದಿಸಿ' },
  no_species_first: { en: 'Add a species first', kn: 'ಮೊದಲು ಪ್ರಭೇದ ಸೇರಿಸಿ' },
  select_shelf:     { en: 'Select a shelf first', kn: 'ಮೊದಲು ಕಪಾಟು ಆಯ್ಕೆ ಮಾಡಿ' },
  no_stages_sp:     { en: 'No stages defined for this species', kn: 'ಈ ಪ್ರಭೇದಕ್ಕೆ ಯಾವುದೇ ಹಂತ ಇಲ್ಲ' },
  no_live_trays:    { en: 'No trays with live animals', kn: 'ಜೀವಂತ ಪ್ರಾಣಿಗಳ ತಟ್ಟೆ ಇಲ್ಲ' },
  no_live_animals:  { en: 'No live animals in this tray', kn: 'ಈ ತಟ್ಟೆಯಲ್ಲಿ ಜೀವಂತ ಪ್ರಾಣಿ ಇಲ್ಲ' },

  // ── Pending banner ───────────────────────────────────────────
  pending_banner:   { en: '{0} unsaved change{1} — upload before closing', kn: '{0} ಬಾಕಿ ಬದಲಾವಣೆ — ಮುಚ್ಚುವ ಮೊದಲು ಅಪ್‌ಲೋಡ್ ಮಾಡಿ' },
  upload_changes:   { en: 'Upload changes',    kn: 'ಬದಲಾವಣೆ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ' },

  // ── Empty states ─────────────────────────────────────────────
  es_no_litters:    { en: 'No litters logged yet', kn: 'ಇನ್ನೂ ಮರಿಗಳ ಗುಂಪು ದಾಖಲಿಲ್ಲ' },
  es_no_data:       { en: 'No data yet',       kn: 'ಇನ್ನೂ ಮಾಹಿತಿ ಇಲ್ಲ' },
  es_no_data_sub:   { en: 'Add species and litters first, then come back here for your colony summary.', kn: 'ಮೊದಲು ಪ್ರಭೇದ ಮತ್ತು ಮರಿಗಳ ಗುಂಪು ಸೇರಿಸಿ, ನಂತರ ವಸಾಹತು ಸಾರಾಂಶ ನೋಡಿ.' },
  es_freezer:       { en: 'Freezer is empty',  kn: 'ಫ್ರೀಜರ್ ಖಾಲಿ ಇದೆ' },
  es_freezer_sub:   { en: 'Remove animals from a tray with reason <b>Frozen</b> to add them here.', kn: 'ತಟ್ಟೆಯಿಂದ <b>Frozen</b> ಕಾರಣದೊಂದಿಗೆ ತೆಗೆದಾಗ ಇಲ್ಲಿ ಸೇರ್ಪಡೆಯಾಗುತ್ತದೆ.' },
  es_no_shelves:    { en: 'No shelves yet',    kn: 'ಇನ್ನೂ ಕಪಾಟು ಇಲ್ಲ' },
  es_no_shelves_sub:{ en: 'Tap + to add your first shelf and trays.', kn: '+ ಒತ್ತಿ ನಿಮ್ಮ ಮೊದಲ ಕಪಾಟು ಮತ್ತು ತಟ್ಟೆ ಸೇರಿಸಿ.' },
  es_no_species:    { en: 'No species defined', kn: 'ಯಾವುದೇ ಪ್ರಭೇದ ಇಲ್ಲ' },
  es_no_species_sub:{ en: 'Add a species under the Species tab to see its maturity timeline.', kn: 'ಪ್ರಭೇದ ಟ್ಯಾಬ್‌ನಲ್ಲಿ ಪ್ರಭೇದ ಸೇರಿಸಿ ಅದರ ಪ್ರೌಢಾವಸ್ಥೆ ಟೈಮ್‌ಲೈನ್ ನೋಡಿ.' },
  es_no_species2_sub:{ en: 'Add a species and its stage day-thresholds.', kn: 'ಪ್ರಭೇದ ಮತ್ತು ಅದರ ಹಂತ ದಿನಾಂಕಗಳನ್ನು ಸೇರಿಸಿ.' },

  // ── Pull-to-refresh ──────────────────────────────────────────
  ptr_pull:         { en: '↻ Pull to sync',    kn: '↻ ಸಿಂಕ್‌ಗಾಗಿ ಎಳೆಯಿರಿ' },
  ptr_release:      { en: '↻ Release to sync', kn: '↻ ಸಿಂಕ್‌ಗೆ ಬಿಡಿ' },

  // ── Month names (full) ───────────────────────────────────────
  mon_jan:  { en: 'January',   kn: 'ಜನವರಿ' },
  mon_feb:  { en: 'February',  kn: 'ಫೆಬ್ರವರಿ' },
  mon_mar:  { en: 'March',     kn: 'ಮಾರ್ಚ್' },
  mon_apr:  { en: 'April',     kn: 'ಏಪ್ರಿಲ್' },
  mon_may:  { en: 'May',       kn: 'ಮೇ' },
  mon_jun:  { en: 'June',      kn: 'ಜೂನ್' },
  mon_jul:  { en: 'July',      kn: 'ಜುಲೈ' },
  mon_aug:  { en: 'August',    kn: 'ಆಗಸ್ಟ್' },
  mon_sep:  { en: 'September', kn: 'ಸೆಪ್ಟೆಂಬರ್' },
  mon_oct:  { en: 'October',   kn: 'ಅಕ್ಟೋಬರ್' },
  mon_nov:  { en: 'November',  kn: 'ನವೆಂಬರ್' },
  mon_dec:  { en: 'December',  kn: 'ಡಿಸೆಂಬರ್' },

  // ── Month names (short) ──────────────────────────────────────
  mon_jan_s:{ en: 'Jan', kn: 'ಜನ' },
  mon_feb_s:{ en: 'Feb', kn: 'ಫೆಬ್' },
  mon_mar_s:{ en: 'Mar', kn: 'ಮಾರ್' },
  mon_apr_s:{ en: 'Apr', kn: 'ಏಪ್ರ್' },
  mon_may_s:{ en: 'May', kn: 'ಮೇ' },
  mon_jun_s:{ en: 'Jun', kn: 'ಜೂನ್' },
  mon_jul_s:{ en: 'Jul', kn: 'ಜುಲ್' },
  mon_aug_s:{ en: 'Aug', kn: 'ಆಗ' },
  mon_sep_s:{ en: 'Sep', kn: 'ಸೆಪ್' },
  mon_oct_s:{ en: 'Oct', kn: 'ಅಕ್ಟ್' },
  mon_nov_s:{ en: 'Nov', kn: 'ನವ' },
  mon_dec_s:{ en: 'Dec', kn: 'ಡಿಸ್' },

  // ── Settings ─────────────────────────────────────────────────
  change_language:  { en: 'Change language',   kn: 'ಭಾಷೆ ಬದಲಾಯಿಸಿ' },

  // ── Language picker ──────────────────────────────────────────
  lang_picker_prompt: { en: 'Choose your language', kn: 'ನಿಮ್ಮ ಭಾಷೆ ಆಯ್ಕೆ ಮಾಡಿ' },
  lang_en_sub:        { en: 'Continue in English',  kn: 'Continue in English' },
  lang_kn_sub:        { en: 'ಕನ್ನಡದಲ್ಲಿ ಮುಂದುವರಿಸಿ',  kn: 'ಕನ್ನಡದಲ್ಲಿ ಮುಂದುವರಿಸಿ' },
};

/* ── Public helpers ──────────────────────────────────────────── */
function getLang() {
  return localStorage.getItem('rbm.lang') || 'en';
}

/**
 * Translate a key, optionally substituting {0}, {1}, … placeholders.
 * Falls back to English, then to the bare key if nothing matches.
 */
function t(key, ...subs) {
  const l = getLang();
  const row = I18N[key];
  let s = (row && (row[l] || row.en)) || key;
  subs.forEach((v, i) => { s = s.replace('{' + i + '}', v); });
  return s;
}

/**
 * Called by the language-picker buttons in index.html.
 * Stores the choice, hides the overlay, then boots the app.
 */
function selectLang(lang) {
  localStorage.setItem('rbm.lang', lang);
  const picker = document.getElementById('lang-picker');
  if (picker) picker.hidden = true;
  if (typeof init === 'function') init();
}
