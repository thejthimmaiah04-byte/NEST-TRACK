'use strict';
/* ================================================================
   RAT-TRACK  — Internationalisation dictionary (English + ಕನ್ನಡ)
   Add new keys here; call t('key') anywhere in app.js.
   ================================================================ */
const I18N = {

  // ── Navigation tabs ──────────────────────────────────────────
  tab_dashboard:    { en: 'Dashboard',  kn: 'ಮುಖಪುಟ' },
  tab_trays:        { en: 'Trays',      kn: 'ಟ್ರೇಗಳು' },
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

  // ── Dashboard ────────────────────────────────────────────────
  welcome_title:      { en: 'Welcome to RAT-TRACK', kn: 'RAT-TRACK ಗೆ ಸ್ವಾಗತ' },
  onb_intro:          { en: 'Complete these steps to start tracking your colony:', kn: 'ನಿಮ್ಮ ವಸಾಹತು ಟ್ರ್ಯಾಕ್ ಮಾಡಲು ಈ ಹಂತಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿ:' },
  onb_1_sub:          { en: 'Define stages (Pinky, Fuzzy, Hopper, Adult…), gestation, lifespan', kn: 'ಹಂತ ವ್ಯಾಖ್ಯಾನಿಸಿ (Pinky, Fuzzy, Hopper, Adult…), ಗರ್ಭಾವಧಿ, ಆಯುಷ್ಯ' },
  onb_2_sub:          { en: 'Group trays by shelf / rack location', kn: 'ಕಪಾಟು / ರ್ಯಾಕ್ ಪ್ರಕಾರ ಟ್ರೇ ಗುಂಪು ಮಾಡಿ' },
  onb_3_title:        { en: 'Add trays & record first litter', kn: 'ಟ್ರೇ ಸೇರಿಸಿ & ಮೊದಲ ಮರಿ ದಾಖಲಿಸಿ' },
  onb_3_sub:          { en: 'Go to Trays tab → tap a shelf → Add tray → Born today', kn: 'ಟ್ರೇ ಟ್ಯಾಬ್‌ಗೆ ಹೋಗಿ → ಕಪಾಟು ಆಯ್ಕೆ → ಟ್ರೇ ಸೇರಿಸಿ → ಇಂದು ಜನಿಸಿದೆ' },
  go_to_trays:        { en: 'Go to Trays', kn: 'ಟ್ರೇ ಟ್ಯಾಬ್‌ಗೆ ಹೋಗಿ' },
  es_no_litters_goto: { en: 'Go to the <b>Trays</b> tab and add a litter to a tray to start tracking.', kn: '<b>ಟ್ರೇ</b> ಟ್ಯಾಬ್‌ಗೆ ಹೋಗಿ ತಟ್ಟೆಗೆ ಮರಿ ಸೇರಿಸಿ.' },
  recommendations:    { en: 'Recommendations', kn: 'ಶಿಫಾರಸುಗಳು' },
  right_now:          { en: 'Right now',       kn: 'ಈಗ' },
  tap_stage_remove:   { en: 'Tap a stage card to record a removal', kn: 'ತೆಗೆಯಲು ಹಂತ ಕಾರ್ಡ್ ಒತ್ತಿ' },
  all_species_opt:    { en: 'All species',     kn: 'ಎಲ್ಲ ಪ್ರಭೇದಗಳು' },
  move:               { en: 'Move',            kn: 'ಸ್ಥಳಾಂತರ' },
  view_btn:           { en: 'View',            kn: 'ನೋಡಿ' },
  urgent_lbl:         { en: 'Urgent',          kn: 'ತುರ್ತು' },
  moderate_lbl:       { en: 'Moderate',        kn: 'ಮಧ್ಯಮ' },
  aging_lbl:          { en: 'Aging',           kn: 'ವಯಸ್ಸಾಗುತ್ತಿದೆ' },
  overdue_lbl:        { en: 'Overdue',         kn: 'ವಿಳಂಬ' },
  action_lbl:         { en: 'Action',          kn: 'ಕ್ರಿಯೆ' },
  frozen_badge:       { en: '❄ {0} frozen',    kn: '❄ {0} ಫ್ರೋಜನ್' },

  // ── Charts ────────────────────────────────────────────────────
  stage_distribution:   { en: 'Stage distribution',   kn: 'ಹಂತ ವಿತರಣೆ' },
  individuals_by_stage: { en: 'Individuals by stage', kn: 'ಹಂತ ಪ್ರಕಾರ ಜೀವಿಗಳು' },
  all_shelves:          { en: 'All shelves',           kn: 'ಎಲ್ಲ ಕಪಾಟುಗಳು' },
  all_trays:            { en: 'All trays',             kn: 'ಎಲ್ಲ ಟ್ರೇಗಳು' },
  pop_forecast:         { en: 'Population forecast — next 90 days', kn: 'ಜನಸಂಖ್ಯಾ ಮುನ್ಸೂಚನೆ — ಮುಂದಿನ 90 ದಿನಗಳು' },
  pop_forecast_sub:     { en: 'Projects current animals through stages. Assumes no future removals.', kn: 'ಪ್ರಸ್ತುತ ಪ್ರಾಣಿಗಳನ್ನು ಹಂತಗಳ ಮೂಲಕ ಊಹಿಸುತ್ತದೆ. ಭವಿಷ್ಯದ ತೆಗೆದ ಇಲ್ಲ ಎಂದು ಊಹಿಸಲಾಗಿದೆ.' },

  // ── Trays / Freezer ───────────────────────────────────────────
  find_harvest:       { en: 'Find & Harvest',  kn: 'ಹುಡುಕಿ & ಕಟಾವು' },
  stage_opt:          { en: 'Stage…',          kn: 'ಹಂತ…' },
  how_many_q:         { en: 'How many?',       kn: 'ಎಷ್ಟು?' },
  frozen_stock:       { en: '❄ Frozen Stock',  kn: '❄ ಫ್ರೋಜನ್ ಸ್ಟಾಕ್' },
  shelves_title:      { en: 'Shelves',         kn: 'ಕಪಾಟುಗಳು' },
  freezer_title:      { en: 'Freezer',         kn: 'ಫ್ರೀಜರ್' },
  fz_in_stock:        { en: '{0} individual{1} in stock', kn: '{0} ಪ್ರಾಣಿ ಸ್ಟಾಕ್‌ನಲ್ಲಿ' },

  // ── Maturity / Species ─────────────────────────────────────────
  maturity_timeline:      { en: 'Maturity timeline',      kn: 'ಪ್ರೌಢಾವಸ್ಥೆ ಟೈಮ್‌ಲೈನ್' },
  maturity_subtitle:      { en: 'How long each stage lasts and when animals born today will reach each stage.', kn: 'ಪ್ರತಿ ಹಂತ ಎಷ್ಟು ಕಾಲ ಮತ್ತು ಇಂದು ಜನಿಸಿದ ಪ್ರಾಣಿ ಯಾವಾಗ ಆ ಹಂತ ತಲುಪುತ್ತದೆ.' },
  species_stage_timing:   { en: 'Species & stage timing',  kn: 'ಪ್ರಭೇದ & ಹಂತ ಸಮಯ' },
  species_stage_subtitle: { en: 'The age (in days) at which an animal <b>enters</b> each stage. All counts and forecasts are calculated from this.', kn: 'ಪ್ರಾಣಿ ಯಾವ ವಯಸ್ಸಿನಲ್ಲಿ ಆ ಹಂತ <b>ಪ್ರವೇಶಿಸುತ್ತದೆ</b> (ದಿನಗಳಲ್ಲಿ). ಎಲ್ಲ ಎಣಿಕೆ ಮತ್ತು ಮುನ್ಸೂಚನೆ ಇದರಿಂದ ಲೆಕ್ಕ.' },

  // ── Settings ──────────────────────────────────────────────────
  google_sync:     { en: 'Google Sheet sync',    kn: 'Google Sheet ಸಿಂಕ್' },
  backup_export:   { en: 'Backup & Export',      kn: 'ಬ್ಯಾಕಪ್ & ರಫ್ತು' },
  version_history: { en: 'Version history',      kn: 'ಆವೃತ್ತಿ ಇತಿಹಾಸ' },
  pop_target:      { en: 'Population Target',    kn: 'ಜನಸಂಖ್ಯಾ ಗುರಿ' },
  danger_zone:     { en: 'Danger zone',          kn: 'ಅಪಾಯದ ವಲಯ' },
  notif_section:   { en: 'Notifications',        kn: 'ಅಧಿಸೂಚನೆಗಳು' },
  sync_status:     { en: 'Sync status',          kn: 'ಸಿಂಕ್ ಸ್ಥಿತಿ' },
  last_sync:       { en: 'Last sync',            kn: 'ಕೊನೆಯ ಸಿಂಕ್' },
  network:         { en: 'Network',              kn: 'ನೆಟ್‌ವರ್ಕ್' },
  online:          { en: 'Online',               kn: 'ಆನ್‌ಲೈನ್' },
  target_count:    { en: 'Target count',         kn: 'ಗುರಿ ಸಂಖ್ಯೆ' },
  any_stage:       { en: 'Any stage',            kn: 'ಯಾವ ಹಂತವಾದರೂ' },
  target_date:     { en: 'Target date',          kn: 'ಗುರಿ ದಿನಾಂಕ' },
  save_target:     { en: 'Save target',          kn: 'ಗುರಿ ಉಳಿಸಿ' },
  clear_target:    { en: 'Clear target',         kn: 'ಗುರಿ ತೆರವು' },
  erase_all:       { en: 'Erase all local data', kn: 'ಎಲ್ಲ ಸ್ಥಳೀಯ ಮಾಹಿತಿ ಅಳಿಸಿ' },

  // ── Reports ───────────────────────────────────────────────────
  productivity:      { en: 'Productivity',              kn: 'ಉತ್ಪಾದಕತೆ' },
  colony_snapshot:   { en: 'Colony Snapshot — {0} {1}', kn: 'ವಸಾಹತು ಸ್ನ್ಯಾಪ್‌ಶಾಟ್ — {0} {1}' },
  total_alive:       { en: 'total alive',               kn: 'ಒಟ್ಟು ಜೀವಂತ' },
  births_label:      { en: 'Births',                    kn: 'ಜನನ' },
  deaths_label:      { en: 'Deaths',                    kn: 'ಮರಣ' },
  harvested_label:   { en: 'Harvested',                 kn: 'ಕಟಾವು' },
  frozen_label:      { en: 'Frozen',                    kn: 'ಫ್ರೋಜನ್' },
  overall_sex_ratio: { en: 'Overall sex ratio',         kn: 'ಒಟ್ಟು ಲಿಂಗ ಅನುಪಾತ' },
  avg_litter_size:   { en: 'Avg litter size',           kn: 'ಸರಾಸರಿ ಮರಿ ಗಾತ್ರ' },
  yield_rate:        { en: 'Yield rate (fed / alive)',  kn: 'ಇಳುವರಿ ದರ (ತಿಂದ / ಜೀವಂತ)' },
  freezer_stock:     { en: 'Freezer stock',             kn: 'ಫ್ರೀಜರ್ ಸ್ಟಾಕ್' },
  avg_harvest_age:   { en: 'Avg age at harvest',        kn: 'ಸರಾಸರಿ ಕಟಾವು ವಯಸ್ಸು' },
  death_rate:        { en: 'Death rate',                kn: 'ಮರಣ ದರ' },
  removals_deaths:   { en: 'Removals & Deaths',         kn: 'ತೆಗೆದ & ಮರಣ' },
  deaths_by_cause:   { en: 'Deaths by Cause — {0}',    kn: 'ಕಾರಣಗಳ ಮರಣ — {0}' },
  species_breakdown: { en: 'Species Breakdown',         kn: 'ಪ್ರಭೇದ ವಿಶ್ಲೇಷಣೆ' },
  auto_reports:      { en: 'Auto-Reports & Email',      kn: 'ಸ್ವಯಂ-ವರದಿ & ಇಮೇಲ್' },

  // ── Settings ─────────────────────────────────────────────────
  change_language:  { en: 'Change language',   kn: 'ಭಾಷೆ ಬದಲಾಯಿಸಿ' },

  // ── Language picker ──────────────────────────────────────────
  lang_picker_prompt: { en: 'Choose your language', kn: 'ನಿಮ್ಮ ಭಾಷೆ ಆಯ್ಕೆ ಮಾಡಿ' },
  lang_en_sub:        { en: 'Continue in English',  kn: 'Continue in English' },
  lang_kn_sub:        { en: 'ಕನ್ನಡದಲ್ಲಿ ಮುಂದುವರಿಸಿ',  kn: 'ಕನ್ನಡದಲ್ಲಿ ಮುಂದುವರಿಸಿ' },

  // ── Stage name transliterations ──────────────────────────────
  stage_Pinky:   { en: 'Pinky',  kn: 'ಪಿಂಕಿ' },
  stage_Fuzzy:   { en: 'Fuzzy',  kn: 'ಫಜ್ಜಿ' },
  stage_Hopper:  { en: 'Hopper', kn: 'ಹಾಪರ್' },
  stage_Adult:   { en: 'Adult',  kn: 'ಅಡಲ್ಟ್' },
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
 * Translate a known stage name (Pinky/Fuzzy/Hopper/Adult) to the current
 * language. Passes unknown / custom stage names through unchanged.
 */
function tStage(name) {
  const key = 'stage_' + name;
  return I18N[key] ? t(key) : name;
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
