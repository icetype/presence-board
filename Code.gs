/********************
 * Spreadsheet and cache configuration
 ********************/
const SHEET_USERS = 'users';
const SHEET_LOCATIONS = 'locations';
const SHEET_CURRENT = 'current_presence';
const LOG_SHEET_PREFIX = 'logs_';

const USERS_CACHE_KEY = 'users_v1';
const LOCATIONS_CACHE_KEY = 'locations_v2';
const PRESENCE_SNAPSHOT_CACHE_KEY = 'presence_snapshot_v1';

const USERS_CACHE_TTL_SEC = 21600;       // 6 hours
const LOCATIONS_CACHE_TTL_SEC = 21600;   // 6 hours
const PRESENCE_SNAPSHOT_TTL_SEC = 21600; // 6 hours

const DATETIME_DISPLAY_FORMAT = 'yyyy/MM/dd HH:mm:ss';

/********************
 * Submission control
 ********************/
// Fail fast rather than building a waiting queue behind a long-running save.
const LOCK_TRY_TIMEOUT_MS = 1000;

/********************
 * Web app entry point
 ********************/
function doGet(e) {
  const terminalName = getTerminalName_(e);
  const hasTerminal = !!terminalName;

  const tpl = HtmlService.createTemplateFromFile('Index');
  const appUrl = ScriptApp.getService().getUrl();
  tpl.initialTerminalName = terminalName;
  tpl.hasTerminal = hasTerminal;
  tpl.appUrl = appUrl;
  tpl.appUrlRaw = toScriptJsonLiteral_(appUrl);

  if (hasTerminal) {
    try {
      tpl.initialDataRaw = toScriptJsonLiteral_(getInitialData(terminalName));
    } catch (err) {
      tpl.initialDataRaw = toScriptJsonLiteral_({ error: String(err) });
    }
  } else {
    tpl.initialDataRaw = 'null';
  }
  tpl.initialTerminalNameRaw = toScriptJsonLiteral_(terminalName);

  return tpl
    .evaluate()
    .setTitle(hasTerminal ? 'Lab Status Board' : 'Terminal Setup')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

function toScriptJsonLiteral_(value) {
  const json = JSON.stringify(value);
  return (json == null ? 'null' : json).replace(/[<>&\u2028\u2029]/g, function(ch) {
    return {
      '<': '\\u003c',
      '>': '\\u003e',
      '&': '\\u0026',
      '\u2028': '\\u2028',
      '\u2029': '\\u2029'
    }[ch];
  });
}

function getInitialData(terminalName) {
  terminalName = validateTerminalName_(terminalName);

  return {
    users: getUsers_(),
    locations: getLocations_(),
    terminalName: terminalName,
    presence: getPresenceData()
  };
}

/********************
 * Presence data
 ********************/
function getPresenceData() {
  const cached = getPresenceSnapshotCache_();
  if (cached) return cached;

  ensureCurrentPresenceSheet_();

  const users = getUsers_();
  const locations = getLocations_();
  const currentMap = getCurrentPresenceMap_();
  const presence = buildPresenceFromCurrent_(users, currentMap, locations);

  putPresenceSnapshotCache_(presence);
  return presence;
}

function saveLocation(username, locationId, terminalName) {
  username = String(username || '').trim();
  locationId = String(locationId || '').trim();
  terminalName = validateTerminalName_(terminalName);

  if (!username || !locationId) throw new Error('Missing required fields.');

  const users = getUsers_();
  const user = users.find(u => u.username === username);
  if (!user) throw new Error(`Unknown username: ${username}`);

  const locations = getLocations_();
  const location = locations.find(l => l.id === locationId);
  if (!location) throw new Error(`Invalid location_id: ${locationId}`);

  const now = new Date();

  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(LOCK_TRY_TIMEOUT_MS);

  if (!locked) {
    throw new Error(
      'ほかの保存処理と重なったため、今回は保存されませんでした。少し待ってから、もう一度操作してください。\n' +
      'This action was not saved because another save was in progress. Please wait a moment and try again.'
    );
  }

  let presence;
  try {
    upsertCurrentPresenceFast_(now, user, location, terminalName);
    presence = updatePresenceSnapshotCache_(users, locations, {
      username: user.username,
      nameJa: user.nameJa,
      nameEn: user.nameEn,
      locationId: location.id,
      locationJa: location.ja,
      locationEn: location.en,
      updatedAt: now,
      terminal: terminalName
    });
  } finally {
    lock.releaseLock();
  }

  try {
    appendLog_(now, user, location, terminalName);
  } catch (logErr) {
    console.error(JSON.stringify({
      event: 'appendLog_failed_after_presence_saved',
      username: user.username,
      locationId: location.id,
      terminalName: terminalName,
      message: String(logErr)
    }));
  }

  return {
    ok: true,
    saved: {
      username: user.username,
      nameJa: user.nameJa,
      nameEn: user.nameEn,
      locationJa: location.ja,
      locationEn: location.en,
      terminalName: terminalName
    },
    presence: presence
  };
}


/********************
 * Master data
 ********************/
function getUsers_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(USERS_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  if (!sh) throw new Error('Sheet "users" not found.');

  const values = sh.getDataRange().getValues();
  if (values.length <= 1) {
    cache.put(USERS_CACHE_KEY, JSON.stringify([]), USERS_CACHE_TTL_SEC);
    return [];
  }

  const headers = values[0];
  const colUsername = headers.indexOf('username');
  const colNameJa = headers.indexOf('name_ja');
  const colNameEn = headers.indexOf('name_en');

  if ([colUsername, colNameJa, colNameEn].includes(-1)) {
    throw new Error('users sheet must contain: username, name_ja, name_en');
  }

  const users = [];
  const seen = new Set();

  values.slice(1).forEach((r, idx) => {
    const username = String(r[colUsername] || '').trim();
    if (!username && !r[colNameJa] && !r[colNameEn]) return;

    if (!username || !r[colNameJa]) {
      throw new Error(`users row ${idx + 2}: username or name_ja is blank`);
    }
    if (seen.has(username)) {
      throw new Error(`users: duplicate username: ${username}`);
    }

    seen.add(username);
    users.push({
      username: username,
      nameJa: String(r[colNameJa] || '').trim(),
      nameEn: String(r[colNameEn] || '').trim()
    });
  });

  cache.put(USERS_CACHE_KEY, JSON.stringify(users), USERS_CACHE_TTL_SEC);
  return users;
}

function getLocations_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(LOCATIONS_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOCATIONS);
  if (!sh) throw new Error('Sheet "locations" not found.');

  const values = sh.getDataRange().getValues();
  if (values.length <= 1) {
    cache.put(LOCATIONS_CACHE_KEY, JSON.stringify([]), LOCATIONS_CACHE_TTL_SEC);
    return [];
  }

  const headers = values[0];
  const colId = headers.indexOf('location_id');
  const colJa = headers.indexOf('location_ja');
  const colEn = headers.indexOf('location_en');
  const colColor = headers.indexOf('color');
  const colIcon = headers.indexOf('icon');

  if ([colId, colJa, colEn].includes(-1)) {
    throw new Error('locations sheet must contain: location_id, location_ja, location_en');
  }

  const locations = [];
  const seen = new Set();

  values.slice(1).forEach((r, idx) => {
    const id = String(r[colId] || '').trim();
    if (!id && !r[colJa] && !r[colEn]) return;

    if (!id || !r[colJa]) {
      throw new Error(`locations row ${idx + 2}: location_id or location_ja is blank`);
    }
    if (seen.has(id)) {
      throw new Error(`locations: duplicate location_id: ${id}`);
    }

    seen.add(id);
    locations.push({
      id: id,
      ja: String(r[colJa] || '').trim(),
      en: String(r[colEn] || '').trim(),
      color: normalizeCssColor_(colColor !== -1 ? r[colColor] : ''),
      icon: normalizeMaterialSymbolName_(colIcon !== -1 ? r[colIcon] : '')
    });
  });

  cache.put(LOCATIONS_CACHE_KEY, JSON.stringify(locations), LOCATIONS_CACHE_TTL_SEC);
  return locations;
}

function normalizeCssColor_(value) {
  const s = String(value || '').trim();
  if (!s) return '';

  if (
    /^#[0-9a-fA-F]{3}$/.test(s) ||
    /^#[0-9a-fA-F]{6}$/.test(s)
  ) {
    return s;
  }

  return '';
}

function normalizeMaterialSymbolName_(value) {
  const s = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!s) return '';
  return /^[a-z0-9_]+$/.test(s) ? s : '';
}

/********************
 * Monthly logs
 ********************/
function getMonthlyLogSheetName_(dateObj) {
  const tz = Session.getScriptTimeZone();
  return LOG_SHEET_PREFIX + Utilities.formatDate(dateObj, tz, 'yyyy_MM');
}

function getLogLikeHeader_(firstColumnName) {
  return [
    firstColumnName,
    'username',
    'name_ja',
    'name_en',
    'location_id',
    'location_ja',
    'location_en',
    'terminal'
  ];
}

function getOrCreateMonthlyLogSheet_(dateObj) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheetName = getMonthlyLogSheetName_(dateObj);
  let sh = ss.getSheetByName(sheetName);

  const header = getLogLikeHeader_('timestamp');

  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat(DATETIME_DISPLAY_FORMAT);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat(DATETIME_DISPLAY_FORMAT);
  }

  return sh;
}

function appendLog_(now, user, location, terminalName) {
  const sh = getOrCreateMonthlyLogSheet_(now);

  const row = [
    now,
    user.username,
    user.nameJa,
    user.nameEn,
    location.id,
    location.ja,
    location.en,
    terminalName
  ];

  sh.appendRow(row);
}

/********************
 * Current presence sheet
 ********************/
function ensureCurrentPresenceSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_CURRENT);

  const header = getLogLikeHeader_('updated_at');

  if (!sh) {
    sh = ss.insertSheet(SHEET_CURRENT);
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.getRange('A:A').setNumberFormat(DATETIME_DISPLAY_FORMAT);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
    sh.getRange('A:A').setNumberFormat(DATETIME_DISPLAY_FORMAT);
  }
}

function getCurrentPresenceMap_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CURRENT);
  if (!sh) return new Map();

  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return new Map();

  const headers = values[0];
  const colMap = {
    updated: headers.indexOf('updated_at'),
    user: headers.indexOf('username'),
    nameJa: headers.indexOf('name_ja'),
    nameEn: headers.indexOf('name_en'),
    locId: headers.indexOf('location_id'),
    locJa: headers.indexOf('location_ja'),
    locEn: headers.indexOf('location_en'),
    term: headers.indexOf('terminal')
  };

  const required = [
    colMap.updated,
    colMap.user,
    colMap.nameJa,
    colMap.nameEn,
    colMap.locId,
    colMap.locJa,
    colMap.locEn,
    colMap.term
  ];

  if (required.some(i => i < 0)) {
    throw new Error('current_presence sheet must contain: updated_at, username, name_ja, name_en, location_id, location_ja, location_en, terminal');
  }

  const map = new Map();
  const seen = new Set();

  values.slice(1).forEach(r => {
    const username = String(r[colMap.user] || '').trim();
    if (!username) return;

    if (seen.has(username)) {
      throw new Error(`current_presence: duplicate username: ${username}`);
    }
    seen.add(username);

    map.set(username, {
      username: username,
      nameJa: String(r[colMap.nameJa] || '').trim(),
      nameEn: String(r[colMap.nameEn] || '').trim(),
      locationId: String(r[colMap.locId] || '').trim(),
      locationJa: String(r[colMap.locJa] || '').trim(),
      locationEn: String(r[colMap.locEn] || '').trim(),
      updatedAt: r[colMap.updated],
      terminal: String(r[colMap.term] || '').trim()
    });
  });

  return map;
}

function buildPresenceFromCurrent_(users, currentMap, locations) {
  const grouped = locations.map(l => ({
    locationId: l.id,
    locationJa: l.ja,
    locationEn: l.en,
    members: []
  }));

  const groupMap = new Map(grouped.map(g => [g.locationId, g]));

  users.forEach(u => {
    const current = currentMap.get(u.username);
    if (current && groupMap.has(current.locationId)) {
      groupMap.get(current.locationId).members.push({
        username: u.username,
        nameJa: u.nameJa,
        nameEn: u.nameEn
      });
    }
  });

  return grouped;
}

function upsertCurrentPresenceFast_(now, user, location, terminalName) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_CURRENT);
  const rowValues = [
    now,
    user.username,
    user.nameJa,
    user.nameEn,
    location.id,
    location.ja,
    location.en,
    terminalName
  ];

  const lastRow = sh.getLastRow();

  if (lastRow >= 2) {
    const usernames = sh.getRange(2, 2, lastRow - 1, 1).getValues().flat();
    const idx = usernames.findIndex(v => String(v || '').trim() === user.username);

    if (idx !== -1) {
      sh.getRange(idx + 2, 1, 1, rowValues.length).setValues([rowValues]);
      return;
    }
  }

  const nextRow = lastRow + 1;
  sh.getRange(nextRow, 1, 1, rowValues.length).setValues([rowValues]);
}

/********************
 * Presence snapshot cache
 ********************/
function getPresenceSnapshotCache_() {
  const cached = CacheService.getScriptCache().get(PRESENCE_SNAPSHOT_CACHE_KEY);
  return cached ? JSON.parse(cached) : null;
}

function putPresenceSnapshotCache_(presence) {
  CacheService.getScriptCache().put(
    PRESENCE_SNAPSHOT_CACHE_KEY,
    JSON.stringify(presence || []),
    PRESENCE_SNAPSHOT_TTL_SEC
  );
}

function updatePresenceSnapshotCache_(users, locations, saved) {
  const presence =
    getPresenceSnapshotCache_() ||
    buildPresenceFromCurrent_(users, getCurrentPresenceMap_(), locations);

  const userOrder = new Map(users.map((u, idx) => [u.username, idx]));
  const user = users.find(u => u.username === saved.username);
  if (!user) return presence;

  const nextPresence = locations.map(locationDef => {
    const existingGroup = presence.find(g => g.locationId === locationDef.id);
    const members = (existingGroup?.members || []).filter(m => m.username !== saved.username);

    if (saved.locationId === locationDef.id) {
      members.push({
        username: user.username,
        nameJa: user.nameJa,
        nameEn: user.nameEn
      });
    }

    const seen = new Set();
    const deduped = members.filter(m => (seen.has(m.username) ? false : seen.add(m.username)));
    deduped.sort((a, b) => (userOrder.get(a.username) ?? 999999) - (userOrder.get(b.username) ?? 999999));

    return {
      locationId: locationDef.id,
      locationJa: locationDef.ja,
      locationEn: locationDef.en,
      members: deduped
    };
  });

  putPresenceSnapshotCache_(nextPresence);
  return nextPresence;
}

/********************
 * Maintenance utilities
 ********************/
function clearCaches_() {
  CacheService.getScriptCache().removeAll([
    USERS_CACHE_KEY,
    LOCATIONS_CACHE_KEY,
    PRESENCE_SNAPSHOT_CACHE_KEY
  ]);
}

function clearCachesAndNotify_() {
  clearCaches_();
  SpreadsheetApp.getUi().alert(
    '完了 / Complete',
    'キャッシュをクリアしました。\nCache has been cleared.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function getRecentMonthlyLogSheetNames_(baseDate, monthCount) {
  const tz = Session.getScriptTimeZone();
  const names = [];
  const seen = new Set();

  for (let offset = 0; offset < monthCount; offset += 1) {
    const d = new Date(baseDate);
    d.setDate(1);
    d.setMonth(d.getMonth() - offset);

    const name = LOG_SHEET_PREFIX + Utilities.formatDate(d, tz, 'yyyy_MM');
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}

function rebuildCurrentPresenceFromLogs() {
  ensureCurrentPresenceSheet_();
  clearCaches_();

  const users = getUsers_();
  const userMap = new Map(users.map(u => [u.username, u]));
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const currentSh = ss.getSheetByName(SHEET_CURRENT);

  const targetSheetNames = new Set(getRecentMonthlyLogSheetNames_(new Date(), 2));
  const logSheets = ss.getSheets()
    .filter(s => targetSheetNames.has(s.getName()))
    .sort((a, b) => a.getName().localeCompare(b.getName()));

  const header = getLogLikeHeader_('updated_at');
  const latestByUser = new Map();

  logSheets.forEach(logSh => {
    const logValues = logSh.getDataRange().getValues();
    if (logValues.length <= 1) return;

    const headerRow = logValues[0];
    const colMap = {
      ts: headerRow.indexOf('timestamp'),
      user: headerRow.indexOf('username')
    };

    if (colMap.ts < 0 || colMap.user < 0) return;

    logValues.slice(1).forEach(r => {
      const username = String(r[colMap.user] || '').trim();
      if (!username || !userMap.has(username)) return;

      const ts = new Date(r[colMap.ts]).getTime();
      if (!Number.isFinite(ts)) return;

      if (!latestByUser.has(username) || ts > latestByUser.get(username).ts) {
        const row = r.slice(0, header.length);
        latestByUser.set(username, { ts: ts, row: row });
      }
    });
  });

  currentSh.clearContents();
  currentSh.getRange(1, 1, 1, header.length).setValues([header]);
  currentSh.getRange('A:A').setNumberFormat(DATETIME_DISPLAY_FORMAT);

  const rebuiltRows = users
    .map(u => latestByUser.get(u.username)?.row)
    .filter(Boolean);

  if (rebuiltRows.length > 0) {
    currentSh.getRange(2, 1, rebuiltRows.length, header.length).setValues(rebuiltRows);
  }
}

function rebuildCurrentPresenceFromLogsAndNotify_() {
  rebuildCurrentPresenceFromLogs();
  SpreadsheetApp.getUi().alert(
    '完了 / Complete',
    'current_presence を logs_ シートの直近2ヶ月分から再構築しました。\ncurrent_presence has been rebuilt from logs_ sheets.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/********************
 * Parameter helpers
 ********************/
function getTerminalName_(e) {
  return String(e?.parameter?.terminal || '').trim();
}

function normalizeTerminalName_(v) {
  return String(v || '').trim();
}

function validateTerminalName_(v) {
  const terminalName = normalizeTerminalName_(v);
  if (!terminalName) throw new Error('Missing terminal parameter.');
  if (terminalName.length > 64) {
    throw new Error('Invalid terminal parameter: too long.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(terminalName)) {
    throw new Error('Invalid terminal parameter: use only letters, numbers, hyphens, and underscores.');
  }
  return terminalName;
}

/********************
 * Cache invalidation
 ********************/
function onEdit(e) {
  if (!e || !e.range) return;

  const sheetName = e.range.getSheet().getName();
  if ([SHEET_USERS, SHEET_LOCATIONS, SHEET_CURRENT].includes(sheetName)) {
    clearCaches_();
  }
}

/********************
 * Night presence notification
 ********************/
function checkAndNotifyPresence() {
  ensureCurrentPresenceSheet_();

  const props = PropertiesService.getScriptProperties();
  const notifyEmail = props.getProperty('NOTIFY_EMAIL');
  const awayIdsRaw = props.getProperty('AWAY_LOCATION_IDS');
  if (!notifyEmail || !awayIdsRaw) return;

  const awayIdSet = new Set(
    awayIdsRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  );

  const currentMap = getCurrentPresenceMap_();
  if (!currentMap || currentMap.size === 0) return;

  const remainingUsers = [];
  currentMap.forEach(data => {
    if (!awayIdSet.has(data.locationId)) {
      remainingUsers.push(data);
    }
  });

  if (remainingUsers.length === 0) return;

  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const timeStr = Utilities.formatDate(now, tz, 'yyyy/MM/dd HH:mm');

  let body = `日時 / Time: ${timeStr}\n\n`;
  body += '現在の時刻で、以下のメンバーが在室となっています。\n';
  body += 'The following members are currently present in the lab.\n\n';
  body += '----------------------------------------\n';

  remainingUsers.forEach(u => {
    body += `・${u.nameJa} / ${u.nameEn} （${u.locationJa} / ${u.locationEn}）\n`;
  });

  body += '----------------------------------------\n\n';
  body += '※このメールは在室管理システムからの自動送信です。\n';
  body += '*This is an automated message from the Lab Status Board.\n';

  MailApp.sendEmail(notifyEmail, '【在室通知 / Presence Notification】', body);
}

/********************
 * Spreadsheet UI menu
 ********************/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚙️ Admin Menu')
    .addItem('自動通知タイマーを設定する / Set Notification Timer', 'setupNotificationTrigger_')
    .addItem('自動通知タイマーを解除する / Cancel Notification Timer', 'deleteNotificationTrigger_')
    .addSeparator()
    .addItem('キャッシュをクリア / Clear Cache', 'clearCachesAndNotify_')
    .addItem('current_presence を再構築 / Rebuild current_presence', 'rebuildCurrentPresenceFromLogsAndNotify_')
    .addSeparator()
    .addItem('📱 アプリURLの取得手順 / How to get URL', 'showUrlInstructions_')
    .addToUi();
}

function showUrlInstructions_() {
  const ui = SpreadsheetApp.getUi();
  const message =
    '【アプリ用URLの取得手順】\n\n' +
    '1. 画面上のメニューから「拡張機能」＞「Apps Script」を開く\n' +
    '2. エディタ右上の青いボタン「デプロイ」＞「デプロイを管理」をクリック\n' +
    '3. 表示された画面の「ウェブアプリ」の項目にあるURL（末尾が /exec のもの）をコピー\n\n' +
    '※コピーしたURLを、iPadなどの端末に送ってブラウザで開いてください。';

  ui.alert('📱 アプリのURLについて', message, ui.ButtonSet.OK);
}

/********************
 * Notification trigger setup
 ********************/
function setupNotificationTrigger_() {
  const ui = SpreadsheetApp.getUi();

  const emailMsg =
    '【1/3】通知先のメールアドレスを入力してください。\n' +
    'Enter the notification email address.\n' +
    '(e.g., mail@example.com)';
  const emailRes = ui.prompt('通知設定 / Notification Settings', emailMsg, ui.ButtonSet.OK_CANCEL);
  if (emailRes.getSelectedButton() !== ui.Button.OK) return;

  const email = emailRes.getResponseText().trim();
  if (!email) {
    ui.alert('Error', 'メールアドレスが入力されませんでした。\nEmail address was not entered.', ui.ButtonSet.OK);
    return;
  }

  const awayMsg =
    '【2/3】「帰宅」を示す、または「在室として扱わない」場所IDをカンマ区切りで入力してください。\n' +
    'Enter Location IDs that indicate "home" or should be treated as "not present in the lab", separated by commas.\n' +
    '(e.g., home, trip, other_univ)';
  const awayRes = ui.prompt('通知設定 / Notification Settings', awayMsg, ui.ButtonSet.OK_CANCEL);
  if (awayRes.getSelectedButton() !== ui.Button.OK) return;

  const awayIds = awayRes.getResponseText()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (awayIds.length === 0) {
    ui.alert(
      'Error',
      '少なくとも1つの Location ID を入力してください。\nPlease enter at least one Location ID.',
      ui.ButtonSet.OK
    );
    return;
  }

  const locations = getLocations_();
  const locationIdSet = new Set(locations.map(l => l.id));
  const invalidIds = awayIds.filter(id => !locationIdSet.has(id));

  if (invalidIds.length > 0) {
    ui.alert(
      'Error',
      'locations シートに存在しない Location ID です:\n' +
      invalidIds.join(', ') + '\n\n' +
      'Unknown Location ID(s) in locations sheet.',
      ui.ButtonSet.OK
    );
    return;
  }

  const timeMsg =
    '【3/3】通知を行いたい時間（0〜23の数字）を入力してください。\n' +
    'Enter the notification time (0-23).\n' +
    '(e.g., 0 = Midnight, 22 = 10 PM)';
  const timeRes = ui.prompt('通知設定 / Notification Settings', timeMsg, ui.ButtonSet.OK_CANCEL);
  if (timeRes.getSelectedButton() !== ui.Button.OK) return;

  const timeStr = timeRes.getResponseText().trim();
  const timeNum = parseInt(timeStr, 10);

  if (isNaN(timeNum) || timeNum < 0 || timeNum > 23) {
    ui.alert(
      'Error',
      '0〜23の数字を正しく入力してください。\nPlease enter a valid number between 0 and 23.',
      ui.ButtonSet.OK
    );
    return;
  }

  deleteNotificationTrigger_(true);

  const props = PropertiesService.getScriptProperties();
  props.setProperties({
    NOTIFY_EMAIL: email,
    AWAY_LOCATION_IDS: awayIds.join(',')
  });

  try {
    ScriptApp.newTrigger('checkAndNotifyPresence')
      .timeBased()
      .inTimezone('Asia/Tokyo')
      .atHour(timeNum)
      .everyDays(1)
      .create();
  } catch (err) {
    props.deleteProperty('NOTIFY_EMAIL');
    props.deleteProperty('AWAY_LOCATION_IDS');

    ui.alert(
      'Error',
      '通知タイマーの作成に失敗しました。\n' +
      'Failed to create the notification timer.\n\n' +
      'もう一度やり直してみてください。\n' +
      'Please try again.\n\n' +
      String(err),
      ui.ButtonSet.OK
    );
    return;
  }

  const successMsg =
    `設定完了 / Setup Complete\n\n` +
    `時間 / Time: Around ${timeNum}:00\n` +
    `宛先 / To: ${email}\n` +
    `除外ID / Excluded IDs: ${awayIds.join(', ')}\n\n` +
    `※除外ID以外の場所にメンバーがいる場合のみ通知されます。\n` +
    `*Notifications will be sent only when members are in locations not listed above.`;

  ui.alert('Success', successMsg, ui.ButtonSet.OK);
}

function deleteNotificationTrigger_(isSilent) {
  const triggers = ScriptApp.getProjectTriggers();
  let deleted = false;

  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'checkAndNotifyPresence') {
      ScriptApp.deleteTrigger(trigger);
      deleted = true;
    }
  });

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty('NOTIFY_EMAIL');
  props.deleteProperty('AWAY_LOCATION_IDS');

  if (isSilent !== true) {
    const ui = SpreadsheetApp.getUi();
    if (deleted) {
      ui.alert(
        '完了 / Complete',
        'タイマーを解除しました。\nThe notification timer has been cancelled.',
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        'お知らせ / Notice',
        '現在設定されているタイマーはありません。\nNo timer is currently set.',
        ui.ButtonSet.OK
      );
    }
  }
}
