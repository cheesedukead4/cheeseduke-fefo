/*
 * 雲端資料層（FEStore）
 * ---------------------------------------------------------------
 *  - 資料存在這台裝置的 IndexedDB（可離線使用），分類上傳到 Google Apps Script 後端（雲端後端/Code.gs）：
 *      products        產品（名稱、單位、保存天數、低庫存警戒量）
 *      settings        效期預警設定（一筆，id = main）
 *      opening_YYYYMM  期初庫存，依「入帳日期」（entryDate）的年月分檔
 *      shop_YYYYMM     門市進貨、銷售、報廢（shop = a11 | jz | dq），依日期的年月分檔
 *      moves_YYYYMM    每日生產與出貨（type = production | shipment），依日期的年月分檔，
 *                      避免單一檔案越來越大、每次修改都要上傳全部歷史
 *  - 每類有雲端版本號；上傳時帶「我是根據哪一版改的」，有人搶先更新就先下載，以單筆（id）為單位三方合併後再上傳
 *  - 同一筆的同一個欄位被兩個人改成不同值時，以這台裝置的修改為準，並通知畫面提示
 *  - IndexedDB 名稱用 fe- 開頭，和同網域的其他網站（採購看板 pb-、檔期包材 cms-）不會互相影響
 */
(function () {
  'use strict';

  var IDB_NAME = 'fe-app-data';
  var STORE = 'kv';
  var POLL_MS = 30000;
  var PUSH_DELAY_MS = 800;
  var LABELS = { products: '產品', settings: '效期設定', opening: '期初庫存', moves: '生產與出貨紀錄', shop: '門市庫存' };
  var MONTHLY = ['opening', 'moves', 'shop'];   // 依日期年月分檔的種類（資料要有 date 或 entryDate 欄位）
  var KEY_RE = /^(products|settings|(opening|moves|shop)_\d{6})$/;

  var parts = Object.create(null);   // 類別 -> JSON 字串（目前本機值，陣列）
  var bases = Object.create(null);   // 類別 -> 上次與雲端一致時的 JSON 字串（僅本機有未上傳修改時保存）
  var vers = Object.create(null);    // 類別 -> 雲端版本號
  var dirty = new Set();             // 尚未上傳的類別
  var blocked = Object.create(null); // 雲端拒絕儲存的類別 -> 錯誤訊息
  var cache = Object.create(null);   // 種類 -> 合併後的陣列（有變動就清掉）
  var pushing = false, pulling = false, pushTimer = null, retryDelay = 4000, serverErrors = 0;
  var status = { state: 'loading', detail: '', lastSync: 0, loaded: false };
  var listeners = [];
  var idb = null;

  function kindOf(key) { var m = /^(opening|moves|shop)_\d{6}$/.exec(key); return m ? m[1] : key; }
  function label(key) {
    var k = kindOf(key);
    if (MONTHLY.indexOf(k) >= 0) { var ym = key.slice(-6); return LABELS[k] + '（' + ym.slice(0, 4) + '/' + ym.slice(4) + '）'; }
    return LABELS[k] || key;
  }
  function monthKey(kind, date) { var m = /^(\d{4})-(\d{2})/.exec(String(date || '')); return kind + '_' + (m ? m[1] + m[2] : '000000'); }
  function keyFor(kind, rec) { return MONTHLY.indexOf(kind) >= 0 ? monthKey(kind, rec.date || rec.entryDate) : kind; }
  function keysOf(kind) { return Object.keys(parts).filter(function (k) { return kindOf(k) === kind; }); }

  // ---------- 設定：網址來自 config.js，憑證是 Google 登入後的工作階段 ----------
  function getConfig() {
    var A = window.FEAuth, url = ((window.FE_CLOUD || {}).url || '').trim();
    if (!A || !A.enabled || !url) return null;
    var s = A.session();
    return s ? { url: url, token: s } : null;
  }

  // ---------- IndexedDB ----------
  function idbOpen() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) return resolve(null);
      var req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { resolve(null); };
      req.onblocked = function () { resolve(null); };
    });
  }
  function idbAll() {
    return new Promise(function (resolve) {
      if (!idb) return resolve({});
      var out = {};
      var cur = idb.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
      cur.onsuccess = function () { var c = cur.result; if (c) { out[c.key] = c.value; c.continue(); } else resolve(out); };
      cur.onerror = function () { resolve(out); };
    });
  }
  function idbWrite(puts, dels) {
    if (!idb) return;
    try {
      var st = idb.transaction(STORE, 'readwrite').objectStore(STORE);
      Object.keys(puts || {}).forEach(function (k) { st.put(puts[k], k); });
      (dels || []).forEach(function (k) { st.delete(k); });
    } catch (e) { console.warn('本機快取寫入失敗', e); }
  }
  function metaRecord() { return { vers: Object.assign({}, vers), dirty: Array.from(dirty) }; }

  // ---------- 讀取 ----------
  function arrOf(key) {
    try { var a = JSON.parse(parts[key] || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function list(kind) {
    if (cache[kind]) return cache[kind];
    var out = [];
    keysOf(kind).forEach(function (k) { arrOf(k).forEach(function (r) { if (r && r.id != null) out.push(r); }); });
    cache[kind] = out;
    return out;
  }
  function get(kind, id) { return list(kind).find(function (r) { return r.id === id; }) || null; }
  function invalidate(keys) { keys.forEach(function (k) { delete cache[kindOf(k)]; }); }

  // ---------- 本機修改 ----------
  function setKey(key, arr, puts) {
    var s = JSON.stringify(arr);
    if (parts[key] === s) return false;
    if (!dirty.has(key)) { bases[key] = (key in parts) ? parts[key] : null; puts['b:' + key] = bases[key]; dirty.add(key); }
    delete blocked[key];
    parts[key] = s; puts['p:' + key] = s;
    return true;
  }
  function commit(puts, changed) {
    if (!changed.length) return;
    invalidate(changed);
    puts.meta = metaRecord();
    idbWrite(puts);
    emit('change', { keys: changed, local: true });
    if (getConfig()) { setStatus('pending'); schedulePush(); }
  }
  function saveMany(kind, recs) {
    var puts = {}, changed = [], work = Object.create(null);
    var load = function (k) { if (!(k in work)) work[k] = arrOf(k); return work[k]; };
    recs.forEach(function (rec) {
      if (!rec || rec.id == null) throw new Error('資料缺少 id');
      var clean = JSON.parse(JSON.stringify(rec));
      var target = keyFor(kind, clean);
      keysOf(kind).concat(Object.keys(work)).forEach(function (k) {
        if (k === target || kindOf(k) !== kind) return;
        var a = load(k), i = a.findIndex(function (x) { return x && x.id === clean.id; });
        if (i >= 0) a.splice(i, 1);
      });
      var a = load(target), i = a.findIndex(function (x) { return x && x.id === clean.id; });
      if (i >= 0) a[i] = clean; else a.push(clean);
    });
    Object.keys(work).forEach(function (k) { if (setKey(k, work[k], puts)) changed.push(k); });
    commit(puts, changed);
  }
  function removeMany(kind, ids) {
    var set = new Set(ids), puts = {}, changed = [];
    keysOf(kind).forEach(function (k) {
      var a = arrOf(k), b = a.filter(function (x) { return !(x && set.has(x.id)); });
      if (b.length !== a.length && setKey(k, b, puts)) changed.push(k);
    });
    commit(puts, changed);
  }
  // 整類取代（匯入備份、清除全部、範例資料）：依新資料重新分檔，用不到的舊檔清成空陣列
  function replaceKinds(map) {
    var puts = {}, changed = [];
    Object.keys(map).forEach(function (kind) {
      var next = Object.create(null);
      (map[kind] || []).forEach(function (rec) {
        if (!rec || rec.id == null) throw new Error('資料缺少 id');
        var clean = JSON.parse(JSON.stringify(rec)), k = keyFor(kind, clean);
        (next[k] = next[k] || []).push(clean);
      });
      keysOf(kind).forEach(function (k) { if (!(k in next)) next[k] = []; });
      Object.keys(next).forEach(function (k) { if (setKey(k, next[k], puts)) changed.push(k); });
    });
    commit(puts, changed);
  }

  // ---------- 三方合併（與 cloud-sync.js 相同）----------
  function same(a, b) { return a === b || JSON.stringify(a) === JSON.stringify(b); }
  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function idArray(a) {
    if (!Array.isArray(a)) return false;
    var seen = new Set();
    for (var i = 0; i < a.length; i++) {
      var x = a[i];
      if (!isObj(x) || x.id === undefined || x.id === null || x.id === '') return false;
      var id = String(x.id);
      if (seen.has(id)) return false;
      seen.add(id);
    }
    return true;
  }
  // 回傳 { v: 合併結果, conflicts: [路徑...] }；衝突欄位依 prefer（'local' | 'remote'）取值
  function merge3(b, l, r, prefer, path) {
    path = path || '';
    if (same(l, r)) return { v: l, conflicts: [] };
    if (b !== undefined && same(b, l)) return { v: r, conflicts: [] };
    if (b !== undefined && same(b, r)) return { v: l, conflicts: [] };
    var conflicts = [];
    function mergeEntry(bv, hasB, lv, hasL, rv, hasR, p) {
      if (hasL && hasR) { var m = merge3(hasB ? bv : undefined, lv, rv, prefer, p); conflicts = conflicts.concat(m.conflicts); return { keep: true, v: m.v }; }
      if (hasL) {
        if (!hasB) return { keep: true, v: lv };
        if (same(bv, lv)) return { keep: false };
        conflicts.push(p); return prefer === 'remote' ? { keep: false } : { keep: true, v: lv };
      }
      if (hasR) {
        if (!hasB) return { keep: true, v: rv };
        if (same(bv, rv)) return { keep: false };
        conflicts.push(p); return prefer === 'remote' ? { keep: true, v: rv } : { keep: false };
      }
      return { keep: false };
    }
    if (isObj(l) && isObj(r)) {
      var bo = isObj(b) ? b : {};
      var out = {};
      var keys = Object.keys(l).concat(Object.keys(r).filter(function (k) { return !(k in l); }));
      keys.forEach(function (k) {
        var e = mergeEntry(bo[k], k in bo, l[k], k in l, r[k], k in r, path + '.' + k);
        if (e.keep) out[k] = e.v;
      });
      return { v: out, conflicts: conflicts };
    }
    if (idArray(l) && idArray(r) && (b === undefined || idArray(b))) {
      var mapOf = function (a) { var m = new Map(); (a || []).forEach(function (x) { m.set(String(x.id), x); }); return m; };
      var bm = mapOf(b), lm = mapOf(l), rm = mapOf(r);
      var order = r.map(function (x) { return String(x.id); });
      l.forEach(function (x, i) {
        var id = String(x.id);
        if (rm.has(id)) return;
        var prev = i > 0 ? String(l[i - 1].id) : null;
        var at = prev === null ? 0 : order.indexOf(prev) + 1;
        if (prev !== null && at === 0) at = order.length;
        order.splice(at, 0, id);
      });
      var res = [];
      order.forEach(function (id) {
        var e = mergeEntry(bm.get(id), bm.has(id), lm.get(id), lm.has(id), rm.get(id), rm.has(id), path + '[' + id + ']');
        if (e.keep) res.push(e.v);
      });
      return { v: res, conflicts: conflicts };
    }
    return { v: prefer === 'remote' ? r : l, conflicts: [path || '(整筆)'] };
  }

  // ---------- 網路 ----------
  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('連線逾時')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) {
        clearTimeout(t);
        reject(e instanceof TypeError ? new Error(navigator.onLine === false ? '目前沒有網路' : '無法連線到雲端（網路不穩，或雲端網址／部署設定有誤）') : e);
      });
    });
  }
  function apiGet(cfg, params, ms) {
    var q = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
    var url = cfg.url + (cfg.url.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(cfg.token) + '&' + q + '&_=' + Date.now();
    return withTimeout(fetch(url, { method: 'GET', redirect: 'follow', cache: 'no-store' }), ms || 30000).then(readJson).then(checkResp);
  }
  function apiPost(cfg, body, ms) {
    body.token = cfg.token;
    return withTimeout(fetch(cfg.url, {
      method: 'POST', redirect: 'follow', cache: 'no-store',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }), ms || 120000).then(readJson).then(checkResp);
  }
  function readJson(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json().catch(function () {
      var e = new Error('雲端回應的不是資料（請確認網址結尾是 /exec，且部署的「誰可以存取」是「所有人」）');
      e.code = 'bad_response';
      throw e;
    });
  }
  function checkResp(j) {
    if (j && j.ok && window.FEAuth) FEAuth.applyMe(j); // 雲端順帶回傳最新的權限，以及延長後的登入
    if (!j || !j.ok) {
      var code = j && j.error;
      var msg = code === 'unauthorized' ? '登入已過期，請重新登入'
        : code === 'forbidden' ? '帳號已停用或不在人員名單內'
        : code === 'busy' ? '雲端忙碌中，稍後自動重試'
        : code === 'server' ? '雲端發生錯誤：' + (j.message || '')
        : (code || '雲端回應錯誤');
      var err = new Error(msg);
      err.code = code;
      throw err;
    }
    return j;
  }
  function isHardError(e) { return e.code === 'unauthorized' || e.code === 'forbidden' || e.code === 'server' || e.code === 'bad_response'; }
  function denyIfAuth(e) {
    if (window.FEAuth && (e.code === 'unauthorized' || e.code === 'forbidden')) { clearTimeout(pushTimer); FEAuth.denied(e.code); return true; }
    return false;
  }
  function fetchKeys(cfg, keys) {
    var batches = [], cur = [];
    keys.forEach(function (k) { cur.push(k); if (cur.join(',').length > 1500) { batches.push(cur); cur = []; } });
    if (cur.length) batches.push(cur);
    var data = {};
    return batches.reduce(function (p, b) {
      return p.then(function () {
        return apiGet(cfg, { action: 'get', keys: b.join(',') }, 120000).then(function (j) { Object.assign(data, j.data || {}); });
      });
    }, Promise.resolve()).then(function () { return data; });
  }

  // ---------- 下載 ----------
  function pull(opts) {
    opts = opts || {};
    var cfg = getConfig();
    if (!cfg || pulling || pushing) return Promise.resolve(false);
    pulling = true;
    if (opts.initial) setStatus('syncing', '正在讀取雲端資料…');
    return apiGet(cfg, { action: 'meta' }, opts.initial ? 15000 : 20000).then(function (j) {
      var meta = j.meta || {};
      // 雲端遺失了本機記錄過的類別（例如後端被重設）：版本歸零並重新上傳本機資料
      Object.keys(vers).forEach(function (k) {
        if (!(k in meta) && vers[k]) {
          vers[k] = 0;
          if (k in parts && !dirty.has(k)) { bases[k] = null; dirty.add(k); }
        }
      });
      var toFetch = [], deletedRemote = [];
      Object.keys(meta).forEach(function (k) {
        if (!KEY_RE.test(k) || (vers[k] | 0) === (meta[k].v | 0)) return;
        (meta[k].deleted ? deletedRemote : toFetch).push(k);
      });
      if (!toFetch.length && !deletedRemote.length) return { changed: [], conflicts: [] };
      return (toFetch.length ? fetchKeys(cfg, toFetch) : Promise.resolve({})).then(function (data) {
        deletedRemote.forEach(function (k) { data[k] = { v: meta[k].v, value: null }; });
        return applyRemote(data);
      });
    }).then(function (res) {
      pulling = false;
      status.lastSync = Date.now();
      status.loaded = true;
      if (dirty.size) { setStatus('pending'); schedulePush(0); } else setStatus('synced');
      if (res.changed.length) { invalidate(res.changed); emit('change', { keys: res.changed, local: false }); }
      if (res.conflicts.length) emit('conflict', res.conflicts);
      return true;
    }).catch(function (e) {
      pulling = false;
      setStatus(isHardError(e) ? 'error' : 'offline', e.message);
      denyIfAuth(e);
      return false;
    });
  }

  // 套用雲端資料；本機也改過的類別做三方合併
  function applyRemote(data) {
    var puts = {}, dels = [], changed = [], conflicts = [];
    Object.keys(data).forEach(function (k) {
      var d = data[k], remoteStr = d.value;
      if (d.missing) { // 雲端檔案遺失：用這台裝置的資料重建
        vers[k] = d.v;
        if (k in parts && !dirty.has(k)) { bases[k] = null; puts['b:' + k] = null; dirty.add(k); }
        return;
      }
      if (dirty.has(k)) {
        var b = bases[k], l = k in parts ? parts[k] : null;
        if (remoteStr === l) { vers[k] = d.v; dirty.delete(k); delete bases[k]; dels.push('b:' + k); return; }
        var bv = b == null ? undefined : JSON.parse(b);
        var lv = l == null ? undefined : JSON.parse(l);
        var rv = remoteStr == null ? undefined : JSON.parse(remoteStr);
        var mv;
        if (lv === undefined) mv = rv;
        else if (rv === undefined) mv = lv;
        else {
          var m = merge3(bv, lv, rv, 'local');
          mv = m.v;
          if (m.conflicts.length) conflicts.push(label(k));
        }
        if (mv === undefined) { delete parts[k]; dels.push('p:' + k); }
        else { parts[k] = JSON.stringify(mv); puts['p:' + k] = parts[k]; }
        // 合併後的結果以新的雲端版本為基準，仍需上傳
        bases[k] = remoteStr; puts['b:' + k] = remoteStr;
        vers[k] = d.v;
        changed.push(k);
      } else {
        if (remoteStr == null) { if (k in parts) { delete parts[k]; dels.push('p:' + k); changed.push(k); } }
        else if (parts[k] !== remoteStr) { parts[k] = remoteStr; puts['p:' + k] = remoteStr; changed.push(k); }
        vers[k] = d.v;
      }
    });
    puts.meta = metaRecord();
    idbWrite(puts, dels);
    return { changed: changed, conflicts: conflicts };
  }

  // ---------- 上傳 ----------
  function schedulePush(delay) {
    if (!getConfig()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, delay == null ? PUSH_DELAY_MS : delay);
  }
  function push() {
    var cfg = getConfig();
    if (!cfg || !dirty.size) return Promise.resolve();
    if (pushing || pulling) { schedulePush(800); return Promise.resolve(); }
    var keys = Array.from(dirty).filter(function (k) { return !blocked[k]; }), sent = {}, changes = {};
    if (!keys.length) { setStatus('error', blockedMsg()); return Promise.resolve(); }
    pushing = true;
    setStatus('syncing', '上傳中…');
    keys.forEach(function (k) {
      sent[k] = k in parts ? parts[k] : null;
      changes[k] = { base: vers[k] | 0, value: sent[k] };
    });
    return apiPost(cfg, { action: 'put', changes: changes }).then(function (j) {
      pushing = false; retryDelay = 4000; serverErrors = 0;
      var puts = {}, dels = [];
      Object.keys(j.applied || {}).forEach(function (k) {
        vers[k] = j.applied[k];
        var now = k in parts ? parts[k] : null;
        if (now === sent[k]) { dirty.delete(k); delete bases[k]; dels.push('b:' + k); }
        else { bases[k] = sent[k]; puts['b:' + k] = sent[k]; } // 上傳期間又有修改
      });
      Object.keys(j.rejected || {}).forEach(function (k) { dirty.delete(k); delete bases[k]; dels.push('b:' + k); console.warn('雲端不接受的資料類別：' + k); });
      Object.keys(j.failed || {}).forEach(function (k) { blocked[k] = j.failed[k]; });
      puts.meta = metaRecord();
      idbWrite(puts, dels);
      status.lastSync = Date.now();
      if (Object.keys(j.conflicts || {}).length) return pull(); // 有人搶先更新：下載後自動合併再上傳
      var progressed = Object.keys(j.applied || {}).length > 0;
      var sendable = Array.from(dirty).some(function (k) { return !blocked[k]; });
      if (sendable) schedulePush(progressed ? 300 : retryDelay);
      else if (dirty.size) setStatus('error', blockedMsg());
      else setStatus('synced');
    }).catch(function (e) {
      pushing = false;
      if (e.code === 'unauthorized' || e.code === 'forbidden' || e.code === 'bad_response') { setStatus('error', e.message); denyIfAuth(e); return; }
      if (e.code === 'server' && ++serverErrors >= 5) { setStatus('error', e.message + '（已停止自動重試，請通知管理員）'); return; }
      setStatus(e.code === 'server' ? 'error' : 'offline', e.message);
      schedulePush(retryDelay); retryDelay = Math.min(retryDelay * 2, 60000);
    });
  }
  function blockedMsg() {
    var k = Object.keys(blocked)[0];
    return k ? '雲端無法儲存「' + label(k) + '」：' + blocked[k] : '';
  }

  // ---------- 狀態通知 ----------
  function setStatus(state, detail) { status.state = state; status.detail = detail || ''; emit('status', status); }
  function emit(type, payload) { listeners.forEach(function (fn) { try { fn(type, payload); } catch (e) { console.error(e); } }); }

  // ---------- 啟動 ----------
  var ready = idbOpen().then(function (db_) {
    idb = db_;
    return idbAll();
  }).then(function (all) {
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('p:') === 0) parts[k.slice(2)] = all[k];
      else if (k.indexOf('b:') === 0) bases[k.slice(2)] = all[k];
    });
    var meta = all.meta || {};
    Object.assign(vers, meta.vers || {});
    (meta.dirty || []).forEach(function (k) { dirty.add(k); });
    // 讀本機資料之前畫面可能已經呼叫過 list()，把那時算出的空結果清掉
    Object.keys(cache).forEach(function (k) { delete cache[k]; });
    return window.FEAuth ? FEAuth.ready : null; // 沒登入就不開始（登入畫面顯示中），登入後才讀雲端
  }).then(function () {
    var cfg = getConfig();
    var hasLocal = Object.keys(vers).length > 0 || Object.keys(parts).length > 0;
    if (!cfg) { setStatus('error', '尚未設定雲端網址（config.js）'); return; }
    if (navigator.onLine === false) {
      status.loaded = hasLocal;
      setStatus('offline', hasLocal ? '目前離線，使用這台裝置上的資料' : '目前離線，連上網路後才能第一次下載資料');
      emit('change', { keys: Object.keys(parts), local: false });
      return;
    }
    if (hasLocal) { status.loaded = true; emit('change', { keys: Object.keys(parts), local: false }); }
    return pull({ initial: true });
  }).catch(function (e) { console.error('資料層啟動失敗', e); });

  setInterval(function () {
    if (document.visibilityState === 'visible' && getConfig() && !pushing && navigator.onLine !== false) pull();
  }, POLL_MS);
  window.addEventListener('online', function () { if (getConfig()) { pull(); schedulePush(0); } });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && getConfig()) pull(); });
  // 未上傳的修改已存在本機 IndexedDB，下次開啟會自動補傳，所以關閉頁面時不需要阻擋
  window.addEventListener('pagehide', function () { if (getConfig() && dirty.size) push(); });

  // 登出或被移出名單時清掉這台裝置上的資料（IndexedDB）
  function wipeLocal() {
    return new Promise(function (resolve) {
      clearTimeout(pushTimer);
      var db0 = idb; idb = null;
      [parts, bases, vers, cache].forEach(function (o) { Object.keys(o).forEach(function (k) { delete o[k]; }); });
      dirty.clear();
      try { if (db0) db0.close(); } catch (e) {}
      if (!window.indexedDB) return resolve();
      var r;
      try { r = indexedDB.deleteDatabase(IDB_NAME); } catch (e) { return resolve(); }
      r.onsuccess = r.onerror = r.onblocked = function () { resolve(); };
    });
  }

  window.FEStore = {
    ready: ready,
    list: list, get: get,
    save: function (kind, rec) { saveMany(kind, [rec]); },
    saveMany: saveMany,
    remove: function (kind, id) { removeMany(kind, [id]); },
    removeMany: removeMany,
    replaceKinds: replaceKinds,
    on: function (fn) { listeners.push(fn); },
    status: function () { return Object.assign({ dirty: dirty.size }, status); },
    syncNow: function () {
      blocked = Object.create(null); serverErrors = 0;
      return pull().then(function (ok) { return push().then(function () { return ok; }); });
    },
    wipeLocal: wipeLocal,
    label: label,
    _merge3: merge3, _keyFor: keyFor
  };
})();
