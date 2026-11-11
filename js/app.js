/*
 * 生產出貨庫存效期管理｜畫面與 FEFO 庫存引擎
 * ---------------------------------------------------------------
 * 資料（FEStore，見 cloud-store.js）：
 *   products  { id, name, unit, shelfDays, lowStock }                       id = 'p-' + 名稱雜湊（兩台裝置新增同名產品會合併成同一筆）
 *   settings  { id: 'main', warnDays, defaultShelf }
 *   opening   { id, type: 'opening', seq, product, batch, manufactureDate, expiryDate, entryDate, quantity, note, by, at, editBy?, editAt? }
 *   moves     生產 { id, type: 'production', seq, date, product, batch, manufactureDate, expiryDate, quantity, note, by, at, ... }
 *             出貨 { id, type: 'shipment', seq, date, product, quantity, orderNo, note, by, at, ... }
 *   product 欄位存「產品名稱」（不是 id），和舊的網頁版、離線版 JSON 備份格式相同。
 * 分頁（網址 #）：dashboard opening production shipment portal batches allocations products manage users
 * 權限：FEAuth.can(代號)，管理員全部都有。代號見 PERMS。這是畫面權限，雲端後端只擋「不在名單的人」。
 *
 * 入口網站同步（#portal）：入口網站 cheeseduke.flowings.app 要 Google 登入，App 不能直接去讀，所以用書籤：
 *   書籤在入口網站讀「物管駕駛艙 → 總表」的 API（/api/internal/logistics-console/hq-ledger?date=，只讀）最近 14 天，
 *   每天每個品號取 row.semiIn（半成品入庫）與 row.actualPick（實際揀貨），放進網址 #portal= 後開啟 App。
 *   App 一開啟就把資料收進 sessionStorage（fe_portal_pending）並清掉網址，登入且資料載入後才寫入：
 *     半成品入庫 → 生產紀錄 id = 'pt-p-日期-品號'；實際揀貨 → 出貨紀錄 id = 'pt-s-日期-品號'（同一天同品號只有一筆，重複同步只更新）。
 *     書籤讀到的日期中，入口網站已經沒有數字的 pt- 紀錄會刪掉（以入口網站為準）。起算日（settings 'portal'.syncFrom，
 *     預設＝期初庫存最晚入帳日的隔天）以前的日期不匯入。品號用產品名稱第一段（「品號 品名」）對應，對不到就新增產品。
 */
'use strict';

/* 入口網站書籤帶來的資料：越早收起來越好（登入畫面或重新載入都不會弄丟），並把很長的網址換掉 */
const PORTAL_PENDING = 'fe_portal_pending';
(function stashPortal() {
  const m = /^#portal=([A-Za-z0-9_-]+)$/.exec(location.hash || '');
  if (!m) return;
  try { sessionStorage.setItem(PORTAL_PENDING, m[1]); } catch (e) {}
  try { history.replaceState(null, '', location.pathname + location.search + '#portal'); } catch (e) {}
})();

const PERMS = [
  { id: 'produce', label: '生產與期初庫存', desc: '新增、修改、刪除期初庫存與每日生產紀錄' },
  { id: 'ship', label: '出貨', desc: '新增、修改、刪除每日出貨紀錄' },
  { id: 'setting', label: '產品與效期設定', desc: '修改產品單位、保存天數、低庫存警戒量，以及效期預警天數' },
];
const PERM_LABEL = Object.fromEntries(PERMS.map(p => [p.id, p.label]));
const isAdmin = () => !!(window.FEAuth && FEAuth.isAdmin());
const can = p => !!(window.FEAuth && FEAuth.can(p));
const myName = () => (window.FEAuth && FEAuth.name()) || '';
const MAX_ROWS = 300;

/* ---------- 基本工具 ---------- */
const TODAY = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Number(n || 0).toLocaleString('zh-TW', { maximumFractionDigits: 3 });
const isDate = s => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const [y, m, d] = s.split('-').map(Number); const z = new Date(Date.UTC(y, m - 1, d)); return z.getUTCFullYear() === y && z.getUTCMonth() === m - 1 && z.getUTCDate() === d; };
const addDays = (date, days) => { if (!isDate(date) || !Number.isFinite(Number(days))) return ''; const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + Number(days))).toISOString().slice(0, 10); };
const dayDiff = (from, to) => { const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(to) - p(from)) / 86400000); };
const shortDate = s => isDate(s) ? s.slice(5).replace('-', '/') : '—';
const $ = id => document.getElementById(id);
const clean = s => String(s ?? '').trim();
const clampQty = q => Math.round((Number(q) + Number.EPSILON) * 1000) / 1000;
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const uid = () => `id_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
const cyrb53 = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909); return 4294967296 * (2097151 & h2) + (h1 >>> 0); };
const productId = name => 'p-' + cyrb53(clean(name)).toString(36);
let lastSeq = 0; const nextSeq = () => { const n = Math.max(Date.now(), lastSeq + 1); lastSeq = n; return n; };
const nowIso = () => new Date().toISOString();
// 現貨（已包裝好的成品）沒有效期資料：存成 pool = 'stock'、有效日期 9999-12-31 的批次，出貨時先扣現貨，不夠才照效期扣半成品
const NO_EXPIRY = '9999-12-31';
const expShow = d => d === NO_EXPIRY ? '—' : d;
// 不需要管理的產品：品名含這些字的（例如「CK-08|YA-23 6朱|擺盤」）不同步、不顯示，所有表格與計算都當作不存在
const EXCLUDE_WORDS = ['擺盤'];
const isExcluded = name => EXCLUDE_WORDS.some(w => String(name || '').includes(w));
const blankState = () => ({ version: 1, products: [], opening: [], movements: [], settings: { warnDays: 30, defaultShelf: 30 } });

/* ---------- 狀態 ---------- */
let data = blankState();
let currentView = 'dashboard';
let editOpening = null;
const loading = () => !FEStore.status().loaded;

const getProduct = name => data.products.find(p => p.name === clean(name));
const getUnit = (name, st = data) => st.products.find(p => p.name === name)?.unit || '個';
const unitsLabel = entries => { const units = [...new Set(entries.map(x => x.unit))]; if (!entries.length) return '0'; if (units.length === 1) return `${fmt(entries.reduce((t, x) => t + x.quantity, 0))}<span class="kpi-unit">${esc(units[0])}</span>`; return `${entries.length}<span class="kpi-unit">筆（多種單位）</span>`; };

function toast(message, error = false, ms = 4200) { const el = $('toast'); el.textContent = message; el.className = `toast${error ? ' error' : ''}`; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, ms); }

/* ---------- 從 FEStore 組出畫面用的資料（共用資料一律先檢查格式） ---------- */
function normProduct(p) {
  if (!p || !clean(p.name)) return null;
  const sd = Number(p.shelfDays), low = Number(p.lowStock);
  return { id: clean(p.id) || productId(p.name), name: clean(p.name), unit: clean(p.unit) || '個', shelfDays: Number.isInteger(sd) && sd >= 0 ? sd : 30, lowStock: low > 0 ? low : 0 };
}
function normSettings(s) {
  const w = Number(s?.warnDays), d = Number(s?.defaultShelf);
  return { warnDays: Number.isInteger(w) && w > 0 ? w : 30, defaultShelf: Number.isInteger(d) && d >= 0 ? d : 30 };
}
function sanitizeRec(r) {
  if (!r || typeof r !== 'object' || !r.id) return null;
  const q = Number(r.quantity), product = clean(r.product);
  if (!product || !(q > 0) || !Number.isFinite(q)) return null;
  const base = { id: String(r.id), seq: Number(r.seq) || 0, product, quantity: q, note: clean(r.note), by: clean(r.by), at: r.at || '', editBy: clean(r.editBy), editAt: r.editAt || '' };
  if (r.type === 'shipment') return isDate(r.date) ? { ...base, type: 'shipment', date: r.date, orderNo: clean(r.orderNo) } : null;
  if (r.type === 'convert') return isDate(r.date) ? { ...base, type: 'convert', date: r.date } : null; // 半成品轉現貨
  if (!isDate(r.manufactureDate) || !isDate(r.expiryDate)) return null;
  const lot = { ...base, batch: clean(r.batch) || '—', manufactureDate: r.manufactureDate, expiryDate: r.expiryDate, ...(r.pool === 'stock' ? { pool: 'stock' } : {}) };
  if (r.type === 'opening') return isDate(r.entryDate) ? { ...lot, type: 'opening', entryDate: r.entryDate } : null;
  if (r.type === 'production') return isDate(r.date) ? { ...lot, type: 'production', date: r.date } : null;
  return null;
}
function addVirtualProducts(st) {
  const names = new Set(st.products.map(p => p.name));
  for (const r of [...st.opening, ...st.movements]) if (!names.has(r.product)) { names.add(r.product); st.products.push({ id: productId(r.product), name: r.product, unit: '個', shelfDays: st.settings.defaultShelf, lowStock: 0, virtual: true }); }
  return st;
}
function rebuild() {
  const seen = new Set();
  const products = FEStore.list('products').map(normProduct).filter(p => p && !isExcluded(p.name) && !seen.has(p.name) && seen.add(p.name));
  const settings = normSettings(FEStore.get('settings', 'main'));
  const opening = [], movements = [];
  for (const r of FEStore.list('opening')) { const x = sanitizeRec({ ...r, type: 'opening' }); if (x && !isExcluded(x.product)) opening.push(x); }
  for (const r of FEStore.list('moves')) { const x = sanitizeRec(r); if (x && x.type !== 'opening' && !isExcluded(x.product)) movements.push(x); }
  data = addVirtualProducts({ version: 1, products, opening, movements, settings });
}

/* ---------- 寫入（先存這台裝置，背景上傳雲端） ---------- */
const kindOfRec = r => r.type === 'opening' ? 'opening' : 'moves';
function recordBody(rec) {
  const b = { id: rec.id, type: rec.type, seq: rec.seq, product: rec.product, quantity: rec.quantity, note: rec.note || '', by: rec.by || '', at: rec.at || '' };
  if (rec.editBy) { b.editBy = rec.editBy; b.editAt = rec.editAt; }
  if (rec.type === 'shipment') { b.date = rec.date; b.orderNo = rec.orderNo || ''; }
  else if (rec.type === 'convert') b.date = rec.date;
  else { b.batch = rec.batch; b.manufactureDate = rec.manufactureDate; b.expiryDate = rec.expiryDate; if (rec.type === 'opening') b.entryDate = rec.entryDate; else b.date = rec.date; if (rec.pool === 'stock') b.pool = 'stock'; }
  return b;
}
function storeRecord(rec) { FEStore.save(kindOfRec(rec), recordBody(rec)); }
const storeProduct = p => FEStore.save('products', { id: p.id, name: p.name, unit: p.unit, shelfDays: p.shelfDays, lowStock: p.lowStock });
function replaceAll(st) {
  const strip = r => { const { virtual, ...x } = r; return x; };
  const uniq = (arr, key) => { const seen = new Set(); return arr.filter(x => !seen.has(key(x)) && seen.add(key(x))); };
  FEStore.replaceKinds({
    products: uniq(st.products, p => p.name).map(p => ({ id: productId(p.name), name: p.name, unit: p.unit, shelfDays: p.shelfDays, lowStock: p.lowStock })),
    settings: [{ id: 'main', warnDays: st.settings.warnDays, defaultShelf: st.settings.defaultShelf }],
    opening: uniq(st.opening, r => r.id).map(r => strip({ ...r, type: 'opening' })),
    moves: uniq(st.movements, r => r.id).map(strip),
  });
}
function act(fn) { try { fn(); return true; } catch (err) { toast(err.message || '操作失敗', true, 6000); return false; } }

/* ---------- JSON 備份（與舊的網頁版、離線版通用：version 1） ---------- */
function isValidState(d) { return !!d && d.version === 1 && Array.isArray(d.products) && Array.isArray(d.opening) && Array.isArray(d.movements) && d.opening.length < 100000 && d.movements.length < 300000; }
function normalizeImport(d) {
  return {
    version: 1,
    products: d.products.map(normProduct).filter(Boolean),
    opening: d.opening.map(r => sanitizeRec({ ...r, type: 'opening', entryDate: r.entryDate || r.date })).filter(Boolean),
    movements: d.movements.map(r => sanitizeRec(r)).filter(r => r && r.type !== 'opening'),
    settings: normSettings(d.settings),
  };
}
function validateImport(obj) {
  if (!isValidState(obj)) throw Error('這不是本系統的 JSON 備份檔');
  for (const row of [...obj.opening, ...obj.movements]) {
    if (!row || !row.id || !row.product || !(Number(row.quantity) > 0) || !Number.isFinite(Number(row.quantity)) || !(Number(row.quantity) <= 1e12)) throw Error('備份內有無效的數量或產品');
    if (row.type === 'shipment') { if (!isDate(row.date)) throw Error('出貨日期格式錯誤'); }
    else if (!isDate(row.expiryDate) || !isDate(row.manufactureDate) || !isDate(row.entryDate || row.date)) throw Error('庫存日期格式錯誤');
  }
  for (const p of obj.products) if (!p.name || !p.unit) throw Error('產品資料不完整');
  return normalizeImport(obj);
}
function exportState() {
  const maxSeq = [...data.opening, ...data.movements].reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0);
  return { version: 1, products: data.products.map(({ virtual, ...p }) => p), opening: data.opening.map(({ type, ...r }) => r), movements: data.movements.map(r => ({ ...r })), settings: { ...data.settings }, nextSeq: maxSeq + 1 };
}

/* ---------- 庫存引擎：依日期重放所有事件；同日先入庫，再依出貨順序扣最早到期者 ---------- */
// 同一天的順序：入庫（期初、生產）→ 半成品轉現貨 → 出貨
// 批次 pool：'stock' 現貨、'semi' 半成品（全現貨模式的有效期批次也記成 semi，但出貨時一律當現貨看）
// lot.used＝已扣（出貨＋轉成現貨）、lot.shipped＝只算出貨、lot.converted＝轉成現貨的量
function calculateLedger(asOf = '9999-12-31', st = data) {
  const events = [], prio = { production: 0, convert: 1, shipment: 2 };
  for (const x of st.opening) if (x.entryDate <= asOf) events.push({ date: x.entryDate, priority: 0, seq: x.seq || 0, type: 'opening', item: x });
  for (const x of st.movements) if (x.date <= asOf) events.push({ date: x.date, priority: prio[x.type] ?? 2, seq: x.seq || 0, type: x.type, item: x });
  events.sort((a, b) => cmp(a.date, b.date) || a.priority - b.priority || a.seq - b.seq || cmp(String(a.item.id), String(b.item.id)));
  const lots = [], shipments = new Map(), converts = new Map(), byProduct = new Map();
  const addLot = lot => { lots.push(lot); if (!byProduct.has(lot.product)) byProduct.set(lot.product, []); byProduct.get(lot.product).push(lot); };
  const prior = (l, d) => l.source === 'opening' || l.entryDate < d;
  const noExpFirst = (a, b) => (a.expiryDate === NO_EXPIRY ? 0 : 1) - (b.expiryDate === NO_EXPIRY ? 0 : 1); // 期初現貨沒有效期資料，當最舊的先出
  const tie = (a, b) => cmp(a.expiryDate, b.expiryDate) || cmp(a.manufactureDate, b.manufactureDate) || cmp(a.entryDate, b.entryDate) || a.seq - b.seq || cmp(a.id, b.id);
  for (const e of events) {
    const x = e.item;
    if (e.type === 'opening' || e.type === 'production') {
      addLot({ id: x.id, source: e.type, pool: x.pool === 'stock' ? 'stock' : 'semi', product: x.product, batch: x.batch, manufactureDate: x.manufactureDate, expiryDate: x.expiryDate, entryDate: e.date, quantity: Number(x.quantity), used: 0, shipped: 0, converted: 0, remaining: Number(x.quantity), seq: x.seq || 0, unit: getUnit(x.product, st) });
      continue;
    }
    const usable = l => l.remaining > 1e-7 && l.expiryDate >= e.date && l.manufactureDate <= e.date && l.entryDate <= e.date;
    if (e.type === 'convert') {
      // 半成品轉現貨：從效期最早的半成品轉（之前的先，當天入庫的最後），轉過去的現貨保留原本的批號與有效日期
      const from = (byProduct.get(x.product) || []).filter(l => l.pool === 'semi' && usable(l)).sort((a, b) => (prior(a, e.date) ? 0 : 1) - (prior(b, e.date) ? 0 : 1) || tie(a, b));
      const required = Number(x.quantity); let need = required;
      for (const lot of from) {
        if (need <= 1e-7) break;
        const q = clampQty(Math.min(need, lot.remaining));
        lot.remaining = clampQty(lot.remaining - q); lot.used = clampQty(lot.used + q); lot.converted = clampQty(lot.converted + q); need = clampQty(need - q);
        addLot({ id: x.id + '#' + lot.id, source: 'convert', pool: 'stock', product: lot.product, batch: lot.batch, manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, entryDate: e.date, quantity: q, used: 0, shipped: 0, converted: 0, remaining: q, seq: x.seq || 0, unit: lot.unit, fromLot: lot.id });
      }
      converts.set(x.id, { required, moved: clampQty(required - need), shortage: clampQty(need) });
      continue;
    }
    const eligible = (byProduct.get(x.product) || []).filter(usable);
    // 出貨順序
    //   半成品模式：①現貨（之前的、期初、當天轉好的）②半成品（轉現貨，效期最早的先）③當天的生產轉現貨
    //               ④當天的半成品入庫＝出完貨剩下的，前面都不夠時才當最後備用（手動登錄的當天生產也在這裡）
    //   全現貨模式：①既有現貨（效期最早的先）②當天生產
    const B = isStockModeDay(e.date);
    const rank = l => B ? ((prior(l, e.date) || l.source === 'convert') ? 0 : 2) : ((prior(l, e.date) || l.source === 'convert') ? (l.pool === 'stock' ? 0 : 1) : (l.pool === 'stock' ? 2 : 3));
    eligible.sort((a, b) => rank(a) - rank(b) || noExpFirst(a, b) || tie(a, b));
    const required = Number(x.quantity); let remaining = required; const allocations = [];
    for (const lot of eligible) { if (remaining <= 1e-7) break; const amount = clampQty(Math.min(remaining, lot.remaining)); lot.remaining = clampQty(lot.remaining - amount); lot.used = clampQty(lot.used + amount); lot.shipped = clampQty(lot.shipped + amount); remaining = clampQty(remaining - amount); allocations.push({ lotId: lot.id, pool: lot.pool, source: lot.source, product: lot.product, batch: lot.batch, manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, entryDate: lot.entryDate, quantity: amount }); }
    shipments.set(x.id, { required, shipped: clampQty(required - remaining), shortage: clampQty(remaining), allocations });
  }
  return { lots, shipments, converts };
}
// 依「產品＋現貨／半成品＋批號＋製作日＋有效日」彙整；inQty＝入庫（期初＋生產＋轉入現貨），shipped＝出貨，converted＝轉成現貨
function groupLots(ledger) { const g = new Map(); for (const lot of ledger.lots) { const key = JSON.stringify([lot.product, lot.pool, lot.batch, lot.manufactureDate, lot.expiryDate]); if (!g.has(key)) g.set(key, { product: lot.product, pool: lot.pool, batch: lot.batch, manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, opening: 0, production: 0, convert: 0, inQty: 0, used: 0, shipped: 0, converted: 0, remaining: 0, unit: lot.unit }); const r = g.get(key); r[lot.source] = clampQty((r[lot.source] || 0) + lot.quantity); r.inQty = clampQty(r.inQty + lot.quantity); r.used = clampQty(r.used + lot.used); r.shipped = clampQty(r.shipped + lot.shipped); r.converted = clampQty(r.converted + lot.converted); r.remaining = clampQty(r.remaining + lot.remaining); } return [...g.values()].sort((a, b) => productOrder(a.product, b.product) || cmp(a.expiryDate, b.expiryDate) || cmp(a.pool, b.pool) || cmp(a.manufactureDate, b.manufactureDate)); }
// 全 App 共用的品號排序：品號開頭 CK（6吋）→ CC（4吋）→ CA（小小公爵）→ CS（方盒）→ CL（生巧），其他開頭（例如 KA）排在後面，同開頭內照品號
const SORT_PREFIXES = ['CK', 'CC', 'CA', 'CS', 'CL'];
function prefixRank(name) { const px = String(name).split(/[-| ]/)[0].toUpperCase(), i = SORT_PREFIXES.indexOf(px); return i >= 0 ? i : SORT_PREFIXES.length; }
function productOrder(a, b) { return prefixRank(a) - prefixRank(b) || cmp(String(a), String(b)); }
const byProductName = list => [...list].sort((a, b) => productOrder(a.name, b.name));
const poolLabel = (pool, date = TODAY()) => isStockModeDay(date) || pool === 'stock' ? '現貨' : '半成品';
function productSummary(ledger, asOf = TODAY()) {
  const by = new Map(); for (const l of ledger.lots) { if (!by.has(l.product)) by.set(l.product, []); by.get(l.product).push(l); }
  return data.products.map(p => { const lots = by.get(p.name) || []; const usable = clampQty(lots.filter(x => x.expiryDate >= asOf).reduce((s, x) => s + x.remaining, 0)); const stock = clampQty(lots.filter(x => x.pool === 'stock' && x.expiryDate >= asOf).reduce((s, x) => s + x.remaining, 0)), semi = clampQty(usable - stock); const expired = clampQty(lots.filter(x => x.expiryDate < asOf).reduce((s, x) => s + x.remaining, 0)); const warning = clampQty(lots.filter(x => x.expiryDate >= asOf && dayDiff(asOf, x.expiryDate) <= data.settings.warnDays).reduce((s, x) => s + x.remaining, 0)); const oldest = lots.filter(x => x.remaining > 0 && x.expiryDate >= asOf && x.expiryDate !== NO_EXPIRY).sort((a, b) => cmp(a.expiryDate, b.expiryDate))[0]?.expiryDate || ''; const produced = clampQty(lots.filter(x => x.source === 'production').reduce((s, x) => s + x.quantity, 0)); const opened = clampQty(lots.filter(x => x.source === 'opening').reduce((s, x) => s + x.quantity, 0)); const used = clampQty(lots.reduce((s, x) => s + x.shipped, 0)); return { ...p, usable, stock, semi, expired, warning, oldest, produced, opened, used }; }).sort((a, b) => productOrder(a.name, b.name));
}
function expiryStatus(expiry, qty, date = TODAY()) { if (qty <= 0) return { label: '已用完', cls: 'other' }; if (expiry === NO_EXPIRY) return { label: '現貨', cls: 'future' }; const days = dayDiff(date, expiry); if (days < 0) return { label: '已過期', cls: 'expired' }; if (days <= 7) return { label: days === 0 ? '今日到期' : `剩 ${days} 天`, cls: 'critical' }; if (days <= data.settings.warnDays) return { label: `剩 ${days} 天`, cls: 'due' }; return { label: '正常', cls: 'ok' }; }

/* ---------- 表格與畫面 ---------- */
const badge = (label, cls) => `<span class="pill ${cls}">${esc(label)}</span>`;
const td = v => `<td>${v}</td>`;
const tdm = v => `<td class="mono">${esc(v || '—')}</td>`;
const tdWho = r => `<td class="who" title="${esc(r.editBy ? `最後修改：${r.editBy}` : '')}">${esc(r.by || '—')}${r.editBy && r.editBy !== r.by ? '＊' : ''}</td>`;
function table(columns, rows, empty = '尚無資料') {
  if (!rows.length) return `<div class="empty">${esc(loading() ? '正在讀取資料…' : empty)}</div>`;
  const more = rows.length > MAX_ROWS ? `<div class="more">共 ${rows.length} 筆，只顯示前 ${MAX_ROWS} 筆；請用搜尋縮小範圍，或匯出 CSV／Excel 查看全部。</div>` : '';
  return `<table class="data-table"><thead><tr>${columns.map(c => c.endsWith('#') ? `<th class="num">${esc(c.slice(0, -1))}</th>` : `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, MAX_ROWS).join('')}</tbody></table>${more}`;
}
function searchable(rows, term, fields) { const q = clean(term).toLowerCase(); return !q ? rows : rows.filter(r => fields.some(k => String(r[k] ?? '').toLowerCase().includes(q))); }
const permFor = type => type === 'shipment' ? 'ship' : 'produce';
const manageCol = type => can(permFor(type)) ? ['管理'] : [];
const manageCell = (kind, id) => String(id).startsWith('pt-') ? (can(permFor(kind)) ? td('<span class="pill other" title="入口網站同步的數字，要修改請在入口網站改後再同步">入口網站</span>') : '') : can(permFor(kind)) ? td(`<div class="segment">${kind === 'opening' ? `<button type="button" class="btn small" data-action="edit-${kind}" data-id="${esc(id)}">修改</button>` : ''}<button type="button" class="btn small danger" data-action="delete-${kind}" data-id="${esc(id)}">刪除</button></div>`) : '';

const VIEWS = { dashboard: ['營運總覽', '每日生產、出貨及批次有效日期，即時統整。'], opening: ['期初庫存建檔', '原始庫存按製作日期分開管理，不需擔心同批不同效期。'], production: ['每日生產紀錄', '入口網站同步帶入的每日生產，自動增加可出貨批次庫存。'], shipment: ['每日出貨紀錄', '入口網站同步帶入的實際揀貨，自動從有效期最近的庫存開始扣除。'], portal: ['入口網站同步', '從入口網站總表帶入每日半成品入庫（生產）與實際揀貨（出貨）。'], batches: ['批次庫存與效期', '依製作日期和有效日期追蹤每一批剩餘量。'], allocations: ['出貨扣批明細', '每張出貨單實際扣除了哪些製作日期，一目了然。'], products: ['產品庫存總表', '總庫存、近效期及過期量依產品清楚呈現。'], manage: ['資料與設定', '備份、效期預警及產品基本設定。'], users: ['人員與權限', '管理誰可以登入，以及每個人能做的事。'] };
function showView(view) {
  if (!VIEWS[view] || (view === 'users' && !isAdmin()) || (view === 'portal' && window.FEAuth && FEAuth.user() && !canPortal())) { view = 'dashboard'; if (location.hash && location.hash !== '#dashboard') try { history.replaceState(null, '', '#dashboard'); } catch (e) {} }
  const changed = currentView !== view; currentView = view;
  document.querySelectorAll('.section').forEach(e => e.classList.toggle('active', e.id === view));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('pageTitle').textContent = VIEWS[view][0]; $('pageSub').textContent = VIEWS[view][1];
  if (view === 'users') loadUsers();
  if (changed) try { window.scrollTo({ top: 0 }); } catch (e) {}
}
function go(view) { if (location.hash.slice(1) !== view) location.hash = view; else showView(view); }

let renderQueued = false;
function scheduleRender() { if (renderQueued) return; renderQueued = true; setTimeout(() => { renderQueued = false; render(); }, 0); }
function render() {
  const today = TODAY(), current = calculateLedger(today), full = calculateLedger(), groups = groupLots(current), prod = productSummary(current, today);
  renderDashboard(today, current, groups, prod); renderOpening(); renderProduction(); renderShipments(full); renderBatches(groups, today); renderAllocations(full); renderProducts(prod); renderSettings(); renderPortal();
  $('productNames').innerHTML = byProductName(data.products).map(p => `<option value="${esc(p.name)}"></option>`).join('');
  const empty = !data.opening.length && !data.movements.length;
  $('welcome').hidden = loading() || !empty || !(isAdmin() || can('produce'));
  $('recordInfo').textContent = loading() ? '讀取中…' : `共 ${data.opening.length + data.movements.length} 筆紀錄｜${data.products.length} 項產品`;
}
function renderDashboard(today, current, groups, prod) {
  const todayProductions = data.movements.filter(x => x.type === 'production' && x.date === today).map(x => ({ quantity: x.quantity, unit: getUnit(x.product) }));
  const todayShip = data.movements.filter(x => x.type === 'shipment' && x.date === today).map(x => ({ quantity: current.shipments.get(x.id)?.shipped || 0, unit: getUnit(x.product) }));
  const usableProducts = prod.filter(x => x.usable > 0).length;
  const live = groups.filter(x => x.remaining > 0);
  const due = live.filter(x => { const d = dayDiff(today, x.expiryDate); return d >= 0 && d <= data.settings.warnDays; }).length;
  const due7 = live.filter(x => { const d = dayDiff(today, x.expiryDate); return d >= 0 && d <= 7; }).length;
  const expired = live.filter(x => x.expiryDate < today).length;
  $('summaryCards').innerHTML = `<article class="kpi"><div class="kpi-label">今日生產量</div><div class="kpi-value">${unitsLabel(todayProductions)}</div><div class="kpi-desc">已登錄 ${todayProductions.length} 筆生產</div></article><article class="kpi"><div class="kpi-label">今日實際出貨量</div><div class="kpi-value">${unitsLabel(todayShip)}</div><div class="kpi-desc">已登錄 ${todayShip.length} 筆出貨需求</div></article><article class="kpi"><div class="kpi-label">目前有庫存產品</div><div class="kpi-value">${usableProducts}<span class="kpi-unit">種</span></div><div class="kpi-desc">所有庫存以產品個別單位計算</div></article><article class="kpi ${expired ? 'bad' : due ? 'warn' : ''}"><div class="kpi-label">效期預警批次</div><div class="kpi-value">${due}<span class="kpi-unit">批</span></div><div class="kpi-desc">7 天內 ${due7} 批｜已過期 ${expired} 批</div></article>`;
  const shortCount = [...current.shipments.values()].filter(x => x.shortage > 0).length;
  const alert = $('shortageAlert'); alert.hidden = shortCount === 0; if (shortCount) alert.innerHTML = `目前有 <strong>${shortCount}</strong> 筆出貨未能足額分配。出貨缺口不列入實際出貨、不產生負庫存，請前往「每日出貨登錄」檢視。`;
  const chartDays = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const trend = chartDays.map(d => ({ date: d, prod: data.movements.filter(m => m.type === 'production' && m.date === d).reduce((s, m) => s + m.quantity, 0), ship: data.movements.filter(m => m.type === 'shipment' && m.date === d).reduce((s, m) => s + (current.shipments.get(m.id)?.shipped || 0), 0) }));
  const max = Math.max(0, ...trend.flatMap(x => [x.prod, x.ship])); const h = v => v > 0 && max > 0 ? Math.max(2, Math.round(v / max * 100)) : 0;
  $('trendChart').innerHTML = trend.map(x => `<div class="chart-day${x.date === today ? ' today' : ''}" title="${x.date}：生產 ${fmt(x.prod)}，出貨 ${fmt(x.ship)}"><div class="chart-bars"><div class="bar produced" style="height:${h(x.prod)}%"></div><div class="bar shipped" style="height:${h(x.ship)}%"></div></div><span>${x.date === today ? '今天' : shortDate(x.date)}</span></div>`).join('');
  $('chartScale').textContent = max > 0 ? `最高柱 = ${fmt(max)}（混合單位時僅供趨勢參考）` : '近 7 天尚無生產或出貨';
  // 庫存效期預警：15 天內到期與已過期，每個品號一列，各有效日期的數量列在同一列
  const urgent = e => e.expiry !== NO_EXPIRY && dayDiff(today, e.expiry) <= SOON_DAYS;
  const warnRows = [...byProductExpiry(groups).values()].map(p => ({ ...p, exps: p.exps.filter(urgent) })).filter(p => p.exps.length).sort((a, b) => productOrder(a.product, b.product));
  $('dashExpiry').innerHTML = table(['產品', `${SOON_DAYS} 天內到期與已過期的有效日期`, '數量#', '剩餘庫存#', '最早效期狀態'], warnRows.map(p => { const q = clampQty(p.exps.reduce((s, e) => s + e.total, 0)), s = expiryStatus(p.exps[0].expiry, q, today); return `<tr>${td(`<strong>${esc(p.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${p.exps.map(e => expChip(e, p.unit, today)).join('')}</div></td><td class="num">${fmt(q)} ${esc(p.unit)}</td><td class="num">${fmt(p.total)} ${esc(p.unit)}</td>${td(badge(s.label, s.cls))}</tr>`; }), `目前沒有 ${SOON_DAYS} 天內到期或已過期的庫存`);
  // 近期出貨：最近 7 天，每個品號一列，各日期的出貨量列在同一列（有缺口的標紅）
  const since = addDays(today, -6), recent = data.movements.filter(x => x.type === 'shipment' && x.date <= today && x.date >= since);
  $('dashShipments').innerHTML = table(['產品', '最近 7 天出貨（日期新到舊）', '需求量#', '實際出貨#', '缺口#'], groupByProduct(recent, '', []).map(g => { const t = shipTotals(g.recs, current); return `<tr>${td(`<strong>${esc(g.product)}</strong>`)}${chipCell(g.recs, r => shipChip(r, current), 'shipment', g.product)}<td class="num">${fmt(t.req)} ${esc(getUnit(g.product))}</td><td class="num">${fmt(t.shipped)}</td><td class="num">${t.short ? badge(fmt(t.short), 'bad') : '—'}</td></tr>`; }), '最近 7 天沒有出貨紀錄');
}

/* ---------- 登錄紀錄：每個品號一列，各筆紀錄用標籤列在同一列，「明細」看每一筆並修改、刪除 ---------- */
const CHIP_MAX = 12;
const md = d => isDate(d) ? d.slice(5) : (d || '');
// 依品號分組並照 productOrder 排；搜尋字有對到品名時列出全部紀錄，否則只列出有對到的紀錄
function groupByProduct(recs, q, fields, recSort = (a, b) => cmp(b.date || b.entryDate, a.date || a.entryDate) || b.seq - a.seq) {
  const query = clean(q).toLowerCase(), m = new Map();
  for (const r of recs) { if (!m.has(r.product)) m.set(r.product, []); m.get(r.product).push(r); }
  const out = [];
  for (const [product, list] of m) {
    list.sort(recSort);
    const recs2 = !query || product.toLowerCase().includes(query) ? list : list.filter(r => fields.some(k => String(r[k] ?? '').toLowerCase().includes(query)));
    if (recs2.length) out.push({ product, all: list, recs: recs2 });
  }
  return out.sort((a, b) => productOrder(a.product, b.product));
}
const sumQ = (recs, f = r => r.quantity) => clampQty(recs.reduce((s, r) => s + (Number(f(r)) || 0), 0));
function chipCell(recs, chip, kind, product) {
  const more = recs.length > CHIP_MAX ? `<button type="button" class="pill other exp-chip linkchip" data-action="detail-${kind}" data-id="${esc(product)}">還有 ${recs.length - CHIP_MAX} 筆…</button>` : '';
  return `<td class="exp-cell"><div class="exp-chips">${recs.slice(0, CHIP_MAX).map(chip).join('')}${more}</div></td>`;
}
const detailBtn = (kind, product) => td(`<button type="button" class="btn small" data-action="detail-${kind}" data-id="${esc(product)}">明細${(kind !== 'opening' || !can(permFor(kind))) ? '' : '／修改'}</button>`);
const unitOf = r => esc(getUnit(r.product));
const openingChip = r => `<span class="pill ${r.pool === 'stock' ? 'future' : 'other'} exp-chip" title="${esc(`入帳 ${r.entryDate}｜製作 ${r.manufactureDate}｜效期 ${expShow(r.expiryDate)}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`)}"><span class="mono">${esc(r.batch)}</span> ${r.expiryDate === NO_EXPIRY ? '' : '效期 ' + esc(md(r.expiryDate)) + ' '}${esc(fmt(r.quantity))} ${unitOf(r)}</span>`;
const prodKind = r => r.pool === 'stock' ? '生產轉現貨' : /當天生產/.test(r.note) ? '當天生產' : /半成品入庫/.test(r.note) ? '半成品入庫' : '';
const prodChip = r => `<span class="pill ${r.pool === 'stock' ? 'future' : 'ok'} exp-chip" title="${esc(`${r.date}｜批號 ${r.batch}｜製作 ${r.manufactureDate}｜效期 ${expShow(r.expiryDate)}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`)}"><span class="mono">${esc(md(r.date))}</span> ${esc(fmt(r.quantity))} ${unitOf(r)}${prodKind(r) === '生產轉現貨' ? '（轉現貨）' : ''}</span>`;
function shipChip(r, ledger) { const s = ledger.shipments.get(r.id) || { shipped: 0, shortage: r.quantity }; return `<span class="pill ${s.shortage ? 'bad' : 'other'} exp-chip" title="${esc(`${r.date}｜${r.orderNo || '—'}｜需求 ${fmt(r.quantity)}｜實際出貨 ${fmt(s.shipped)}${s.shortage ? '｜缺 ' + fmt(s.shortage) : ''}${r.note ? '｜' + r.note : ''}`)}"><span class="mono">${esc(md(r.date))}</span> ${esc(fmt(r.quantity))} ${unitOf(r)}${s.shortage ? `（缺 ${esc(fmt(s.shortage))}）` : ''}</span>`; }
function shipTotals(recs, ledger) { let req = 0, shipped = 0, short = 0; for (const r of recs) { const s = ledger.shipments.get(r.id) || { shipped: 0, shortage: r.quantity }; req += r.quantity; shipped += s.shipped; short += s.shortage; } return { req: clampQty(req), shipped: clampQty(shipped), short: clampQty(short) }; }
function renderOpening() {
  const groups = groupByProduct(data.opening, $('openingFilter').value, ['batch', 'manufactureDate', 'entryDate', 'expiryDate', 'note', 'by'], (a, b) => cmp(b.entryDate, a.entryDate) || (a.expiryDate === NO_EXPIRY ? -1 : b.expiryDate === NO_EXPIRY ? 1 : cmp(a.expiryDate, b.expiryDate)) || b.seq - a.seq);
  $('openingCount').textContent = `共 ${groups.length} 項產品、${data.opening.length} 筆建檔；每個品號一列，點「明細」看每一筆${can('produce') ? '並修改、刪除' : ''}`;
  $('openingTable').innerHTML = table(['產品', '期初批次（批號、有效日期、數量）', '筆數#', '原始庫存合計#', '入帳日期', '明細'], groups.map(g => { const ds = g.recs.map(r => r.entryDate).sort(); return `<tr>${td(`<strong>${esc(g.product)}</strong>`)}${chipCell(g.recs, openingChip, 'opening', g.product)}<td class="num">${g.recs.length}</td><td class="num">${fmt(sumQ(g.recs))} ${esc(getUnit(g.product))}</td>${tdm(ds[0] === ds[ds.length - 1] ? ds[0] : `${md(ds[0])}～${md(ds[ds.length - 1])}`)}${detailBtn('opening', g.product)}</tr>`; }), '尚未建立期初庫存' + (can('produce') ? '，請使用上方表單新增' : ''));
}
function renderProduction() {
  const list = data.movements.filter(x => x.type === 'production');
  const groups = groupByProduct(list, $('productionFilter').value, ['date', 'batch', 'manufactureDate', 'expiryDate', 'note', 'by']);
  $('productionCount').textContent = `共 ${groups.length} 項產品、${list.length} 筆生產；每個品號一列，日期新的在前，點「明細」看每一筆${can('produce') ? '並修改、刪除' : ''}`;
  $('productionTable').innerHTML = table(['產品', '生產紀錄（日期新到舊，綠＝半成品／當天生產、藍＝生產轉現貨）', '筆數#', '生產合計#', '最近生產日', '明細'], groups.map(g => `<tr>${td(`<strong>${esc(g.product)}</strong>`)}${chipCell(g.recs, prodChip, 'production', g.product)}<td class="num">${g.recs.length}</td><td class="num">${fmt(sumQ(g.recs))} ${esc(getUnit(g.product))}</td>${tdm(g.recs[0].date)}${detailBtn('production', g.product)}</tr>`), '尚未登錄生產紀錄');
}
function renderShipments(ledger) {
  const list = data.movements.filter(x => x.type === 'shipment');
  const groups = groupByProduct(list, $('shipmentFilter').value, ['date', 'orderNo', 'note', 'by']);
  $('shipmentCount').textContent = `共 ${groups.length} 項產品、${list.length} 筆出貨；每個品號一列，日期新的在前（紅＝有缺口），點「明細」看每一筆${can('ship') ? '並修改、刪除' : ''}`;
  $('shipmentTable').innerHTML = table(['產品', '出貨紀錄（日期新到舊，紅＝有缺口）', '筆數#', '需求合計#', '實際出貨#', '缺口#', '最近出貨日', '明細'], groups.map(g => { const t = shipTotals(g.recs, ledger); return `<tr>${td(`<strong>${esc(g.product)}</strong>`)}${chipCell(g.recs, r => shipChip(r, ledger), 'shipment', g.product)}<td class="num">${g.recs.length}</td><td class="num">${fmt(t.req)} ${esc(getUnit(g.product))}</td><td class="num">${fmt(t.shipped)}</td><td class="num">${t.short ? badge(fmt(t.short), 'bad') : '—'}</td>${tdm(g.recs[0].date)}${detailBtn('shipment', g.product)}</tr>`; }), '尚未登錄出貨紀錄');
}
// 明細視窗：列出這個品號的每一筆紀錄（舊版的一筆一列），可以修改、刪除
async function openDetail(kind, product) {
  const ledger = calculateLedger(), unit = esc(getUnit(product));
  const byDate = (a, b) => cmp(b.date || b.entryDate, a.date || a.entryDate) || b.seq - a.seq;
  let title = '', html = '';
  if (kind === 'opening') {
    const rows = data.opening.filter(x => x.product === product).sort(byDate);
    title = `「${product}」的期初庫存（${rows.length} 筆）`;
    html = table(['入帳日期', '批號', '製作日期', '有效日期', '原始庫存#', '備註', '登錄人', ...manageCol('opening')], rows.map(x => `<tr>${tdm(x.entryDate)}${tdm(x.batch)}${tdm(x.manufactureDate)}${tdm(expShow(x.expiryDate))}<td class="num">${fmt(x.quantity)} ${unit}</td>${td(esc(x.note || '—'))}${tdWho(x)}${manageCell('opening', x.id)}</tr>`));
  } else if (kind === 'production') {
    const rows = data.movements.filter(x => x.type === 'production' && x.product === product).sort(byDate);
    title = `「${product}」的生產紀錄（${rows.length} 筆）`;
    html = table(['入庫日期', '類別', '批號', '製作日期', '有效日期', '數量#', '備註', '登錄人', ...manageCol('production')], rows.map(x => `<tr>${tdm(x.date)}${td(esc(prodKind(x) || '生產'))}${tdm(x.batch)}${tdm(x.manufactureDate)}${tdm(expShow(x.expiryDate))}<td class="num">${fmt(x.quantity)} ${unit}</td>${td(esc(x.note || '—'))}${tdWho(x)}${manageCell('production', x.id)}</tr>`));
  } else if (kind === 'shipment') {
    const rows = data.movements.filter(x => x.type === 'shipment' && x.product === product).sort(byDate);
    title = `「${product}」的出貨紀錄（${rows.length} 筆）`;
    html = table(['出貨日期', '出貨單號／客戶', '需求量#', '實際出貨#', '缺口', '扣貨批數#', '備註', '登錄人', ...manageCol('shipment')], rows.map(x => { const s = ledger.shipments.get(x.id) || { shipped: 0, shortage: x.quantity, allocations: [] }; return `<tr>${tdm(x.date)}${td(esc(x.orderNo || '—'))}<td class="num">${fmt(x.quantity)} ${unit}</td><td class="num">${fmt(s.shipped)}</td>${td(s.shortage ? badge(`${fmt(s.shortage)} 未配`, 'bad') : badge('足額', 'ok'))}<td class="num">${s.allocations.length}</td>${td(esc(x.note || '—'))}${tdWho(x)}${manageCell('shipment', x.id)}</tr>`; }));
  } else {
    const rows = allocationRows(ledger).filter(x => x.product === product);
    title = `「${product}」的出貨扣批明細（${rows.length} 筆）`;
    html = table(['出貨日', '出貨單號／客戶', '扣除批號', '製作日期', '有效日期', '數量#', '類別'], rows.map(x => `<tr>${tdm(x.date)}${td(esc(x.orderNo || '—'))}${x.kind === 'shortage' ? td(badge('未分配', 'bad')) : td(`<span class="mono">${esc(x.batch)}</span> ${badge(x.pool, x.pool === '現貨' ? 'future' : 'other')}`)}${tdm(x.manufactureDate)}${tdm(expShow(x.expiryDate))}<td class="num">${fmt(x.quantity)} ${esc(x.unit)}</td>${td(x.kind === 'shortage' ? badge('出貨缺口', 'bad') : badge('已分配', 'ok'))}</tr>`));
  }
  await modal({ title, html: `<div class="table-scroll">${html}</div>`, ok: '關閉', wide: true, noCancel: true });
}
const closeModal = () => { if (!$('modal').hidden) $('modalCancel').click(); };
// 每個產品一列：同一個有效日期合在一起，不同有效日期分開列（顏色＝效期狀態）；逐批號的明細用「匯出 CSV」
// 排列照 productOrder（品號開頭 CK、CC、CA、CS、CL）
const SOON_DAYS = 15;
let batchMode = 'all';
// 依有效日期彙整：groups（groupLots 結果）→ Map(產品 → { product, unit, stock, semi, total, exps: [{ expiry, stock, semi, total, batches }] })，只算有剩的
function byProductExpiry(groups) {
  const byP = new Map();
  for (const g of groups) {
    if (!byP.has(g.product)) byP.set(g.product, { product: g.product, unit: g.unit, stock: 0, semi: 0, total: 0, exps: new Map() });
    if (!(g.remaining > 0)) continue;
    const p = byP.get(g.product);
    if (!p.exps.has(g.expiryDate)) p.exps.set(g.expiryDate, { expiry: g.expiryDate, stock: 0, semi: 0, total: 0, batches: new Set() });
    const e = p.exps.get(g.expiryDate), k = g.pool === 'stock' ? 'stock' : 'semi';
    e[k] = clampQty(e[k] + g.remaining); e.total = clampQty(e.total + g.remaining); e.batches.add(g.batch);
    p[k] = clampQty(p[k] + g.remaining); p.total = clampQty(p.total + g.remaining);
  }
  for (const p of byP.values()) p.exps = [...p.exps.values()].sort((a, b) => (a.expiry === NO_EXPIRY ? 0 : 1) - (b.expiry === NO_EXPIRY ? 0 : 1) || cmp(a.expiry, b.expiry));
  return byP;
}
// 一個有效日期一個標籤（顏色＝效期狀態），半成品模式註明現貨／半成品
function expChip(e, unit, today) {
  const s = expiryStatus(e.expiry, e.total, today), split = !isStockModeDay(today);
  const part = split ? (e.stock && e.semi ? `（現貨 ${fmt(e.stock)}・半成品 ${fmt(e.semi)}）` : e.stock ? '（現貨）' : '（半成品）') : '';
  return `<span class="pill ${s.cls} exp-chip" title="${esc(`${expShow(e.expiry)}｜${s.label}｜批號 ${[...e.batches].join('、')}`)}"><span class="mono">${esc(e.expiry === NO_EXPIRY ? '期初現貨' : e.expiry)}</span> ${esc(fmt(e.total))} ${esc(unit)}${esc(part)}</span>`;
}
function renderBatches(groups, today) {
  const split = !isStockModeDay(today), byP = byProductExpiry(groups);
  // 篩選：全部｜15 天內到期（0～15 天，不含已過期）｜已過期；篩選時每列只顯示符合的有效日期
  const inRange = (e, m) => { if (e.expiry === NO_EXPIRY) return false; const d = dayDiff(today, e.expiry); return m === 'soon' ? d >= 0 && d <= SOON_DAYS : d < 0; };
  const inMode = e => batchMode === 'all' || inRange(e, batchMode);
  // 按鈕上的紅色數字：幾項產品（品號）有 15 天內到期／已過期的庫存
  for (const [m, id, lab] of [['soon', 'batchSoonN', `項產品 ${SOON_DAYS} 天內即將到期`], ['expired', 'batchExpN', '項產品已過期']]) {
    const n = [...byP.values()].filter(p => p.exps.some(e => inRange(e, m))).length, el = $(id);
    el.hidden = !n; el.textContent = n; el.parentElement.title = n ? `${n} ${lab}` : `沒有${lab.replace('項產品 ', '').replace('項產品', '')}的產品`;
  }
  const list = [...byP.values()].map(p => { const all = p.exps, exps = all.filter(inMode), first = all.find(e => e.expiry !== NO_EXPIRY) || all[0]; return { ...p, exps, match: clampQty(exps.reduce((s, e) => s + e.total, 0)), first: first ? first.expiry : '', expText: all.map(e => e.expiry).join(' ') }; });
  const base = batchMode !== 'all' ? list.filter(p => p.exps.length) : $('batchLive').checked ? list.filter(p => p.total > 0) : list;
  const rows = searchable(base, $('batchFilter').value, ['product', 'expText']).sort((a, b) => (a.total > 0 ? 0 : 1) - (b.total > 0 ? 0 : 1) || productOrder(a.product, b.product));
  const nExp = list.reduce((s, p) => s + p.exps.length, 0), modeName = batchMode === 'soon' ? `${SOON_DAYS} 天內到期` : '已過期';
  document.querySelectorAll('#batchSeg [data-bmode]').forEach(b => b.classList.toggle('on', b.dataset.bmode === batchMode));
  $('batchCount').textContent = batchMode === 'all' ? `目前有庫存的產品 ${list.filter(p => p.total > 0).length} 項、共 ${nExp} 個不同有效日期；依品號 ${SORT_PREFIXES.join('、')} 排列` : `${modeName}：${base.length} 項產品、${nExp} 個有效日期，共 ${fmt(clampQty(base.reduce((s, p) => s + p.match, 0)))} 個；只顯示「${modeName}」的有效日期`;
  const chip = (e, unit) => expChip(e, unit, today);
  const filtered = batchMode !== 'all';
  $('batchTable').innerHTML = table(['產品', filtered ? `${modeName}的有效日期與數量` : '各有效日期的數量（由早到晚，顏色＝效期狀態）', ...(filtered ? [`${modeName}數量#`] : []), '剩餘庫存#', ...(split ? ['現貨#', '半成品#'] : []), '最早效期狀態'], rows.map(p => { const s = p.total > 0 ? expiryStatus(p.first || NO_EXPIRY, p.total, today) : { label: '已用完', cls: 'other' }; return `<tr>${td(`<strong>${esc(p.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${p.exps.map(e => chip(e, p.unit)).join('') || '<span class="who">—</span>'}</div></td>${filtered ? `<td class="num">${fmt(p.match)} ${esc(p.unit)}</td>` : ''}<td class="num">${fmt(p.total)} ${esc(p.unit)}</td>${split ? `<td class="num">${p.stock ? fmt(p.stock) : '—'}</td><td class="num">${p.semi ? fmt(p.semi) : '—'}</td>` : ''}${td(badge(s.label, s.cls))}</tr>`; }), batchMode === 'soon' ? `目前沒有 ${SOON_DAYS} 天內到期的庫存` : batchMode === 'expired' ? '目前沒有已過期的庫存' : '尚無批次庫存紀錄');
}
function allocationRows(ledger) { const rows = []; for (const sh of [...data.movements.filter(x => x.type === 'shipment')].sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product) || b.seq - a.seq)) { const r = ledger.shipments.get(sh.id); if (!r) continue; for (const a of r.allocations) rows.push({ date: sh.date, orderNo: sh.orderNo || '', product: sh.product, batch: a.batch, pool: poolLabel(a.pool, sh.date), manufactureDate: a.manufactureDate, expiryDate: a.expiryDate, quantity: a.quantity, unit: getUnit(sh.product), kind: 'allocated' }); if (r.shortage) rows.push({ date: sh.date, orderNo: sh.orderNo || '', product: sh.product, batch: '未分配', manufactureDate: '', expiryDate: '', quantity: r.shortage, unit: getUnit(sh.product), kind: 'shortage' }); } return rows; }
// 出貨扣批明細：每個品號一列，每天一個標籤「日期：批號（現貨／半成品）×數量、…」，有缺口的標紅
function renderAllocations(ledger) {
  const all = allocationRows(ledger);
  const days = new Map(); // 品號|日期 → { product, date, parts: [], short }
  for (const x of all) { const k = x.product + '\u0000' + x.date; if (!days.has(k)) days.set(k, { product: x.product, date: x.date, seq: 0, parts: [], short: 0, orders: new Set(), text: '' }); const d = days.get(k); if (x.orderNo) d.orders.add(x.orderNo); if (x.kind === 'shortage') d.short = clampQty(d.short + x.quantity); else d.parts.push(x); d.text += ` ${x.batch} ${x.manufactureDate} ${x.orderNo}`; }
  const groups = groupByProduct([...days.values()], $('allocationFilter').value, ['date', 'text']);
  const chip = d => { const agg = new Map(); for (const p of d.parts) { const k = p.batch + '|' + p.pool; agg.set(k, { batch: p.batch, pool: p.pool, q: clampQty((agg.get(k)?.q || 0) + p.quantity), exp: p.expiryDate }); } const txt = [...agg.values()].map(a => `${a.batch}${a.pool === '現貨' ? '現貨' : '半成品'}×${fmt(a.q)}`).join('、'); return `<span class="pill ${d.short ? 'bad' : 'other'} exp-chip" title="${esc(`${d.date}｜${[...d.orders].join('、') || '—'}｜${[...agg.values()].map(a => `${a.batch}（${a.pool}，效期 ${expShow(a.exp)}）×${fmt(a.q)}`).join('、')}${d.short ? '｜缺 ' + fmt(d.short) : ''}`)}"><span class="mono">${esc(md(d.date))}</span> ${esc(txt || '—')}${d.short ? `（缺 ${esc(fmt(d.short))}）` : ''}</span>`; };
  $('allocationCount').textContent = `共 ${groups.length} 項產品、${all.length} 筆扣批／缺口明細；每個品號一列，每天一個標籤（紅＝有缺口），點「明細」看每一筆`;
  $('allocationTable').innerHTML = table(['產品', '扣批（日期新到舊：批號、現貨／半成品 × 數量）', '扣貨合計#', '缺口#', '明細'], groups.map(g => { const q = clampQty(g.recs.reduce((s, d) => s + d.parts.reduce((t, p) => t + p.quantity, 0), 0)), sh = clampQty(g.recs.reduce((s, d) => s + d.short, 0)); return `<tr>${td(`<strong>${esc(g.product)}</strong>`)}${chipCell(g.recs, chip, 'allocation', g.product)}<td class="num">${fmt(q)} ${esc(getUnit(g.product))}</td><td class="num">${sh ? badge(fmt(sh), 'bad') : '—'}</td>${detailBtn('allocation', g.product)}</tr>`; }), '尚無出貨扣批紀錄');
}
function renderProducts(products) {
  const base = $('productLive').checked ? products.filter(x => x.usable > 0 || x.expired > 0) : products;
  const rows = searchable(base, $('productFilter').value, ['name']);
  // 半成品模式分開列現貨（無效期）與半成品；全現貨模式全部都是現貨，不分欄
  const split = !isStockModeDay(TODAY());
  $('productTable').innerHTML = table(['產品名稱', '單位', '期初入庫#', '累計生產#', '累計扣貨#', split ? '可用庫存#' : '可用庫存（現貨）#', ...(split ? ['現貨#', '半成品#'] : []), '已過期量#', '近效期量#', '最近有效日期', '安全庫存狀態'], rows.map(x => { const st = x.lowStock && x.usable < x.lowStock ? badge(`低於 ${fmt(x.lowStock)}`, 'bad') : x.lowStock ? badge('正常', 'ok') : badge('未設定', 'other'); return `<tr>${td(`<strong>${esc(x.name)}</strong>`)}${td(esc(x.unit))}<td class="num">${fmt(x.opened)}</td><td class="num">${fmt(x.produced)}</td><td class="num">${fmt(x.used)}</td><td class="num">${fmt(x.usable)}</td>${split ? `<td class="num">${fmt(x.stock)}</td><td class="num">${fmt(x.semi)}</td>` : ''}<td class="num">${fmt(x.expired)}</td><td class="num">${fmt(x.warning)}</td>${tdm(x.oldest)}${td(st)}</tr>`; }), '尚無產品，請先建立期初庫存或生產紀錄');
}
function renderSettings() {
  for (const [id, v] of [['warnDays', data.settings.warnDays], ['defaultShelf', data.settings.defaultShelf]]) { const el = $(id); if (document.activeElement !== el) el.value = v; }
  const rows = searchable(byProductName(data.products), $('settingFilter').value, ['name']);
  $('productSettingsTable').innerHTML = table(['產品', '單位', '保存天數#', '低庫存警戒量#', ...(can('setting') ? ['操作'] : [])], rows.map(p => `<tr>${td(`<strong>${esc(p.name)}</strong>`)}${td(esc(p.unit))}<td class="num">${fmt(p.shelfDays)} 天</td><td class="num">${p.lowStock ? fmt(p.lowStock) : '—'}</td>${can('setting') ? td(`<button type="button" class="btn small" data-action="edit-product" data-id="${esc(p.id)}">修改設定</button>`) : ''}</tr>`), '新增期初庫存或生產資料後，產品會自動顯示在這裡');
}

/* ---------- 同步狀態、權限、提示列 ---------- */
function renderSync() {
  const st = FEStore.status(), el = $('sync');
  const map = { loading: ['busy', '讀取中…'], syncing: ['busy', '同步中…'], pending: ['busy', '等待上傳'], synced: ['ok', '已同步'], offline: ['warn', '離線'], error: ['bad', '連線失敗'] };
  const [cls, txt] = map[st.state] || ['', st.state];
  el.className = 'sync ' + cls; el.querySelector('span').textContent = txt;
  el.title = (st.detail ? st.detail + '。' : '') + (st.lastSync ? '上次同步 ' + new Date(st.lastSync).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) + '。' : '') + '按一下立即同步';
}
let lastBanner = '';
function renderBanner() {
  const st = FEStore.status(), b = [];
  if (st.state === 'error') b.push(`<div class="banner bad">${esc(st.detail || '無法連線到雲端')}<button class="btn small" type="button" data-action="sync">重試</button></div>`);
  else if (st.state === 'offline') b.push(`<div class="banner warn">${esc(st.detail || '目前離線')}。修改會先存在這台裝置，恢復網路後自動上傳。</div>`);
  if (window.FEAuth && FEAuth.user() && !isAdmin() && !PERMS.some(p => can(p.id))) b.push('<div class="banner">你目前只能查看與下載資料。需要登錄生產、出貨或修改設定的話，請找管理員開權限。</div>');
  const html = b.join('');
  if (html !== lastBanner) { $('banner').innerHTML = html; lastBanner = html; }
}
function applyPerms() {
  const cl = document.body.classList;
  cl.toggle('is-admin', isAdmin());
  for (const p of PERMS) cl.toggle('can-' + p.id, can(p.id));
  cl.toggle('can-portal', canPortal());
  const n = myName(); $('meName').textContent = n; $('meName2').textContent = n;
  if (currentView === 'users' && !isAdmin()) go('dashboard');
  renderBanner();
}

/* ---------- 表單 ---------- */
function autoExpiry(prefix) { const m = $(`${prefix}Mfg`).value, day = Number($(`${prefix}Shelf`).value); if (isDate(m) && Number.isFinite(day) && day >= 0) $(`${prefix}Expiry`).value = addDays(m, day); }
function productDefaults(prefix) { const p = getProduct($(`${prefix}Product`).value); if (p && !p.virtual) { $(`${prefix}Unit`).value = p.unit; $(`${prefix}Shelf`).value = p.shelfDays; } else { $(`${prefix}Shelf`).value = data.settings.defaultShelf; } autoExpiry(prefix); }
function inputPositive(id) { const v = Number($(id).value); if (!Number.isFinite(v) || !(v > 0) || Math.abs(Math.round(v * 1000) - v * 1000) > 1e-7) throw Error('數量必須大於 0，最多 3 位小數'); return v; }
function baseRow(prefix, dateKey) {
  const name = clean($(`${prefix}Product`).value), unit = clean($(`${prefix}Unit`).value), batch = clean($(`${prefix}Batch`).value), manufactureDate = $(`${prefix}Mfg`).value, expiryDate = $(`${prefix}Expiry`).value, entryDate = $(dateKey).value;
  if (!name || !unit || !batch) throw Error('請填寫產品、單位及批號');
  if (!isDate(manufactureDate) || !isDate(expiryDate) || !isDate(entryDate)) throw Error('請填寫有效的日期');
  if (manufactureDate > entryDate) throw Error('製作日期不可晚於入庫日期');
  if (expiryDate < manufactureDate) throw Error('有效日期不可早於製作日期');
  return { name, unit, batch, manufactureDate, expiryDate, entryDate, quantity: inputPositive(`${prefix}Qty`), note: clean($(`${prefix}Note`).value), shelfDays: Number($(`${prefix}Shelf`).value) };
}
function ensureProductSaved(name, unit, shelfDays) {
  if (isExcluded(name)) throw Error(`品名有「${EXCLUDE_WORDS.join('、')}」的產品不用管理，不能登錄`);
  const m = getProduct(name);
  if (m && !m.virtual) { if (m.unit !== unit) throw Error(`「${name}」的單位已設定為「${m.unit}」，請統一使用相同單位`); return m; }
  const p = { id: productId(name), name, unit, shelfDays: Number.isInteger(shelfDays) && shelfDays >= 0 ? shelfDays : data.settings.defaultShelf, lowStock: 0 };
  storeProduct(p); return p;
}
const stampNew = () => ({ by: myName(), at: nowIso() });
const stampEdit = () => ({ editBy: myName(), editAt: nowIso() });
function saveOpening(e) { e.preventDefault(); if (!can('produce')) return; act(() => {
  const r = baseRow('o', 'oEntry'); ensureProductSaved(r.name, r.unit, r.shelfDays);
  const fields = { product: r.name, batch: r.batch, manufactureDate: r.manufactureDate, expiryDate: r.expiryDate, entryDate: r.entryDate, quantity: r.quantity, note: r.note };
  if (editOpening) { const old = data.opening.find(x => x.id === editOpening); if (!old) throw Error('這筆資料已被刪除，無法儲存修改'); storeRecord({ ...old, ...fields, ...stampEdit() }); }
  else storeRecord({ id: uid(), type: 'opening', seq: nextSeq(), ...fields, ...stampNew() });
  resetOpening(); toast('期初庫存已儲存，其他工作表已同步更新');
}); }
function resetOpening() { $('openingForm').reset(); $('oMfg').value = TODAY(); $('oEntry').value = TODAY(); $('oUnit').value = '個'; $('oShelf').value = data.settings.defaultShelf; autoExpiry('o'); editOpening = null; $('openingFormTitle').textContent = '新增期初庫存'; $('oSubmit').textContent = '＋ 儲存期初庫存'; $('oCancel').classList.add('hide'); }
const resetForms = () => resetOpening();
const smooth = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
function populateEdit(type, id) {
  if (type === 'opening') { const x = data.opening.find(x => x.id === id); if (!x) return; editOpening = id; for (const [f, v] of Object.entries({ oProduct: x.product, oUnit: getUnit(x.product), oBatch: x.batch, oQty: x.quantity, oMfg: x.manufactureDate, oEntry: x.entryDate, oExpiry: x.expiryDate, oNote: x.note || '' })) $(f).value = v; $('oShelf').value = getProduct(x.product)?.shelfDays ?? data.settings.defaultShelf; $('openingFormTitle').textContent = '修改期初庫存'; $('oSubmit').textContent = '儲存修改'; $('oCancel').classList.remove('hide'); go('opening'); setTimeout(() => $('openingForm').scrollIntoView({ block: 'center', behavior: smooth() }), 30); return; }
}

/* ---------- 對話框 ---------- */
function modal({ title, html, ok = '確定', danger = false, collect = null, wide = false, noCancel = false }) {
  return new Promise(resolve => {
    const m = $('modal'), form = $('modalForm'), body = $('modalBody'), okBtn = $('modalOk'), cancel = $('modalCancel');
    $('modalTitle').textContent = title; body.innerHTML = html; okBtn.textContent = ok; okBtn.className = 'btn ' + (danger ? 'danger-solid' : 'primary');
    form.classList.toggle('wide', !!wide); cancel.hidden = !!noCancel;
    const prev = document.activeElement; m.hidden = false;
    const close = v => { m.hidden = true; form.onsubmit = null; cancel.onclick = null; m.onclick = null; m.onkeydown = null; try { prev && prev.focus && prev.focus(); } catch (e) {} resolve(v); };
    form.onsubmit = e => { e.preventDefault(); if (!collect) return close(true); try { close(collect(body)); } catch (err) { const er = body.querySelector('.modal-error'); if (er) { er.textContent = err.message; er.hidden = false; } } };
    cancel.onclick = () => close(false);
    m.onclick = e => { if (e.target === m) close(false); };
    m.onkeydown = e => { if (e.key === 'Escape') close(false); };
    setTimeout(() => (body.querySelector('input:not([readonly])') || okBtn).focus(), 0);
  });
}
function describeRec(r) { const u = getUnit(r.product); if (r.type === 'shipment') return `${r.date}｜出貨 ${r.product} ${fmt(r.quantity)} ${u}${r.orderNo ? '｜' + r.orderNo : ''}`; return `${r.type === 'opening' ? r.entryDate : r.date}｜${r.type === 'opening' ? '期初庫存' : '生產'} ${r.product}｜批號 ${r.batch}｜${fmt(r.quantity)} ${u}`; }
async function editProduct(id) {
  const p = data.products.find(x => x.id === id); if (!p || !can('setting')) return;
  const res = await modal({ title: `修改「${p.name}」設定`, ok: '儲存設定',
    html: `<div class="field"><label for="mUnit">單位</label><input id="mUnit" maxlength="12" value="${esc(p.unit)}"></div><div class="field"><label for="mShelf">預設保存天數</label><input id="mShelf" type="number" inputmode="numeric" min="0" max="36500" step="1" value="${esc(p.shelfDays)}"></div><div class="field"><label for="mLow">低庫存警戒量</label><input id="mLow" type="number" inputmode="decimal" min="0" step="0.001" value="${esc(p.lowStock)}"><span class="hint">填 0 代表不提醒</span></div><p class="modal-note" style="margin-top:12px">調整保存天數只影響之後新增的資料，已登錄的有效日期不會更動。</p><p class="modal-error" hidden></p>`,
    collect: b => { const unit = clean(b.querySelector('#mUnit').value), days = Number(b.querySelector('#mShelf').value), low = Number(b.querySelector('#mLow').value); if (!unit) throw Error('請填寫單位'); if (!Number.isInteger(days) || days < 0 || days > 36500) throw Error('保存天數需為 0 到 36500 的整數'); if (!Number.isFinite(low) || low < 0) throw Error('警戒量不可小於 0'); return { unit, shelfDays: days, lowStock: low }; } });
  if (!res) return;
  act(() => { storeProduct({ id: p.id, name: p.name, ...res }); toast('產品設定已更新；已登錄的有效日期不會更動'); });
}
function demoState() {
  const d = TODAY(), earlier = addDays(d, -7); let s = 1; const st = blankState(); const by = myName(), at = nowIso();
  st.products = [{ id: productId('產品A（範例）'), name: '產品A（範例）', unit: '個', shelfDays: 14, lowStock: 80 }, { id: productId('產品B（範例）'), name: '產品B（範例）', unit: '盒', shelfDays: 30, lowStock: 20 }];
  st.opening = [{ id: uid(), type: 'opening', seq: s++, product: '產品A（範例）', batch: 'A001', manufactureDate: addDays(d, -10), entryDate: earlier, expiryDate: addDays(d, 4), quantity: 100, note: '範例：同批第一製作日', by, at }, { id: uid(), type: 'opening', seq: s++, product: '產品A（範例）', batch: 'A001', manufactureDate: addDays(d, -8), entryDate: earlier, expiryDate: addDays(d, 6), quantity: 200, note: '範例：同批第二製作日', by, at }, { id: uid(), type: 'opening', seq: s++, product: '產品B（範例）', batch: 'B001', manufactureDate: addDays(d, -5), entryDate: earlier, expiryDate: addDays(d, 25), quantity: 50, note: '範例', by, at }];
  st.movements = [{ id: uid(), type: 'production', seq: s++, date: addDays(d, -1), product: '產品A（範例）', batch: 'A001', manufactureDate: addDays(d, -1), expiryDate: addDays(d, 13), quantity: 150, note: '範例', by, at }, { id: uid(), type: 'shipment', seq: s++, date: d, product: '產品A（範例）', quantity: 250, orderNo: 'SO-001', note: '範例：自動先扣 100，再扣 150', by, at }];
  return st;
}
async function seedDemo() {
  if (!isAdmin()) return;
  if (data.opening.length || data.movements.length || data.products.length) { if (!await modal({ title: '載入示範資料？', html: '<p>示範資料會取代雲端上所有人共用的資料，目前的紀錄將被刪除。</p><p class="modal-note">建議先下載 JSON 備份。</p>', ok: '取代並載入', danger: true })) return; }
  act(() => { replaceAll(demoState()); resetForms(); go('dashboard'); toast('已載入示範資料：產品A 同批不同製作日期，出貨 250 個'); });
}
async function resetAll() {
  if (!isAdmin()) return;
  const ok = await modal({ title: '清除所有資料？', ok: '清除全部資料', danger: true,
    html: '<p>將刪除雲端上所有人共用的資料，包含期初庫存、生產、出貨與產品設定。雲端每日備份仍會保留 30 天。</p><div class="field"><label for="mConfirm">請輸入「清除全部」確認</label><input id="mConfirm" autocomplete="off"></div><p class="modal-error" hidden></p>',
    collect: b => { if (clean(b.querySelector('#mConfirm').value) !== '清除全部') throw Error('請輸入「清除全部」四個字'); return true; } });
  if (!ok) return;
  act(() => { replaceAll(blankState()); resetForms(); go('dashboard'); toast('資料已全部清除'); });
}

/* ---------- 下載（JSON / CSV / Excel） ---------- */
function downloadFile(filename, content, mime, okMsg) {
  try { const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); toast(okMsg || '檔案已下載'); }
  catch (e) { toast('無法下載檔案：' + e.message, true); }
}
function csvEscape(v) { const raw = String(v ?? ''); const safe = /^[\s]*[=+@-]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw; return `"${safe.replace(/"/g, '""')}"`; }
function csvData(kind) {
  const led = calculateLedger(), cur = calculateLedger(TODAY()), groups = groupLots(cur), products = productSummary(cur);
  if (kind === 'opening') return ['期初庫存', ['入帳日期', '產品', '單位', '批號', '製作日期', '有效日期', '原始庫存', '備註', '登錄人'], [...data.opening].sort((a, b) => cmp(b.entryDate, a.entryDate) || productOrder(a.product, b.product)).map(x => [x.entryDate, x.product, getUnit(x.product), x.batch, x.manufactureDate, expShow(x.expiryDate), x.quantity, x.note || '', x.by || ''])];
  if (kind === 'production') return ['每日生產', ['生產入庫日期', '產品', '單位', '批號', '製作日期', '有效日期', '生產量', '備註', '登錄人'], data.movements.filter(x => x.type === 'production').sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product)).map(x => [x.date, x.product, getUnit(x.product), x.batch, x.manufactureDate, expShow(x.expiryDate), x.quantity, x.note || '', x.by || ''])];
  if (kind === 'shipment') return ['每日出貨', ['出貨日期', '產品', '單位', '出貨單號', '需求量', '實際出貨', '出貨缺口', '備註', '登錄人'], data.movements.filter(x => x.type === 'shipment').sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product)).map(x => { const s = led.shipments.get(x.id); return [x.date, x.product, getUnit(x.product), x.orderNo || '', x.quantity, s?.shipped || 0, s?.shortage || 0, x.note || '', x.by || '']; })];
  if (kind === 'batches') return ['批次庫存', ['產品', '單位', '類別', '批號', '製作日期', '有效日期', '期初庫存', '新增生產', '半成品轉入', '已出貨', '轉成現貨', '剩餘量', '狀態'], groups.map(x => [x.product, x.unit, poolLabel(x.pool), x.batch, x.manufactureDate, expShow(x.expiryDate), x.opening, x.production, x.convert, x.shipped, x.converted, x.remaining, expiryStatus(x.expiryDate, x.remaining).label])];
  if (kind === 'allocation') return ['出貨扣批明細', ['出貨日期', '出貨單號', '產品', '單位', '批號', '製作日期', '有效日期', '扣貨量', '類別'], allocationRows(led).map(x => [x.date, x.orderNo, x.product, x.unit, x.batch, x.manufactureDate, expShow(x.expiryDate), x.quantity, x.kind === 'shortage' ? '缺口' : '已分配'])];
  return ['產品庫存總表', ['產品', '單位', '期初庫存', '累計生產', '累計扣貨', '可用庫存', '現貨', '半成品', '過期量', '近效期量', '最近有效日期', '低庫存警戒量'], products.map(x => [x.name, x.unit, x.opened, x.produced, x.used, x.usable, x.stock, x.semi, x.expired, x.warning, x.oldest, x.lowStock])];
}
function exportCsv(kind) { const [name, headers, records] = csvData(kind); const content = '﻿' + [headers, ...records].map(r => r.map(csvEscape).join(',')).join('\r\n'); downloadFile(`${name}_${TODAY()}.csv`, content, 'text/csv;charset=utf-8', `${name} CSV 已下載`); }
function exportBackup() { downloadFile(`生產出貨庫存_FEFO備份_${TODAY()}.json`, JSON.stringify({ ...exportState(), exportedAt: nowIso(), exportedBy: myName() }, null, 2), 'application/json;charset=utf-8', '完整 JSON 備份已下載'); }
let xlsxPromise = null;
function loadXLSX() { if (window.XLSX) return Promise.resolve(window.XLSX); if (!xlsxPromise) xlsxPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = () => window.XLSX ? res(window.XLSX) : rej(Error('Excel 元件載入失敗')); s.onerror = () => { xlsxPromise = null; s.remove(); rej(Error('Excel 元件載入失敗（需要網路），請改用各表的「匯出 CSV」')); }; document.head.appendChild(s); }); return xlsxPromise; }
async function exportXlsx() {
  toast('正在產生 Excel 檔…');
  try { const XLSX = await loadXLSX(); const wb = XLSX.utils.book_new(); for (const kind of ['products', 'batches', 'opening', 'production', 'shipment', 'allocation']) { const [name, headers, records] = csvData(kind); const ws = XLSX.utils.aoa_to_sheet([headers, ...records]); ws['!cols'] = headers.map(h => ({ wch: Math.max(10, h.length * 2 + 2) })); XLSX.utils.book_append_sheet(wb, ws, name); }
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }); downloadFile(`生產出貨庫存_完整明細_${TODAY()}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), null, 'Excel 明細已下載（六張工作表）'); }
  catch (err) { toast(err.message || 'Excel 產生失敗', true); }
}

/* ---------- 入口網站同步（書籤帶入 半成品入庫＝生產、實際揀貨＝出貨）---------- */
const PORTAL_URL = 'https://cheeseduke.flowings.app/logistics-console';
const PORTAL_DAYS = 14;
const CODE_RE = /^[\w.|\-]{1,60}$/;
const canPortal = () => can('produce') || can('ship');
const portalMeta = () => FEStore.get('settings', 'portal') || {};
// 預設起算日＝期初庫存（不含入口網站帶入的期初現貨 pt-o-）最晚入帳日的隔天
function defaultSyncFrom() { const last = data.opening.reduce((m, r) => !r.id.startsWith('pt-') && r.entryDate > m ? r.entryDate : m, ''); return last ? addDays(last, 1) : ''; }
const syncFromDate = () => isDate(portalMeta().syncFrom) ? portalMeta().syncFrom : defaultSyncFrom();
// 只同步這些開頭的品號（品號第一段「-」前面的英文，例如 CK-01|YB-08 → CK）；設定存在 settings 'portal'.prefixes
const DEFAULT_PREFIXES = ['CK', 'CC', 'CA', 'CL', 'CS', 'KA'];
const parsePrefixes = s => [...new Set(String(s || '').toUpperCase().split(/[\s,，、;；]+/).map(x => x.trim()).filter(x => /^[A-Z0-9]{1,10}$/.test(x)))];
const portalPrefixes = () => { const p = portalMeta().prefixes; return Array.isArray(p) && p.length ? p : DEFAULT_PREFIXES; };
const codePrefix = code => String(code).split(/[-|]/)[0].toUpperCase();
// 兩種流程，依「改用全現貨模式的日期」（settings 'portal'.stockFrom）切換，每一天各自套用：
//   半成品模式：半成品入庫＝有效期批次、生產轉現貨＝當天現貨（無效期）；出貨 ①現貨 ②半成品（FEFO）③當天生產轉現貨
//   全現貨模式：當天生產（半成品入庫＋生產轉現貨）＝一個有效期的現貨批次；出貨 ①既有現貨（FEFO）②當天生產，剩下的就是現貨入庫
const stockFromDate = () => isDate(portalMeta().stockFrom) ? portalMeta().stockFrom : '';
const isStockModeDay = d => { const s = stockFromDate(); return !!s && d >= s; };
const productCodeOf = name => { const s = clean(name), i = s.indexOf(' '); return i > 0 ? s.slice(0, i) : s; };
function decodeB64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return JSON.parse(decodeURIComponent(escape(atob(s)))); }
// 書籤資料整理乾淨：{ v:3, t: 書籤當天, d: { 日期: [[品號, 品名, 半成品入庫, 實際揀貨, 期初現貨, 生產轉現貨, 半成品轉現貨], ...] }, w: 讀取失敗的日期說明 }
// （舊書籤：v:1 只有前 4 欄，不動現貨紀錄；v:2 沒有半成品轉現貨，不動轉現貨紀錄）
function cleanPortal(p) {
  if (!p || ![1, 2, 3].includes(p.v) || !p.d || typeof p.d !== 'object') throw Error('資料格式不對，請重新拖曳最新的書籤');
  const qty = v => { v = Number(v); return v > 0 && v < 1e7 ? clampQty(v) : 0; };
  const days = {};
  for (const ds of Object.keys(p.d).slice(0, 62)) {
    if (!isDate(ds) || !Array.isArray(p.d[ds])) continue;
    const rows = [], seen = new Set();
    for (const a of p.d[ds].slice(0, 3000)) {
      if (!Array.isArray(a)) continue;
      const code = clean(a[0]);
      if (!CODE_RE.test(code) || seen.has(code)) continue;
      seen.add(code);
      rows.push({ code, name: clean(a[1]).slice(0, 40), inQ: qty(a[2]), outQ: qty(a[3]), openStock: qty(a[4]), toStock: qty(a[5]), semiToStock: qty(a[6]) });
    }
    days[ds] = rows;
  }
  if (!Object.keys(days).length) throw Error('沒有讀到任何日期的總表');
  return { days, hasStock: p.v >= 2, hasConvert: p.v >= 3, warn: typeof p.w === 'string' ? p.w.slice(0, 300) : '' };
}
let portalApplying = false;
function applyPortalPending() {
  if (portalApplying || loading() || !window.FEAuth || !FEAuth.user()) return;
  let raw = null; try { raw = sessionStorage.getItem(PORTAL_PENDING); } catch (e) {}
  if (!raw) return;
  try { sessionStorage.removeItem(PORTAL_PENDING); } catch (e) {}
  const okP = can('produce'), okS = can('ship');
  if (!okP && !okS) { toast('你沒有「生產與期初庫存」或「出貨」的權限，這次入口網站的資料沒有存。請找管理員開權限。', true, 8000); return; }
  portalApplying = true;
  try {
    const c = cleanPortal(decodeB64url(raw)), today = TODAY(), from = syncFromDate();
    const prefixes = portalPrefixes(), skippedCodes = new Set(), excludedCodes = new Set();
    // 擺盤等不需要的品號：總表品名有「擺盤」，或產品設定裡同品號的品名有「擺盤」
    const exclCodes = new Set(FEStore.list('products').map(p => clean(p && p.name)).filter(isExcluded).map(productCodeOf));
    for (const ds of Object.keys(c.days)) c.days[ds] = c.days[ds].filter(r => {
      if (!prefixes.includes(codePrefix(r.code))) { skippedCodes.add(r.code); return false; }
      if (exclCodes.has(r.code) || isExcluded(`${r.code} ${r.name}`)) { excludedCodes.add(r.code); return false; }
      return true;
    });
    const all = Object.keys(c.days).sort();
    const dates = all.filter(d => d <= today && (!from || d >= from));
    const before = all.filter(d => from && d < from);
    const byCode = new Map();
    for (const p of data.products) { const k = productCodeOf(p.name); if (!byCode.has(k) || byCode.get(k).virtual) byCode.set(k, p); }
    const newProducts = [];
    const productFor = (code, name) => {
      let p = byCode.get(code);
      if (!p || p.virtual) { const nm = `${code} ${name}`.trim(); p = { id: productId(nm), name: nm, unit: '個', shelfDays: data.settings.defaultShelf, lowStock: 0 }; byCode.set(code, p); newProducts.push(p); }
      return p;
    };
    const existing = new Map(data.movements.filter(r => r.id.startsWith('pt-')).map(r => [r.id, r]));
    const saves = [], removes = [], who = myName(), at = nowIso(), sum = { pN: 0, pQ: 0, sN: 0, sQ: 0, qN: 0, qQ: 0, cN: 0, cQ: 0 };
    // 期初現貨：起算日那天總表的「期初現貨」，每個品號一筆期初庫存（批號「現貨」、沒有效期）；書籤有讀到起算日才更新
    const openSaves = [], openRemoves = [], stockOpen = { n: 0, q: 0, set: false };
    if (c.hasStock && okP && from && c.days[from]) {
      stockOpen.set = true;
      const oldOpen = new Map(data.opening.filter(r => r.id.startsWith('pt-o-')).map(r => [r.id, r])), wantOpen = new Set();
      for (const r of c.days[from]) {
        if (!(r.openStock > 0)) continue;
        const p = productFor(r.code, r.name), id = `pt-o-${r.code}`, old = oldOpen.get(id);
        wantOpen.add(id); stockOpen.n++; stockOpen.q += r.openStock;
        const rec = old ? { ...old, product: p.name, quantity: r.openStock, entryDate: from, manufactureDate: from } : { id, type: 'opening', pool: 'stock', seq: nextSeq(), product: p.name, batch: '現貨', manufactureDate: from, expiryDate: NO_EXPIRY, entryDate: from, quantity: r.openStock, note: '入口網站：期初現貨', by: who, at };
        if (!old || old.quantity !== rec.quantity || old.product !== rec.product || old.entryDate !== from) openSaves.push(rec);
      }
      for (const id of oldOpen.keys()) if (!wantOpen.has(id)) openRemoves.push(id);
    }
    let modeB = 0;
    for (const ds of dates) {
      const want = new Set(), stockMode = isStockModeDay(ds);
      if (stockMode) modeB++;
      for (const r of c.days[ds]) {
        if (stockMode) {
          // 全現貨模式：當天生產＝半成品入庫＋生產轉現貨，一個有效期的現貨批次
          const q = clampQty(r.inQ + r.toStock);
          if (okP && q > 0) {
            const p = productFor(r.code, r.name), id = `pt-p-${ds}-${r.code}`, old = existing.get(id);
            want.add(id); sum.pN++; sum.pQ += q;
            const rec = old ? { ...old, product: p.name, quantity: q, note: '入口網站：當天生產（全現貨模式）' } : { id, type: 'production', seq: nextSeq(), date: ds, product: p.name, batch: ds.replace(/-/g, ''), manufactureDate: ds, expiryDate: addDays(ds, p.shelfDays), quantity: q, note: '入口網站：當天生產（全現貨模式）', by: who, at };
            if (!old || old.quantity !== rec.quantity || old.product !== rec.product || old.note !== rec.note) saves.push(rec);
          }
          if (okS && r.outQ > 0) {
            const p = productFor(r.code, r.name), id = `pt-s-${ds}-${r.code}`, old = existing.get(id);
            want.add(id); sum.sN++; sum.sQ += r.outQ;
            const rec = old ? { ...old, product: p.name, quantity: r.outQ } : { id, type: 'shipment', seq: nextSeq(), date: ds, product: p.name, quantity: r.outQ, orderNo: '入口網站：實際揀貨', note: '', by: who, at };
            if (!old || old.quantity !== rec.quantity || old.product !== rec.product) saves.push(rec);
          }
          continue;
        }
        if (c.hasStock && okP && r.toStock > 0) {
          // 生產轉現貨：當天生產直接做成現貨，製作日＝當天，有效日期＝當天＋保存天數
          const p = productFor(r.code, r.name), id = `pt-q-${ds}-${r.code}`, old = existing.get(id), exp = addDays(ds, p.shelfDays);
          want.add(id); sum.qN++; sum.qQ += r.toStock;
          const rec = old ? { ...old, product: p.name, quantity: r.toStock, batch: ds.replace(/-/g, ''), expiryDate: old.editBy ? old.expiryDate : exp } : { id, type: 'production', pool: 'stock', seq: nextSeq(), date: ds, product: p.name, batch: ds.replace(/-/g, ''), manufactureDate: ds, expiryDate: exp, quantity: r.toStock, note: '入口網站：生產轉現貨', by: who, at };
          if (!old || old.quantity !== rec.quantity || old.product !== rec.product || old.batch !== rec.batch || old.expiryDate !== rec.expiryDate) saves.push(rec);
        }
        if (c.hasConvert && okP && r.semiToStock > 0) {
          // 半成品轉現貨：照總表的實際數量，從效期最早的半成品轉；轉多了沒出完的留在現貨，隔天繼續出
          const p = productFor(r.code, r.name), id = `pt-c-${ds}-${r.code}`, old = existing.get(id);
          want.add(id); sum.cN++; sum.cQ += r.semiToStock;
          const rec = old ? { ...old, product: p.name, quantity: r.semiToStock } : { id, type: 'convert', seq: nextSeq(), date: ds, product: p.name, quantity: r.semiToStock, note: '入口網站：半成品轉現貨', by: who, at };
          if (!old || old.quantity !== rec.quantity || old.product !== rec.product) saves.push(rec);
        }
        if (okP && r.inQ > 0) {
          const p = productFor(r.code, r.name), id = `pt-p-${ds}-${r.code}`, old = existing.get(id);
          want.add(id); sum.pN++; sum.pQ += r.inQ;
          const rec = old ? { ...old, product: p.name, quantity: r.inQ, note: '入口網站：半成品入庫' } : { id, type: 'production', seq: nextSeq(), date: ds, product: p.name, batch: ds.replace(/-/g, ''), manufactureDate: ds, expiryDate: addDays(ds, p.shelfDays), quantity: r.inQ, note: '入口網站：半成品入庫', by: who, at };
          if (!old || old.quantity !== rec.quantity || old.product !== rec.product || old.note !== rec.note) saves.push(rec);
        }
        if (okS && r.outQ > 0) {
          const p = productFor(r.code, r.name), id = `pt-s-${ds}-${r.code}`, old = existing.get(id);
          want.add(id); sum.sN++; sum.sQ += r.outQ;
          const rec = old ? { ...old, product: p.name, quantity: r.outQ } : { id, type: 'shipment', seq: nextSeq(), date: ds, product: p.name, quantity: r.outQ, orderNo: '入口網站：實際揀貨', note: '', by: who, at };
          if (!old || old.quantity !== rec.quantity || old.product !== rec.product) saves.push(rec);
        }
      }
      for (const [id, r] of existing) if (r.date === ds && !want.has(id) && ((r.type === 'production' && okP && (c.hasStock || !id.startsWith('pt-q-'))) || (r.type === 'convert' && okP && (c.hasConvert || stockMode)) || (r.type === 'shipment' && okS))) removes.push(id);
    }
    if (newProducts.length) FEStore.saveMany('products', newProducts.map(p => ({ id: p.id, name: p.name, unit: p.unit, shelfDays: p.shelfDays, lowStock: 0 })));
    if (openSaves.length) FEStore.saveMany('opening', openSaves.map(recordBody));
    if (openRemoves.length) FEStore.removeMany('opening', openRemoves);
    if (saves.length) FEStore.saveMany('moves', saves.map(recordBody));
    if (removes.length) FEStore.removeMany('moves', removes);
    const meta = portalMeta(), changed = saves.length + removes.length + openSaves.length + openRemoves.length;
    FEStore.save('settings', { ...meta, id: 'portal', at: Date.now(), by: who, first: dates[0] || '', last: dates[dates.length - 1] || '', days: dates.length, ...sum, pQ: clampQty(sum.pQ), sQ: clampQty(sum.sQ), qQ: clampQty(sum.qQ), cQ: clampQty(sum.cQ), ...(stockOpen.set ? { stockOpenDate: from, stockOpenN: stockOpen.n, stockOpenQ: clampQty(stockOpen.q) } : {}), newProducts: newProducts.length, changed, warn: c.warn });
    const range = dates.length ? `${shortDate(dates[0])}～${shortDate(dates[dates.length - 1])}` : '沒有可匯入的日期';
    const parts = [okP ? `${modeB === dates.length && dates.length ? '當天生產' : modeB ? '半成品入庫／當天生產' : '半成品入庫'} ${sum.pN} 筆（${fmt(sum.pQ)} 個）` : '', okP && c.hasStock && sum.qN ? `生產轉現貨 ${sum.qN} 筆（${fmt(sum.qQ)} 個）` : '', okP && c.hasConvert && sum.cN ? `半成品轉現貨 ${sum.cN} 筆（${fmt(sum.cQ)} 個）` : '', okS ? `出貨 ${sum.sN} 筆（${fmt(sum.sQ)} 個）` : ''].filter(Boolean).join('、');
    const notes = [modeB ? `${modeB === dates.length ? '全部' : `其中 ${modeB} 天`}用全現貨模式（${stockFromDate()} 起）` : '', stockOpen.set ? `期初現貨 ${stockOpen.n} 個品號（${fmt(stockOpen.q)} 個，${from}）` : '', !c.hasConvert ? '這是舊版書籤，' + (c.hasStock ? '沒有帶入半成品轉現貨' : '沒有帶入現貨') + '，請到「入口網站同步」重新拖曳書籤' : '', newProducts.length ? `新增產品 ${newProducts.length} 項` : '', skippedCodes.size ? `略過 ${prefixes.join('、')} 以外的品號 ${skippedCodes.size} 個` : '', excludedCodes.size ? `略過${EXCLUDE_WORDS.join('、')} ${excludedCodes.size} 個品號` : '', before.length ? `起算日 ${from} 以前的 ${before.length} 天沒有匯入` : '', !okP ? '你沒有生產權限，生產數字沒有存' : '', !okS ? '你沒有出貨權限，出貨數字沒有存' : '', c.warn ? '注意：' + c.warn : ''].filter(Boolean).join('；');
    toast(`已同步入口網站 ${range}：${parts}${changed ? '' : '（數字都沒變）'}${notes ? '。' + notes : ''}`, false, 10000);
    go('portal');
  } catch (e) { toast('入口網站資料讀取失敗：' + e.message, true, 8000); }
  finally { portalApplying = false; }
}
// 書籤：在入口網站讀最近 14 天的總表（只讀），每天每個品號 [品號, 品名, 半成品入庫, 實際揀貨, 期初現貨, 生產轉現貨, 半成品轉現貨]，放在網址 #portal= 後開啟 App
function portalBookmarklet() {
  const app = location.origin + location.pathname;
  const code = "(async()=>{" +
    "if(location.hostname.indexOf('flowings.app')<0){if(confirm('這顆書籤要在「入口網站」的頁面按，你現在在別的網站。\\n\\n要現在打開入口網站嗎？打開後請登入，再按一次這顆書籤。'))window.open('" + PORTAL_URL + "','_blank');return}" +
    "var ov=document.createElement('div');ov.textContent='正在讀取總表最近 " + PORTAL_DAYS + " 天的現貨、半成品入庫與實際揀貨…';ov.style.cssText='position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;background:#153b48;color:#fff;padding:12px 18px;border-radius:10px;font:14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)';document.body.appendChild(ov);" +
    "try{var p=function(n){return String(n).padStart(2,'0')},f=function(d){return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())},now=new Date(),D={},bad=[],days=[];" +
    "for(var i=" + (PORTAL_DAYS - 1) + ";i>=0;i--)days.push(f(new Date(now.getFullYear(),now.getMonth(),now.getDate()-i)));" +
    "await Promise.all(days.map(async function(ds){var u=location.origin+'/api/internal/logistics-console/hq-ledger?date='+ds;" +
    "try{var r=await fetch(u,{credentials:'include',headers:{Accept:'application/json'}});if(!r.ok){bad.push(ds+' HTTP '+r.status);return}" +
    "var j=await r.json(),L=[];(j.rows||[]).forEach(function(x){var w=x.row||{},a=Number(w.semiIn)||0,b=Number(w.actualPick)||0,c=Number(w.opening&&w.opening.stock)||0,e=Number(w.packing&&w.packing.productionToStock)||0,k=Number(w.packing&&w.packing.semiToStock)||0;if(x.code&&(a>0||b>0||c>0||e>0||k>0))L.push([x.code,String(x.name||'').slice(0,30),a,b,c,e,k])});D[ds]=L}catch(e1){bad.push(ds+' '+e1.message)}}));" +
    "if(!Object.keys(D).length)throw new Error('總表沒有讀到任何日期'+(bad.length?'（'+bad.join('；')+'）':''));" +
    "var s=btoa(unescape(encodeURIComponent(JSON.stringify({v:3,t:f(now),d:D,w:bad.length?'這幾天沒讀到：'+bad.join('；'):''})))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');" +
    "ov.textContent='讀取完成，正在開啟庫存效期 App…';location.href='" + app + "#portal='+s}catch(e){ov.remove();alert('讀取入口網站失敗：'+e.message+'\\n\\n請確認已經登入入口網站，並在入口網站的頁面（例如物管駕駛艙總表）按這個書籤')}})()";
  return 'javascript:' + encodeURIComponent(code);
}
const FLOW_SEMI = '<strong>半成品模式</strong>：<strong>半成品入庫</strong>登錄成有效期的半成品批次；<strong>半成品轉現貨</strong>照總表的實際數量，從效期最早的半成品轉成現貨（保留原本的批號與有效日期，轉多了沒出完的留到隔天）；<strong>生產轉現貨</strong>是當天生產直接做成的現貨；起算日的<strong>期初現貨</strong>沒有效期資料。<strong>實際揀貨</strong>登錄成出貨：<strong>①現貨（含當天轉好的）→ ②現貨不夠再直接扣半成品（效期最早的先）→ ③當天的生產轉現貨</strong>，當天的半成品入庫是出完貨剩下的。';
const FLOW_STOCK = '<strong>全現貨模式</strong>：沒有半成品，<strong>當天生產</strong>（總表的半成品入庫＋生產轉現貨）登錄成有效期的現貨批次；<strong>實際揀貨</strong>登錄成出貨：<strong>①既有現貨（效期最早的先）→ ②不夠再從當天生產直接取</strong>，剩下的就是現貨入庫。';
function renderPortal() {
  const m = portalMeta(), from = syncFromDate(), sf = stockFromDate(), nowB = isStockModeDay(TODAY());
  $('portalFlow').innerHTML = `從入口網站（物管駕駛艙「總表」）帶入每日數字。${nowB ? FLOW_STOCK : FLOW_SEMI}${sf ? (nowB ? `（${sf} 以前的日期仍用半成品模式）` : `<br>${sf} 起改用${FLOW_STOCK}`) : ''}<br>`;
  $('portalKpis').innerHTML = [
    ['上次同步', m.at ? new Date(m.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '還沒同步過', m.by || '', m.at ? '' : 'warn'],
    ['目前流程', nowB ? '全現貨模式' : '半成品模式', sf ? (nowB ? `${sf} 起` : `${sf} 起改全現貨`) : '尚未設定切換日期', nowB ? 'warn' : ''],
    ['期初現貨', m.stockOpenDate ? `${fmt(m.stockOpenQ)} 個` : '還沒帶入', m.stockOpenDate ? `${m.stockOpenN} 個品號（${m.stockOpenDate}）` : '用新版書籤同步一次就會帶入', m.stockOpenDate ? '' : 'warn'],
    ['起算日', from || '不限', m.last ? `上次同步 ${shortDate(m.first)}～${shortDate(m.last)}` : (isDate(m.syncFrom) ? '手動設定' : '期初庫存入帳日的隔天'), ''],
  ].map(([l, v, d, c]) => `<article class="kpi ${c}"><div class="kpi-label">${esc(l)}</div><div class="kpi-value" style="font-size:20px">${esc(v)}</div><div class="kpi-desc">${esc(d)}</div></article>`).join('');
  const fEl = $('portalFrom'); if (document.activeElement !== fEl) fEl.value = from || '';
  const sEl = $('portalStockFrom'); if (document.activeElement !== sEl) sEl.value = sf;
  const pEl = $('portalPrefixes'); if (document.activeElement !== pEl) pEl.value = portalPrefixes().join(', ');
  $('portalPrefixText').textContent = portalPrefixes().join('、');
  $('portalFromHint').textContent = isDate(m.syncFrom) ? '' : '目前用預設：期初庫存最晚入帳日的隔天';
  const ledger = calculateLedger(), by = new Map();
  for (const r of data.movements) {
    if (!r.id.startsWith('pt-')) continue;
    if (!by.has(r.date)) by.set(r.date, { date: r.date, pQ: 0, qQ: 0, cQ: 0, sQ: 0, fromStock: 0, fromSemi: 0, fromToday: 0, short: 0 });
    const g = by.get(r.date), B = isStockModeDay(r.date);
    if (r.type === 'production') { if (r.pool === 'stock') g.qQ += r.quantity; else g.pQ += r.quantity; }
    else if (r.type === 'convert') g.cQ += r.quantity;
    else {
      // 扣現貨＝現貨（期初、之前留下的、當天半成品轉好的；全現貨模式含之前的有效期批次）
      // 扣半成品＝現貨不夠、直接從半成品扣（總表沒記到的轉現貨）；扣當天生產＝當天生產轉現貨／全現貨模式的當天生產
      const s = ledger.shipments.get(r.id); g.sQ += r.quantity; g.short += s?.shortage || 0;
      for (const a of s?.allocations || []) {
        if (a.source === 'production' && a.entryDate === r.date) g.fromToday += a.quantity;
        else if (a.pool === 'stock' || B) g.fromStock += a.quantity;
        else g.fromSemi += a.quantity;
      }
    }
  }
  const rows = [...by.values()].sort((a, b) => cmp(b.date, a.date));
  $('portalCount').textContent = rows.length ? `共 ${rows.length} 天。要看明細，到「出貨扣批明細」或「每日生產紀錄」「每日出貨紀錄」按「明細」` : '入口網站帶入的生產與出貨紀錄，依日期彙總';
  const n = v => `<td class="num">${v ? fmt(clampQty(v)) : '—'}</td>`;
  $('portalTable').innerHTML = table(['日期', '流程', '半成品入庫／當天生產#', '生產轉現貨#', '半成品轉現貨#', '實際揀貨#', '扣現貨#', '扣半成品#', '扣當天生產#', '出貨缺口#'], rows.map(g => `<tr>${tdm(g.date)}${td(isStockModeDay(g.date) ? badge('全現貨', 'due') : badge('半成品', 'other'))}${n(g.pQ)}${n(g.qQ)}${n(g.cQ)}${n(g.sQ)}${n(g.fromStock)}${n(g.fromSemi)}${n(g.fromToday)}<td class="num">${g.short ? badge(fmt(clampQty(g.short)), 'bad') : '—'}</td></tr>`), '還沒有從入口網站同步過');
}

/* ---------- 人員與權限（管理員）---------- */
const U = { list: null, admins: [], loading: false, error: '' };
async function loadUsers() {
  if (!isAdmin() || U.loading) return;
  U.loading = true; renderUsers();
  try { const j = await FEAuth.api('users'); U.list = j.users || []; U.admins = j.admins || []; U.error = ''; }
  catch (e) { U.error = e.message; }
  U.loading = false; renderUsers();
}
function renderUsers() {
  const root = $('userList');
  if (!U.list) { root.innerHTML = U.error ? `<div class="banner bad">讀不到人員名單：${esc(U.error)}<button class="btn small" type="button" data-action="reload-users">重試</button></div>` : '<div class="empty">正在讀取人員名單…</div>'; return; }
  const when = ms => ms ? new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '還沒登入過';
  const admins = U.admins.map(a => `<div class="urow"><div class="urow-main"><b>${esc(a)}</b><div class="chips"><span class="chip perm">管理員：全部權限</span></div></div><span class="hint">要更換管理員，請改雲端後端 Code.gs 的 ADMIN_EMAILS_</span></div>`).join('');
  const rows = U.list.map(u => `<div class="urow"><div class="urow-main"><b>${esc(u.name || u.email)}</b><span class="hint">${esc(u.email)} · 最後登入 ${esc(when(u.lastLogin))}</span><div class="chips">${u.enabled ? '' : '<span class="chip off">已停用</span>'}${(u.pages || []).map(p => `<span class="chip perm">${esc(PERM_LABEL[p] || p)}</span>`).join('') || '<span class="chip">只能查看</span>'}</div></div><div class="segment"><button class="btn small" type="button" data-action="edit-user" data-id="${esc(u.email)}">編輯</button><button class="btn small" type="button" data-action="toggle-user" data-id="${esc(u.email)}">${u.enabled ? '停用' : '啟用'}</button><button class="btn small danger" type="button" data-action="delete-user" data-id="${esc(u.email)}">刪除</button></div></div>`).join('');
  root.innerHTML = `<div class="ulist">${admins}${rows}</div>${U.list.length ? '' : '<p class="helper">還沒有加入任何同事。按「＋ 新增人員」，輸入同事的 Gmail 並勾選權限。</p>'}${U.loading ? '<p class="helper">更新中…</p>' : ''}`;
}
async function openUserForm(u, isEdit = !!u, err = '') {
  u = u || { email: '', name: '', pages: ['produce', 'ship'], enabled: true };
  const res = await modal({ title: isEdit ? '編輯人員' : '新增人員', ok: '儲存',
    html: `<p class="modal-note">同事用這個 Gmail 登入後，就能看到全部資料；下面勾選的是他能做的事。</p><div class="field"><label for="u-email">Gmail</label><input id="u-email" type="email" value="${esc(u.email)}" ${isEdit ? 'readonly' : ''} placeholder="name@gmail.com" autocomplete="off"></div><div class="field"><label for="u-name">姓名（顯示在登錄紀錄）</label><input id="u-name" value="${esc(u.name)}" placeholder="例如：王小明" maxlength="30"></div><div class="field"><label>權限</label><div class="perm-list">${PERMS.map(p => `<label class="perm" for="u-p-${p.id}"><input type="checkbox" id="u-p-${p.id}" value="${p.id}"${(u.pages || []).includes(p.id) ? ' checked' : ''}><span><b>${p.label}</b><span>${p.desc}</span></span></label>`).join('')}</div><span class="hint">都不勾＝只能查看與下載資料</span></div><p class="modal-error"${err ? '' : ' hidden'}>${esc(err)}</p>`,
    collect: b => { const email = clean(b.querySelector('#u-email').value); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Error('請輸入正確的 Gmail 地址。'); return { email, name: clean(b.querySelector('#u-name').value), pages: PERMS.filter(p => b.querySelector('#u-p-' + p.id).checked).map(p => p.id) }; } });
  if (!res) return;
  try { const j = await FEAuth.api('userSave', { ...res, enabled: u.enabled !== false }); U.list = j.users || U.list; renderUsers(); toast(isEdit ? '已更新' : `已加入 ${res.email}，請他用這個 Gmail 登入`); }
  catch (e) { openUserForm({ ...u, ...res }, isEdit, e.message); }
}
async function userCall(action, payload, okMsg) { try { const j = await FEAuth.api(action, payload); U.list = j.users || U.list; renderUsers(); toast(okMsg); } catch (e) { toast(e.message, true); } }

/* ---------- 事件 ---------- */
async function handleAction(el) {
  const a = el.dataset.action, id = el.dataset.id;
  if (a === 'backup') return exportBackup();
  if (a === 'xlsx-all') return exportXlsx();
  if (a === 'sync') return FEStore.syncNow();
  if (a.startsWith('csv-')) return exportCsv(a.slice(4));
  if (a === 'cancel-opening') return resetOpening();
  if (a === 'reload-users') return loadUsers();
  if (a === 'edit-user') { const u = (U.list || []).find(x => x.email === id); return u && openUserForm(u, true); }
  if (a === 'toggle-user') { const u = (U.list || []).find(x => x.email === id); return u && userCall('userSave', { email: u.email, name: u.name, pages: u.pages, enabled: !u.enabled }, u.enabled ? '已停用，這個人會馬上被登出' : '已啟用'); }
  if (a === 'delete-user') { const u = (U.list || []).find(x => x.email === id); if (!u || !await modal({ title: '刪除這位人員？', html: `<p>${esc(u.name || u.email)}（${esc(u.email)}）會馬上被登出，之後不能再登入。他登錄過的資料會保留。</p>`, ok: '刪除', danger: true })) return; return userCall('userDelete', { email: u.email }, '已刪除'); }
  if (a.startsWith('detail-')) return openDetail(a.slice(7), id);
  if (a === 'edit-opening') { closeModal(); return can('produce') && populateEdit('opening', id); }
  if (a === 'edit-product') return editProduct(id);
  if (a.startsWith('delete-') && a !== 'delete-user') {
    closeModal();
    const typ = a.slice(7); if (!can(permFor(typ))) return;
    const rec = typ === 'opening' ? data.opening.find(x => x.id === id) : data.movements.find(x => x.id === id); if (!rec) return;
    if (!await modal({ title: '刪除這筆資料？', html: `<p>${esc(describeRec(rec))}</p><p class="modal-note">刪除後，所有庫存與歷史 FEFO 扣批會重新計算。</p>`, ok: '刪除', danger: true })) return;
    return act(() => { FEStore.remove(kindOfRec(rec), rec.id); if (editOpening === id) resetOpening(); toast('已刪除，庫存及出貨分配已重算'); });
  }
  if (a === 'demo') return seedDemo();
  if (a === 'import') return isAdmin() && $('importFile').click();
  if (a === 'reset') return resetAll();
}
function bind() {
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-action]'); if (el) { e.preventDefault(); handleAction(el); return; }
    const v = e.target.closest('[data-view]'); if (v && v.tagName !== 'A') go(v.dataset.view);
  });
  window.addEventListener('hashchange', () => showView(location.hash.slice(1)));
  $('sync').addEventListener('click', () => FEStore.syncNow());
  $('logoutBtn').addEventListener('click', () => FEAuth.logout());
  $('logoutBtn2').addEventListener('click', () => FEAuth.logout());
  $('addUserBtn').addEventListener('click', () => openUserForm());
  for (const id of ['openingFilter', 'productionFilter', 'shipmentFilter', 'batchFilter', 'allocationFilter', 'productFilter', 'settingFilter', 'batchLive', 'productLive']) $(id).addEventListener('input', scheduleRender);
  $('batchSeg').addEventListener('click', e => { const b = e.target.closest('[data-bmode]'); if (!b) return; batchMode = b.dataset.bmode; scheduleRender(); });
  $('openingForm').addEventListener('submit', saveOpening);
  $('settingsForm').addEventListener('submit', e => { e.preventDefault(); if (!can('setting')) return; const w = Number($('warnDays').value), s = Number($('defaultShelf').value); if (!Number.isInteger(w) || w < 1 || w > 3650 || !Number.isInteger(s) || s < 0 || s > 36500) { toast('請填寫有效的預警及保存天數（整數）', true); return; } act(() => { FEStore.save('settings', { id: 'main', warnDays: w, defaultShelf: s }); toast('系統設定已儲存'); }); });
  for (const id of ['oMfg', 'oShelf']) $(id).addEventListener('change', () => autoExpiry('o')); $('oProduct').addEventListener('change', () => productDefaults('o'));
  const bm = $('portalBm'); bm.setAttribute('href', portalBookmarklet());
  bm.addEventListener('click', e => { e.preventDefault(); toast('請把這顆按鈕「拖曳」到瀏覽器的書籤列，再到入口網站的頁面按書籤。'); });
  $('portalFromForm').addEventListener('submit', e => {
    e.preventDefault(); if (!can('setting')) return;
    const v = $('portalFrom').value, sf = $('portalStockFrom').value, px = parsePrefixes($('portalPrefixes').value);
    if ((v && !isDate(v)) || (sf && !isDate(sf))) { toast('請選擇有效的日期', true); return; }
    if (!px.length) { toast('請至少填一個品號開頭，例如 CK', true); return; }
    act(() => { FEStore.save('settings', { ...portalMeta(), id: 'portal', syncFrom: v || '', stockFrom: sf || '', prefixes: px }); toast(`同步設定已儲存：起算日 ${v || '預設（' + (defaultSyncFrom() || '不限') + '）'}，${sf ? `${sf} 起用全現貨模式` : '繼續用半成品模式'}，品號開頭 ${px.join('、')}。已經同步過的日期，下次同步會照新設定重算`); });
  });
  $('importFile').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0]; e.target.value = ''; if (!file || !isAdmin()) return;
    let incoming; try { incoming = validateImport(JSON.parse(await file.text())); } catch (err) { toast(`匯入失敗：${err.message}`, true, 6000); return; }
    const ok = await modal({ title: '匯入 JSON 備份？', ok: '匯入並取代', danger: true, html: `<p>將以「${esc(file.name)}」取代雲端上所有人共用的資料。</p><ul class="modal-list"><li>產品 ${incoming.products.length} 項</li><li>期初庫存 ${incoming.opening.length} 筆</li><li>生產與出貨 ${incoming.movements.length} 筆</li></ul><p class="modal-note">建議先下載目前資料的備份。</p>` });
    if (!ok) return;
    act(() => { replaceAll(incoming); resetForms(); go('dashboard'); toast('匯入完成，正在上傳雲端；右上角變成「已同步」就完成了', false, 7000); });
  });
}

/* ---------- 啟動 ---------- */
let lastLoaded = false;
FEStore.on((type, payload) => {
  if (type === 'change') { rebuild(); scheduleRender(); }
  else if (type === 'status') { renderSync(); renderBanner(); const l = !!FEStore.status().loaded; if (l !== lastLoaded) { lastLoaded = l; scheduleRender(); } if (l) setTimeout(applyPortalPending, 0); }
  else if (type === 'conflict') toast('有同事同時修改了同一筆資料，已自動合併；同一個欄位以你的修改為準。');
});
FEAuth.on(() => { applyPerms(); scheduleRender(); });
bind(); resetForms(); showView(location.hash.slice(1) || 'dashboard'); renderSync();
FEAuth.ready.then(() => { applyPerms(); rebuild(); resetForms(); render(); applyPortalPending(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js').catch(() => {}); });
}
// 跨日（App 開著過午夜）時，「今天」與效期判斷跟著更新
let lastDay = TODAY();
setInterval(() => { const d = TODAY(); if (d !== lastDay) { lastDay = d; resetForms(); scheduleRender(); } }, 60000);
