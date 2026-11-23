/*
 * 生產出貨庫存效期管理｜畫面與 FEFO 庫存引擎
 * ---------------------------------------------------------------
 * 資料（FEStore，見 cloud-store.js）：
 *   products  { id, name, unit, shelfDays, lowStock }                       id = 'p-' + 名稱雜湊（兩台裝置新增同名產品會合併成同一筆）
 *   settings  { id: 'main', warnDays（舊，已不用）, defaultShelf, stockDays, stockWarn, semiWarn }
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

// 門市：每間一頁，權限代號 shop_代號（例如 shop_a11）
// pos：POS 銷售明細「倉庫」欄的代號（匯入銷售／報廢檔案時用來分門市）
const SHOPS = [{ id: 'a11', name: 'A11', pos: '5' }, { id: 'jz', name: '京站', pos: '4' }, { id: 'dq', name: '東橋', pos: '24' }];
// POS 倉庫代號 1（01）＝總公司：不匯入門市（總公司的出貨照入口網站總表的實際揀貨帶入，再匯 POS 會重複算）
const POS_HQ = '1';
const posWhName = v => String(v).replace(/^0+(?=\d)/, '') === POS_HQ ? '總公司' : '';
const shopPerm = id => 'shop_' + id;
const PERMS = [
  { id: 'produce', label: '生產與期初庫存', desc: '新增、修改、刪除期初庫存；入口網站同步時存生產數字' },
  { id: 'ship', label: '出貨', desc: '入口網站同步時存出貨數字' },
  { id: 'setting', label: '產品與效期設定', desc: '修改產品單位、保存天數、低庫存警戒量，以及效期預警天數' },
  ...SHOPS.map(x => ({ id: shopPerm(x.id), label: `${x.name}門市`, desc: `登錄、刪除${x.name}門市的入貨、銷售與報廢` })),
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
const blankState = () => ({ version: 1, products: [], opening: [], movements: [], shops: [], audits: [], txbs: [], settings: { warnDays: 30, defaultShelf: 30, stockDays: 12, stockWarn: 3, semiWarn: 15 } });

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
  const w = Number(s?.warnDays), d = Number(s?.defaultShelf), k = Number(s?.stockDays), kw = Number(s?.stockWarn), mw = Number(s?.semiWarn);
  // stockDays：總公司現貨可放幾天（有效日期＝轉現貨日＋幾天）；stockWarn：現貨剩幾天以內算「現貨到期」；semiWarn：半成品剩幾天以內警示（15 天）
  return { warnDays: Number.isInteger(w) && w > 0 ? w : 30, defaultShelf: Number.isInteger(d) && d >= 0 ? d : 30, stockDays: Number.isInteger(k) && k >= 1 && k <= 365 ? k : 12, stockWarn: Number.isInteger(kw) && kw >= 0 && kw <= 60 ? kw : 3, semiWarn: Number.isInteger(mw) && mw >= 1 && mw <= 365 ? mw : 15 };
}
function sanitizeRec(r) {
  if (!r || typeof r !== 'object' || !r.id) return null;
  const q = Number(r.quantity), product = clean(r.product);
  if (!product || !(q > 0) || !Number.isFinite(q)) return null;
  const base = { id: String(r.id), seq: Number(r.seq) || 0, product, quantity: q, note: clean(r.note), by: clean(r.by), at: r.at || '', editBy: clean(r.editBy), editAt: r.editAt || '' };
  if (r.type === 'shipment') return isDate(r.date) ? { ...base, type: 'shipment', date: r.date, orderNo: clean(r.orderNo) } : null;
  if (r.type === 'convert') return isDate(r.date) ? { ...base, type: 'convert', date: r.date } : null; // 半成品轉現貨
  if (r.type === 'adjust') { // 半成品增減：add 增加一批（有製作日期、有效日期）；sub 減少（可指定哪一批 fromMfg／fromExp）
    if (!isDate(r.date) || (r.dir !== 'add' && r.dir !== 'sub')) return null;
    // pool 'stock'＝現貨增減（入口網站「現貨增減」）；phase 'pack'＝入口網站帶入的包裝區增減，跟轉現貨同時算（出貨前）；
    // phase 'open'＝隔夜差異（總表當天期初跟前一天期末對不上），算在當天一開始
    // phase 'close'＝盤點校正，算在當天最後（所有出貨、增減之後）
    const extra = { ...(r.pool === 'stock' ? { pool: 'stock' } : {}), ...(['pack', 'open', 'close'].includes(r.phase) ? { phase: r.phase } : {}) };
    if (r.dir === 'add') return isDate(r.manufactureDate) && isDate(r.expiryDate) ? { ...base, ...extra, type: 'adjust', dir: 'add', date: r.date, batch: r.pool === 'stock' && clean(r.batch) && clean(r.batch) !== '—' ? clean(r.batch) : '—', manufactureDate: r.manufactureDate, expiryDate: r.expiryDate } : null;
    return { ...base, ...extra, type: 'adjust', dir: 'sub', date: r.date, fromMfg: isDate(r.fromMfg) ? r.fromMfg : '', fromExp: isDate(r.fromExp) ? r.fromExp : '', ...(r.pool === 'stock' && clean(r.fromBatch) ? { fromBatch: clean(r.fromBatch) } : {}) };
  }
  if (!isDate(r.manufactureDate) || !isDate(r.expiryDate)) return null;
  // 還沒轉現貨的半成品沒有批號，只看製作日期與有效日期；現貨（期初現貨、生產轉現貨、全現貨模式的當天生產）才有批號
  const semi = r.pool !== 'stock' && !(r.type === 'production' && isStockModeDay(r.date));
  const lot = { ...base, batch: semi ? '—' : clean(r.batch) || '—', manufactureDate: r.manufactureDate, expiryDate: r.expiryDate, ...(r.pool === 'stock' ? { pool: 'stock' } : {}) };
  if (r.type === 'opening') return isDate(r.entryDate) ? { ...lot, type: 'opening', entryDate: r.entryDate } : null;
  if (r.type === 'production') return isDate(r.date) ? { ...lot, type: 'production', date: r.date } : null;
  return null;
}
// 總公司交易明細的批號（txb）：交易日 tx 的明細，照訂單單號對到排單日 date（揀貨那天），每個品號（第一段）一筆 { 批號: 數量 }；
// 批號空白存成「—」（明細沒寫批號，扣的時候照先到期先出）；unmatched＝訂單不在排單表，只列在核對表、不拿來扣
function sanitizeTxb(r) {
  if (!r || typeof r !== 'object' || !r.id || !isDate(r.tx) || !isDate(r.date)) return null;
  const code = clean(r.code).toUpperCase(); if (!/^[A-Z0-9]{1,8}(-[A-Z0-9]{1,8})?$/.test(code)) return null;
  const batches = {};
  if (r.batches && typeof r.batches === 'object') for (const [b, v] of Object.entries(r.batches).slice(0, 80)) { const k = cleanBatch(b) || '—', n = Number(v); if (n > 0 && n < 1e7) batches[k] = clampQty((batches[k] || 0) + n); }
  if (!Object.keys(batches).length) return null;
  return { id: String(r.id), tx: r.tx, date: r.date, code, batches, n: Number(r.n) || 0, by: clean(r.by), at: r.at || '', ...(r.unmatched ? { unmatched: true, orders: Array.isArray(r.orders) ? r.orders.filter(o => ORDER_RE.test(o)).slice(0, 60) : [] } : {}) };
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
  const shops = [];
  for (const r of FEStore.list('shop')) { const x = sanitizeShop(r); if (x && !isExcluded(x.product)) shops.push(x); }
  const audits = FEStore.list('audit').map(sanitizeAudit).filter(Boolean);
  const txbs = FEStore.list('txb').map(sanitizeTxb).filter(Boolean);
  data = addVirtualProducts({ version: 1, products, opening, movements, shops, audits, txbs, settings });
}

/* ---------- 寫入（先存這台裝置，背景上傳雲端） ---------- */
const kindOfRec = r => r.type === 'opening' ? 'opening' : 'moves';
function recordBody(rec) {
  const b = { id: rec.id, type: rec.type, seq: rec.seq, product: rec.product, quantity: rec.quantity, note: rec.note || '', by: rec.by || '', at: rec.at || '' };
  if (rec.editBy) { b.editBy = rec.editBy; b.editAt = rec.editAt; }
  if (rec.type === 'shipment') { b.date = rec.date; b.orderNo = rec.orderNo || ''; }
  else if (rec.type === 'convert') b.date = rec.date;
  else if (rec.type === 'adjust') { b.date = rec.date; b.dir = rec.dir; if (rec.pool === 'stock') b.pool = 'stock'; if (['pack', 'open', 'close'].includes(rec.phase)) b.phase = rec.phase; if (rec.dir === 'add') { b.manufactureDate = rec.manufactureDate; b.expiryDate = rec.expiryDate; if (rec.batch && rec.batch !== '—') b.batch = rec.batch; } else { b.fromMfg = rec.fromMfg || ''; b.fromExp = rec.fromExp || ''; if (rec.fromBatch) b.fromBatch = rec.fromBatch; } }
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
    settings: [{ id: 'main', warnDays: st.settings.warnDays, defaultShelf: st.settings.defaultShelf, stockDays: st.settings.stockDays, stockWarn: st.settings.stockWarn, semiWarn: st.settings.semiWarn }],
    opening: uniq(st.opening, r => r.id).map(r => strip({ ...r, type: 'opening' })),
    moves: uniq(st.movements, r => r.id).map(strip),
    ...(Array.isArray(st.shops) ? { shop: uniq(st.shops, r => r.id).map(strip) } : {}), // 舊備份沒有門市資料時不動門市
    ...(Array.isArray(st.audits) ? { audit: uniq(st.audits, r => r.id).map(strip) } : {}), // 舊備份沒有盤點資料時不動盤點
    ...(Array.isArray(st.txbs) ? { txb: uniq(st.txbs, r => r.id).map(strip) } : {}), // 舊備份沒有交易明細批號時不動
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
    ...(Array.isArray(d.shops) ? { shops: d.shops.map(sanitizeShop).filter(Boolean) } : {}),
    ...(Array.isArray(d.audits) ? { audits: d.audits.map(sanitizeAudit).filter(Boolean) } : {}),
    ...(Array.isArray(d.txbs) ? { txbs: d.txbs.map(sanitizeTxb).filter(Boolean) } : {}),
    settings: normSettings(d.settings),
  };
}
function validateImport(obj) {
  if (!isValidState(obj)) throw Error('這不是本系統的 JSON 備份檔');
  for (const row of [...obj.opening, ...obj.movements]) {
    if (!row || !row.id || !row.product || !(Number(row.quantity) > 0) || !Number.isFinite(Number(row.quantity)) || !(Number(row.quantity) <= 1e12)) throw Error('備份內有無效的數量或產品');
    if (row.type === 'shipment' || row.type === 'convert' || (row.type === 'adjust' && row.dir === 'sub')) { if (!isDate(row.date)) throw Error('出貨／轉現貨／增減日期格式錯誤'); }
    else if (row.type === 'adjust') { if (!isDate(row.date) || !isDate(row.manufactureDate) || !isDate(row.expiryDate)) throw Error('半成品增加的日期格式錯誤'); }
    else if (!isDate(row.expiryDate) || !isDate(row.manufactureDate) || !isDate(row.entryDate || row.date)) throw Error('庫存日期格式錯誤');
  }
  for (const p of obj.products) if (!p.name || !p.unit) throw Error('產品資料不完整');
  return normalizeImport(obj);
}
function exportState() {
  const maxSeq = [...data.opening, ...data.movements].reduce((m, x) => Math.max(m, Number(x.seq) || 0), 0);
  return { version: 1, products: data.products.map(({ virtual, ...p }) => p), opening: data.opening.map(({ type, ...r }) => r), movements: data.movements.map(r => ({ ...r })), shops: data.shops.map(r => ({ ...r })), audits: data.audits.map(r => ({ ...r })), txbs: data.txbs.map(r => ({ ...r })), settings: { ...data.settings }, nextSeq: maxSeq + 1 };
}

/* ---------- 庫存引擎：依日期重放所有事件；同日先入庫，再依出貨順序扣最早到期者 ---------- */
// 同一天的順序：入庫（期初、生產、半成品增加）→ 半成品轉現貨 → 出貨 → 半成品減少（當天結束時盤點扣）
// 批次 pool：'stock' 現貨、'semi' 半成品（全現貨模式的有效期批次也記成 semi，但出貨時一律當現貨看）
// lot.used＝已扣（出貨＋轉成現貨）、lot.shipped＝只算出貨、lot.converted＝轉成現貨的量
// 增減的順序：半成品增加＝當天一開始；入口網站的半成品減少（含轉試吃）＝跟轉現貨同時（出貨前）；現貨增加＝轉現貨之後、出貨前；
//            手動的半成品減少、現貨減少＝當天結束（出貨之後）；隔夜差異（phase 'open'）＝當天最一開始（比當天入庫還早）
const adjPriority = x => x.phase === 'open' ? -1 : x.phase === 'close' ? 3.5 : x.dir === 'add' ? (x.pool === 'stock' ? 1.5 : 0) : (x.pool !== 'stock' && x.phase === 'pack' ? 0.9 : 3);
const baseCode = name => productCodeOf(name).split('|')[0];
// 出貨時這一批的批號：現貨用那批的批號；直接從半成品出的貨用出貨當天的批號；期初現貨沒有批號
const lotBatchOn = (l, day) => l.expiryDate === NO_EXPIRY ? '' : (l.batch && l.batch !== '—' ? l.batch : makeBatch(l.product, day));
/* 可販售期（只用在門市）：蛋糕類（CL 以外）可販售 15 天、第 11 天起提醒；生巧克力（CL 開頭）可販售 10 天、第 7 天起提醒
   （「可販售期」設定可改，存在 settings 'sell'）。門市入貨那天算第 1 天，最後可販售日＝入貨日＋可販售天數－1。
   總公司只看半成品與現貨的有效日期（製作日期＋保存天數；現貨的製作日期＝轉現貨那天），不套可販售期。 */
const SELL_DEFAULT = { cake: { days: 15, warnFrom: 11 }, choc: { days: 10, warnFrom: 7 } };
const SELL_NAMES = { cake: '蛋糕類', choc: '生巧克力' };
function sellRule() {
  const r = FEStore.get('settings', 'sell') || {};
  const one = (x, d) => { const n = Number(x && x.days), w = Number(x && x.warnFrom), days = Number.isInteger(n) && n >= 1 && n <= 365 ? n : d.days; return { days, warnFrom: Number.isInteger(w) && w >= 1 && w <= days ? w : Math.min(d.warnFrom, days) }; };
  return { cake: one(r.cake, SELL_DEFAULT.cake), choc: one(r.choc, SELL_DEFAULT.choc) };
}
const sellKind = name => String(productCodeOf(name)).toUpperCase().startsWith('CL') ? 'choc' : 'cake';
const sellOf = name => sellRule()[sellKind(name)];
const sellEnd = (name, day1) => addDays(day1, sellOf(name).days - 1);
// 第幾天、剩幾天；剩的天數 ≤ 可販售天數－提醒日 就是「快到期」（例如蛋糕 15 天、第 11 天起：剩 4 天以內）
function sellStatus(name, expiry, today) {
  const d = dayDiff(today, expiry), s = sellOf(name);
  if (d < 0) return { label: `已過期 ${-d} 天`, cls: 'expired', d, warn: false };
  if (d === 0) return { label: '今天最後一天', cls: 'critical', d, warn: true };
  const warn = d <= s.days - s.warnFrom, n = s.days - d;
  return { label: `${n >= 1 ? `第 ${n} 天・` : ''}剩 ${d} 天`, cls: warn ? 'critical' : 'ok', d, warn };
}
// 總公司現貨可放幾天（現階段 12 天，「資料與設定」可改）：現貨有效日期＝轉現貨日（製作日期）＋這個天數；半成品照產品的保存天數（30 天）
const stockDaysOf = (st = data) => (st.settings && st.settings.stockDays) || 12;
// 入口網站帶入的生產轉現貨：有效日期＝當天＋現貨可放天數
const prodExp = (r, st = data) => r.type === 'production' && r.pool === 'stock' && String(r.id).startsWith('pt-q-') ? addDays(r.manufactureDate, stockDaysOf(st)) : r.expiryDate;
function calculateLedger(asOf = '9999-12-31', st = data) {
  const events = [], prio = { production: 0, convert: 1, shipment: 2 };
  for (const x of st.opening) if (x.entryDate <= asOf) events.push({ date: x.entryDate, priority: 0, seq: x.seq || 0, type: 'opening', item: x });
  for (const x of st.movements) if (x.date <= asOf) events.push({ date: x.date, priority: x.type === 'adjust' ? adjPriority(x) : prio[x.type] ?? 2, seq: x.seq || 0, type: x.type, item: x });
  events.sort((a, b) => cmp(a.date, b.date) || a.priority - b.priority || a.seq - b.seq || cmp(String(a.item.id), String(b.item.id)));
  const lots = [], shipments = new Map(), converts = new Map(), adjusts = new Map(), byProduct = new Map(), packPool = new Map();
  // 總公司交易明細的批號：排單日＋品號第一段 → { 批號: 數量 }（同一天、同一個品號第一段的出貨共用，例如 CK-14 和 CK-14|YB-86，照出貨順序扣）
  const txPool = new Map();
  for (const t of st.txbs || []) { if (t.unmatched || t.date > asOf) continue; const k = t.date + '|' + t.code, m = txPool.get(k) || {}; for (const [b, q] of Object.entries(t.batches)) m[b] = clampQty((m[b] || 0) + q); txPool.set(k, m); }
  const shipGroups = new Map(), txDone = new Set();
  if (txPool.size) for (const ev of events) if (ev.type === 'shipment') { const k = ev.date + '|' + baseCode(ev.item.product); if (txPool.has(k)) { if (!shipGroups.has(k)) shipGroups.set(k, []); shipGroups.get(k).push(ev.item); } }
  const addLot = lot => { lots.push(lot); if (!byProduct.has(lot.product)) byProduct.set(lot.product, []); byProduct.get(lot.product).push(lot); };
  const prior = (l, d) => l.source === 'opening' || l.entryDate < d;
  const noExpFirst = (a, b) => (a.expiryDate === NO_EXPIRY ? 0 : 1) - (b.expiryDate === NO_EXPIRY ? 0 : 1); // 期初現貨沒有效期資料，當最舊的先出
  const tie = (a, b) => cmp(a.expiryDate, b.expiryDate) || cmp(a.manufactureDate, b.manufactureDate) || cmp(a.entryDate, b.entryDate) || a.seq - b.seq || cmp(a.id, b.id);
  for (const e of events) {
    const x = e.item;
    if (e.type === 'opening' || e.type === 'production') {
      addLot({ id: x.id, source: e.type, pool: x.pool === 'stock' ? 'stock' : 'semi', product: x.product, batch: x.batch, manufactureDate: x.manufactureDate, expiryDate: e.type === 'production' ? prodExp(x, st) : x.expiryDate, entryDate: e.date, quantity: Number(x.quantity), used: 0, shipped: 0, converted: 0, remaining: Number(x.quantity), seq: x.seq || 0, unit: getUnit(x.product, st) });
      continue;
    }
    if (e.type === 'adjust') {
      const isStock = x.pool === 'stock', lotBase = { source: 'adjust', product: x.product, entryDate: e.date, used: 0, shipped: 0, converted: 0, adjusted: 0, seq: x.seq || 0, unit: getUnit(x.product, st) };
      if (x.dir === 'add' && !isStock) { addLot({ ...lotBase, id: x.id, pool: 'semi', batch: '—', manufactureDate: x.manufactureDate, expiryDate: x.expiryDate, quantity: Number(x.quantity), remaining: Number(x.quantity) }); continue; }
      if (x.dir === 'add') {
        // 現貨增加：同一天、同一個品號開頭（例如 CK-01 與 CK-01|YB-86 換盒）在包裝區減掉的半成品，照順序變成這裡的現貨（記下來源）；
        //           換盒跟轉現貨一樣，當天算第一天：製作日期與有效日期用這筆紀錄的（入口網站帶入的＝當天、當天＋保存天數）。批號用當天
        // 入口網站帶入的現貨增加（換盒、總表手動、隔夜差異）：有效日期＝製作日期＋現貨可放天數；手動登錄的照紀錄填的
        const pool = packPool.get(baseCode(x.product) + '|' + e.date) || [], parts = [], xExp = String(x.id).startsWith('pt-') ? addDays(x.manufactureDate, stockDaysOf(st)) : x.expiryDate; let need = Number(x.quantity), k = 0;
        for (const p of pool) { if (need <= 1e-7) break; if (p.left <= 1e-7) continue; const q = clampQty(Math.min(need, p.left)); p.left = clampQty(p.left - q); need = clampQty(need - q); addLot({ ...lotBase, id: `${x.id}#${k++}`, pool: 'stock', batch: (x.batch && x.batch !== '—') ? x.batch : makeBatch(x.product, e.date) || '—', manufactureDate: x.manufactureDate, expiryDate: xExp, quantity: q, remaining: q, fromMfg: p.manufactureDate, fromExp: p.expiryDate }); parts.push({ manufactureDate: x.manufactureDate, expiryDate: xExp, quantity: q, from: p.product, fromMfg: p.manufactureDate }); }
        if (need > 1e-7) { addLot({ ...lotBase, id: `${x.id}#${k++}`, pool: 'stock', batch: (x.batch && x.batch !== '—') ? x.batch : makeBatch(x.product, e.date) || '—', manufactureDate: x.manufactureDate, expiryDate: xExp, quantity: need, remaining: need }); parts.push({ manufactureDate: x.manufactureDate, expiryDate: xExp, quantity: need }); }
        adjusts.set(x.id, { required: Number(x.quantity), done: Number(x.quantity), shortage: 0, parts });
        continue;
      }
      // 減少：指定那一批（製作日期／有效日期）就只扣那批，否則從效期最早的扣；已過期的也可以扣
      const from = (byProduct.get(x.product) || []).filter(l => l.pool === (isStock ? 'stock' : 'semi') && l.remaining > 1e-7 && l.entryDate <= e.date && (!x.fromMfg || l.manufactureDate === x.fromMfg) && (!x.fromExp || l.expiryDate === x.fromExp) && (!x.fromBatch || l.batch === x.fromBatch)).sort((a, b) => noExpFirst(a, b) || tie(a, b));
      const required = Number(x.quantity), parts = []; let need = required;
      for (const lot of from) { if (need <= 1e-7) break; const q = clampQty(Math.min(need, lot.remaining)); lot.remaining = clampQty(lot.remaining - q); lot.used = clampQty(lot.used + q); lot.adjusted = clampQty((lot.adjusted || 0) + q); need = clampQty(need - q); parts.push({ manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, quantity: q, batch: lot.batch }); }
      adjusts.set(x.id, { required, done: clampQty(required - need), shortage: clampQty(need), parts });
      if (!isStock && x.phase === 'pack' && !String(x.id).startsWith('pt-jt-')) { const key = baseCode(x.product) + '|' + e.date; if (!packPool.has(key)) packPool.set(key, []); packPool.get(key).push(...parts.map(p => ({ ...p, product: x.product, left: p.quantity }))); }
      continue;
    }
    const usable = l => l.remaining > 1e-7 && l.expiryDate >= e.date && l.manufactureDate <= e.date && l.entryDate <= e.date;
    if (e.type === 'convert') {
      // 半成品轉現貨：從效期最早的半成品轉（之前的先，當天入庫的最後）；轉現貨那天算第一天（製作日期＝轉現貨日，有效日期＝轉現貨日＋現貨可放天數）
      const from = (byProduct.get(x.product) || []).filter(l => l.pool === 'semi' && usable(l)).sort((a, b) => (prior(a, e.date) ? 0 : 1) - (prior(b, e.date) ? 0 : 1) || tie(a, b));
      const required = Number(x.quantity); let need = required;
      for (const lot of from) {
        if (need <= 1e-7) break;
        const q = clampQty(Math.min(need, lot.remaining));
        lot.remaining = clampQty(lot.remaining - q); lot.used = clampQty(lot.used + q); lot.converted = clampQty(lot.converted + q); need = clampQty(need - q);
        // 半成品轉現貨：轉現貨那天算第一天，批號、製作日期都用轉現貨當天，有效日期＝轉現貨日＋現貨可放天數（記下原本半成品的製作／有效日期）
        addLot({ id: x.id + '#' + lot.id, source: 'convert', pool: 'stock', product: lot.product, batch: makeBatch(lot.product, e.date) || '—', manufactureDate: e.date, expiryDate: addDays(e.date, stockDaysOf(st)), fromMfg: lot.manufactureDate, fromExp: lot.expiryDate, entryDate: e.date, quantity: q, used: 0, shipped: 0, converted: 0, remaining: q, seq: x.seq || 0, unit: lot.unit, fromLot: lot.id });
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
    const allocOf = (lot, amount, tx) => ({ lotId: lot.id, pool: lot.pool, source: lot.source, product: lot.product, batch: lot.batch, manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, entryDate: lot.entryDate, quantity: amount, ...(tx ? { tx: true } : {}) });
    const use = (lot, amount) => { lot.remaining = clampQty(lot.remaining - amount); lot.used = clampQty(lot.used + amount); lot.shipped = clampQty(lot.shipped + amount); };
    // 有匯入那天的交易明細：同一天、同一個品號第一段（例如 CA-25 和 CA-25|YC-09）的出貨一起扣，第一筆出貨時整組一次算完
    //   ① 明細的批號：誰的庫存有那個批號就由誰扣（組合品和單品各有各的批）；庫存裡沒有或不夠的記成「批號對不上」（txMiss），
    //      數量照樣改扣別批（2026-11-20 起：數量以總表為準，庫存才會跟總表一致；改扣的算客人的，標 tx、txSub，不分給門市）
    //   ② 明細沒寫批號、或明細比總表少的部分（txNone＝寄門市等）：剩下的批號拿最舊的（先到期先出），分給門市推定批號
    //   ③ 最後才改扣 ① 批號對不上的數量（門市先拿最舊的，2026-11-23 起）
    const gk = e.date + '|' + baseCode(x.product), pool = txPool.get(gk);
    if (pool) {
      if (txDone.has(gk)) continue;
      txDone.add(gk);
      const grp = (shipGroups.get(gk) || [x]).map(it => ({ x: it, remaining: Number(it.quantity), allocations: [], miss: {}, none: 0, elig: (byProduct.get(it.product) || []).filter(usable).sort((a, b) => rank(a) - rank(b) || noExpFirst(a, b) || tie(a, b)) }));
      const take = (g, lot, amount, tx) => { use(lot, amount); g.remaining = clampQty(g.remaining - amount); g.allocations.push(allocOf(lot, amount, tx)); };
      for (const b of Object.keys(pool).filter(k => k !== '—').sort((p, q) => cmp(batchDate(p) || p, batchDate(q) || q))) {
        let need = pool[b];
        const free = g => clampQty(g.remaining - Object.values(g.miss).reduce((t, v) => t + v, 0)); // 扣掉已經記成批號對不上（之後要改扣）的數量
        for (const g of grp) for (const lot of g.elig) { if (need <= 1e-7 || free(g) <= 1e-7) break; if (lot.remaining <= 1e-7 || lotBatchOn(lot, e.date) !== b) continue; const amount = clampQty(Math.min(need, free(g), lot.remaining)); take(g, lot, amount, true); need = clampQty(need - amount); }
        for (const g of grp) { if (need <= 1e-7) break; const left = free(g); if (left <= 1e-7) continue; const m = clampQty(Math.min(need, left)); g.miss[b] = clampQty((g.miss[b] || 0) + m); need = clampQty(need - m); }
      }
      for (const g of grp) {
        const missQ = clampQty(Object.values(g.miss).reduce((t, v) => t + v, 0)); g.none = Math.max(0, clampQty(g.remaining - missQ));
        // 扣掉明細（客人）的批號後，剩下的最舊的先給明細沒涵蓋的（寄門市等）；批號對不上的（客人的）最後才改扣
        let rest = g.none;
        for (const lot of g.elig) { if (rest <= 1e-7 || g.remaining <= 1e-7) break; if (lot.remaining <= 1e-7) continue; const q = clampQty(Math.min(rest, g.remaining, lot.remaining)); take(g, lot, q, false); rest = clampQty(rest - q); }
        for (const lot of g.elig) { if (g.remaining <= 1e-7) break; if (lot.remaining <= 1e-7) continue; take(g, lot, clampQty(Math.min(g.remaining, lot.remaining)), true); g.allocations[g.allocations.length - 1].txSub = true; }
      }
      for (const g of grp) { const required = Number(g.x.quantity), shortage = clampQty(g.remaining); shipments.set(g.x.id, { required, shipped: clampQty(required - shortage), shortage, allocations: g.allocations, tx: true, txMiss: g.miss, txNone: g.none }); }
      continue;
    }
    const required = Number(x.quantity); let remaining = required; const allocations = [];
    for (const lot of eligible) { if (remaining <= 1e-7) break; if (lot.remaining <= 1e-7) continue; const amount = clampQty(Math.min(remaining, lot.remaining)); use(lot, amount); allocations.push(allocOf(lot, amount, false)); remaining = clampQty(remaining - amount); }
    shipments.set(x.id, { required, shipped: clampQty(required - remaining), shortage: clampQty(remaining), allocations });
  }
  return { lots, shipments, converts, adjusts };
}
// 依「產品＋現貨／半成品＋批號＋製作日＋有效日」彙整；inQty＝入庫（期初＋生產＋轉入現貨），shipped＝出貨，converted＝轉成現貨
function groupLots(ledger) { const g = new Map(); for (const lot of ledger.lots) { const key = JSON.stringify([lot.product, lot.pool, lot.batch, lot.manufactureDate, lot.expiryDate]); if (!g.has(key)) g.set(key, { product: lot.product, pool: lot.pool, batch: lot.batch, manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, opening: 0, production: 0, convert: 0, adjust: 0, inQty: 0, used: 0, shipped: 0, converted: 0, adjusted: 0, remaining: 0, unit: lot.unit, fromMfgs: new Set() }); const r = g.get(key); if (lot.fromMfg) r.fromMfgs.add(lot.fromMfg); r[lot.source] = clampQty((r[lot.source] || 0) + lot.quantity); r.inQty = clampQty(r.inQty + lot.quantity); r.used = clampQty(r.used + lot.used); r.shipped = clampQty(r.shipped + lot.shipped); r.converted = clampQty(r.converted + lot.converted); r.adjusted = clampQty(r.adjusted + (lot.adjusted || 0)); r.remaining = clampQty(r.remaining + lot.remaining); } return [...g.values()].sort((a, b) => productOrder(a.product, b.product) || cmp(a.expiryDate, b.expiryDate) || cmp(a.pool, b.pool) || cmp(a.manufactureDate, b.manufactureDate)); }
// 全 App 共用的品號排序：品號開頭 CK（6吋）→ CC（4吋）→ CA（小小公爵）→ CS（方盒）→ CL（生巧），其他開頭（例如 KA）排在後面，同開頭內照品號
const SORT_PREFIXES = ['CK', 'CC', 'CA', 'CS', 'CL'];
function prefixRank(name) { const px = String(name).split(/[-| ]/)[0].toUpperCase(), i = SORT_PREFIXES.indexOf(px); return i >= 0 ? i : SORT_PREFIXES.length; }
// 排序跟總表一樣（2026-11-20 起）：入口網站同步時記下總表的列順序（settings 'portal' 的 order），照那個順序排；
// 總表沒有的組合品排在它的一般品後面，其他總表沒有的、或還沒同步過，照舊：CK → CC → CA → CS → CL → 其他，同開頭照品號
let ordMemo = { data: null, map: new Map() };
function portalRank(name) {
  if (ordMemo.data !== data) { const o = (FEStore.get('settings', 'portal') || {}).order; ordMemo = { data, map: new Map((Array.isArray(o) ? o : []).map((c, i) => [String(c).toUpperCase(), i])) }; }
  const m = ordMemo.map; if (!m.size) return -1;
  const code = productCodeOf(String(name)).toUpperCase(); if (m.has(code)) return m.get(code);
  const base = code.split('|')[0]; return m.has(base) ? m.get(base) + 0.5 : Infinity;
}
function productOrder(a, b) {
  const ra = portalRank(a), rb = portalRank(b);
  if (ra !== rb) return ra === Infinity ? 1 : rb === Infinity ? -1 : ra - rb;
  return prefixRank(a) - prefixRank(b) || cmp(String(a), String(b));
}
// 從書籤讀到的每天資料排出總表的列順序（新的日子為主，舊日子才有的品號插在它前一列的後面），再併進之前記下的
function portalOrderMerge(days, old) {
  const order = [], ins = seq => { let prev = -1; for (const c of seq) { const i = order.indexOf(c); if (i >= 0) { prev = i; continue; } order.splice(prev + 1, 0, c); prev++; } };
  for (const d of Object.keys(days).sort().reverse()) ins(days[d].map(r => String(r.code).toUpperCase()));
  if (Array.isArray(old)) ins(old.map(c => String(c).toUpperCase()));
  return order.slice(0, 800);
}
const byProductName = list => [...list].sort((a, b) => productOrder(a.name, b.name));
const poolLabel = (pool, date = TODAY()) => isStockModeDay(date) || pool === 'stock' ? '現貨' : '半成品';
function productSummary(ledger, asOf = TODAY()) {
  const by = new Map(); for (const l of ledger.lots) { if (!by.has(l.product)) by.set(l.product, []); by.get(l.product).push(l); }
  return data.products.map(p => { const lots = by.get(p.name) || []; const usable = clampQty(lots.filter(x => x.expiryDate >= asOf).reduce((s, x) => s + x.remaining, 0)); const stock = clampQty(lots.filter(x => x.pool === 'stock' && x.expiryDate >= asOf).reduce((s, x) => s + x.remaining, 0)), semi = clampQty(usable - stock); const expired = clampQty(lots.filter(x => x.expiryDate < asOf).reduce((s, x) => s + x.remaining, 0)); const warning = clampQty(lots.filter(x => x.expiryDate >= asOf && x.expiryDate !== NO_EXPIRY && dayDiff(asOf, x.expiryDate) <= (x.pool === 'stock' ? data.settings.stockWarn : data.settings.semiWarn)).reduce((s, x) => s + x.remaining, 0)); const oldest = lots.filter(x => x.remaining > 0 && x.expiryDate >= asOf && x.expiryDate !== NO_EXPIRY).sort((a, b) => cmp(a.expiryDate, b.expiryDate))[0]?.expiryDate || ''; const produced = clampQty(lots.filter(x => x.source === 'production').reduce((s, x) => s + x.quantity, 0)); const opened = clampQty(lots.filter(x => x.source === 'opening').reduce((s, x) => s + x.quantity, 0)); const used = clampQty(lots.reduce((s, x) => s + x.shipped, 0)); return { ...p, usable, stock, semi, expired, warning, oldest, produced, opened, used }; }).sort((a, b) => productOrder(a.name, b.name));
}
// pool 'stock'：現貨剩「現貨提醒天數」以內是紅色；半成品照原本（7 天內紅、預警天數內黃）
function expiryStatus(expiry, qty, date = TODAY(), pool = '') { if (qty <= 0) return { label: '已用完', cls: 'other' }; if (expiry === NO_EXPIRY) return { label: '現貨', cls: 'future' }; const days = dayDiff(date, expiry); if (days < 0) return { label: '已過期', cls: 'expired' }; if (pool === 'stock') return days <= data.settings.stockWarn ? { label: days === 0 ? '今日到期' : `剩 ${days} 天`, cls: 'critical' } : { label: `剩 ${days} 天`, cls: 'ok' }; if (days <= 7) return { label: days === 0 ? '今日到期' : `剩 ${days} 天`, cls: 'critical' }; if (days <= data.settings.semiWarn) return { label: `剩 ${days} 天（半成品警示）`, cls: 'due' }; return { label: '正常', cls: 'ok' }; }

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
VIEWS.adjust = ['半成品／現貨增減', '總公司半成品與現貨的增加、減少（入口網站帶入或手動登錄），庫存、轉現貨與出貨扣批跟著重算。'];
VIEWS.audit = ['庫存盤點', '照批次庫存與有效日期盤點，對齊帳上與實際的批號、效期。'];
VIEWS.batchrule = ['批號產生', '依批號規則，每天生產的自動帶入批號與有效日期。'];
for (const x of SHOPS) VIEWS['shop-' + x.id] = [`${x.name}門市庫存`, `${x.name}門市的入貨批號、銷售、報廢與到期日（入貨日起算），先到期先出。`];
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
  renderDashboard(today, current, groups, prod); renderOpening(); renderProduction(); renderShipments(full); renderBatches(groups, today); renderAllocations(full); renderProducts(prod); renderSettings(); renderPortal(); renderShops(today); try { renderDailyCheck(today, full); } catch (e) { console.error('每日檢查', e); } renderBatchRule(today); renderAdjust(full); renderAudit();
  $('productNames').innerHTML = byProductName(data.products).map(p => `<option value="${esc(p.name)}"></option>`).join('');
  const empty = !data.opening.length && !data.movements.length;
  $('welcome').hidden = loading() || !empty || !(isAdmin() || can('produce'));
  $('recordInfo').textContent = loading() ? '讀取中…' : `共 ${data.opening.length + data.movements.length} 筆紀錄｜${data.products.length} 項產品`;
  renderBanner();
}
function renderDashboard(today, current, groups, prod) {
  const todayProductions = data.movements.filter(x => x.type === 'production' && x.date === today).map(x => ({ quantity: x.quantity, unit: getUnit(x.product) }));
  const todayShip = data.movements.filter(x => x.type === 'shipment' && x.date === today).map(x => ({ quantity: current.shipments.get(x.id)?.shipped || 0, unit: getUnit(x.product) }));
  const usableProducts = prod.filter(x => x.usable > 0).length;
  const live = groups.filter(x => x.remaining > 0);
  // 效期預警：現貨剩「現貨提醒天數」以內、半成品 15 天內（期初現貨沒有效期不算）
  const isStk = x => x.pool === 'stock' || (x.batch && x.batch !== '—');
  const dueStock = live.filter(x => isStk(x) && x.expiryDate !== NO_EXPIRY && dayDiff(today, x.expiryDate) >= 0 && dayDiff(today, x.expiryDate) <= data.settings.stockWarn).length;
  const dueSemi = live.filter(x => !isStk(x) && dayDiff(today, x.expiryDate) >= 0 && dayDiff(today, x.expiryDate) <= semiWarnDays()).length, due = dueStock + dueSemi;
  const expired = live.filter(x => x.expiryDate < today).length;
  dashDue = { stock: dueStock, semi: dueSemi, expired };
  $('summaryCards').innerHTML = `<article class="kpi"><div class="kpi-label">今日生產量</div><div class="kpi-value">${unitsLabel(todayProductions)}</div><div class="kpi-desc">已登錄 ${todayProductions.length} 筆生產</div></article><article class="kpi"><div class="kpi-label">今日實際出貨量</div><div class="kpi-value">${unitsLabel(todayShip)}</div><div class="kpi-desc">已登錄 ${todayShip.length} 筆出貨需求</div></article><article class="kpi"><div class="kpi-label">目前有庫存產品</div><div class="kpi-value">${usableProducts}<span class="kpi-unit">種</span></div><div class="kpi-desc">所有庫存以產品個別單位計算</div></article><article class="kpi ${expired ? 'bad' : due ? 'warn' : ''}"><div class="kpi-label">效期預警批次</div><div class="kpi-value">${due}<span class="kpi-unit">批</span></div><div class="kpi-desc">現貨到期 ${dueStock}｜半成品到期 ${dueSemi}｜已過期 ${expired} 批</div></article>`;
  const shortCount = [...current.shipments.values()].filter(x => x.shortage > 0).length;
  const alert = $('shortageAlert'); alert.hidden = shortCount === 0; if (shortCount) alert.innerHTML = `目前有 <strong>${shortCount}</strong> 筆出貨未能足額分配。出貨缺口不列入實際出貨、不產生負庫存，請前往「每日出貨登錄」檢視。`;
  const chartDays = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const trend = chartDays.map(d => ({ date: d, prod: data.movements.filter(m => m.type === 'production' && m.date === d).reduce((s, m) => s + m.quantity, 0), ship: data.movements.filter(m => m.type === 'shipment' && m.date === d).reduce((s, m) => s + (current.shipments.get(m.id)?.shipped || 0), 0) }));
  const max = Math.max(0, ...trend.flatMap(x => [x.prod, x.ship])); const h = v => v > 0 && max > 0 ? Math.max(2, Math.round(v / max * 100)) : 0;
  $('trendChart').innerHTML = trend.map(x => `<div class="chart-day${x.date === today ? ' today' : ''}" title="${x.date}：生產 ${fmt(x.prod)}，出貨 ${fmt(x.ship)}"><div class="chart-bars"><div class="bar produced" style="height:${h(x.prod)}%"></div><div class="bar shipped" style="height:${h(x.ship)}%"></div></div><span>${x.date === today ? '今天' : shortDate(x.date)}</span></div>`).join('');
  $('chartScale').textContent = max > 0 ? `最高柱 = ${fmt(max)}（混合單位時僅供趨勢參考）` : '近 7 天尚無生產或出貨';
  // 庫存效期預警：分「現貨到期」（剩現貨提醒天數以內）與「半成品到期」（15 天內），已過期的也列；每個品號一列
  const warnRows = [...byProductExpiry(groups).values()].map(p => ({ ...p, sx: p.exps.filter(e => e.kind === 'stock' && (isStockSoon(e, today) || isGone(e, today))), mx: p.exps.filter(e => e.kind === 'semi' && (isSemiSoon(e, today) || isGone(e, today))) })).filter(p => p.sx.length || p.mx.length).sort((a, b) => productOrder(a.product, b.product));
  const chips = (list, u) => list.length ? `<div class="exp-chips">${list.map(e => expChip(e, u, today)).join('')}</div>` : '<span class="who">—</span>';
  $('dashExpiry').innerHTML = table(['產品', `現貨到期（剩 ${data.settings.stockWarn} 天內）與已過期`, `半成品到期（${semiWarnDays()} 天內）與已過期`, '剩餘庫存#'], warnRows.map(p => `<tr>${td(`<strong>${esc(p.product)}</strong>`)}<td class="exp-cell">${chips(p.sx, p.unit)}</td><td class="exp-cell">${chips(p.mx, p.unit)}</td><td class="num">${fmt(p.total)} ${esc(p.unit)}</td></tr>`), '目前沒有快到期或已過期的現貨、半成品');
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
const lotLabel = r => r.batch && r.batch !== '—' ? r.batch : `製 ${md(r.manufactureDate)}`;
const openingChip = r => `<span class="pill ${r.pool === 'stock' ? 'future' : 'other'} exp-chip" title="${esc(`入帳 ${r.entryDate}｜製作 ${r.manufactureDate}｜效期 ${expShow(r.expiryDate)}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`)}"><span class="mono">${esc(lotLabel(r))}</span> ${r.expiryDate === NO_EXPIRY ? '' : '效期 ' + esc(md(r.expiryDate)) + ' '}${esc(fmt(r.quantity))} ${unitOf(r)}</span>`;
const prodKind = r => r.pool === 'stock' ? '生產轉現貨' : /當天生產/.test(r.note) ? '當天生產' : /半成品入庫/.test(r.note) ? '半成品入庫' : '';
const prodChip = r => `<span class="pill ${r.pool === 'stock' ? 'future' : 'ok'} exp-chip" title="${esc(`${r.date}${r.batch !== '—' ? '｜批號 ' + r.batch : '｜半成品（轉現貨後才有批號）'}｜製作 ${r.manufactureDate}｜效期 ${expShow(prodExp(r))}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`)}"><span class="mono">${esc(md(r.date))}</span> ${esc(fmt(r.quantity))} ${unitOf(r)}${prodKind(r) === '生產轉現貨' ? '（轉現貨）' : ''}</span>`;
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
    const day = allocDay(), rows = allocationRows(ledger).filter(x => x.product === product && x.date === day);
    title = `「${product}」${day} 的出貨扣批明細（${rows.length} 筆）`;
    html = table(['出貨日', '出貨單號／客戶', '扣除批號', '製作日期', '有效日期', '數量#', '類別'], rows.map(x => `<tr>${tdm(x.date)}${td(esc(x.orderNo || '—'))}${x.kind === 'shortage' ? td(badge('未分配', 'bad')) : td(`<span class="mono">${esc(x.batch)}</span> ${badge(x.pool, x.pool === '現貨' ? 'future' : 'other')}`)}${tdm(x.manufactureDate)}${tdm(expShow(x.expiryDate))}<td class="num">${fmt(x.quantity)} ${esc(x.unit)}</td>${td(x.kind === 'shortage' ? badge('出貨缺口', 'bad') : badge('已分配', 'ok'))}</tr>`));
  }
  await modal({ title, html: `<div class="table-scroll">${html}</div>`, ok: '關閉', wide: true, noCancel: true });
}
const closeModal = () => { if (!$('modal').hidden) $('modalCancel').click(); };
// 每個產品一列：同一個有效日期合在一起，不同有效日期分開列（顏色＝效期狀態）；逐批號的明細用「匯出 CSV」
// 排列照 productOrder（品號開頭 CK、CC、CA、CS、CL）
// 半成品警示天數（現階段 15 天，「資料與設定」可改）
const semiWarnDays = () => data.settings.semiWarn || 15;
// 現貨到期：現貨剩「現貨提醒天數」以內（不含已過期）；半成品到期：半成品 15 天內（不含已過期）；已過期：兩種都算
const isGone = (e, today) => e.expiry !== NO_EXPIRY && dayDiff(today, e.expiry) < 0;
const isStockSoon = (e, today) => { if (e.kind !== 'stock' || e.expiry === NO_EXPIRY) return false; const d = dayDiff(today, e.expiry); return d >= 0 && d <= data.settings.stockWarn; };
const isSemiSoon = (e, today) => { if (e.kind !== 'semi' || e.expiry === NO_EXPIRY) return false; const d = dayDiff(today, e.expiry); return d >= 0 && d <= semiWarnDays(); };
let batchMode = 'all';
// 彙整成標籤：groups（groupLots 結果）→ Map(產品 → { product, unit, stock, semi, total, exps: [標籤] })，只算有剩的
//   現貨：每個「批號＋有效日期」一個標籤（kind 'stock'）；半成品：每個有效日期一個標籤（kind 'semi'，沒有批號，記製作日期）
function byProductExpiry(groups) {
  const byP = new Map();
  for (const g of groups) {
    if (!byP.has(g.product)) byP.set(g.product, { product: g.product, unit: g.unit, stock: 0, semi: 0, total: 0, exps: new Map() });
    if (!(g.remaining > 0)) continue;
    const p = byP.get(g.product), isStock = g.pool === 'stock' || (g.batch && g.batch !== '—'), key = isStock ? `S|${g.batch}|${g.expiryDate}` : `M|${g.expiryDate}`;
    if (!p.exps.has(key)) p.exps.set(key, { kind: isStock ? 'stock' : 'semi', expiry: g.expiryDate, batch: isStock ? g.batch : '', mfgs: new Set(), stock: 0, semi: 0, total: 0 });
    const e = p.exps.get(key), k = g.pool === 'stock' ? 'stock' : 'semi';
    e[k] = clampQty(e[k] + g.remaining); e.total = clampQty(e.total + g.remaining); e.mfgs.add(g.manufactureDate);
    p[k] = clampQty(p[k] + g.remaining); p.total = clampQty(p.total + g.remaining);
  }
  // 排序：期初現貨（沒有效期）在最前面，其他照有效日期由早到晚；同一天現貨在前
  for (const p of byP.values()) p.exps = [...p.exps.values()].sort((a, b) => (a.expiry === NO_EXPIRY ? 0 : 1) - (b.expiry === NO_EXPIRY ? 0 : 1) || cmp(a.expiry, b.expiry) || (a.kind === 'stock' ? 0 : 1) - (b.kind === 'stock' ? 0 : 1) || cmp(a.batch, b.batch));
  return byP;
}
// 標籤（顏色＝效期狀態）：現貨寫批號＋有效日期；半成品寫製作日期＋有效日期
function expChip(e, unit, today) {
  const s = expiryStatus(e.expiry, e.total, today, e.kind === 'stock' ? 'stock' : ''), mfg = [...e.mfgs].sort(), q = `${esc(fmt(e.total))} ${esc(unit)}`;
  if (e.kind === 'stock') {
    if (e.expiry === NO_EXPIRY) return `<span class="pill ${s.cls} exp-chip" title="期初現貨（入口網站帶入，沒有批號與效期資料）"><span class="mono">期初現貨</span> ${q}</span>`;
    return `<span class="pill ${s.cls} exp-chip" title="${esc(`現貨｜批號 ${e.batch}｜製作（轉現貨）${mfg.join('、')}｜有效日期 ${e.expiry}｜${s.label}`)}"><span class="mono">${esc(e.batch)}</span> 現貨・效期 <span class="mono">${esc(e.expiry)}</span>・${q}</span>`;
  }
  return `<span class="pill ${s.cls} exp-chip" title="${esc(`半成品（轉現貨後才有批號）｜製作 ${mfg.join('、')}｜有效日期 ${e.expiry}｜${s.label}`)}"><span class="mono">製 ${esc(md(mfg[0]))}</span> 半成品・效期 <span class="mono">${esc(e.expiry)}</span>・${q}</span>`;
}
function renderBatches(groups, today) {
  const byP = byProductExpiry(groups), sw = data.settings.stockWarn;
  // 篩選：全部｜現貨到期（剩現貨提醒天數以內）｜半成品到期（15 天內）｜已過期；篩選時每列只顯示符合的有效日期
  const inRange = (e, m) => m === 'stockSoon' ? isStockSoon(e, today) : m === 'semiSoon' ? isSemiSoon(e, today) : isGone(e, today);
  const inMode = e => batchMode === 'all' || inRange(e, batchMode);
  const MODES = { stockSoon: [`現貨到期（剩 ${sw} 天內）`, 'batchStockN'], semiSoon: [`半成品到期（${semiWarnDays()} 天內）`, 'batchSemiN'], expired: ['已過期', 'batchExpN'] };
  // 按鈕上的紅色數字：幾項產品（品號）有現貨到期／半成品到期／已過期的庫存
  for (const [m, [lab, id]] of Object.entries(MODES)) {
    const n = [...byP.values()].filter(p => p.exps.some(e => inRange(e, m))).length, el = $(id);
    el.hidden = !n; el.textContent = n; el.parentElement.title = n ? `${n} 項產品${lab}` : `沒有${lab}的產品`;
  }
  const list = [...byP.values()].map(p => { const all = p.exps, exps = all.filter(inMode); return { ...p, exps, match: clampQty(exps.reduce((s, e) => s + e.total, 0)), expText: all.map(e => `${e.expiry} ${e.batch}`).join(' ') }; });
  const base = batchMode !== 'all' ? list.filter(p => p.exps.length) : $('batchLive').checked ? list.filter(p => p.total > 0) : list;
  const rows = searchable(base, $('batchFilter').value, ['product', 'expText']).sort((a, b) => (a.total > 0 ? 0 : 1) - (b.total > 0 ? 0 : 1) || productOrder(a.product, b.product));
  const nExp = list.reduce((s, p) => s + p.exps.length, 0), modeName = (MODES[batchMode] || [''])[0];
  document.querySelectorAll('#batchSeg [data-bmode]').forEach(b => b.classList.toggle('on', b.dataset.bmode === batchMode));
  $('batchCount').textContent = batchMode === 'all' ? `目前有庫存的產品 ${list.filter(p => p.total > 0).length} 項、共 ${nExp} 個批次；現貨有效日期＝轉現貨日＋${stockDaysOf()} 天，半成品＝製作日期＋保存天數；依品號 ${SORT_PREFIXES.join('、')} 排列` : `${modeName}：${base.length} 項產品、${nExp} 個批次，共 ${fmt(clampQty(base.reduce((s, p) => s + p.match, 0)))} 個`;
  const cell = (list, u) => `<td class="exp-cell">${list.length ? `<div class="exp-chips">${list.map(e => expChip(e, u, today)).join('')}</div>` : '<span class="who">—</span>'}</td>`;
  $('batchTable').innerHTML = table(['產品', `現貨（批號・有效日期；可放 ${stockDaysOf()} 天）`, '半成品（製作日期・有效日期）', '現貨#', '半成品#', '剩餘庫存#'], rows.map(p => `<tr>${td(`<strong>${esc(p.product)}</strong>`)}${cell(p.exps.filter(e => e.kind === 'stock'), p.unit)}${cell(p.exps.filter(e => e.kind === 'semi'), p.unit)}<td class="num">${p.stock ? fmt(p.stock) : '—'}</td><td class="num">${p.semi ? fmt(p.semi) : '—'}</td><td class="num">${fmt(p.total)} ${esc(p.unit)}</td></tr>`), batchMode === 'all' ? '尚無批次庫存紀錄' : `目前沒有${modeName}的庫存`);
}
function allocationRows(ledger) { const rows = []; for (const sh of [...data.movements.filter(x => x.type === 'shipment')].sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product) || b.seq - a.seq)) { const r = ledger.shipments.get(sh.id); if (!r) continue; for (const a of r.allocations) rows.push({ date: sh.date, orderNo: sh.orderNo || '', product: sh.product, batch: a.batch, pool: poolLabel(a.pool, sh.date), manufactureDate: a.manufactureDate, expiryDate: a.expiryDate, quantity: a.quantity, unit: getUnit(sh.product), kind: 'allocated' }); if (r.shortage) rows.push({ date: sh.date, orderNo: sh.orderNo || '', product: sh.product, batch: '未分配', manufactureDate: '', expiryDate: '', quantity: r.shortage, unit: getUnit(sh.product), kind: 'shortage' }); } return rows; }
// 出貨扣批明細：一次看一天（預設最近一天有出貨的日子），每個品號一列，列出那天扣了哪些批號／製作日期（現貨／半成品）
let allocDate = '';
const shipDates = () => [...new Set(data.movements.filter(x => x.type === 'shipment').map(x => x.date))].sort();
function allocDay() { if (isDate(allocDate)) return allocDate; const t = TODAY(), ds = shipDates().filter(d => d <= t); return ds.length ? ds[ds.length - 1] : t; }
function renderAllocations(ledger) {
  renderTxRecon(ledger, allocDay());
  const day = allocDay(), dates = shipDates(), prev = dates.filter(d => d < day).pop(), next = dates.find(d => d > day);
  const di = $('allocationDate'); if (document.activeElement !== di) di.value = day;
  for (const [id, d] of [['allocPrev', prev], ['allocNext', next]]) { const b = $(id); b.disabled = !d; b.dataset.date = d || ''; b.title = d ? `跳到 ${d}` : '沒有更多有出貨的日子'; }
  const byP = new Map();
  for (const x of allocationRows(ledger)) {
    if (x.date !== day) continue;
    if (!byP.has(x.product)) byP.set(x.product, { product: x.product, parts: new Map(), short: 0, orders: new Set(), text: '' });
    const g = byP.get(x.product); if (x.orderNo) g.orders.add(x.orderNo);
    if (x.kind === 'shortage') { g.short = clampQty(g.short + x.quantity); continue; }
    const lab = lotLabel(x), k = lab + '|' + x.pool, a = g.parts.get(k) || { lab, pool: x.pool, q: 0, exp: x.expiryDate, mfg: x.manufactureDate };
    a.q = clampQty(a.q + x.quantity); g.parts.set(k, a); g.text += ` ${lab} ${x.pool} ${x.manufactureDate} ${x.orderNo}`;
  }
  const reqOf = new Map(); for (const r of data.movements) if (r.type === 'shipment' && r.date === day) reqOf.set(r.product, clampQty((reqOf.get(r.product) || 0) + r.quantity));
  const rows = searchable([...byP.values()], $('allocationFilter').value, ['product', 'text']).sort((a, b) => productOrder(a.product, b.product));
  const tot = (list, f) => clampQty(list.reduce((s, g) => s + f(g), 0)), qOf = g => tot([...g.parts.values()], a => a.q);
  const stockQ = tot(rows, g => tot([...g.parts.values()].filter(a => a.pool === '現貨'), a => a.q)), allQ = tot(rows, qOf), shortQ = tot(rows, g => g.short);
  $('allocationCount').textContent = rows.length ? `${day}：${rows.length} 項產品，扣貨 ${fmt(allQ)} 個（現貨 ${fmt(stockQ)}、半成品 ${fmt(clampQty(allQ - stockQ))}）${shortQ ? `，缺口 ${fmt(shortQ)} 個` : ''}；用上方的日期或「前一天／後一天」切換` : `${day} 沒有出貨扣批紀錄`;
  const chip = a => `<span class="pill ${a.pool === '現貨' ? 'future' : 'other'} exp-chip" title="${esc(`${a.pool}｜${a.lab}｜製作 ${a.mfg}｜效期 ${expShow(a.exp)}`)}"><span class="mono">${esc(a.lab)}</span> ${esc(a.pool)} ×${esc(fmt(a.q))}</span>`;
  $('allocationTable').innerHTML = table(['產品', `${md(day)} 扣的批號／製作日期（先到期先扣）`, '出貨需求#', '扣貨#', '缺口#', '明細'], rows.map(g => `<tr>${td(`<strong>${esc(g.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${[...g.parts.values()].map(chip).join('')}${g.short ? `<span class="pill bad exp-chip">缺 ${esc(fmt(g.short))}</span>` : ''}</div></td><td class="num">${fmt(reqOf.get(g.product) || 0)}</td><td class="num">${fmt(qOf(g))} ${esc(getUnit(g.product))}</td><td class="num">${g.short ? badge(fmt(g.short), 'bad') : '—'}</td>${detailBtn('allocation', g.product)}</tr>`), `${day} 沒有出貨扣批紀錄`);
}
// 交易明細核對（總公司）：這一天（排單日）總表的實際揀貨 vs 交易明細的數量與批號
const allocBatch = (a, day) => a.expiryDate === NO_EXPIRY ? '期初現貨' : (a.batch && a.batch !== '—' ? a.batch : makeBatch(a.product, day) || '—');
const txBatchLab = b => b === '—' ? '沒寫批號' : batchMd(b) ? `${b.slice(4, 6)}（${batchMd(b)}）` : b;
// 交易明細核對的資料（每個品號第一段一列）：總表需求 req、交易明細 det（客人）、寄門市 shop（門市入貨，排單日＝這天）、App 扣的批號 app、批號對不上 miss
// adj＝調整明細表上總公司的出庫、領取（例如 KA-20 出庫 3 個）；gap＝總表 −（明細＋寄門市＋調整單）：整天的出庫跟總表核對（試吃、還沒開單、打錯…會留在這裡）
// full＝這天的明細到齊了（這天和隔天開單的交易明細都匯入了：很多訂單揀貨隔天才開單）；due＝還缺哪幾天開單的明細
function txReconData(ledger, day) {
  const recs = data.txbs.filter(r => r.date === day && !r.unmatched), unm = data.txbs.filter(r => r.unmatched && r.tx === day);
  const by = new Map(), g = bc => { if (!by.has(bc)) by.set(bc, { code: bc, req: 0, det: {}, app: {}, miss: 0, none: 0, shop: 0, adj: 0 }); return by.get(bc); };
  const mk = FEStore.get('settings', 'sys-' + day); for (const [c, q] of Object.entries((mk && mk.hqOut) || {})) g(c).adj = clampQty(Number(q) || 0);
  for (const r of recs) { const x = g(r.code); for (const [b, q] of Object.entries(r.batches)) x.det[b] = clampQty((x.det[b] || 0) + q); }
  for (const sh of data.movements) {
    if (sh.type !== 'shipment' || sh.date !== day) continue;
    const x = g(baseCode(sh.product)), L = ledger.shipments.get(sh.id); x.req = clampQty(x.req + sh.quantity); if (!L) continue;
    for (const a of L.allocations) { const b = allocBatch(a, day); x.app[b] = clampQty((x.app[b] || 0) + a.quantity); }
    if (L.tx) { x.miss = clampQty(x.miss + Object.values(L.txMiss || {}).reduce((t, v) => t + v, 0)); x.none = clampQty(x.none + (L.txNone || 0)); }
  }
  for (const r of data.shops) if (r.type === 'in' && !r.aud && shopFrom(r) === day) { const x = g(baseCode(r.product)); x.shop = clampQty(x.shop + r.quantity); }
  const rows = [...by.values()].map(x => { const detQ = sumQ(Object.values(x.det), v => v); return { ...x, detQ, gap: clampQty(x.req - detQ - x.shop - x.adj) }; }).sort((a, b) => productOrder(a.code, b.code));
  const txDays = new Set(data.txbs.map(t => t.tx)), due = [day, addDays(day, 1)].filter(t => !txDays.has(t));
  return { recs, unm, rows, full: !due.length, due };
}
function renderTxRecon(ledger, day) {
  const box = $('txRecon'), info = $('txInfo'); if (!box) return;
  const R = txReconData(ledger, day), { recs, unm } = R;
  const src = new Map(); for (const r of recs) src.set(r.tx, clampQty((src.get(r.tx) || 0) + sumQ(Object.values(r.batches), v => v)));
  const unmQ = sumQ(unm, r => sumQ(Object.values(r.batches), v => v));
  if (!recs.length) {
    info.textContent = `跟上面同一天（${day}）。這天還沒有交易明細，批號照先到期先出`;
    box.innerHTML = `<div class="empty">${unm.length ? `${md(day)} 開單的交易明細有 ${fmt(unmQ)} 個對不到排單表（見下方）。` : ''}按「匯入系統報表」選前一天的交易明細表（和調整明細表）：總公司（倉庫 1）的數量照總表、批號照明細扣，對不上的會列在這裡。</div>${unm.length ? txUnmatchedHtml(unm) : ''}`;
    return;
  }
  const chips = (m, cls) => Object.entries(m).sort((a, b) => cmp(a[0], b[0])).map(([b, q]) => `<span class="pill ${cls} exp-chip" title="${esc(b)}"><span class="mono">${esc(txBatchLab(b))}</span> ×${esc(fmt(q))}</span>`).join('');
  const issue = x => x.miss || (R.full && x.gap);
  const rows = R.rows.map(x => {
    const ok = !x.miss && !x.gap;
    const st = ok ? badge('一致', 'ok') : [x.miss ? `<span title="交易明細上的批號，App 庫存裡沒有或不夠；數量已照先到期先出改扣別批（庫存跟總表一致），常見原因是前一天開單的明細還沒匯入">${badge(`批號對不上 ${fmt(x.miss)}`, 'bad')}</span>` : '', x.gap ? `<span title="${esc(x.gap > 0 ? '總表的出貨比交易明細＋寄門市＋調整單多：試吃、還沒開單（等隔天的明細）、調整明細表還沒匯、總表打錯…' : '交易明細＋寄門市＋調整單比總表的出貨多：總表少記、門市入貨日期不對…')}">${badge(x.gap > 0 ? `總表多 ${fmt(x.gap)}` : `明細＋門市多 ${fmt(-x.gap)}`, R.full ? 'due' : 'other')}</span>` : ''].filter(Boolean).join(' ');
    return `<tr class="${issue(x) ? 'row-on' : ''}">${td(`<strong class="mono">${esc(x.code)}</strong>`)}<td class="num">${fmt(x.req)}</td><td class="num">${fmt(x.detQ)}</td><td class="num">${fmt(x.shop)}</td><td class="num">${x.adj ? fmt(x.adj) : '—'}</td><td class="num">${x.gap ? fmt(x.gap) : '—'}</td><td class="exp-cell"><div class="exp-chips">${chips(x.det, 'other') || '—'}</div></td><td class="exp-cell"><div class="exp-chips">${chips(x.app, 'future') || '—'}</div></td>${td(st)}</tr>`;
  });
  const tot = f => clampQty(R.rows.reduce((t, x) => t + f(x), 0)), bad = R.rows.filter(issue).length;
  info.textContent = `跟上面同一天（${day}）：總表 ${fmt(tot(x => x.req))} 個＝交易明細 ${fmt(tot(x => x.detQ))} 個（${[...src.entries()].sort().map(([t, q]) => `${md(t)} 開單 ${fmt(q)}`).join('、')}）＋寄門市 ${fmt(tot(x => x.shop))} 個${tot(x => x.adj) ? `＋調整單（總公司出庫、領取）${fmt(tot(x => x.adj))} 個` : ''}${tot(x => x.gap) ? `，差 ${fmt(tot(x => x.gap))} 個` : ''}；${R.full ? '明細已到齊' : `還缺 ${R.due.map(md).join('、')} 開單的明細（很多訂單揀貨隔天才開單），差的數字先參考就好`}${bad ? `；${bad} 項要看` : '；沒有要處理的'}`;
  box.innerHTML = table(['品號', '總表需求#', '明細#', '寄門市#', '調整單#', '差#', '明細的批號', 'App 扣的批號（明細優先，剩下的先到期先出）', '核對'], rows, '') + (unm.length ? txUnmatchedHtml(unm) : '');
}
function txUnmatchedHtml(unm) {
  const q = sumQ(unm, r => sumQ(Object.values(r.batches), v => v)), ords = [...new Set(unm.flatMap(r => r.orders || []))];
  return `<p class="modal-note" style="margin:10px 14px"><button type="button" class="btn small need-ship" data-action="tx-rematch" style="float:right;margin-left:8px">重新對排單日</button>這天開單、但訂單不在揀貨總表排單（開單日前 ${TX_BEFORE} 天到後 ${TX_AFTER} 天）的明細 ${fmt(q)} 個，先不拿來扣（之後匯入系統報表時會自動再對一次，也可以按右邊的按鈕）：${esc(unm.map(r => `${r.code} ×${fmt(sumQ(Object.values(r.batches), v => v))}`).join('、'))}${ords.length ? `（訂單 ${esc(ords.slice(0, 6).join('、'))}${ords.length > 6 ? '…' : ''}）` : ''}</p>`;
}
const WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
/* ---------- 每日檢查（營運總覽最上面，2026-11-20 起） ----------
   最近 7 天（昨天往前）每天一列，看每一步有沒有做、哪裡要處理：
   入口網站同步（那天有總表帶入的紀錄）、交易明細（那天開單的有沒有匯）、調整明細（那天的有沒有匯；匯入時存在 settings「sys-日期」）、
   總公司核對（那天排單：批號對不上、總表 vs 明細＋寄門市；明細要那天和隔天開單的都匯入才算到齊）、
   生產 vs 總表（調整明細表的生產 vs 總表的半成品轉現貨＋生產轉現貨＋現貨增加，照現在的資料即時比）、
   門市（入貨、銷售、缺口、待確認、入庫單 vs 入貨）。下面一行是今天的到期提醒。按格子跳到那一頁那一天。 */
let dashDue = { stock: 0, semi: 0, expired: 0 };
const shopAlertN = {};
const sysMark = d => FEStore.get('settings', 'sys-' + d);
// 開始用系統報表的那天：第一次匯入的交易明細（開單日）或調整明細的日期；還沒匯過＝''
const sysRepStart = () => [...data.txbs.map(t => t.tx), ...FEStore.list('settings').filter(r => /^sys-\d{4}-\d{2}-\d{2}$/.test(r.id)).map(r => r.date)].sort()[0] || '';
const shopBaseTot = (sid, d) => { const m = {}; for (const r of data.shops) if (r.shop === sid && r.type === 'in' && !r.aud && r.date === d) { const c = baseCode(r.product); m[c] = clampQty((m[c] || 0) + r.quantity); } return m; };
const sameTot = (a, b) => { const ks = new Set([...Object.keys(a), ...Object.keys(b)]); return [...ks].every(k => Math.abs((a[k] || 0) - (b[k] || 0)) < 1e-7); };
function renderDailyCheck(today, ledger) {
  const box = $('dailyCheck'); if (!box) return;
  const from = syncFromDate(), days = [1, 2, 3, 4, 5, 6, 7].map(k => addDays(today, -k)).filter(d => !from || d >= from);
  const portal = new Set(data.movements.filter(r => String(r.id).startsWith('pt-')).map(r => r.date)), txDays = new Set(data.txbs.map(t => t.tx));
  const Ls = new Map(SHOPS.map(s => [s.id, shopLedger(s.id)])), plan = shopBatchPlan();
  const B = (t, cls, title = '') => `<span class="pill ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
  const link = (view, d, html) => `<button type="button" class="chk-go" data-action="chk-go" data-view="${esc(view)}" data-date="${esc(d)}">${html}</button>`;
  // 開始用系統報表的那天（第一次匯入交易明細或調整明細）以前的「沒匯」不算要處理；都還沒匯過就從昨天算
  const repStart = sysRepStart() || addDays(today, -1);
  const lastPortal = [...portal].filter(d => d <= today).sort().pop() || '';
  let todo = 0;
  const rows = days.map(d => {
    const flag = (html, bad) => { if (bad) todo++; return html; };
    // 之後的日子有總表資料、這天沒有＝那天總表沒有數字（例如公休；書籤一次讀 14 天，有的話會一起帶入）
    const c1 = portal.has(d) ? B('已同步', 'ok') : d < lastPortal ? B('沒有資料', 'other', '這天總表沒有數字（例如公休）') : flag(B('沒同步', 'due', '這天還沒有從入口網站帶入生產、出貨。請在入口網站按書籤「同步生產與出貨」（一次讀最近 14 天）'), true);
    const early = d < repStart, mk = sysMark(d);
    const c2 = link('allocations', d, txDays.has(d) ? B('已匯入', 'ok') : early ? B('—', 'other', '還沒開始用系統報表') : flag(B('沒匯', 'due', `${md(d)} 開單的交易明細表還沒匯入（按「匯入系統報表」）`), true));
    const c3 = mk ? B('已匯入', 'ok') : early ? B('—', 'other', '還沒開始用系統報表') : flag(B('沒匯', 'due', `${md(d)} 的調整明細表還沒匯入（按「匯入系統報表」）`), true);
    // 總公司核對（排單日＝這天）
    const R = txReconData(ledger, d); let c4 = B('—', 'other', '這天排單的貨還沒有交易明細');
    if (R.recs.length) {
      const missQ = clampQty(sumQ(R.rows, x => x.miss)), gapQ = clampQty(sumQ(R.rows, x => Math.abs(x.gap))), parts = [];
      if (missQ) parts.push(flag(B(`批號對不上 ${fmt(missQ)}`, 'bad', '交易明細上的批號，App 庫存裡沒有或不夠（數量已照先到期先出改扣別批，庫存跟總表一致）：先補匯前一天的明細，還在就查總表的轉現貨、換盒'), true));
      if (!R.full) for (const t of R.due) parts.push(t >= today ? B(`等 ${md(t)} 明細`, 'other', `${md(t)} 開單的明細明天才有；很多訂單揀貨隔天才開單`) : flag(B(`缺 ${md(t)} 明細`, 'due', `${md(t)} 開單的交易明細沒匯入，這天的核對不完整`), true));
      else if (gapQ) parts.push(flag(B(`差 ${fmt(gapQ)}`, 'due', '總表的出貨 ≠ 交易明細＋寄門市＋調整單（試吃、總表打錯、門市入貨日期不對…），到「出貨扣批明細」看是哪個品號'), true));
      if (!parts.length) parts.push(B('一致', 'ok'));
      c4 = link('allocations', d, parts.join(' '));
    }
    // 生產 vs 總表
    let c5 = '—';
    if (mk && mk.prod && Object.keys(mk.prod).length) {
      const app = stockInOn(d), codes = [...new Set([...Object.keys(mk.prod), ...Object.keys(app)])].sort(productOrder), diff = codes.filter(c => Math.abs((mk.prod[c] || 0) - (app[c] || 0)) > 1e-7);
      c5 = !portal.has(d) ? B('總表還沒同步', 'other') : !diff.length ? B('一致', 'ok') : flag(B(`${diff.length} 項不同`, 'due', diff.slice(0, 12).map(c => `${c} 系統 ${fmt(mk.prod[c] || 0)}／總表 ${fmt(app[c] || 0)}`).join('、')), true);
    }
    // 門市
    const sh = [], nIn = SHOPS.filter(s => data.shops.some(r => r.shop === s.id && r.type === 'in' && !r.aud && r.date === d)).length, nSale = SHOPS.filter(s => data.shops.some(r => r.shop === s.id && r.type === 'sale' && r.date === d)).length;
    for (const s of SHOPS) {
      const recs = data.shops.filter(r => r.shop === s.id && r.date === d), out = Ls.get(s.id).outs;
      const short = clampQty(sumQ(recs.filter(r => r.type !== 'in'), r => (out.get(r.id) || {}).short || 0));
      const pend = recs.filter(r => r.type === 'in' && !r.batch && !r.aud).filter(r => { const p = plan.get(r.id) || []; return sumQ(p.filter(x => x.confirmed), x => x.qty) < r.quantity - 1e-7; }).length;
      const rv = mk && mk.recv && mk.recv[s.id];
      if (rv) { const c = [d, addDays(d, -1), addDays(d, -2)].map(p => shopBaseTot(s.id, p)); if (!c.some(t => Object.keys(t).length)) sh.push(link('shop-' + s.id, d, flag(B(`${s.name}入貨沒帶入`, 'due', `${md(d)} 的入庫單在 App 找不到對應的入貨（排單日 ${md(addDays(d, -2))}～${md(d)}）：重新匯入那天的調整明細表會從揀貨總表補帶`), true))); else if (!c.some(t => sameTot(t, rv))) sh.push(link('shop-' + s.id, d, flag(B(`${s.name}入庫不同`, 'due', '入庫單的數量跟 App 的入貨（揀貨總表）對不上'), true))); }
      if (txDays.has(d) && !recs.some(r => r.type === 'sale')) sh.push(link('shop-' + s.id, d, flag(B(`${s.name}銷售沒匯`, 'due', `${md(d)} 的交易明細已匯入，但${s.name}沒有銷售紀錄（沒有門市權限的人匯入時不會存門市的部分）`), true)));
      if (short) sh.push(link('shop-' + s.id, d, flag(B(`${s.name}缺口 ${fmt(short)}`, 'bad', '銷售／報廢／領取比門市庫存多：入貨沒帶入、舊貨沒建檔（門市期初盤點）'), true)));
      if (pend) sh.push(link('shop-' + s.id, d, B(`${s.name}待確認 ${pend}`, 'other', '寄門市的有好幾個批號、還沒確認（不影響數量和可販售日）')));
    }
    const c6 = `<span class="chk-sum">入貨 ${nIn}/${SHOPS.length}・銷售 ${nSale}/${SHOPS.length}</span>${sh.length ? ' ' + sh.join(' ') : ''}`;
    return `<tr>${td(`<strong>${esc(md(d))}</strong> <span class="who">${esc(WEEK[new Date(d + 'T00:00:00').getDay()])}</span>`)}${td(c1)}${td(c2)}${td(c3)}<td class="exp-cell">${c4}</td>${td(c5)}<td class="exp-cell"><div class="exp-chips">${c6}</div></td></tr>`;
  });
  $('dcInfo').textContent = days.length ? `最近 ${days.length} 天（昨天往前）。每天早上：入口網站按書籤同步 → 「匯入系統報表」選前一天的交易明細表和調整明細表 → 看這張表${todo ? `；有 ${todo} 格要處理（滑鼠移到格子上看原因，按一下跳到那一頁）` : '；目前沒有要處理的'}` : '還沒有資料';
  box.innerHTML = table(['日期', '入口網站同步', '交易明細（開單日）', '調整明細', '總公司核對（排單日）', '生產 vs 總表', '門市'], rows, '還沒有資料');
  const sd = SHOPS.map(s => { const n = shopAlertN[s.id] || {}; return n.soon || n.exp ? link('shop-' + s.id, '', `${esc(s.name)}${n.soon ? ` ${B(`快到期 ${n.soon} 項`, 'due')}` : ''}${n.exp ? ` ${B(`已過期 ${n.exp} 項`, 'bad')}` : ''}`) : ''; }).filter(Boolean);
  const hq = [dashDue.stock ? B(`現貨到期 ${dashDue.stock} 批`, 'due') : '', dashDue.semi ? B(`半成品到期 ${dashDue.semi} 批`, 'due') : '', dashDue.expired ? B(`已過期 ${dashDue.expired} 批`, 'bad') : ''].filter(Boolean);
  $('dcDue').innerHTML = `<strong>今天的到期提醒</strong>：總公司 ${hq.length ? link('batches', '', hq.join(' ')) : '沒有'}；門市 ${sd.length ? sd.join('、') : '沒有'}`;
}

/* ---------- 總公司交易明細（POS 匯出，倉庫 1＝總公司）→ 出貨批號 ----------
   數量以總表的實際揀貨為準，交易明細只用來決定扣哪個批號。交易明細記的是開單日、總表記的是揀貨日（排單日），
   所以用訂單單號找它在揀貨總表哪一天的「MMDD排」（沒勾刪單；雲端後端 pickOrders），照那天扣：
   同一張訂單出現在好幾天時，優先開單當天，再來是之前最近的一天，最後才是之後的；批號的製造日期晚於那天的不算（那天還沒做出來）。
   沒有訂單單號的列算開單當天；對不到排單表的列存成 unmatched（只在核對表列出，不拿來扣）。只看同步範圍的品號（CK、CC、CA…），烙印、運費等不算。
   存成 txb：id txb-交易日-排單日-品號（unmatched：txb-交易日-x-品號），同一個交易日再匯入一次會取代上次的。 */
function parseTxDetail(text, fallbackDate) {
  const rows = splitTable(text); let hi = -1, col = {};
  for (let i = 0; i < Math.min(rows.length, 8) && hi < 0; i++) {
    const f = re => rows[i].findIndex(c => re.test(c)), code = f(/品號|商品編號|商品代碼|貨號|sku/i), qty = f(/數量|qty/i);
    if (code >= 0 && qty >= 0) hi = i, col = { code, qty, batch: f(/批號|批次|^lot/i), date: f(/日期|date/i), wh: f(/倉庫|倉別|庫別/), order: f(/訂單單號|訂單編號|銷貨單號|^單號/) };
  }
  if (hi < 0) throw Error('找不到標題列：要有「品號」和「數量」欄');
  if (col.batch < 0) throw Error('找不到「批號」欄');
  if (col.date < 0 && !isDate(fallbackDate)) throw Error('檔案沒有日期欄，請選開單日期');
  const pf = portalPrefixes(), out = [], skip = { wh: 0, other: 0, bad: 0 };
  rows.slice(hi + 1).forEach(cells => {
    if (cells.some(c => /^(合計|小計|總計|total)/i.test(c))) return;
    if (col.wh >= 0 && String(cells[col.wh] || '').replace(/^0+(?=\d)/, '') !== POS_HQ) { skip.wh++; return; }
    const code = clean(cells[col.code]).toUpperCase(); if (!code) return;
    if (!pf.includes(codePrefix(code))) { skip.other++; return; }
    const q = numCell(cells[col.qty]), date = col.date >= 0 ? parseCellDate(cells[col.date]) : fallbackDate;
    if (!(q > 0) || q >= 1e7 || !date) { skip.bad++; return; }
    out.push({ code: code.split('|')[0], q, batch: cleanBatch(cells[col.batch]), tx: date, order: col.order >= 0 ? orderNo(cells[col.order]) : '' });
  });
  return { rows: out, skip, hasWh: col.wh >= 0, hasOrder: col.order >= 0 };
}
// 這一列是哪一天揀貨的：cands＝這張訂單出現在哪幾天的排單（沒勾刪單）
function txPickDay(row, cands) {
  const bd = batchDate(row.batch), ok = cands.filter(d => !bd || d >= bd).sort();
  if (!ok.length) return '';
  if (ok.includes(row.tx)) return row.tx;
  const before = ok.filter(d => d < row.tx); return before.length ? before[before.length - 1] : ok[0];
}
// 到揀貨總表找這些開單日的訂單排在哪一天：開單日前 3 天到後 14 天（預購會晚幾天才揀貨），最晚到明天；雲端後端一次最多 31 天，分批讀
const TX_BEFORE = 3, TX_AFTER = 14;
const txPickWindow = txs => { const t1 = addDays(TODAY(), 1); return [...new Set(txs.flatMap(t => Array.from({ length: TX_BEFORE + TX_AFTER + 1 }, (_, i) => addDays(t, i - TX_BEFORE)).filter(d => d <= t1)))].sort(); };
async function pickOrdersOn(dates) {
  const days = {};
  try { for (let i = 0; i < dates.length; i += 31) { const j = await FEAuth.api('pickOrders', { dates: dates.slice(i, i + 31) }); Object.assign(days, j.days || {}); } }
  catch (e) { throw Error(e.code === 'unknown_action' ? '雲端後端還沒更新，不能用訂單單號對排單日。請先照使用說明更新雲端後端（Code.gs）' : '讀不到揀貨總表：' + (e.message || e)); }
  const where = new Map(); for (const [d, v] of Object.entries(days)) if (v && v.found) for (const o of v.orders || []) { if (!where.has(o)) where.set(o, []); where.get(o).push(d); }
  return { days, where };
}
// 交易明細（總公司）→ 用訂單單號到揀貨總表找排單日，分組（還沒存）；讀不到揀貨總表時丟出錯誤
// 對不到排單表的列：每張訂單、每個品號各存一筆（unmatched），之後揀貨總表出現那張訂單時可以自動重對（txRematchPlan）
async function txBuild(r) {
  const txs = [...new Set(r.rows.map(x => x.tx))].sort(), want = txPickWindow(txs);
  let days = {}, where = new Map();
  if (r.hasOrder && r.rows.some(x => x.order)) ({ days, where } = await pickOrdersOn(want));
  const near = new Set(txs.flatMap(t => [-1, 0, 1].map(k => addDays(t, k)))); // 只提醒開單日前後一天沒有排單表（其他日子本來就可能沒有）
  const missing = Object.keys(days).length ? want.filter(d => near.has(d) && d <= TODAY() && !(days[d] && days[d].found)) : [];
  const groups = new Map(); let unmQ = 0;
  for (const x of r.rows) {
    const d = x.order ? txPickDay(x, where.get(x.order) || []) : x.tx, un = !d, key = un ? `${x.tx}|x|${x.code}|${x.order}` : `${x.tx}|${d}|${x.code}`;
    const g = groups.get(key) || { tx: x.tx, date: un ? x.tx : d, code: x.code, batches: {}, n: 0, unmatched: un, orders: new Set() };
    g.batches[x.batch || '—'] = clampQty((g.batches[x.batch || '—'] || 0) + x.q); g.n++; if (un) { g.orders.add(x.order); unmQ += x.q; }
    groups.set(key, g);
  }
  const all = [...groups.values()], byDay = new Map();
  for (const g of all) { if (g.unmatched) continue; const v = byDay.get(g.date) || { q: 0, codes: new Set() }; v.q = clampQty(v.q + sumQ(Object.values(g.batches), q => q)); v.codes.add(g.code); byDay.set(g.date, v); }
  return { txs, all, byDay, unmQ, missing, old: data.txbs.filter(t => txs.includes(t.tx)).length, total: sumQ(r.rows, x => x.q), n: r.rows.length };
}
// 漏匯的開單日：已匯入（含這次）最早到最晚之間、總表那天有出貨、卻沒有交易明細的日子
function txGaps(extra = []) {
  const have = new Set([...data.txbs.map(t => t.tx), ...extra]), ds = [...have].sort(); if (!ds.length) return [];
  const ship = new Set(data.movements.filter(m => m.type === 'shipment').map(m => m.date)), out = [];
  for (let d = ds[0]; d < ds[ds.length - 1]; d = addDays(d, 1)) if (!have.has(d) && ship.has(d)) out.push(d);
  return out;
}
const txGapNote = gaps => gaps.length ? `還沒匯 ${gaps.map(md).join('、')} 開單的交易明細：${gaps.map(d => `${md(addDays(d, -1))}、${md(d)}`).join('；')} 排單的核對會不完整，可能出現假的「批號對不上」，有的話請一起匯入` : '';
function txPreviewHtml(P, RM) {
  const reqOn = d => sumQ(data.movements.filter(m => m.type === 'shipment' && m.date === d), m => m.quantity);
  const rowsHtml = [...P.byDay.entries()].sort().map(([d, v]) => `<tr>${tdm(d)}<td class="num">${fmt(v.q)}</td><td class="num">${v.codes.size}</td><td class="num">${fmt(reqOn(d))}</td></tr>`);
  const gaps = txGaps(P.txs);
  return `<p class="modal-note">${P.txs.map(md).join('、')} 開單、總公司 ${fmt(P.total)} 個（${P.n} 列），照訂單單號分到排單日如下。${P.old ? `會取代上次匯入的 ${P.old} 筆。` : ''}${P.missing.length ? ` 揀貨總表沒有 ${P.missing.map(md).join('、')} 的排單表。` : ''}出貨數量照總表，明細只決定扣哪個批號；扣掉明細（客人）的批號後，剩下的就是分給門市的批號。</p>
    <div class="table-scroll">${table(['排單日（揀貨）', '明細#', '品號數#', '那天總表需求#'], rowsHtml, '沒有對到排單日的列')}</div>
    ${P.unmQ ? `<p class="modal-note">對不到排單表的 ${fmt(P.unmQ)} 個（開單日前 ${TX_BEFORE} 天到後 ${TX_AFTER} 天的排單表都沒有這張訂單）先不拿來扣，會列在核對表；之後揀貨總表出現這張訂單時，下次匯入會自動重對：${esc([...new Set(P.all.filter(g => g.unmatched).flatMap(g => [...g.orders]))].slice(0, 8).join('、'))}</p>` : ''}
    ${RM && RM.n ? `<p class="modal-note"><strong>之前對不到的 ${fmt(RM.q)} 個這次對到了</strong>：${esc(RM.list.slice(0, 6).join('、'))}${RM.list.length > 6 ? '…' : ''}，會一起改成那天的批號。</p>` : ''}
    ${gaps.length ? `<div class="notice warning">${esc(txGapNote(gaps))}。</div>` : ''}`;
}
const txUnId = g => `txb-${g.tx}-x-${g.code}-${[...g.orders][0] || ''}`;
function txSave(P) {
  const who = myName(), at = nowIso(), recs = P.all.map(g => ({ id: g.unmatched ? txUnId(g) : `txb-${g.tx}-${g.date}-${g.code}`, tx: g.tx, date: g.date, code: g.code, batches: g.batches, n: g.n, by: who, at, ...(g.unmatched ? { unmatched: true, orders: [...g.orders].filter(Boolean).slice(0, 60) } : {}) }));
  const keep = new Set(recs.map(x => x.id)), removes = data.txbs.filter(t => P.txs.includes(t.tx) && !keep.has(t.id)).map(t => t.id);
  if (removes.length) FEStore.removeMany('txb', removes);
  FEStore.saveMany('txb', recs);
  const lastTx = P.txs[P.txs.length - 1], latest = [...P.byDay.keys()].sort().pop(); if (P.byDay.has(lastTx)) allocDate = lastTx; else if (latest) allocDate = latest;
}
// 之前對不到排單表的交易明細：到揀貨總表再找一次（開單日前 3 天到後 14 天、最晚到明天），找到就搬到那天（跟那天同品號的明細合在一起）
// 舊資料一筆裡可能有好幾張訂單：每張訂單的排單日都一樣才搬。skipTx＝這次要重新匯入的開單日（會整批取代，不用重對）
async function txRematchPlan(skipTx = []) {
  const un = data.txbs.filter(t => t.unmatched && (t.orders || []).length && !skipTx.includes(t.tx));
  const res = { n: 0, q: 0, list: [], saves: [], removes: [] };
  if (!un.length) return res;
  const { where } = await pickOrdersOn(txPickWindow([...new Set(un.map(t => t.tx))]));
  const saves = new Map();
  for (const t of un) {
    const last = Object.keys(t.batches).filter(b => b !== '—').sort((a, b) => cmp(batchDate(b) || '', batchDate(a) || ''))[0] || '';
    const ds = t.orders.map(o => txPickDay({ tx: t.tx, batch: last }, where.get(o) || []));
    if (ds.some(d => !d) || new Set(ds).size !== 1) continue;
    const d = ds[0], id = `txb-${t.tx}-${d}-${t.code}`, base = saves.get(id) || data.txbs.find(x => x.id === id && !x.unmatched) || { id, tx: t.tx, date: d, code: t.code, batches: {}, n: 0, by: myName(), at: nowIso() };
    const m = { ...base, batches: { ...base.batches } }; for (const [b, q] of Object.entries(t.batches)) m.batches[b] = clampQty((m.batches[b] || 0) + q); m.n = (m.n || 0) + (t.n || 0);
    saves.set(id, m); res.removes.push(t.id); res.n++;
    const q = sumQ(Object.values(t.batches), v => v); res.q = clampQty(res.q + q); res.list.push(`${t.orders.join('／')} ${t.code}×${fmt(q)} → ${md(d)} 排單`);
  }
  res.saves = [...saves.values()];
  return res;
}
function txRematchApply(RM) { if (!RM || !RM.n) return; FEStore.removeMany('txb', RM.removes); FEStore.saveMany('txb', RM.saves); }
async function txRematchNow() {
  if (!can('ship')) return;
  toast('正在到揀貨總表重新對排單日…', false, 20000);
  let RM; try { RM = await txRematchPlan(); } catch (e) { toast(e.message, true, 10000); return; }
  if (!RM.n) { toast(`還是對不到：揀貨總表開單日前 ${TX_BEFORE} 天到後 ${TX_AFTER} 天的排單表都還沒有這些訂單`, false, 7000); return; }
  act(() => { txRematchApply(RM); toast(`之前對不到的 ${fmt(RM.q)} 個對到了：${RM.list.slice(0, 4).join('、')}${RM.list.length > 4 ? '…' : ''}。出貨扣批已重算`, false, 9000); });
}

/* ---------- 系統報表匯入（交易明細表＋調整明細表，2026-11-20 起） ----------
   一個畫面選一或多個檔案（每天早上匯前一天的），App 照標題列認出是哪一種報表：
   交易明細表（品號、數量、批號、倉庫…）：倉庫 1＝總公司 → 出貨批號（見上方交易明細）；4、5、24 → 三家門市的銷售（跟門市頁的匯入一樣，imp-sale-…）
   調整明細表（單號、調整類別／類別名稱、倉庫代號、+/-…）：
     領取（門市倉庫，－）→ 門市「領取」紀錄（imp-take-…），從門市庫存扣
     入庫（門市倉庫，＋）→ 只核對：跟揀貨總表寄那家門市的數量比（排單日＝入庫日或前 1～2 天）；門市入貨照排單日記（揀貨總表帶入），
                           對到的排單日 App 還沒有入貨就一起從揀貨總表帶入
     生產（倉庫 01，＋）→ 只核對：跟總表那天變成現貨的數量比（半成品轉現貨＋生產轉現貨＋現貨增加；全現貨模式＝當天生產＋現貨增加）
     其他（出庫、門市之間調撥、總公司的領取…）不匯入：總公司的增減照總表
   兩種報表都只看同步範圍的品號（CK、CC、CA、CL、CS、KA）。 */
const ADJ_KIND = { A1: '生產', A2: '出庫', A3: '入庫', '002': '領取' };
function reportKind(text) {
  for (const row of splitTable(String(text).split('\n').slice(0, 10).join('\n'))) {
    const has = re => row.some(c => re.test(c));
    if (has(/調整類別|類別名稱/) && has(/倉庫/) && has(/品號/)) return 'adj';
    if (has(/品號/) && has(/數量/) && has(/批號/)) return 'tx';
  }
  return '';
}
function parseAdjDetail(text) {
  const rows = splitTable(text); let hi = -1, col = {};
  for (let i = 0; i < Math.min(rows.length, 8) && hi < 0; i++) {
    const f = re => rows[i].findIndex(c => re.test(c));
    const name = f(/類別名稱/), kind = f(/調整類別/), code = f(/品號/), qty = f(/數量/), wh = f(/倉庫/);
    if ((name >= 0 || kind >= 0) && code >= 0 && qty >= 0 && wh >= 0) hi = i, col = { name, kind, code, qty, wh, sign: f(/^(\+|＋)\s*\/\s*(-|－)$|加減|正負/), date: f(/日期/), doc: f(/單號/) };
  }
  if (hi < 0) throw Error('找不到調整明細表的標題列（要有品號、數量、倉庫代號、調整類別）');
  const pf = portalPrefixes(), out = [], skip = { other: 0, bad: 0 };
  rows.slice(hi + 1).forEach(cells => {
    if (cells.some(c => /^(合計|小計|總計|total)/i.test(c))) return;
    const code = clean(cells[col.code]).toUpperCase(); if (!code) return;
    if (!pf.includes(codePrefix(code))) { skip.other++; return; }
    const kind = (col.name >= 0 && clean(cells[col.name])) || ADJ_KIND[clean(cells[col.kind])] || clean(cells[col.kind]);
    const q = numCell(cells[col.qty]), date = col.date >= 0 ? parseCellDate(cells[col.date]) : '';
    if (!(q > 0) || q >= 1e7 || !date) { skip.bad++; return; }
    const sv = col.sign >= 0 ? clean(cells[col.sign]) : '', sign = sv ? (/[-－−]/.test(sv) ? '-' : '+') : (/領取|出庫/.test(kind) ? '-' : '+');
    out.push({ doc: col.doc >= 0 ? clean(cells[col.doc]) : '', date, kind, code: code.split('|')[0], wh: clean(cells[col.wh]).replace(/^0+(?=\d)/, ''), sign, q });
  });
  return { rows: out, skip, dates: [...new Set(out.map(x => x.date))].sort() };
}
// 總表那天變成現貨的數量（每個品號第一段）：半成品轉現貨＋生產轉現貨＋現貨增加；全現貨模式＝當天生產＋現貨增加
function stockInOn(d) {
  const m = {}, all = isStockModeDay(d), add = (p, q) => { const c = baseCode(p); m[c] = clampQty((m[c] || 0) + Number(q)); };
  for (const r of data.movements) {
    if (r.date !== d) continue;
    if (r.type === 'convert') add(r.product, r.quantity);
    else if (r.type === 'production' && (all || r.pool === 'stock')) add(r.product, r.quantity);
    else if (r.type === 'adjust' && r.dir === 'add' && r.pool === 'stock') add(r.product, r.quantity);
  }
  return m;
}
const whLabel = wh => wh === POS_HQ ? '總公司' : (SHOPS.find(s => s.pos === wh) || {}).name || `倉庫 ${wh}`;
async function openSysImport() {
  if (!can('ship') && !SHOPS.some(s => can(shopPerm(s.id)))) return;
  let files = [];
  const pr = modal({ title: '匯入系統報表', ok: '下一步', wide: true,
    html: `<p class="modal-note">每天早上把前一天的<strong>交易明細表</strong>和<strong>調整明細表</strong>（倉庫都選全部）一起選進來，App 會自己認出是哪一份：</p>
      <ul class="modal-note" style="margin:0 0 10px 1.2em;padding:0"><li>交易明細表：倉庫 1（總公司）→ 出貨批號（扣掉這些客人的批號，剩下的就是寄門市的）；倉庫 ${esc(SHOPS.map(s => `${s.pos}＝${s.name}`).join('、'))} → 門市銷售</li><li>調整明細表：門市的<strong>領取</strong>從門市庫存扣；門市<strong>入庫</strong>跟揀貨總表核對（入貨照排單日記）；<strong>生產</strong>跟總表核對</li></ul>
      <div class="field"><label for="sys-files">選擇檔案（可以一次選好幾個）</label><input id="sys-files" type="file" multiple accept=".xlsx,.xls,.xlsm,.ods,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"></div>
      <div id="sys-prev"></div><p class="modal-error" hidden></p>`,
    collect: () => { const ok = files.filter(f => f.kind && !f.err); if (!ok.length) throw Error('請選交易明細表或調整明細表'); return ok; } });
  const body = $('modalBody'), prev = body.querySelector('#sys-prev');
  body.querySelector('#sys-files').addEventListener('change', async e => {
    files = []; prev.innerHTML = '<p class="who">讀取中…</p>';
    for (const f of [...(e.target.files || [])]) {
      const x = { name: f.name, kind: '' };
      try {
        x.text = await readTableFile(f); x.kind = reportKind(x.text);
        if (x.kind === 'tx') { x.hq = parseTxDetail(x.text, ''); x.shop = parseShopPaste(x.text, SHOPS[0].id); }
        else if (x.kind === 'adj') x.adj = parseAdjDetail(x.text);
        else x.err = '認不出是哪一種報表（要有交易明細表或調整明細表的標題列）';
      } catch (err) { x.err = err.message || String(err); }
      files.push(x);
    }
    prev.innerHTML = files.map(x => {
      if (x.err) return `<div class="notice warning"><strong>${esc(x.name)}</strong>：${esc(x.err)}</div>`;
      if (x.kind === 'tx') {
        const txs = [...new Set(x.hq.rows.map(r => r.tx))].sort(), per = SHOPS.map(s => `${s.name} ${fmt(sumQ(x.shop.groups.filter(g => g.shop === s.id).flatMap(g => g.items)))}`).join('、');
        return `<div class="notice"><strong>交易明細表</strong>「${esc(x.name)}」：開單日 ${esc(txs.map(md).join('、') || '—')}；總公司 ${fmt(sumQ(x.hq.rows, r => r.q))} 個、門市銷售 ${esc(per)} 個</div>`;
      }
      const a = x.adj, by = k => { const m = new Map(); for (const r of a.rows) if (r.kind === k && SHOPS.some(s => s.pos === r.wh)) m.set(r.wh, clampQty((m.get(r.wh) || 0) + r.q)); return [...m].map(([w, q]) => `${whLabel(w)} ${fmt(q)}`).join('、') || '—'; };
      const prodQ = sumQ(a.rows.filter(r => r.kind === '生產' && r.wh === POS_HQ), r => r.q);
      return `<div class="notice"><strong>調整明細表</strong>「${esc(x.name)}」：日期 ${esc(a.dates.map(md).join('、') || '—')}；生產 ${fmt(prodQ)} 個、門市入庫 ${esc(by('入庫'))}、領取 ${esc(by('領取'))}</div>`;
    }).join('');
  });
  const picked = await pr; if (!picked) return;
  return sysImportStep2(picked);
}
async function sysImportStep2(files) {
  const txFiles = files.filter(f => f.kind === 'tx'), adjRows = files.filter(f => f.kind === 'adj').flatMap(f => f.adj.rows);
  toast('整理中…（到揀貨總表對排單日）', false, 20000);
  // 調整明細表：分類
  const takeRaw = [], recv = new Map(), prod = new Map(), other = new Map(), hqOut = new Map();
  for (const x of adjRows) {
    const s = SHOPS.find(y => y.pos === x.wh);
    if (x.kind === '領取' && s && x.sign === '-') takeRaw.push({ ...x, shop: s.id });
    else if (x.kind === '入庫' && s && x.sign === '+') { const k = s.id + '|' + x.date, m = recv.get(k) || {}; m[x.code] = clampQty((m[x.code] || 0) + x.q); recv.set(k, m); }
    else if (x.kind === '生產' && x.wh === POS_HQ && x.sign === '+') { const m = prod.get(x.date) || {}; m[x.code] = clampQty((m[x.code] || 0) + x.q); prod.set(x.date, m); }
    else { if (x.wh === POS_HQ && x.sign === '-') { const m = hqOut.get(x.date) || {}; m[x.code] = clampQty((m[x.code] || 0) + x.q); hqOut.set(x.date, m); } const k = `${whLabel(x.wh)}的${x.kind}`; other.set(k, clampQty((other.get(k) || 0) + x.q)); }
  }
  // 門市入庫 → 揀貨總表哪一天的排單（入庫日或前 1～2 天，數量最接近的那天）
  const recvRes = []; let recvErr = '';
  if (recv.size) {
    const want = [...new Set([...recv.keys()].flatMap(k => { const d = k.split('|')[1]; return [d, addDays(d, -1), addDays(d, -2)]; }))].sort();
    let days = {};
    try { days = (await FEAuth.api('storeOut', { dates: want })).days || {}; } catch (e) { recvErr = e.code === 'unknown_action' ? '雲端後端還沒更新，不能核對門市入庫' : '讀不到揀貨總表，門市入庫沒有核對：' + (e.message || e); }
    const pf = portalPrefixes();
    const pickTot = (d, s) => {
      const v = days[d], m = {}; if (!v || !v.found) return null;
      for (const x of ((v.stores || {})[s.name] || [])) {
        const code = clean(x[0]), name = clean(x[1]), q = Number(x[2]); if (!(q > 0) || isExcluded(name)) continue;
        const mp = code ? null : matchProductCell(name), c = (code || (mp ? productCodeOf(mp.name) : '')).toUpperCase().split('|')[0];
        if (!c || !pf.includes(codePrefix(c))) continue; m[c] = clampQty((m[c] || 0) + q);
      }
      return m;
    };
    const diffOf = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(productOrder).map(c => [c, a[c] || 0, b[c] || 0]).filter(x => Math.abs(x[1] - x[2]) > 1e-7);
    const off = c => sumQ(c.diff, z => Math.abs(z[1] - z[2]));
    if (!recvErr) for (const [k, m] of [...recv.entries()].sort()) {
      const [sid, d] = k.split('|'), s = SHOPS.find(y => y.id === sid);
      const cands = [d, addDays(d, -1), addDays(d, -2)].map(p => ({ p, t: pickTot(p, s) })).filter(c => c.t && Object.keys(c.t).length).map(c => ({ ...c, diff: diffOf(m, c.t) })).sort((x, y) => off(x) - off(y) || cmp(y.p, x.p));
      const best = cands[0], hasIn = !!best && data.shops.some(r => r.shop === sid && r.type === 'in' && r.date === best.p && String(r.id).startsWith('pt-in-'));
      recvRes.push({ sid, date: d, q: sumQ(Object.values(m), v => v), pick: best ? best.p : '', ok: !!best && !best.diff.length, diff: best ? best.diff : [], hasIn, can: canStoreOut(sid) });
    }
  }
  // 對到的排單日 App 還沒有門市入貨（例如那天忘了同步）→ 先從揀貨總表帶入（門市銷售的組合品要用到入貨的訂單單號）
  const fill = [...new Set(recvRes.filter(x => x.ok && !x.hasIn && x.can).map(x => x.pick))].sort();
  if (fill.length) { await syncStoreOut(fill, { quiet: true }); rebuild(); }
  // 門市領取 → 產品（補帶入貨可能新增產品，所以放在補帶之後）；調整明細表只有品號第一段，對到一般品（例如 CK-01 6原）
  const take = new Map(), takeUn = new Set();
  for (const x of takeRaw) { const p = matchProductCell(x.code); if (!p || isExcluded(p.name)) { takeUn.add(x.code); continue; } const k = x.shop + '|' + x.date, m = take.get(k) || new Map(); m.set(p.name, clampQty((m.get(p.name) || 0) + x.q)); take.set(k, m); }
  // 交易明細表：總公司 → 出貨批號；門市 → 銷售（只扣門市自己的帳）
  let P = null, txErr = '';
  const hqRows = txFiles.flatMap(f => f.hq.rows);
  if (hqRows.length && can('ship')) { try { P = await txBuild({ rows: hqRows, hasOrder: txFiles.some(f => f.hq.hasOrder) }); } catch (e) { txErr = e.message; } }
  let RM = null; if (can('ship')) { try { RM = await txRematchPlan(P ? P.txs : []); } catch (e) { RM = null; } }
  const sales = txFiles.flatMap(f => parseShopPaste(f.text, SHOPS[0].id).groups).filter(g => g.date && can(shopPerm(g.shop)));
  const takes = [...take.entries()].map(([k, m]) => { const [shop, date] = k.split('|'); return { shop, date, items: [...m].map(([product, quantity]) => ({ product, quantity })).sort((a, b) => productOrder(a.product, b.product)) }; }).filter(g => can(shopPerm(g.shop)));
  // 預估缺口（門市銷售、領取一起算）
  let list = data.shops; const planned = [];
  for (const [type, gs] of [['sale', sales], ['take', takes]]) for (const g of gs) { const x = shopImportRecords(g.shop, type, g.date, g.items, type === 'take' ? '調整明細：領取' : '批次匯入'); list = [...list.filter(y => !x.removes.includes(y.id) && !x.recs.some(z => z.id === y.id)), ...x.recs]; planned.push({ type, ...g, ...x }); }
  const Ls = new Map([...new Set(planned.map(g => g.shop))].map(s => [s, shopLedger(s, list)]));
  const shortOf = g => sumQ(g.recs, r => ((Ls.get(g.shop).outs.get(r.id)) || {}).short || 0);
  // 生產核對
  const prodRes = [...prod.entries()].sort().map(([d, m]) => { const app = stockInOn(d), codes = [...new Set([...Object.keys(m), ...Object.keys(app)])].sort(productOrder); return { d, n: codes.length, diff: codes.map(c => [c, m[c] || 0, app[c] || 0]).filter(x => Math.abs(x[1] - x[2]) > 1e-7), synced: data.movements.some(r => r.date === d && r.type === 'shipment') }; });
  toast('整理好了，請看預覽', false, 2000);
  const sec = (title, inner) => `<h3 style="margin:14px 0 6px">${title}</h3>${inner}`;
  const saleRows = SHOPS.map(s => { const gs = planned.filter(g => g.type === 'sale' && g.shop === s.id); if (!gs.length) return ''; const ds = [...new Set(gs.map(g => g.date))].sort(), sh = sumQ(gs, shortOf); return `<tr>${td(esc(s.name))}${td(esc(ds.map(md).join('、')))}<td class="num">${gs.reduce((n, g) => n + g.items.length, 0)}</td><td class="num">${fmt(sumQ(gs.flatMap(g => g.items)))}</td><td class="num">${sh ? badge(fmt(sh), 'bad') : '—'}</td></tr>`; }).filter(Boolean);
  const takeRows = planned.filter(g => g.type === 'take').map(g => { const sh = shortOf(g); return `<tr>${td(esc(shopName(g.shop)))}${tdm(g.date)}${td(esc(g.items.map(i => `${i.product} ×${fmt(i.quantity)}`).join('、')))}<td class="num">${sh ? badge(fmt(sh), 'bad') : '—'}</td></tr>`; });
  const recvRows = recvRes.map(x => `<tr>${td(esc(shopName(x.sid)))}${tdm(x.date)}<td class="num">${fmt(x.q)}</td>${td(x.pick ? `${md(x.pick)} 排單` : '—')}${td(x.ok ? badge('一致', 'ok') : x.pick ? badge('數量不同', 'due') + ' ' + esc(x.diff.slice(0, 6).map(([c, a, b]) => `${c} 入庫 ${fmt(a)}／排單 ${fmt(b)}`).join('、')) : badge('對不到排單', 'due'))}${td(!x.pick ? '—' : x.hasIn ? '已有' : fill.includes(x.pick) ? '剛從揀貨總表補帶入' : '沒有')}</tr>`);
  const prodRows = prodRes.map(x => `<tr>${tdm(x.d)}<td class="num">${x.n}</td>${td(!x.synced ? badge('總表還沒同步這天', 'due') : !x.diff.length ? badge('全部一致', 'ok') : badge(`${x.diff.length} 項不同`, 'due') + ' ' + esc(x.diff.slice(0, 8).map(([c, a, b]) => `${c} 系統 ${fmt(a)}／總表 ${fmt(b)}`).join('、')))}</tr>`);
  const html = [
    hqRows.length ? sec('總公司出貨批號（交易明細・倉庫 1）', !can('ship') ? '<p class="modal-note">你沒有「出貨」權限，總公司的部分不會匯入。</p>' : txErr ? `<div class="notice warning">${esc(txErr)}；總公司的部分這次不會匯入。</div>` : txPreviewHtml(P, RM)) : (RM && RM.n ? sec('之前對不到排單表的交易明細', `<p class="modal-note"><strong>這次對到了 ${fmt(RM.q)} 個</strong>：${esc(RM.list.slice(0, 6).join('、'))}，會改成那天的批號。</p>`) : ''),
    saleRows.length ? sec('門市銷售（交易明細・倉庫 ' + esc(SHOPS.map(s => s.pos).join('、')) + '）', `<div class="table-scroll">${table(['門市', '日期', '筆數#', '個數#', '缺口#'], saleRows, '')}</div><p class="modal-note">同一間門市、同一天再匯入一次會取代上次匯入的銷售；先扣 POS 上的批號，門市沒有那個批號才照先到期先扣。只扣門市自己的帳，跟總公司無關。</p>`) : '',
    takeRows.length || takeUn.size ? sec('門市領取（調整明細）', `${takeRows.length ? `<div class="table-scroll">${table(['門市', '日期', '領取', '缺口#'], takeRows, '')}</div>` : ''}${takeUn.size ? `<p class="modal-note">產品清單沒有、沒有匯入：${esc([...takeUn].join('、'))}</p>` : ''}`) : '',
    recvRows.length || recvErr ? sec('門市入庫核對（調整明細 vs 揀貨總表）', recvErr ? `<div class="notice warning">${esc(recvErr)}</div>` : `<div class="table-scroll">${table(['門市', '入庫日', '入庫#', '對到', '核對', 'App 的入貨（照排單日）'], recvRows, '')}</div>`) : '',
    prodRows.length ? sec('生產核對（調整明細 vs 總表）', `<div class="table-scroll">${table(['日期', '品號數#', '核對（系統的生產＝總表的半成品轉現貨＋生產轉現貨＋現貨增加）'], prodRows, '')}</div>`) : '',
    other.size ? `<p class="modal-note">不匯入庫存：${esc([...other].map(([k, q]) => `${k} ${fmt(q)} 個`).join('、'))}（總公司的增減照總表；總公司的出庫、領取會列在交易明細核對表的「調整單」欄，跟總表一起核對）。</p>` : ''
  ].join('');
  const adjDates = [...new Set(adjRows.map(x => x.date))].sort();
  const willSave = !!(P && can('ship')) || planned.length > 0 || adjDates.length > 0 || !!(RM && RM.n);
  const ok = await modal({ title: '匯入系統報表：預覽', ok: willSave ? '匯入' : '關閉', wide: true, html: html || '<p>沒有可以匯入的資料。</p>', collect: () => true });
  if (!ok || !willSave) return;
  act(() => {
    const parts = [];
    if (P && can('ship')) { txSave(P); parts.push(`總公司 ${P.txs.map(md).join('、')} 開單的批號（分到 ${P.byDay.size} 天排單）`); }
    if (RM && RM.n && can('ship')) { txRematchApply(RM); parts.push(`之前對不到排單表的 ${fmt(RM.q)} 個對到了`); }
    for (const g of planned) { if (!can(shopPerm(g.shop))) continue; const x = shopImportRecords(g.shop, g.type, g.date, g.items, g.type === 'take' ? '調整明細：領取' : '批次匯入'); if (x.removes.length) FEStore.removeMany('shop', x.removes); FEStore.saveMany('shop', x.recs); }
    const ns = planned.filter(g => g.type === 'sale'), nt = planned.filter(g => g.type === 'take');
    if (ns.length) parts.push(`門市銷售 ${[...new Set(ns.map(g => shopName(g.shop)))].join('、')}`);
    if (nt.length) parts.push(`門市領取 ${fmt(sumQ(nt.flatMap(g => g.items)))} 個`);
    if (fill.length) parts.push(`補帶入 ${fill.map(md).join('、')} 的門市入貨`);
    if (adjDates.length) {
      const who = myName(), at = nowIso();
      FEStore.saveMany('settings', adjDates.map(d => ({ id: 'sys-' + d, date: d, at, by: who, prod: prod.get(d) || {}, hqOut: hqOut.get(d) || {}, recv: Object.fromEntries(SHOPS.map(s => [s.id, recv.get(s.id + '|' + d)]).filter(([, m]) => m)) })));
      const old = FEStore.list('settings').filter(r => /^sys-\d{4}-\d{2}-\d{2}$/.test(r.id) && r.date < addDays(TODAY(), -60)).map(r => r.id);
      if (old.length) FEStore.removeMany('settings', old);
      parts.push(`調整明細 ${adjDates.map(md).join('、')}（生產、入庫核對結果在營運總覽的每日檢查）`);
    }
    const gaps = P ? txGaps() : [];
    toast(`已匯入：${parts.join('；')}${gaps.length ? `。注意：${txGapNote(gaps)}` : ''}`, !!gaps.length, gaps.length ? 14000 : 9000);
    if (P && can('ship')) go('allocations');
  });
}
function renderProducts(products) {
  const base = $('productLive').checked ? products.filter(x => x.usable > 0 || x.expired > 0) : products;
  const rows = searchable(base, $('productFilter').value, ['name']);
  // 半成品模式分開列現貨（無效期）與半成品；全現貨模式全部都是現貨，不分欄
  const split = !isStockModeDay(TODAY());
  $('productTable').innerHTML = table(['產品名稱', '單位', '期初入庫#', '累計生產#', '累計扣貨#', split ? '可用庫存#' : '可用庫存（現貨）#', ...(split ? ['現貨#', '半成品#'] : []), '已過期量#', '近效期量#', '最近有效日期', '安全庫存狀態'], rows.map(x => { const st = x.lowStock && x.usable < x.lowStock ? badge(`低於 ${fmt(x.lowStock)}`, 'bad') : x.lowStock ? badge('正常', 'ok') : badge('未設定', 'other'); return `<tr>${td(`<strong>${esc(x.name)}</strong>`)}${td(esc(x.unit))}<td class="num">${fmt(x.opened)}</td><td class="num">${fmt(x.produced)}</td><td class="num">${fmt(x.used)}</td><td class="num">${fmt(x.usable)}</td>${split ? `<td class="num">${fmt(x.stock)}</td><td class="num">${fmt(x.semi)}</td>` : ''}<td class="num">${fmt(x.expired)}</td><td class="num">${fmt(x.warning)}</td>${tdm(x.oldest)}${td(st)}</tr>`; }), '尚無產品，請先建立期初庫存或生產紀錄');
}
function renderSettings() {
  for (const [id, v] of [['semiWarn', data.settings.semiWarn], ['defaultShelf', data.settings.defaultShelf], ['stockDays', data.settings.stockDays], ['stockWarn', data.settings.stockWarn]]) { const el = $(id); if (document.activeElement !== el) el.value = v; }
  { const r = sellRule(); $('sellRuleText').textContent = `蛋糕類 ${r.cake.days} 天、第 ${r.cake.warnFrom} 天起提醒；生巧克力（CL 開頭）${r.choc.days} 天、第 ${r.choc.warnFrom} 天起提醒。只用在門市，入貨那天算第 1 天；總公司照半成品、現貨的有效日期。`; }
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
  // 上次入口網站同步用的是舊版書籤：一直提醒，直到用新版書籤同步一次
  // 沒有書籤版本紀錄（用更新前的 App 同步的）：有帶入增減就當成新版書籤
  { const m = portalMeta(), bv = Number(m.bv) || (Number(m.jN) > 0 ? PORTAL_BM_V : 0); if (window.FEAuth && FEAuth.user() && canPortal() && m.at && bv < PORTAL_BM_V) b.push(`<div class="banner bad">上次入口網站同步（${new Date(m.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${m.by ? '，' + esc(m.by) : ''}）用的是<strong>舊版書籤</strong>，總表的半成品增減、現貨增減、轉試吃、手動數字與隔夜差異都<strong>沒有帶入</strong>。請到「入口網站同步」頁把「同步生產與出貨」按鈕重新拖到書籤列（取代舊的），再同步一次。<a class="btn small" href="#portal" data-view="portal">前往入口網站同步</a></div>`); }
  { const y = addDays(TODAY(), -1), rs = sysRepStart();
    if (window.FEAuth && FEAuth.user() && can('ship') && st.loaded && rs && y >= rs && data.movements.some(m => m.type === 'shipment' && m.date === y)) {
      const miss = [data.txbs.some(x => x.tx === y) ? '' : '交易明細表', sysMark(y) ? '' : '調整明細表'].filter(Boolean);
      if (miss.length) b.push(`<div class="banner warn">昨天（${md(y)}）的${miss.join('和')}還沒匯入：每天早上匯入前一天的，總公司批號和門市帳才會完整。<button class="btn small" type="button" data-action="sys-import">匯入系統報表</button></div>`);
    } }
  if (window.FEAuth && FEAuth.user() && !isAdmin() && !PERMS.some(p => can(p.id))) b.push('<div class="banner">你目前只能查看與下載資料。需要登錄生產、出貨或修改設定的話，請找管理員開權限。</div>');
  const html = b.join('');
  if (html !== lastBanner) { $('banner').innerHTML = html; lastBanner = html; }
}
function applyPerms() {
  const cl = document.body.classList;
  cl.toggle('is-admin', isAdmin());
  for (const p of PERMS) cl.toggle('can-' + p.id, can(p.id));
  cl.toggle('can-portal', canPortal());
  cl.toggle('can-storeout', SHOPS.some(x => canStoreOut(x.id)));
  const n = myName(); $('meName').textContent = n; $('meName2').textContent = n;
  if (currentView === 'users' && !isAdmin()) go('dashboard');
  renderBanner();
}

/* ---------- 表單 ---------- */
function autoExpiry(prefix) { const m = $(`${prefix}Mfg`).value, day = Number($(`${prefix}Shelf`).value); if (isDate(m) && Number.isFinite(day) && day >= 0) $(`${prefix}Expiry`).value = addDays(m, day); }
function productDefaults(prefix) { const p = getProduct($(`${prefix}Product`).value); if (p && !p.virtual) { $(`${prefix}Unit`).value = p.unit; $(`${prefix}Shelf`).value = p.shelfDays; } else { $(`${prefix}Shelf`).value = data.settings.defaultShelf; } autoExpiry(prefix); }
function inputPositive(id) { const v = Number($(id).value); if (!Number.isFinite(v) || !(v > 0) || Math.abs(Math.round(v * 1000) - v * 1000) > 1e-7) throw Error('數量必須大於 0，最多 3 位小數'); return v; }
function baseRow(prefix, dateKey) {
  const name = clean($(`${prefix}Product`).value), unit = clean($(`${prefix}Unit`).value), batch = '—', manufactureDate = $(`${prefix}Mfg`).value, expiryDate = $(`${prefix}Expiry`).value, entryDate = $(dateKey).value;
  if (!name || !unit) throw Error('請填寫產品及單位');
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
const resetForms = () => { resetOpening(); resetAdjust(); SHOPS.forEach(x => resetShopForm(x.id)); };
const smooth = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
function populateEdit(type, id) {
  if (type === 'opening') { const x = data.opening.find(x => x.id === id); if (!x) return; editOpening = id; for (const [f, v] of Object.entries({ oProduct: x.product, oUnit: getUnit(x.product), oQty: x.quantity, oMfg: x.manufactureDate, oEntry: x.entryDate, oExpiry: x.expiryDate, oNote: x.note || '' })) $(f).value = v; $('oShelf').value = getProduct(x.product)?.shelfDays ?? data.settings.defaultShelf; $('openingFormTitle').textContent = '修改期初庫存'; $('oSubmit').textContent = '儲存修改'; $('oCancel').classList.remove('hide'); go('opening'); setTimeout(() => $('openingForm').scrollIntoView({ block: 'center', behavior: smooth() }), 30); return; }
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
  if (kind === 'batches') return ['批次庫存', ['產品', '單位', '類別', '批號', '製作日期', '有效日期', '原半成品製作日期', '期初庫存', '新增生產', '半成品轉入', '半成品增加', '已出貨', '轉成現貨', '半成品減少', '剩餘量', '狀態'], groups.map(x => [x.product, x.unit, poolLabel(x.pool), x.batch, x.manufactureDate, expShow(x.expiryDate), [...(x.fromMfgs || [])].sort().join('、'), x.opening, x.production, x.convert, x.adjust, x.shipped, x.converted, x.adjusted, x.remaining, expiryStatus(x.expiryDate, x.remaining).label])];
  if (kind === 'allocation') return ['出貨扣批明細', ['出貨日期', '出貨單號', '產品', '單位', '批號', '製作日期', '有效日期', '扣貨量', '類別'], allocationRows(led).map(x => [x.date, x.orderNo, x.product, x.unit, x.batch, x.manufactureDate, expShow(x.expiryDate), x.quantity, x.kind === 'shortage' ? '缺口' : '已分配'])];
  if (kind === 'adjust') return ['半成品現貨增減', ['日期', '產品', '單位', '類別', '增加／減少', '數量', '製作日期', '有效日期', '指定扣除的批', '實際扣除／來源', '缺口', '原因／備註', '登錄人'], data.movements.filter(r => r.type === 'adjust').sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product)).map(r => { const o = led.adjusts.get(r.id); return [r.date, r.product, getUnit(r.product), poolName(r.pool), r.dir === 'add' ? '增加' : '減少', r.quantity, r.manufactureDate || '', r.expiryDate || '', r.fromMfg ? `製 ${r.fromMfg}／效期 ${r.fromExp}` : '', o ? adjPartsText(o.parts) : '', o ? o.shortage : '', r.note, r.by]; })];
  if (kind === 'shop') { const outs = new Map(); for (const x of SHOPS) for (const [k, v] of shopLedger(x.id).outs) outs.set(k, v); return ['門市紀錄', ['門市', '日期', '類別', '產品', '單位', '批號', '數量', '可販售到', '扣除的批號', '缺口', '備註', '登錄人'], [...data.shops].sort((a, b) => SHOPS.findIndex(x => x.id === a.shop) - SHOPS.findIndex(x => x.id === b.shop) || cmp(b.date, a.date) || productOrder(a.product, b.product)).map(r => { const o = outs.get(r.id); return [shopName(r.shop), r.date, shopTypeLabel(r), r.product, getUnit(r.product), r.type === 'in' ? shopInText(r) : r.batch, r.quantity, r.type === 'in' ? shopExp(r) : '', o ? shopPartsText(o.parts) : '', o ? o.short : '', r.note, r.by]; })]; }
  return ['產品庫存總表', ['產品', '單位', '期初庫存', '累計生產', '累計扣貨', '可用庫存', '現貨', '半成品', '過期量', '近效期量', '最近有效日期', '低庫存警戒量'], products.map(x => [x.name, x.unit, x.opened, x.produced, x.used, x.usable, x.stock, x.semi, x.expired, x.warning, x.oldest, x.lowStock])];
}
function exportCsv(kind) { const [name, headers, records] = csvData(kind); const content = '﻿' + [headers, ...records].map(r => r.map(csvEscape).join(',')).join('\r\n'); downloadFile(`${name}_${TODAY()}.csv`, content, 'text/csv;charset=utf-8', `${name} CSV 已下載`); }
function exportBackup() { downloadFile(`生產出貨庫存_FEFO備份_${TODAY()}.json`, JSON.stringify({ ...exportState(), exportedAt: nowIso(), exportedBy: myName() }, null, 2), 'application/json;charset=utf-8', '完整 JSON 備份已下載'); }
let xlsxPromise = null;
function loadXLSX() { if (window.XLSX) return Promise.resolve(window.XLSX); if (!xlsxPromise) xlsxPromise = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = () => window.XLSX ? res(window.XLSX) : rej(Error('Excel 元件載入失敗')); s.onerror = () => { xlsxPromise = null; s.remove(); rej(Error('Excel 元件載入失敗（需要網路），請改用各表的「匯出 CSV」')); }; document.head.appendChild(s); }); return xlsxPromise; }
async function exportXlsx() {
  toast('正在產生 Excel 檔…');
  try { const XLSX = await loadXLSX(); const wb = XLSX.utils.book_new(); for (const kind of ['products', 'batches', 'opening', 'production', 'shipment', 'adjust', 'allocation', 'shop']) { const [name, headers, records] = csvData(kind); const ws = XLSX.utils.aoa_to_sheet([headers, ...records]); ws['!cols'] = headers.map(h => ({ wch: Math.max(10, h.length * 2 + 2) })); XLSX.utils.book_append_sheet(wb, ws, name); }
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }); downloadFile(`生產出貨庫存_完整明細_${TODAY()}.xlsx`, new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), null, 'Excel 明細已下載（六張工作表）'); }
  catch (err) { toast(err.message || 'Excel 產生失敗', true); }
}

/* ---------- 半成品／現貨增減（總公司） ----------
   手動登錄或入口網站帶入（總表「半成品增減」「半成品轉試吃」「現貨增減」）。
   增加：半成品＝當天一開始加入一批（製作日期、有效日期）；現貨＝轉現貨之後、出貨前加入（批號用當天）。
   減少：手動的＝當天結束時扣（出貨、轉現貨之後）；入口網站的半成品減少＝跟轉現貨同時（出貨前）。可指定哪一批，沒指定就從效期最早的扣（已過期的也能扣）；不夠扣的列為缺口。
   換盒：同一天、同一個品號開頭（CK-01 → CK-01|YB-86）入口網站的半成品減少，會變成現貨增加的來源；跟轉現貨一樣，換盒當天算第一天。 */
const poolName = pool => pool === 'stock' ? '現貨' : '半成品';
// 某個產品在某天結束時還有的批（給「減少」選）
function lotsLeftOf(product, date, pool) {
  const L = calculateLedger(isDate(date) ? date : '9999-12-31'), m = new Map();
  for (const l of L.lots) if (l.product === product && l.pool === pool && l.remaining > 1e-7) { const k = l.manufactureDate + '|' + l.expiryDate, x = m.get(k) || { mfg: l.manufactureDate, exp: l.expiryDate, left: 0, batches: new Set() }; x.left = clampQty(x.left + l.remaining); if (l.batch && l.batch !== '—') x.batches.add(l.batch); m.set(k, x); }
  return [...m.values()].sort((a, b) => cmp(a.exp, b.exp) || cmp(a.mfg, b.mfg));
}
const adjPartsText = parts => parts.map(p => `${p.from ? `由 ${productCodeOf(p.from)} 換盒（原製 ${md(p.fromMfg)}）・` : ''}${p.expiryDate === NO_EXPIRY ? '期初現貨' : `製 ${md(p.manufactureDate)}（效期 ${md(p.expiryDate)}）`}×${fmt(p.quantity)}`).join('、');
function adjFormSync(fillExpiry) {
  const dir = $('adDir').value, pool = $('adPool').value, date = $('adDate').value, p = getProduct($('adProduct').value), box = $('adPreview');
  $('adMfgWrap').hidden = $('adExpWrap').hidden = dir !== 'add'; $('adFromWrap').hidden = dir !== 'sub';
  if (dir === 'add') {
    if (!$('adMfg').value && isDate(date)) $('adMfg').value = date;
    if (fillExpiry && p && isDate($('adMfg').value)) $('adExp').value = addDays($('adMfg').value, $('adPool').value === 'stock' ? stockDaysOf() : p.shelfDays);
  }
  if (dir === 'sub') {
    const cur = $('adFrom').value, lots = p && isDate(date) ? lotsLeftOf(p.name, date, pool) : [];
    $('adFrom').innerHTML = '<option value="">自動：從效期最早的扣</option>' + lots.map(l => `<option value="${esc(l.mfg + '|' + l.exp)}">${l.exp === NO_EXPIRY ? '期初現貨' : `${l.batches.size ? esc([...l.batches].join('、')) + '・' : ''}製 ${esc(l.mfg)}・效期 ${esc(l.exp)}`}・剩 ${esc(fmt(l.left))}${l.exp < date ? '（已過期）' : ''}</option>`).join('');
    if ([...$('adFrom').options].some(o => o.value === cur)) $('adFrom').value = cur;
  }
  const q = Number($('adQty').value);
  if (!p || !isDate(date) || !(q > 0)) { box.hidden = true; return; }
  if (dir === 'add') { box.hidden = false; box.className = 'notice'; box.textContent = `${date} 增加「${p.name}」${poolName(pool)} ${fmt(q)} ${getUnit(p.name)}：製作 ${$('adMfg').value || '—'}、有效日期 ${$('adExp').value || '—'}${pool === 'stock' ? `、批號 ${makeBatch(p.name, date) || '—'}` : ''}`; return; }
  const [fm, fe] = ($('adFrom').value || '|').split('|');
  const rec = { id: '__preview__', type: 'adjust', dir: 'sub', ...(pool === 'stock' ? { pool: 'stock' } : {}), date, product: p.name, quantity: q, fromMfg: fm, fromExp: fe, seq: Date.now() };
  const o = calculateLedger('9999-12-31', { ...data, movements: [...data.movements, rec] }).adjusts.get('__preview__');
  box.hidden = false; box.className = `notice${o.shortage ? ' warning' : ''}`;
  box.textContent = `預估會扣（當天出貨、轉現貨之後）：${adjPartsText(o.parts) || `沒有可扣的${poolName(pool)}`}${o.shortage ? `；缺 ${fmt(o.shortage)} ${getUnit(p.name)}` : ''}`;
}
function resetAdjust(keep = false) {
  if (!keep) { $('adDate').value = TODAY(); $('adDir').value = 'add'; $('adPool').value = 'semi'; $('adProduct').value = ''; }
  for (const id of ['adQty', 'adMfg', 'adExp', 'adNote']) $(id).value = '';
  adjFormSync(true);
}
function saveAdjust(e) { e.preventDefault(); if (!can('produce')) return; act(() => {
  const date = $('adDate').value, dir = $('adDir').value, pool = $('adPool').value, product = clean($('adProduct').value), quantity = inputPositive('adQty'), note = clean($('adNote').value);
  if (!isDate(date) || !product) throw Error('請輸入日期與產品');
  if (!getProduct(product)) throw Error('此產品尚未建檔，請從清單選擇（可輸入品號或品名搜尋）');
  const rec = { id: uid(), type: 'adjust', dir, ...(pool === 'stock' ? { pool: 'stock' } : {}), seq: nextSeq(), date, product, quantity, note, ...stampNew() };
  if (dir === 'add') {
    const mfg = $('adMfg').value, exp = $('adExp').value;
    if (!isDate(mfg) || !isDate(exp)) throw Error('增加要填製作日期與有效日期');
    if (exp < mfg) throw Error('有效日期不能早於製作日期');
    if (mfg > date) throw Error('製作日期不能晚於增減日期');
    Object.assign(rec, { batch: '—', manufactureDate: mfg, expiryDate: exp });
  } else { const [fm, fe] = ($('adFrom').value || '|').split('|'); rec.fromMfg = isDate(fm) ? fm : ''; rec.fromExp = isDate(fe) ? fe : ''; }
  const o = dir === 'sub' ? calculateLedger('9999-12-31', { ...data, movements: [...data.movements, rec] }).adjusts.get(rec.id) : null;
  storeRecord(rec); resetAdjust(true);
  toast(o && o.shortage ? `已登錄減少：扣 ${fmt(o.done)}，缺 ${fmt(o.shortage)}（${poolName(pool)}不夠）` : `已登錄${poolName(pool)}${dir === 'add' ? '增加' : '減少'} ${fmt(quantity)} ${getUnit(product)}，庫存已重算`, !!(o && o.shortage), o && o.shortage ? 7000 : 4200);
}); }
const adjChip = (r, o) => {
  const u = esc(getUnit(r.product)), short = o && o.shortage > 0, add = r.dir === 'add', pn = poolName(r.pool);
  const tip = `${r.date}｜${pn}${add ? '增加' : '減少'} ${fmt(r.quantity)}${o && o.parts.length ? `｜${add ? '' : '扣 '}${adjPartsText(o.parts)}` : add ? `｜製作 ${r.manufactureDate}｜效期 ${r.expiryDate}` : ''}${short ? '｜缺 ' + fmt(o.shortage) : ''}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`;
  return `<span class="pill ${add ? (r.pool === 'stock' ? 'future' : 'ok') : short ? 'bad' : 'expired'} exp-chip" title="${esc(tip)}"><span class="mono">${esc(md(r.date))}</span> ${pn}${add ? '＋' : '－'}${esc(fmt(r.quantity))} ${u}${short ? `（缺 ${esc(fmt(o.shortage))}）` : ''}${r.note ? ` ${esc(r.note.replace(/^入口網站：/, ''))}` : ''}</span>`;
};
function renderAdjust(ledger) {
  const recs = data.movements.filter(r => r.type === 'adjust');
  const groups = groupByProduct(recs, $('adjustFilter').value, ['date', 'note', 'by', 'manufactureDate']);
  const sumOf = (list, pool, d) => sumQ(list.filter(r => (r.pool === 'stock' ? 'stock' : 'semi') === pool && r.dir === d));
  const nz = v => `<td class="num">${v ? fmt(v) : '—'}</td>`;
  $('adjustCount').textContent = `共 ${groups.length} 項產品、${recs.length} 筆增減（含入口網站帶入的）；每個品號一列，日期新的在前（綠＝半成品增加、藍＝現貨增加、紅＝減少），點「明細」看每一筆`;
  $('adjustTable').innerHTML = table(['產品', '增減紀錄（日期新到舊）', '半成品＋#', '半成品－#', '現貨＋#', '現貨－#', '缺口#', '明細'], groups.map(g => {
    const short = sumQ(g.recs, r => (ledger.adjusts.get(r.id) || {}).shortage || 0), more = g.recs.length > CHIP_MAX ? `<button type="button" class="pill other exp-chip linkchip" data-action="adjust-detail" data-id="${esc(g.product)}">還有 ${g.recs.length - CHIP_MAX} 筆…</button>` : '';
    return `<tr>${td(`<strong>${esc(g.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${g.recs.slice(0, CHIP_MAX).map(r => adjChip(r, ledger.adjusts.get(r.id))).join('')}${more}</div></td>${nz(sumOf(g.recs, 'semi', 'add'))}${nz(sumOf(g.recs, 'semi', 'sub'))}${nz(sumOf(g.recs, 'stock', 'add'))}${nz(sumOf(g.recs, 'stock', 'sub'))}<td class="num">${short ? badge(fmt(short), 'bad') : '—'}</td>${td(`<button type="button" class="btn small" data-action="adjust-detail" data-id="${esc(g.product)}">明細</button>`)}</tr>`;
  }), '還沒有半成品／現貨增減紀錄');
}
async function openAdjustDetail(product) {
  const L = calculateLedger(), u = esc(getUnit(product)), canEdit = can('produce');
  const rows = data.movements.filter(r => r.type === 'adjust' && r.product === product).sort((a, b) => cmp(b.date, a.date) || b.seq - a.seq);
  const html = table(['日期', '類別', '增減', '數量#', '製作／有效日期或實際扣除', '缺口#', '原因／備註', '登錄人', ...(canEdit ? ['管理'] : [])], rows.map(r => {
    const o = L.adjusts.get(r.id), add = r.dir === 'add';
    const what = o && o.parts.length ? `${!add && r.fromMfg ? `指定 製 ${r.fromMfg}・效期 ${r.fromExp}｜` : ''}${adjPartsText(o.parts)}` : add ? `製作 ${r.manufactureDate}・效期 ${r.expiryDate}` : '—';
    const manage = r.id.startsWith('pt-') ? '<span class="pill other" title="入口網站同步的數字，要修改請在入口網站改後再同步">入口網站</span>' : `<button type="button" class="btn small danger" data-action="adjust-delete" data-id="${esc(r.id)}">刪除</button>`;
    return `<tr>${tdm(r.date)}${td(esc(poolName(r.pool)))}${td(badge(add ? '增加' : '減少', add ? 'ok' : 'expired'))}<td class="num">${fmt(r.quantity)} ${u}</td>${td(esc(what))}<td class="num">${o && o.shortage ? fmt(o.shortage) : '—'}</td>${td(esc(r.note || '—'))}${tdWho(r)}${canEdit ? td(manage) : ''}</tr>`;
  }));
  await modal({ title: `「${product}」的半成品／現貨增減（${rows.length} 筆）`, html: `<div class="table-scroll">${html}</div>`, ok: '關閉', wide: true, noCancel: true });
}
async function deleteAdjust(id) {
  closeModal();
  if (!can('produce') || String(id).startsWith('pt-')) return;
  const r = data.movements.find(x => x.id === id && x.type === 'adjust'); if (!r) return;
  if (!await modal({ title: '刪除這筆增減？', html: `<p>${esc(`${r.date}｜${poolName(r.pool)}${r.dir === 'add' ? '增加' : '減少'} ${r.product} ${fmt(r.quantity)} ${getUnit(r.product)}${r.note ? '｜' + r.note : ''}`)}</p><p class="modal-note">刪除後，庫存、轉現貨與出貨扣批會重新計算。</p>`, ok: '刪除', danger: true })) return;
  act(() => { FEStore.remove('moves', r.id); toast('已刪除，庫存已重算'); });
}

/* ---------- 庫存盤點（總公司） ----------
   盤點單（type 'session'）：日期＋時間點（end＝當天結束、start＝當天開始前）＋狀態（open 盤點中／done 已完成）。
   每列實盤（type 'count'）：一列一筆（好幾個人一起盤時各存各的，不會互相蓋掉），key＝現貨「S|產品|批號|有效日期」、半成品「M|產品|製作日期|有效日期」。
   帳上數量：照批次庫存（盤點日當天結束；當天開始前＝前一天結束）即時算，所以批次校正後帳上會跟著變。
   差異處理：同一個品項、同一類（現貨或半成品）每列都盤了、總數一樣、只是批號／效期分布不同 →「批次校正」產生增減紀錄（舊批減、新批加，phase 'close'＝當天最後）；
   總數不一樣 → 列在「總數差異」請到總表修正（下次同步會以手動數字或隔夜差異帶進來），App 不另外調，避免扣兩次。 */
function sanitizeAudit(r) {
  if (!r || typeof r !== 'object' || !r.id || !isDate(r.date)) return null;
  const base = { id: String(r.id), date: r.date, by: clean(r.by), at: r.at || '', ...(r.editBy ? { editBy: clean(r.editBy), editAt: r.editAt || '' } : {}), ...(SHOPS.some(x => x.id === r.shop) ? { shop: r.shop } : {}) };
  if (r.type === 'session') return { ...base, type: 'session', seq: Number(r.seq) || 0, phase: r.phase === 'start' ? 'start' : 'end', status: r.status === 'done' ? 'done' : 'open', note: clean(r.note), appliedAt: r.appliedAt || '', appliedBy: clean(r.appliedBy) };
  if (r.type === 'count') {
    const q = Number(r.qty), product = clean(r.product), key = String(r.key || '');
    if (!r.session || !product || !key || !(q >= 0) || q >= 1e7) return null;
    return { ...base, type: 'count', session: String(r.session), key, product, pool: r.pool === 'stock' ? 'stock' : 'semi', batch: clean(r.batch), mfg: isDate(r.mfg) ? r.mfg : '', exp: isDate(r.exp) ? r.exp : '', qty: clampQty(q), added: !!r.added, ...(isDate(r.sellFrom) ? { sellFrom: r.sellFrom } : {}) };
  }
  return null;
}
const auditKey = (product, pool, batch, mfg, exp) => pool === 'stock' ? `S|${product}|${batch}|${exp}` : `M|${product}|${mfg}|${exp}`;
let auditSel = '', auditMode = 'all', auditDirty = false;
const auditSessions = () => data.audits.filter(r => r.type === 'session' && !r.shop).sort((a, b) => cmp(b.date, a.date) || b.seq - a.seq);
const auditSession = () => auditSessions().find(r => r.id === auditSel) || auditSessions()[0] || null;
// 帳上：盤點時間點的批次庫存（現貨依批號＋有效日期、半成品依製作日期＋有效日期），已過期的也列
function auditBook(sess) {
  const asOf = sess.phase === 'start' ? addDays(sess.date, -1) : sess.date, L = calculateLedger(asOf), m = new Map();
  for (const l of L.lots) {
    if (!(l.remaining > 1e-7)) continue;
    const stock = l.pool === 'stock' || (l.batch && l.batch !== '—'), opening = l.expiryDate === NO_EXPIRY, batch = stock ? (opening ? '期初現貨' : l.batch) : '';
    const key = auditKey(l.product, stock ? 'stock' : 'semi', batch, l.manufactureDate, l.expiryDate);
    const x = m.get(key) || { key, product: l.product, pool: stock ? 'stock' : 'semi', batch, mfg: l.manufactureDate, exp: l.expiryDate, book: 0 };
    x.book = clampQty(x.book + l.remaining); m.set(key, x);
  }
  return m;
}
// 盤點表：帳上的每一列＋實盤新增的列；每個品項分現貨、半成品兩組，各自算狀態
function auditSheet(sess) {
  const book = auditBook(sess), counts = new Map(data.audits.filter(r => r.type === 'count' && r.session === sess.id).map(r => [r.key, r]));
  const lines = new Map([...book.values()].map(x => [x.key, { ...x, count: null, rec: null }]));
  for (const [k, c] of counts) { const x = lines.get(k) || { key: k, product: c.product, pool: c.pool, batch: c.batch, mfg: c.mfg, exp: c.exp, book: 0, added: true }; x.count = c.qty; x.rec = c; lines.set(k, x); }
  const byP = new Map();
  for (const x of lines.values()) { if (!byP.has(x.product)) byP.set(x.product, { product: x.product, stock: [], semi: [] }); byP.get(x.product)[x.pool].push(x); }
  const groupStat = list => {
    if (!list.length) return null;
    const counted = list.filter(x => x.count !== null), book = sumQ(list, x => x.book), cnt = sumQ(counted, x => x.count);
    const st = !counted.length ? 'todo' : counted.length < list.length ? 'partial' : list.every(x => Math.abs(x.count - x.book) < 1e-7) ? 'ok' : Math.abs(cnt - book) < 1e-7 ? 'dist' : 'total';
    return { st, book, cnt, counted: counted.length, n: list.length };
  };
  const prods = [...byP.values()].map(p => {
    const sort = (a, b) => (a.exp === NO_EXPIRY ? 0 : 1) - (b.exp === NO_EXPIRY ? 0 : 1) || cmp(a.exp, b.exp) || cmp(a.batch || a.mfg, b.batch || b.mfg);
    p.stock.sort(sort); p.semi.sort(sort);
    return { ...p, gs: groupStat(p.stock), gm: groupStat(p.semi) };
  }).sort((a, b) => productOrder(a.product, b.product));
  return { prods, counts };
}
const AUDIT_ST = { todo: ['未盤', 'other'], partial: ['盤點中', 'due'], ok: ['一致', 'ok'], dist: ['分布不同（總數一樣）', 'due'], total: ['總數不同', 'bad'] };
function renderAudit() {
  if (!$('auditList')) return;
  const ss = auditSessions(), sess = auditSession(), editP = can('produce');
  $('auditListInfo').textContent = ss.length ? `共 ${ss.length} 張盤點單，點一下打開` : '還沒有盤點單，按右邊「新增盤點單」開始';
  $('auditList').innerHTML = table(['盤點日期', '時間點', '狀態', '建立人', ''], ss.map(r => `<tr${sess && r.id === sess.id ? ' class="row-on"' : ''}>${tdm(r.date)}${td(r.phase === 'start' ? '當天開始前' : '當天結束')}${td(r.status === 'done' ? badge('已完成', 'ok') : badge('盤點中', 'due'))}${td(esc(r.by || '—'))}${td(`<button type="button" class="btn small" data-action="audit-open" data-id="${esc(r.id)}">${sess && r.id === sess.id ? '目前這張' : '打開'}</button>`)}</tr>`), '還沒有盤點單');
  const panel = $('auditSheetPanel'); panel.hidden = !sess; if (!sess) return;
  // 正在輸入實盤時先不重畫表格，離開輸入框再更新
  if ($('auditTable').contains(document.activeElement) && document.activeElement.matches('[data-aud]')) { auditDirty = true; return; }
  auditDirty = false;
  const { prods } = auditSheet(sess), edit = editP && sess.status !== 'done';
  document.querySelectorAll('#auditSeg [data-amode]').forEach(b => b.classList.toggle('on', b.dataset.amode === auditMode));
  const all = prods.flatMap(p => [p.gs, p.gm].filter(Boolean)), cnt = st => all.filter(g => g.st === st).length;
  const dist = prods.flatMap(p => [['stock', p.gs, p.stock], ['semi', p.gm, p.semi]].filter(([, g]) => g && g.st === 'dist').map(([pool, g, list]) => ({ product: p.product, pool, list })));
  const totals = prods.flatMap(p => [['現貨', p.gs], ['半成品', p.gm]].filter(([, g]) => g && g.st === 'total').map(([k, g]) => ({ product: p.product, kind: k, book: g.book, cnt: g.cnt })));
  const corr = data.movements.filter(r => String(r.id).startsWith(`aud-${sess.id}-`));
  $('auditTitle').textContent = `盤點表：${sess.date}（${sess.phase === 'start' ? '當天開始前' : '當天結束'}）`;
  $('auditInfo').textContent = `${sess.status === 'done' ? '已完成' : '盤點中'}｜帳上＝${sess.phase === 'start' ? `${addDays(sess.date, -1)} 結束` : `${sess.date} 結束`}的批次庫存｜一致 ${cnt('ok')} 組、分布不同 ${cnt('dist')} 組、總數不同 ${cnt('total')} 組、盤點中 ${cnt('partial')} 組、未盤 ${cnt('todo')} 組（每個品項的現貨、半成品各算一組）`;
  $('auditActions').innerHTML = [
    dist.length ? `<div class="notice warning"><strong>分布不同（總數一樣）${dist.length} 組</strong>：${esc(dist.map(d => `${productCodeOf(d.product)} ${d.pool === 'stock' ? '現貨' : '半成品'}`).join('、'))}。按「批次校正」會讓帳上的批號／效期照實盤調整（舊的減、對的加，總數不變，跟總表一致）。${edit ? ' <button type="button" class="btn small primary" data-action="audit-apply">批次校正</button>' : ''}</div>` : '',
    totals.length ? `<div class="notice danger"><strong>總數不同 ${totals.length} 組，請到總表（入口網站）修正</strong>，下次同步會以手動數字或隔夜差異帶進來；App 不另外調整，避免扣兩次：${esc(totals.map(t => `${t.product} ${t.kind} 帳上 ${fmt(t.book)}／實盤 ${fmt(t.cnt)}（${t.cnt > t.book ? '多' : '少'} ${fmt(Math.abs(clampQty(t.cnt - t.book)))}）`).join('；'))}</div>` : '',
    corr.length ? `<div class="notice">這張盤點單做過批次校正 ${corr.length} 筆增減（${esc(sess.appliedAt ? new Date(sess.appliedAt).toLocaleString('zh-TW') : '')}${sess.appliedBy ? '，' + esc(sess.appliedBy) : ''}），在「半成品／現貨增減」頁看得到。${editP ? ' <button type="button" class="btn small danger" data-action="audit-unapply">取消這張的批次校正</button>' : ''}</div>` : '',
    editP ? `<div class="form-actions">${edit ? '<button type="button" class="btn small" data-action="audit-add">＋ 新增一列（帳上沒有的批號）</button><button type="button" class="btn small primary" data-action="audit-done">完成盤點</button>' : '<button type="button" class="btn small" data-action="audit-reopen">重新開啟</button>'}<button type="button" class="btn small danger" data-action="audit-delete">刪除盤點單</button></div>` : ''].join('');
  const q = clean($('auditFilter').value).toLowerCase();
  const show = p => { const gs = [p.gs, p.gm].filter(Boolean); if (auditMode === 'diff' && !gs.some(g => g.st === 'dist' || g.st === 'total' || [...p.stock, ...p.semi].some(x => x.count !== null && Math.abs(x.count - x.book) > 1e-7))) return false; if (auditMode === 'todo' && !gs.some(g => g.st === 'todo' || g.st === 'partial')) return false; return !q || p.product.toLowerCase().includes(q) || [...p.stock, ...p.semi].some(x => (x.batch || x.mfg || '').toLowerCase().includes(q)); };
  const rows = [];
  for (const p of prods.filter(show)) {
    const u = esc(getUnit(p.product)), gb = g => g ? `${badge(AUDIT_ST[g.st][0], AUDIT_ST[g.st][1])} <span class="who">帳上 ${fmt(g.book)}／實盤 ${g.counted ? fmt(g.cnt) : '—'}</span>` : '';
    rows.push(`<tr class="aud-prod"><td colspan="6"><strong>${esc(p.product)}</strong>　${p.gs ? '現貨 ' + gb(p.gs) : ''}${p.gs && p.gm ? '　' : ''}${p.gm ? '半成品 ' + gb(p.gm) : ''}</td></tr>`);
    for (const x of [...p.stock, ...p.semi]) {
      const d = x.count === null ? null : clampQty(x.count - x.book), gone = x.exp !== NO_EXPIRY && x.exp < sess.date;
      rows.push(`<tr>${td(x.pool === 'stock' ? badge('現貨', 'future') : badge('半成品', 'other'))}${td(`<span class="mono">${esc(x.pool === 'stock' ? x.batch : '製 ' + x.mfg)}</span>${x.added ? ' ' + badge('實盤新增', 'due') : ''}`)}${td(`<span class="mono">${esc(expShow(x.exp))}</span>${gone ? ' ' + badge('已過期', 'expired') : ''}`)}<td class="num">${fmt(x.book)} ${u}</td><td class="num">${edit ? `<input class="aud-in" type="number" inputmode="numeric" min="0" step="1" value="${x.count === null ? '' : esc(x.count)}" placeholder="未盤" data-aud="${esc(x.key)}" aria-label="${esc(p.product)} ${esc(x.batch || x.mfg)} 實盤">` : (x.count === null ? '—' : fmt(x.count))}</td><td class="num">${d === null ? '—' : Math.abs(d) < 1e-7 ? badge('0', 'ok') : badge((d > 0 ? '＋' : '－') + fmt(Math.abs(d)), 'bad')}</td></tr>`);
    }
  }
  $('auditTable').innerHTML = table(['類別', '批號／製作日期', '有效日期', '帳上#', '實盤#', '差異#'], rows, auditMode === 'all' ? '這個盤點時間點沒有庫存' : '沒有符合的品項');
}
// 存一列實盤（空白＝刪掉，回到未盤）
function auditSave(el) {
  const sess = auditSession(); if (!sess || sess.status === 'done' || !can('produce')) return;
  const key = el.dataset.aud, line = auditSheet(sess).prods.flatMap(p => [...p.stock, ...p.semi]).find(x => x.key === key); if (!line) return;
  const v = el.value.trim(), id = `cnt-${sess.id}-${key}`;
  if (v === '') { if (line.rec) act(() => FEStore.remove('audit', line.rec.id)); return; }
  const n = Number(v); if (!Number.isFinite(n) || n < 0) { toast('實盤數量要是 0 以上的數字', true); return; }
  act(() => FEStore.save('audit', { id, type: 'count', session: sess.id, date: sess.date, key, product: line.product, pool: line.pool, batch: line.batch, mfg: line.mfg, exp: line.exp, qty: n, added: !!line.added, ...(line.rec ? { by: line.rec.by, at: line.rec.at, ...stampEdit() } : stampNew()) }));
}
async function auditNew() {
  if (!can('produce')) return;
  const res = await modal({ title: '新增盤點單', ok: '建立', html: `<div class="field"><label for="an-date">盤點日期</label><input id="an-date" type="date" value="${TODAY()}"></div><div class="field"><label for="an-phase">時間點</label><select id="an-phase"><option value="end">當天結束（已扣當天出貨，下班後盤）</option><option value="start">當天開始前（早上開工前盤）</option></select></div><p class="modal-note">帳上數量照「批次庫存與有效日期」在這個時間點的數字；盤點時有新的同步，帳上會跟著更新。</p><p class="modal-error" hidden></p>`, collect: b => { const date = b.querySelector('#an-date').value, phase = b.querySelector('#an-phase').value; if (!isDate(date)) throw Error('請選盤點日期'); return { date, phase }; } });
  if (!res) return;
  const id = 'aud' + uid().replace(/[^A-Za-z0-9]/g, '').slice(-10);
  act(() => { FEStore.save('audit', { id, type: 'session', seq: nextSeq(), date: res.date, phase: res.phase, status: 'open', note: '', ...stampNew() }); auditSel = id; toast(`已建立 ${res.date} 的盤點單，開始填實盤數量`); });
}
async function auditAddLine() {
  const sess = auditSession(); if (!sess || sess.status === 'done' || !can('produce')) return;
  const res = await modal({ title: '新增一列（帳上沒有的批號）', ok: '加入', html: `<div class="field"><label for="al-product">產品</label><input id="al-product" list="productNames" placeholder="輸入品號或品名" autocomplete="off"></div><div class="field"><label for="al-pool">類別</label><select id="al-pool"><option value="stock">現貨（填批號）</option><option value="semi">半成品（填製作日期）</option></select></div><div class="field"><label for="al-batch">批號（現貨）</label><input id="al-batch" placeholder="例如 CKAS7H01" maxlength="30" style="text-transform:uppercase"></div><div class="field"><label for="al-mfg">製作日期（半成品）</label><input id="al-mfg" type="date"></div><div class="field"><label for="al-exp">有效日期</label><input id="al-exp" type="date"></div><div class="field"><label for="al-qty">實盤數量</label><input id="al-qty" type="number" min="0" step="1" inputmode="numeric"></div><p class="modal-error" hidden></p>`,
    collect: b => {
      const p = getProduct(b.querySelector('#al-product').value), pool = b.querySelector('#al-pool').value, batch = cleanBatch(b.querySelector('#al-batch').value), mfg = b.querySelector('#al-mfg').value, exp = b.querySelector('#al-exp').value, qty = Number(b.querySelector('#al-qty').value);
      if (!p) throw Error('請從清單選產品'); if (pool === 'stock' && !batch) throw Error('現貨要填批號'); if (pool === 'semi' && !isDate(mfg)) throw Error('半成品要填製作日期'); if (!isDate(exp)) throw Error('請填有效日期'); if (!(qty >= 0) || !Number.isFinite(qty)) throw Error('請填實盤數量');
      return { product: p.name, pool, batch: pool === 'stock' ? batch : '', mfg: pool === 'stock' ? (isDate(mfg) ? mfg : addDays(exp, -stockDaysOf())) : mfg, exp, qty };
    } });
  if (!res) return;
  const key = auditKey(res.product, res.pool, res.batch, res.mfg, res.exp);
  act(() => { FEStore.save('audit', { id: `cnt-${sess.id}-${key}`, type: 'count', session: sess.id, date: sess.date, key, product: res.product, pool: res.pool, batch: res.batch, mfg: res.mfg, exp: res.exp, qty: res.qty, added: true, ...stampNew() }); toast('已加入'); });
}
// 批次校正：「分布不同（總數一樣）」的組，舊的減、對的加（當天最後；當天開始前的盤點記在前一天最後）
async function auditApply() {
  const sess = auditSession(); if (!sess || !can('produce')) return;
  const { prods } = auditSheet(sess), date = sess.phase === 'start' ? addDays(sess.date, -1) : sess.date, recs = [], who = myName(), at = nowIso();
  let n = data.movements.filter(r => String(r.id).startsWith(`aud-${sess.id}-`)).length;
  for (const p of prods) for (const [pool, g, list] of [['stock', p.gs, p.stock], ['semi', p.gm, p.semi]]) {
    if (!g || g.st !== 'dist') continue;
    for (const x of list) {
      const d = clampQty(x.count - x.book); if (Math.abs(d) < 1e-7) continue;
      const base = { id: `aud-${sess.id}-${++n}`, type: 'adjust', seq: nextSeq(), date, product: p.product, quantity: Math.abs(d), note: `盤點批次校正（${sess.date}）`, phase: 'close', ...(pool === 'stock' ? { pool: 'stock' } : {}), by: who, at };
      recs.push(d < 0 ? { ...base, dir: 'sub', fromMfg: pool === 'stock' ? '' : x.mfg, fromExp: x.exp, ...(pool === 'stock' && x.batch !== '期初現貨' ? { fromBatch: x.batch } : {}) }
        : { ...base, dir: 'add', manufactureDate: x.mfg || date, expiryDate: x.exp === NO_EXPIRY ? addDays(date, stockDaysOf()) : x.exp, ...(pool === 'stock' && x.batch !== '期初現貨' ? { batch: x.batch } : {}) });
    }
  }
  if (!recs.length) return;
  if (!await modal({ title: '批次校正', ok: '校正', html: `<p>會新增 ${recs.length} 筆增減紀錄（記在 ${esc(date)} 最後），讓帳上的批號／效期照實盤：</p><ul>${recs.map(r => `<li>${esc(productCodeOf(r.product))} ${r.pool === 'stock' ? '現貨' : '半成品'} ${r.dir === 'add' ? '＋' : '－'}${fmt(r.quantity)}　${esc(r.dir === 'add' ? (r.batch || '製 ' + r.manufactureDate) + '・效期 ' + r.expiryDate : (r.fromBatch || (r.fromMfg ? '製 ' + r.fromMfg : '')) + '・效期 ' + r.fromExp)}</li>`).join('')}</ul><p class="modal-note">每組總數不變，跟總表一致；之後可以按「取消這張的批次校正」還原。</p>` })) return;
  act(() => { FEStore.saveMany('moves', recs.map(recordBody)); FEStore.save('audit', { ...sess, appliedAt: Date.now(), appliedBy: who, ...stampEdit() }); toast(`已批次校正 ${recs.length} 筆，帳上已跟實盤一致`); });
}
async function auditUnapply() {
  const sess = auditSession(); if (!sess || !can('produce')) return;
  const ids = data.movements.filter(r => String(r.id).startsWith(`aud-${sess.id}-`)).map(r => r.id); if (!ids.length) return;
  if (!await modal({ title: '取消批次校正？', ok: '取消校正', danger: true, html: `<p>會刪掉這張盤點單做的 ${ids.length} 筆增減紀錄，帳上回到校正前。</p>` })) return;
  act(() => { FEStore.removeMany('moves', ids); FEStore.save('audit', { ...sess, appliedAt: '', appliedBy: '', ...stampEdit() }); toast('已取消批次校正'); });
}
function auditStatus(status) { const sess = auditSession(); if (!sess || !can('produce')) return; act(() => { FEStore.save('audit', { ...sess, status, ...stampEdit() }); toast(status === 'done' ? '盤點單已完成（不能再改實盤；要改請按「重新開啟」）' : '已重新開啟盤點單'); }); }
async function auditDelete() {
  const sess = auditSession(); if (!sess || !can('produce')) return;
  const cnts = data.audits.filter(r => r.type === 'count' && r.session === sess.id).map(r => r.id), corr = data.movements.filter(r => String(r.id).startsWith(`aud-${sess.id}-`)).length;
  if (!await modal({ title: '刪除這張盤點單？', ok: '刪除', danger: true, html: `<p>${esc(sess.date)}（${sess.phase === 'start' ? '當天開始前' : '當天結束'}）的盤點單與 ${cnts.length} 筆實盤數量會刪除，不能復原。</p>${corr ? `<p class="modal-note">這張做過的 ${corr} 筆批次校正不會刪掉；要還原請先按「取消這張的批次校正」。</p>` : ''}` })) return;
  act(() => { FEStore.removeMany('audit', [sess.id, ...cnts]); auditSel = ''; toast('已刪除盤點單'); });
}
function auditCsv() {
  const sess = auditSession(); if (!sess) return;
  const { prods } = auditSheet(sess), rows = [];
  for (const p of prods) for (const x of [...p.stock, ...p.semi]) { const g = x.pool === 'stock' ? p.gs : p.gm; rows.push([p.product, getUnit(p.product), x.pool === 'stock' ? '現貨' : '半成品', x.pool === 'stock' ? x.batch : '', x.pool === 'stock' ? '' : x.mfg, expShow(x.exp), x.book, x.count === null ? '' : x.count, x.count === null ? '' : clampQty(x.count - x.book), g ? AUDIT_ST[g.st][0] : '', x.added ? '實盤新增' : '', x.rec ? (x.rec.editBy || x.rec.by) : '']); }
  const content = '\ufeff' + [['產品', '單位', '類別', '批號', '製作日期', '有效日期', '帳上', '實盤', '差異', '這組狀態', '備註', '盤點人'], ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  downloadFile(`庫存盤點_${sess.date}_${sess.phase === 'start' ? '開始前' : '結束'}.csv`, content, 'text/csv;charset=utf-8', '盤點表 CSV 已下載');
}

/* ---------- 門市庫存（A11、京站、東橋，各一頁） ----------
   門市規則：門市的有效日期從「配送到門市（入貨）」那天開始算，入貨日＋門市保存天數（預設 15 天），跟工廠製作日期算出來的效期無關。
   門市人員登錄：入貨（批號選填；沒填就照總公司當天的出貨扣批「推定」）、銷售、報廢。資料存在 shop_YYYYMM，每筆入貨記下當時算好的有效日期（之後改規則不影響已入貨的）。
   銷售、報廢可指定批號；沒指定就從最早到期的扣（先到期先出）。已過期的不能銷售，只能報廢；不夠扣的列為缺口，不會變負庫存。 */
// take＝領取（系統調整明細表的「領取」：試吃、員工領用等，從門市庫存扣掉；跟報廢一樣，已過期的也能扣）
// loss＝盤虧（門市盤點的調整，照批號扣；批號不明的列 unk＝只扣批號不明的）；盤點多出來的記成入貨（aud＝哪張盤點單），畫面上叫「盤盈」
const SHOP_TYPES = { in: '入貨', sale: '銷售', waste: '報廢', take: '領取', loss: '盤虧' };
const shopTypeLabel = r => r.type === 'in' && r.aud ? '盤盈' : SHOP_TYPES[r.type];
const shopMode = Object.fromEntries(SHOPS.map(s => [s.id, 'all']));
const shopName = id => (SHOPS.find(s => s.id === id) || {}).name || id;
// 門市的可販售天數與提醒日存在 settings 'sell'（見 sellRule）；舊的 settings 'shop' 已不用
// 門市：入貨那天算第 1 天，最後可販售日＝入貨日＋可販售天數－1（依產品類別；規則改了，已入貨的也跟著重算）
const shopExpiryFor = (product, date) => sellEnd(product, date);
// sellFrom＝可販售期的第 1 天（盤盈的入貨：照原本那批貨的入貨日，或保守用批號的製造日期）；沒有就是入貨日
const shopExp = r => shopExpiryFor(r.product, r.sellFrom || r.date);
const cleanBatch = v => clean(v).toUpperCase().replace(/\s+/g, '').slice(0, 30);
// 訂單單號（OO20261116006、WB00160088833；揀貨總表的「-20261111」日期尾巴去掉）
const ORDER_RE = /^[A-Z]{1,4}\d{5,20}$/;
const orderNo = v => { const t = clean(v).toUpperCase().split('-')[0]; return ORDER_RE.test(t) ? t : ''; };
function sanitizeShop(r) {
  if (!r || typeof r !== 'object' || !r.id || !SHOPS.some(s => s.id === r.shop) || !SHOP_TYPES[r.type] || !isDate(r.date)) return null;
  const q = Number(r.quantity), product = clean(r.product);
  if (!product || !(q > 0) || !Number.isFinite(q)) return null;
  const x = { id: String(r.id), seq: Number(r.seq) || 0, shop: r.shop, type: r.type, date: r.date, product, quantity: q, batch: cleanBatch(r.batch), note: clean(r.note), by: clean(r.by), at: r.at || '', ...(r.editBy ? { editBy: clean(r.editBy), editAt: r.editAt || '' } : {}) };
  if (r.aud) x.aud = clean(r.aud).slice(0, 40);
  if (r.phase === 'open' || r.phase === 'close') x.phase = r.phase;
  if (r.type === 'in' && isDate(r.sellFrom) && r.sellFrom <= r.date) x.sellFrom = r.sellFrom;
  if (r.type === 'loss' && r.unk) x.unk = true;
  if (r.type === 'in') {
    x.expiryDate = isDate(r.expiryDate) ? r.expiryDate : ''; if (isDate(r.fromDate)) x.fromDate = r.fromDate;
    // scan：門市確認的批號數量 { 批號: 數量 }（按「確認」或點選正確的批號）
    if (r.scan && typeof r.scan === 'object') { const sc = {}; for (const [b, v] of Object.entries(r.scan).slice(0, 30)) { const k = cleanBatch(b), n = Number(v); if (k && n > 0 && n < 1e7) sc[k] = clampQty((sc[k] || 0) + n); } if (Object.keys(sc).length) x.scan = sc; }
    // orders：組合品是哪幾張訂單寄來的 { 訂單單號: 數量 }（揀貨總表帶入；空物件＝新版帶入、但沒有訂單）
    if (r.orders && typeof r.orders === 'object') { const od = {}; for (const [k, v] of Object.entries(r.orders).slice(0, 500)) { const n = Number(v); if (ORDER_RE.test(k) && n > 0 && n < 1e7) od[k] = clampQty((od[k] || 0) + n); } x.orders = od; }
  } else if (r.pref && typeof r.pref === 'object') {
    // pref：匯入的 POS 銷售明細上的批號 { 批號: 數量 }（門市帳先扣這些批號，不夠才先到期先扣）
    const pf = {}; for (const [b, v] of Object.entries(r.pref).slice(0, 30)) { const k = cleanBatch(b), n = Number(v); if (k && n > 0 && n < 1e7) pf[k] = clampQty((pf[k] || 0) + n); } if (Object.keys(pf).length) x.pref = pf;
  }
  return x;
}
// 重放一間門市的紀錄：同一天先入貨再扣；回傳 lots（每筆入貨的剩餘量）與 outs（每筆銷售／報廢扣了哪些批號、缺多少）
// 同一天的順序：當天開始前的盤點調整 → 入貨 → 銷售／報廢／領取 → 當天最後的盤點調整。planIn：批號推定（預設照 list 算）
const shopRank = r => r.phase === 'open' ? -1 : r.phase === 'close' ? 2 : r.type === 'in' ? 0 : 1;
function shopLedger(shop, list = data.shops, planIn = null) {
  const recs = list.filter(r => r.shop === shop).sort((a, b) => cmp(a.date, b.date) || shopRank(a) - shopRank(b) || a.seq - b.seq);
  const lots = [], outs = new Map(), plan = planIn || shopBatchPlan(list);
  for (const r of recs) {
    if (r.type === 'in') {
      // 門市確認過的（填批號、按確認、點選）＋沒確認的照總公司出貨扣批推定（可能拆成好幾個批號）
      const parts = plan.get(r.id) || [{ batch: '', qty: r.quantity, unknown: true }];
      parts.forEach((p, k) => lots.push({ id: `${r.id}#${k}`, recId: r.id, product: r.product, batch: p.batch || '', guess: !p.confirmed, opening: !!p.opening, expiry: shopExp(r), date: r.date, qty: p.qty, left: p.qty }));
      continue;
    }
    let need = r.quantity; const parts = [];
    const cand = lots.filter(l => l.product === r.product && l.left > 0 && l.date <= r.date && (!r.batch || l.batch === r.batch) && (!r.unk || !l.batch) && (r.type !== 'sale' || l.expiry >= r.date)).sort((a, b) => cmp(a.expiry, b.expiry) || cmp(a.date, b.date));
    const take = (l, want) => { const q = clampQty(Math.min(l.left, want)); if (q <= 0) return 0; l.left = clampQty(l.left - q); need = clampQty(need - q); const x = parts.find(y => y.batch === l.batch && y.expiry === l.expiry && y.date === l.date); if (x) x.q = clampQty(x.q + q); else parts.push({ batch: l.batch, expiry: l.expiry, q, date: l.date }); return q; };
    // 匯入的 POS 銷售明細有批號（r.pref { 批號: 數量 }）：先扣那個批號，不夠或門市沒有那個批號才照先到期先扣（不會因為批號對不上就變缺口）
    if (r.pref && !r.batch) for (const [b, pq] of Object.entries(r.pref)) { let want = clampQty(Math.min(Number(pq) || 0, need)); for (const l of cand) { if (want <= 0) break; if (l.batch === b) want = clampQty(want - take(l, want)); } }
    for (const l of cand) { if (need <= 0) break; take(l, need); }
    outs.set(r.id, { done: clampQty(r.quantity - need), short: need, parts });
  }
  return { lots, outs };
}
const shopPartsText = parts => parts.map(p => `${p.batch || '批號不明'}（可販售到 ${md(p.expiry)}）×${fmt(p.q)}`).join('、');
/* ---------- 門市入貨的推定批號 ----------
   入貨沒填批號時：從總公司「轉出日」（預設＝入貨日）這個品號的實際揀貨扣到的批號裡，照效期最早的先分給門市
   （出貨扣批本來就是先到期先出，所以門市拿到的就是那天出去的批）。同一天好幾間門市照 A11 → 京站 → 東橋 的順序分。
   有匯入那天的交易明細時，先扣掉總公司出給客人的批號（明細上的），只從剩下的分給門市（2026-11-20 起）。
   批號：現貨用那批的批號；直接從半成品出的貨用出貨當天的批號；期初現貨沒有批號資料（標「期初現貨」）。
   有填批號（門市人員更正過）的入貨先佔掉那個批號的量，剩下的才分給推定的；分不夠的標「批號不明」。
   門市到期日一律＝入貨日＋門市保存天數，跟批號無關，所以就算批號推錯，剩幾天還是對的。 */
const shopFrom = r => isDate(r.fromDate) ? r.fromDate : r.date;
// 總公司某天可以分給門市的批號（依品號第一段，例如 CK-01 6原 和 CK-01|YB-86 6原|天蠍烙 同一組，批號本來就一樣）：
// 那天出貨扣到的批號，扣掉照交易明細（總公司出給客人）扣的部分（a.tx），剩下的就是寄門市（和試吃等）的；
// 交易明細只有品號第一段、分不出一般品和組合品，所以剩下的也照第一段一起分。沒有匯入那天交易明細時＝那天出貨扣到的全部批號
function hqShipBatches(ledger) {
  const m = new Map();
  for (const r of data.movements) {
    if (r.type !== 'shipment') continue;
    const s = ledger.shipments.get(r.id); if (!s) continue;
    const k = r.date + '|' + baseCode(r.product), list = m.get(k) || [];
    for (const a of s.allocations) {
      if (a.tx) continue;
      const opening = a.expiryDate === NO_EXPIRY, batch = opening ? '' : (a.batch && a.batch !== '—' ? a.batch : makeBatch(r.product, r.date) || '');
      const x = list.find(p => p.batch === batch && p.opening === opening);
      if (x) { x.qty = clampQty(x.qty + a.quantity); if (a.expiryDate < x.exp) x.exp = a.expiryDate; } else list.push({ batch, exp: a.expiryDate, qty: a.quantity, used: 0, opening });
    }
    m.set(k, list);
  }
  for (const list of m.values()) list.sort((a, b) => (a.opening ? 0 : 1) - (b.opening ? 0 : 1) || cmp(a.exp, b.exp) || cmp(a.batch, b.batch));
  return m;
}
// 門市已確認的批號數量：r.batch（整筆都是這個批號）或 r.scan（按確認、點選確認的 { 批號: 數量 }），最多到入貨數量
function shopConfirmed(r) {
  if (r.type !== 'in') return {};
  if (r.batch) return { [r.batch]: r.quantity };
  const o = {}; let left = r.quantity;
  for (const [b, q] of Object.entries(r.scan || {})) { const v = clampQty(Math.min(Number(q) || 0, left)); if (v > 0) { o[b] = clampQty((o[b] || 0) + v); left = clampQty(left - v); } }
  return o;
}
const shopConfirmedQ = r => sumQ(Object.values(shopConfirmed(r)), v => v);
let shopPlanMemo = null;
function shopBatchPlan(list = data.shops) {
  if (list === data.shops && shopPlanMemo && shopPlanMemo.data === data) return shopPlanMemo.plan;
  const pools = hqShipBatches(calculateLedger()), plan = new Map(), order = r => SHOPS.findIndex(s => s.id === r.shop);
  for (const r of list) if (r.type === 'in' && r.aud) plan.set(r.id, r.batch ? [{ batch: r.batch, qty: r.quantity, confirmed: true, aud: true }] : [{ batch: '', qty: r.quantity, unknown: true, aud: true }]);
  const ins = list.filter(r => r.type === 'in' && !r.aud).sort((a, b) => cmp(shopFrom(a), shopFrom(b)) || order(a) - order(b) || a.seq - b.seq);
  const poolOf = r => pools.get(shopFrom(r) + '|' + baseCode(r.product)) || [];
  const take = (p, need) => { const q = clampQty(Math.min(need, p.qty - p.used)); if (q > 1e-7) p.used = clampQty(p.used + q); return q > 1e-7 ? q : 0; };
  // 先扣掉門市確認過的批號（其他門市推定時就不會再分到）
  const conf = new Map(ins.map(r => [r.id, shopConfirmed(r)]));
  for (const r of ins) for (const [b, q] of Object.entries(conf.get(r.id))) { let need = q; for (const p of poolOf(r)) { if (need <= 1e-7) break; if (p.batch === b) need = clampQty(need - take(p, need)); } }
  for (const r of ins) {
    const c = conf.get(r.id), parts = Object.entries(c).map(([batch, qty]) => ({ batch, qty, confirmed: true }));
    let need = clampQty(r.quantity - sumQ(parts, p => p.qty));
    for (const p of poolOf(r)) {
      if (need <= 1e-7) break;
      const q = take(p, need); if (!q) continue; need = clampQty(need - q);
      const x = parts.find(y => !y.confirmed && y.batch === p.batch && !!y.opening === p.opening); if (x) x.qty = clampQty(x.qty + q); else parts.push({ batch: p.batch, qty: q, factoryExp: p.exp, opening: p.opening });
    }
    if (need > 1e-7) parts.push({ batch: '', qty: need, unknown: true });
    // 總公司那天寄門市的（扣掉交易明細客人的之後）這個品號只有一個批號：門市拿到的一定是這個，自動確認（門市不用再按）；出了好幾個批號才要門市確認
    const shipped = [...new Set(poolOf(r).map(p => p.opening ? '期初現貨' : p.batch))];
    if (shipped.length === 1 && shipped[0] && shipped[0] !== '期初現貨') for (const p of parts) if (!p.confirmed && !p.unknown && p.batch === shipped[0]) { p.confirmed = true; p.auto = true; }
    plan.set(r.id, parts);
  }
  if (list === data.shops) shopPlanMemo = { data, plan };
  return plan;
}
const guessLabel = p => p.batch || (p.opening ? '期初現貨' : '批號不明');
const shopInText = (r, plan) => { if (r.batch) return r.batch; const parts = (plan || shopBatchPlan()).get(r.id) || [{ batch: '', qty: r.quantity, unknown: true }], c = parts.filter(p => p.confirmed), g = parts.filter(p => !p.confirmed); return [...c.map(p => `${p.batch}×${fmt(p.qty)}`), ...(g.length ? ['推定 ' + g.map(p => `${guessLabel(p)}×${fmt(p.qty)}`).join('、')] : [])].join('、'); };
const shopUnknownQ = (r, plan) => r.type !== 'in' || r.batch ? 0 : sumQ(((plan || shopBatchPlan()).get(r.id) || []).filter(p => p.unknown), p => p.qty);
// 工廠現貨的批號（入貨時給門市選）：這個產品還有庫存、或最近 14 天出過貨的現貨批號，新的在前
function factoryBatches(product) {
  const m = new Map(), since = addDays(TODAY(), -14);
  for (const l of calculateLedger().lots) {
    if (l.product !== product || !l.batch || l.batch === '—' || l.expiryDate === NO_EXPIRY || !(l.pool === 'stock' || l.batch !== '—')) continue;
    const x = m.get(l.batch) || { batch: l.batch, left: 0, shipped: 0, date: '' };
    x.left = clampQty(x.left + l.remaining); x.shipped = clampQty(x.shipped + (l.shipped || 0)); if (l.entryDate > x.date) x.date = l.entryDate; m.set(l.batch, x);
  }
  return [...m.values()].filter(x => x.left > 0 || (x.shipped > 0 && x.date >= since)).sort((a, b) => cmp(b.date, a.date) || cmp(b.batch, a.batch));
}
function shopSectionHtml(s) {
  const id = s.id, n = esc(s.name);
  return `<section id="shop-${id}" class="section">
    <div class="stabs" id="stabs-${id}" role="tablist" aria-label="${n}門市分頁"><button type="button" role="tab" data-stab="recv">門市入貨確認</button><button type="button" role="tab" data-stab="entry">入貨／銷售／報廢匯入</button><button type="button" role="tab" data-stab="stock">門市庫存</button><button type="button" role="tab" data-stab="audit">門市盤點</button></div>
    <div class="shop-pane" data-pane="recv">
    <div class="panel"><div class="panel-head"><div><h2>${n}門市入貨確認</h2><p id="rcvInfo-${id}"></p></div><div class="toolbar"><button type="button" class="btn small primary need-shop_${id}" data-action="ocr-slip" data-shop="${id}" title="用手機拍門市出庫單，自動讀品號、數量、製造日期，換成批號">拍出庫單辨識</button><input type="file" id="ocrFile-${id}" accept="image/*" capture="environment" hidden><button type="button" class="btn small need-storeout" data-action="store-out" title="讀揀貨總表的排單表，把各門市的出庫量帶入成入貨（批號自動推定）">從揀貨總表帶入入貨</button><input id="rcvDate-${id}" class="search" type="date" aria-label="入貨日期"></div></div><div id="rcvList-${id}" class="table-scroll"></div></div>
    </div>
    <div class="shop-pane" data-pane="entry">
    <div class="panel form-area need-shop_${id}"><div class="panel-head"><div><h2>登錄${n}門市入貨／銷售／報廢</h2><p>銷售、報廢可以按右邊「匯入」選 Excel／CSV 檔案，或從 POS 報表一次貼上；入貨會從揀貨總表帶入，批號可以不填（照總公司當天的出貨扣批自動推定）。</p></div><div class="toolbar"><button type="button" class="btn small primary" data-action="shop-import" data-shop="${id}">匯入銷售／報廢（檔案或貼上）</button></div></div><div class="panel-body"><form id="shopForm-${id}" class="form-grid" novalidate>
      <div class="field"><label for="shDate-${id}">日期 *</label><input id="shDate-${id}" type="date" required></div>
      <div class="field"><label for="shType-${id}">類別 *</label><select id="shType-${id}"><option value="in">入貨（配送到門市）</option><option value="sale">銷售</option><option value="waste">報廢</option><option value="take">領取</option></select></div>
      <div class="field span2"><label for="shProduct-${id}">產品 *</label><input id="shProduct-${id}" list="productNames" required placeholder="輸入品號或品名，從清單選擇" maxlength="80" autocomplete="off"></div>
      <div class="field"><label for="shBatch-${id}" id="shBatchLab-${id}">批號 *</label><input id="shBatch-${id}" list="shBatchList-${id}" placeholder="例如 CKAS1B08" maxlength="30" autocomplete="off" style="text-transform:uppercase"><datalist id="shBatchList-${id}"></datalist></div>
      <div class="field"><label for="shQty-${id}">數量 *</label><input id="shQty-${id}" type="number" inputmode="decimal" required step="0.001" min="0.001" placeholder="0"></div>
      <div class="field span2"><label for="shNote-${id}">備註</label><input id="shNote-${id}" maxlength="180" placeholder="選填"></div>
      <div class="field span4"><div id="shPreview-${id}" class="notice" hidden></div><div class="form-actions"><button type="submit" class="btn primary">＋ 儲存</button></div></div>
    </form></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${n}門市入貨／銷售／報廢紀錄</h2><p id="shopRecCount-${id}"></p></div><div class="toolbar"><input id="shopRecFilter-${id}" class="search" type="search" placeholder="搜尋日期／產品／批號／備註" aria-label="搜尋${n}門市紀錄"><button type="button" class="btn small" data-action="csv-shop" title="三間門市的紀錄一起匯出">匯出 CSV</button></div></div><div id="shopRecs-${id}" class="table-scroll"></div></div>
    </div>
    <div class="shop-pane" data-pane="stock">
    <div class="notice"><span id="shopRule-${id}"></span> <button type="button" class="btn small need-setting" data-action="shop-rule">修改可販售期</button></div>
    <div id="shopKpi-${id}" class="grid-kpi"></div>
    <div class="panel"><div class="panel-head"><div><h2>${n}門市庫存（依批號）</h2><p id="shopCount-${id}"></p></div><div class="toolbar"><div class="seg" id="shopSeg-${id}" role="group" aria-label="到期篩選"><button type="button" data-smode="all" class="on">全部</button><button type="button" data-smode="soon"><span class="seg-lab">快到期</span><span class="seg-n" hidden></span></button><button type="button" data-smode="expired">已過期<span class="seg-n" hidden></span></button></div><input id="shopFilter-${id}" class="search" type="search" placeholder="搜尋產品／批號" aria-label="搜尋${n}門市庫存"></div></div><div id="shopStock-${id}" class="table-scroll"></div></div>
    </div>
    <div class="shop-pane" data-pane="audit">
    <div class="panel"><div class="panel-head"><div><h2>${n}門市盤點</h2><p id="saudListInfo-${id}"></p></div><div class="toolbar"><button type="button" class="btn small primary need-shop_${id}" data-action="shop-aud-new" data-shop="${id}">＋ 新增盤點單</button></div></div><div class="panel-body"><p class="helper">照門市庫存盤點：每個產品＋批號一列（看盒子標籤上的批號），填實際數到的數量，App 算差異。跟帳上不一樣的按「套用盤點結果」：少的記成盤虧、多的記成盤盈，帳上就跟實盤一樣（門市沒有總表，App 直接調整）。<strong>第一次盤點當作期初</strong>：架上 11/17 以前進的舊貨也要盤，帳上沒有的批號按「新增一列」加。</p></div><div id="saudList-${id}" class="table-scroll"></div></div>
    <div class="panel" id="saudSheet-${id}" hidden><div class="panel-head"><div><h2 id="saudTitle-${id}">盤點表</h2><p id="saudInfo-${id}"></p></div><div class="toolbar"><div class="seg" id="saudSeg-${id}" role="group" aria-label="盤點篩選"><button type="button" data-samode="all" class="on">全部</button><button type="button" data-samode="diff">有差異</button><button type="button" data-samode="todo">未盤完</button></div><input id="saudFilter-${id}" class="search" type="search" placeholder="搜尋品號／品名／批號" aria-label="搜尋${n}門市盤點表"><button type="button" class="btn small" data-action="shop-aud-csv" data-shop="${id}">匯出 CSV</button></div></div><div class="panel-body" id="saudActions-${id}"></div><div id="saudTable-${id}" class="table-scroll"></div></div>
    </div>
  </section>`;
}
// 門市頁的四個分頁：recv 門市入貨確認｜entry 入貨／銷售／報廢匯入｜stock 門市庫存｜audit 門市盤點（記在這台瀏覽器）
const SHOP_TABS = ['recv', 'entry', 'stock', 'audit'];
const shopTab = Object.fromEntries(SHOPS.map(x => { let t = 'recv'; try { t = localStorage.getItem('fe_shoptab_' + x.id) || 'recv'; } catch (e) {} return [x.id, SHOP_TABS.includes(t) ? t : 'recv']; }));
function applyShopTab(sid) {
  const sec = $('shop-' + sid); if (!sec) return;
  sec.querySelectorAll('[data-stab]').forEach(b => { const on = b.dataset.stab === shopTab[sid]; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
  sec.querySelectorAll('.shop-pane').forEach(p => { p.hidden = p.dataset.pane !== shopTab[sid]; });
}
function setShopTab(sid, t) { if (!SHOP_TABS.includes(t)) return; shopTab[sid] = t; try { localStorage.setItem('fe_shoptab_' + sid, t); } catch (e) {} applyShopTab(sid); }
function buildShops() {
  document.querySelector('.nav-btn[data-view="manage"]').insertAdjacentHTML('beforebegin', '<div class="nav-title">門市庫存</div>' + SHOPS.map(s => `<a class="nav-btn" href="#shop-${s.id}" data-view="shop-${s.id}"><span class="nav-ico" aria-hidden="true">⌂</span>${esc(s.name)}門市</a>`).join(''));
  $('users').insertAdjacentHTML('beforebegin', SHOPS.map(shopSectionHtml).join(''));
  SHOPS.forEach(x => applyShopTab(x.id));
}
const shopChip = (r, out, plan) => {
  const u = esc(getUnit(r.product)), short = out && out.short > 0, isIn = r.type === 'in', unk = shopUnknownQ(r, plan);
  const cls = isIn ? (unk ? 'due' : 'ok') : short ? 'bad' : r.type === 'waste' || r.type === 'loss' ? 'expired' : r.type === 'take' ? 'due' : 'other';
  const extra = isIn ? `（可販售到 ${esc(md(shopExp(r)))}）` : short ? `（缺 ${esc(fmt(out.short))}）` : '';
  const btxt = isIn ? shopInText(r, plan) : r.batch;
  const tip = `${r.date}｜${shopTypeLabel(r)} ${fmt(r.quantity)}${btxt ? '｜批號 ' + btxt : ''}${isIn ? '｜可販售到 ' + shopExp(r) : out ? '｜扣 ' + (shopPartsText(out.parts) || '—') + (short ? '｜缺 ' + fmt(out.short) : '') : ''}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`;
  return `<span class="pill ${cls} exp-chip" title="${esc(tip)}"><span class="mono">${esc(md(r.date))}</span> ${shopTypeLabel(r)}${btxt ? ` <span class="mono">${esc(btxt)}</span>` : ''} ${esc(fmt(r.quantity))} ${u}${extra}</span>`;
};
function renderShops(today) {
  const sr = sellRule(), inRange = (e, m, product) => { const st = sellStatus(product, e.expiry, today); return m === 'soon' ? st.d >= 0 && st.warn : st.d < 0; };
  for (const s of SHOPS) {
    const id = s.id, L = shopLedger(id), mode = shopMode[id], plan = shopBatchPlan();
    renderReceive(id, plan);
    try { renderShopAudit(id); } catch (e) { console.error('門市盤點', e); }
    $('shopRule-' + id).innerHTML = `<strong>可販售期：</strong>入貨那天算第 1 天；<strong>蛋糕類 ${sr.cake.days} 天</strong>、第 ${sr.cake.warnFrom} 天起提醒；<strong>生巧克力 ${sr.choc.days} 天</strong>、第 ${sr.choc.warnFrom} 天起提醒（跟工廠的製作日期無關）。入貨會從<strong>揀貨總表</strong>帶入門市出庫，入貨日＝排單日（同步入口網站時一起帶，或按「從揀貨總表帶入入貨」；最近 3 天漏掉的會補），批號照總公司當天出貨扣掉交易明細（客人）後剩下的批號推定。銷售、報廢可以指定批號，沒指定就從最早到期的扣；過了可販售期的不能銷售，只能報廢。`;
    // 庫存：每個品號一列，每個「批號＋到期日」一個標籤（只算今天以前入貨的）
    const byP = new Map();
    for (const l of L.lots) {
      if (!(l.left > 0) || l.date > today) continue;
      if (!byP.has(l.product)) byP.set(l.product, { product: l.product, total: 0, exps: new Map() });
      const p = byP.get(l.product), k = l.batch + '|' + l.expiry + '|' + (l.guess ? 1 : 0) + (l.opening ? 'o' : ''), e = p.exps.get(k) || { batch: l.batch, expiry: l.expiry, guess: l.guess, opening: l.opening, total: 0, dates: new Set() };
      e.total = clampQty(e.total + l.left); e.dates.add(l.date); p.exps.set(k, e); p.total = clampQty(p.total + l.left);
    }
    const list = [...byP.values()].map(p => ({ ...p, exps: [...p.exps.values()].sort((a, b) => cmp(a.expiry, b.expiry) || cmp(a.batch, b.batch)) }));
    const cnt = m => list.filter(p => p.exps.some(e => inRange(e, m, p.product))).length, nSoon = cnt('soon'), nExp = cnt('expired');
    shopAlertN[id] = { soon: nSoon, exp: nExp };
    $('shopSeg-' + id).querySelectorAll('[data-smode]').forEach(b => {
      const m = b.dataset.smode, n = m === 'soon' ? nSoon : m === 'expired' ? nExp : 0, el = b.querySelector('.seg-n'), lab = b.querySelector('.seg-lab');
      b.classList.toggle('on', m === mode);
      if (lab) lab.textContent = '快到期';
      if (el) { el.hidden = !n; el.textContent = n; b.title = n ? `${n} 項產品${m === 'soon' ? '快到期' : '已過期'}` : ''; }
    });
    const modeName = mode === 'soon' ? '快到期' : '已過期';
    const shown = list.map(p => ({ ...p, show: mode === 'all' ? p.exps : p.exps.filter(e => inRange(e, mode, p.product)), text: p.exps.map(e => `${e.batch} ${e.expiry}`).join(' ') })).filter(p => p.show.length);
    const rows = searchable(shown, $('shopFilter-' + id).value, ['product', 'text']).sort((a, b) => productOrder(a.product, b.product));
    const chip = (e, u, product) => { const st = sellStatus(product, e.expiry, today), b = guessLabel(e); return `<span class="pill ${st.cls} exp-chip" title="${esc(`批號 ${b}${e.guess ? '（推定：照總公司出貨扣批，門市人員可在明細更正）' : ''}｜入貨 ${[...e.dates].sort().join('、')}｜可販售到 ${e.expiry}｜${st.label}`)}"><span class="mono">${esc(b)}</span>${e.guess && e.batch ? '<span class="guess">推定</span>' : ''}・可販售到 ${esc(md(e.expiry))}（${esc(st.label)}）・${esc(fmt(e.total))} ${u}</span>`; };
    $('shopCount-' + id).textContent = mode === 'all' ? `目前有庫存的產品 ${list.length} 項，共 ${fmt(sumQ(list, p => p.total))} 個；每個批號一個標籤，寫可販售到哪天、第幾天、剩幾天` : `${modeName}：${shown.length} 項產品，共 ${fmt(sumQ(shown, p => sumQ(p.show, e => e.total)))} 個`;
    $('shopStock-' + id).innerHTML = table(['產品', mode === 'all' ? '各批號（可販售到、第幾天、剩幾天、數量；由早到晚）' : `${modeName}的批號`, '剩餘庫存#', '最早到期'], rows.map(p => {
      const u = esc(getUnit(p.product)), st = sellStatus(p.product, p.exps[0].expiry, today);
      return `<tr>${td(`<strong>${esc(p.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${p.show.map(e => chip(e, u, p.product)).join('')}</div></td><td class="num">${fmt(p.total)} ${u}</td>${td(badge(st.label, st.cls))}</tr>`;
    }), mode === 'all' ? `${s.name}門市目前沒有庫存` : `${s.name}門市沒有${modeName}的庫存`);
    // 摘要
    const recs = data.shops.filter(r => r.shop === id), todayQ = t => sumQ(recs.filter(r => r.date === today && r.type === t));
    $('shopKpi-' + id).innerHTML = [
      ['目前庫存', `${fmt(sumQ(list, p => p.total))} 個`, `${list.length} 項產品、${list.reduce((n, p) => n + p.exps.length, 0)} 個批號`, ''],
      ['今日入貨／銷售', `${fmt(todayQ('in'))}／${fmt(todayQ('sale'))}`, todayQ('waste') || todayQ('take') ? [todayQ('waste') ? `報廢 ${fmt(todayQ('waste'))} 個` : '', todayQ('take') ? `領取 ${fmt(todayQ('take'))} 個` : ''].filter(Boolean).join('、') : '今天還沒有報廢、領取', ''],
      ['快到期', `${nSoon} 項`, nSoon ? '請優先銷售' : '沒有', nSoon ? 'warn' : ''],
      ['已過期', `${nExp} 項`, nExp ? '請報廢下架' : '沒有', nExp ? 'bad' : ''],
    ].map(([l, v, d, c]) => `<article class="kpi ${c}"><div class="kpi-label">${esc(l)}</div><div class="kpi-value" style="font-size:20px">${esc(v)}</div><div class="kpi-desc">${esc(d)}</div></article>`).join('');
    // 紀錄：每個品號一列
    const groups = groupByProduct(recs.map(r => ({ ...r, kind: shopTypeLabel(r), btxt: r.type === 'in' ? shopInText(r, plan) : r.batch })), $('shopRecFilter-' + id).value, ['date', 'kind', 'note', 'btxt', 'expiryDate']);
    const unkN = recs.filter(r => shopUnknownQ(r, plan) > 0).length;
    $('shopRecCount-' + id).textContent = `共 ${groups.length} 項產品、${recs.length} 筆紀錄；每個品號一列，日期新的在前（綠＝入貨、黃＝有批號不明、紅＝有缺口），「推定」＝照總公司出貨扣批推算的批號，點「明細」看每一筆或更正批號${unkN ? `；有 ${unkN} 筆入貨的批號推不出來（總公司當天這個品號的出貨不夠分）` : ''}`;
    $('shopRecs-' + id).innerHTML = table(['產品', '紀錄（日期新到舊）', '入貨#', '銷售#', '報廢#', '缺口#', '明細'], groups.map(g => {
      const by = t => sumQ(g.recs.filter(r => r.type === t)), short = sumQ(g.recs, r => (L.outs.get(r.id) || {}).short || 0), more = g.recs.length > CHIP_MAX ? `<button type="button" class="pill other exp-chip linkchip" data-action="shop-detail" data-shop="${id}" data-id="${esc(g.product)}">還有 ${g.recs.length - CHIP_MAX} 筆…</button>` : '';
      return `<tr>${td(`<strong>${esc(g.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${g.recs.slice(0, CHIP_MAX).map(r => shopChip(r, L.outs.get(r.id), plan)).join('')}${more}</div></td><td class="num">${fmt(by('in'))}</td><td class="num">${fmt(by('sale'))}</td><td class="num">${fmt(by('waste'))}</td><td class="num">${short ? badge(fmt(short), 'bad') : '—'}</td>${td(`<button type="button" class="btn small" data-action="shop-detail" data-shop="${id}" data-id="${esc(g.product)}">明細</button>`)}</tr>`;
    }), `${s.name}門市還沒有紀錄`);
  }
}
async function openShopDetail(sid, product) {
  if (!SHOPS.some(s => s.id === sid)) return;
  const L = shopLedger(sid), u = esc(getUnit(product)), canEdit = can(shopPerm(sid)), plan = shopBatchPlan();
  const rows = data.shops.filter(r => r.shop === sid && r.product === product).sort((a, b) => cmp(b.date, a.date) || b.seq - a.seq);
  const html = table(['日期', '類別', '批號', '數量#', '門市到期日／扣除', '缺口#', '備註', '登錄人', ...(canEdit ? ['管理'] : [])], rows.map(r => {
    const o = L.outs.get(r.id), isIn = r.type === 'in', pt = String(r.id).startsWith('pt-');
    const bcell = isIn ? (r.batch ? `<span class="mono">${esc(r.batch)}</span>${r.editBy ? ' <span class="pill ok">已更正</span>' : ''}` : `<span class="mono">${esc(shopInText(r, plan))}</span>`) : `<span class="mono">${esc(r.batch || '先到期先扣')}</span>`;
    const btns = [isIn ? `<button type="button" class="btn small" data-action="shop-batch" data-shop="${sid}" data-id="${esc(r.id)}">${r.batch ? '改批號' : '更正批號'}</button>` : '', pt ? (String(r.id).startsWith('pt-in-') ? '<span class="pill other" title="揀貨總表帶入的數量，要修改請在揀貨總表改後再帶入一次">揀貨總表</span>' : '<span class="pill other" title="入口網站同步的數量，要修改請在入口網站改後再同步">入口網站</span>') : `<button type="button" class="btn small danger" data-action="shop-delete" data-shop="${sid}" data-id="${esc(r.id)}">刪除</button>`].filter(Boolean).join('');
    return `<tr>${tdm(r.date)}${td(esc(shopTypeLabel(r)))}${td(bcell)}<td class="num">${fmt(r.quantity)} ${u}</td>${td(esc(isIn ? '可販售到 ' + shopExp(r) + (shopFrom(r) !== r.date ? `（總公司 ${shopFrom(r)} 轉出）` : '') : (o && shopPartsText(o.parts)) || '—'))}<td class="num">${o && o.short ? fmt(o.short) : '—'}</td>${td(esc(r.note || '—'))}${tdWho(r)}${canEdit ? td(`<div class="segment">${btns}</div>`) : ''}</tr>`;
  }));
  await modal({ title: `${shopName(sid)}門市「${product}」的紀錄（${rows.length} 筆）`, html: `<div class="table-scroll">${html}</div>`, ok: '關閉', wide: true, noCancel: true });
}
// 更正入貨的批號：填貨上標籤的批號（整筆都是這個批號）；清空＝改回自動推定
async function editShopBatch(sid, id) {
  closeModal();
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid && x.type === 'in'); if (!r) return;
  const pool = (hqShipBatches(calculateLedger()).get(shopFrom(r) + '|' + baseCode(r.product)) || []).filter(p => p.batch);
  const om = new Map(pool.map(p => [p.batch, `總公司 ${shopFrom(r)} 出貨 ${fmt(p.qty)} 個`]));
  for (const x of factoryBatches(r.product)) if (!om.has(x.batch)) om.set(x.batch, `工廠 ${x.date} 入庫`);
  const opts = [...om.entries()];
  const res = await modal({ title: `更正入貨批號：${r.product}`, ok: '儲存',
    html: `<p>${esc(`${shopName(sid)}門市｜${r.date} 入貨 ${fmt(r.quantity)} ${getUnit(r.product)}｜可販售到 ${shopExp(r)}`)}</p><p class="modal-note">目前：${esc(shopInText(r))}。填貨上標籤的批號（這筆全部都是這個批號）；如果其實是好幾個批號，請把這筆刪掉，一個批號登錄一筆。清空＝改回自動推定。可販售日期不會變（照入貨日算）。</p><div class="field"><label for="sb-batch">批號</label><input id="sb-batch" list="sb-list" value="${esc(r.batch || '')}" placeholder="例如 CKAS1B08" maxlength="30" autocomplete="off" style="text-transform:uppercase"><datalist id="sb-list">${opts.map(([v, l]) => `<option value="${esc(v)}" label="${esc(l)}"></option>`).join('')}</datalist></div><p class="modal-error" hidden></p>`,
    collect: b => ({ batch: cleanBatch(b.querySelector('#sb-batch').value) }) });
  if (!res || res.batch === (r.batch || '')) return;
  act(() => { const { scan, ...rest } = r; FEStore.save('shop', { ...rest, batch: res.batch, ...stampEdit() }); toast(res.batch ? `已更正為批號 ${res.batch}，門市庫存已重算` : '已改回自動推定，門市庫存已重算'); });
}
async function deleteShopRec(sid, id) {
  closeModal();
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid); if (!r) return;
  if (!await modal({ title: '刪除這筆門市紀錄？', html: `<p>${esc(`${shopName(sid)}門市｜${r.date}｜${shopTypeLabel(r)} ${r.product}${r.batch ? ' 批號 ' + r.batch : ''} ${fmt(r.quantity)} ${getUnit(r.product)}${r.type === 'in' ? '｜可販售到 ' + shopExp(r) : ''}`)}</p><p class="modal-note">刪除後，這間門市的庫存與扣除會重新計算。</p>`, ok: '刪除', danger: true })) return;
  act(() => { FEStore.remove('shop', r.id); toast('已刪除，門市庫存已重算'); });
}
/* ---------- 門市出庫（揀貨總表）→ 門市入貨 ----------
   雲端後端讀「揀貨總表」每天的排單表（MMDD排），照「商品總計」分頁同樣的條件加總各門市的出庫量（京站、A11、東橋…）；
   這裡把 A11、京站、東橋 的數量存成門市「入貨」：id pt-in-門市-日期-品號，同一天同一個品號一筆，重複帶入會更新、總表刪掉的會移除。
   批號留空＝照總公司當天的出貨扣批自動推定；門市人員更正過的批號會保留。入貨日＝出庫那天，到期日＝入貨日＋門市保存天數。
   只帶入同步品號開頭（CK、CC…）的產品，擺盤不帶；總公司沒有這些產品的出貨資料就推不出批號。 */
const canStoreOut = sid => can('ship') || can(shopPerm(sid));
const storeOutMeta = () => FEStore.get('settings', 'storeout') || {};
let storeOutBusy = false, storeOutOldWarned = false;
// 帶入今天的門市出庫（跟「商品總計」看到的一樣），加上最近 3 天還沒帶入過的日子（那天忘了同步也補得回來，2026-11-20 起）；
// 已經帶入過的過去日子保留不動。門市入貨日＝排單日
function storeOutDates() {
  const t = TODAY(), from = syncFromDate(), has = new Set(data.shops.filter(r => String(r.id).startsWith('pt-in-')).map(r => r.date));
  return [...[3, 2, 1].map(k => addDays(t, -k)).filter(d => !has.has(d)), t].filter(d => !from || d >= from);
}
async function syncStoreOut(dates, { quiet = false, delay = 0 } = {}) {
  if (storeOutBusy || !window.FEAuth || !FEAuth.user() || loading()) return;
  if (!SHOPS.some(x => canStoreOut(x.id))) { if (!quiet) toast('你沒有「出貨」或門市的權限，不能帶入門市入貨', true); return; }
  dates = [...new Set((dates || []).filter(isDate))].sort().slice(-31);
  if (!dates.length) return;
  storeOutBusy = true;
  const t0 = Date.now(), say = (msg, err = false, ms = 9000) => setTimeout(() => toast(msg, err, ms), Math.max(0, delay - (Date.now() - t0)));
  if (!quiet) toast('正在讀取揀貨總表的門市出庫…', false, 30000);
  try {
    let j;
    try { j = await FEAuth.api('storeOut', { dates }); }
    catch (e) {
      if (e.code === 'unknown_action') { if (!quiet || !storeOutOldWarned) say('門市出庫沒有帶入：雲端後端還沒更新。請照使用說明「門市出庫自動帶入」更新雲端後端（只要做一次）', true, 12000); storeOutOldWarned = true; }
      else say('揀貨總表的門市出庫讀取失敗：' + e.message, true, 10000);
      return;
    }
    const prefixes = portalPrefixes(), byCode = new Map(), byName = new Map(), newProducts = [];
    for (const p of data.products) { if (p.virtual) continue; const c = productCodeOf(p.name), nm = clean(p.name.slice(c.length)); if (!byCode.has(c)) byCode.set(c, p); if (nm && !byName.has(nm)) byName.set(nm, p); }
    const productFor = (code, name) => {
      const p = code ? byCode.get(code) : byName.get(name);
      if (p || !code || !CODE_RE.test(code)) return p || null;
      const nm = `${code} ${name}`.trim(), np = { id: productId(nm), name: nm, unit: '個', shelfDays: data.settings.defaultShelf, lowStock: 0 };
      byCode.set(code, np); if (name && !byName.has(name)) byName.set(name, np); newProducts.push(np); return np;
    };
    const existing = new Map(data.shops.filter(r => String(r.id).startsWith('pt-in-')).map(r => [r.id, r]));
    const saves = [], removes = [], who = myName(), at = nowIso(), cnt = Object.fromEntries(SHOPS.map(x => [x.id, 0])), qn = Object.fromEntries(SHOPS.map(x => [x.id, 0])), notFound = [], unknown = new Set();
    for (const ds of dates) {
      const d = (j.days || {})[ds];
      if (!d || !d.found) { notFound.push(ds); continue; }
      const want = new Set();
      for (const sh of SHOPS) {
        if (!canStoreOut(sh.id)) continue;
        const merged = new Map(), ords = new Map(), shopOrders = (d.orders || {})[sh.name] || {};
        for (const x of ((d.stores || {})[sh.name] || [])) {
          if (!Array.isArray(x)) continue;
          const code = clean(x[0]), name = clean(x[1]), q = Number(x[2]);
          if (!(q > 0) || q >= 1e7 || isExcluded(name) || (code && !prefixes.includes(codePrefix(code)))) continue;
          const p = productFor(code, name);
          if (!p) { unknown.add(name); continue; }
          if (!prefixes.includes(codePrefix(productCodeOf(p.name))) || isExcluded(p.name)) continue;
          merged.set(p.name, clampQty((merged.get(p.name) || 0) + q));
          // 組合品是哪幾張訂單寄來的（POS 匯入時用訂單單號把 6原＋烙印 組回組合品）
          const on = shopOrders[name];
          if (on && typeof on === 'object') { const o = ords.get(p.name) || {}; for (const [k, v] of Object.entries(on)) { const n = Number(v); if (ORDER_RE.test(k) && n > 0) o[k] = clampQty((o[k] || 0) + n); } ords.set(p.name, o); }
        }
        const hasOrders = !!d.orders; // 後端有回傳訂單單號（新版後端）才記；舊版後端不動原本的紀錄
        for (const [pname, q] of merged) {
          const id = `pt-in-${sh.id}-${ds}-${productCodeOf(pname)}`, old = existing.get(id), o = ords.get(pname);
          want.add(id); cnt[sh.id]++; qn[sh.id] = clampQty(qn[sh.id] + q);
          let rec = old ? { ...old, product: pname, quantity: q } : { id, shop: sh.id, type: 'in', date: ds, fromDate: ds, product: pname, quantity: q, batch: '', expiryDate: shopExpiryFor(pname, ds), note: '揀貨總表：門市出庫', seq: nextSeq(), by: who, at };
          if (hasOrders && productCodeOf(pname).includes('|')) { const { orders: _o, ...rest } = rec; rec = { ...rest, orders: o && Object.keys(o).length ? o : {} }; }
          if (!old || old.quantity !== q || old.product !== pname || JSON.stringify(old.orders || null) !== JSON.stringify(rec.orders || null)) saves.push(rec);
        }
      }
      for (const [id, r] of existing) if (r.date === ds && !want.has(id) && canStoreOut(r.shop)) removes.push(id);
    }
    const changed = saves.length + removes.length, found = dates.filter(d => !notFound.includes(d));
    act(() => {
      if (newProducts.length) FEStore.saveMany('products', newProducts.map(p => ({ id: p.id, name: p.name, unit: p.unit, shelfDays: p.shelfDays, lowStock: 0 })));
      if (saves.length) FEStore.saveMany('shop', saves);
      if (removes.length) FEStore.removeMany('shop', removes);
      FEStore.save('settings', { id: 'storeout', at: Date.now(), by: who, first: dates[0], last: dates[dates.length - 1], days: found.length, counts: cnt, qty: qn, notFound, changed, unknown: [...unknown].slice(0, 20) });
    });
    if (quiet && !changed) return;
    const range = dates.length === 1 ? shortDate(dates[0]) : `${shortDate(dates[0])}～${shortDate(dates[dates.length - 1])}`;
    const parts = SHOPS.filter(x => canStoreOut(x.id)).map(x => `${x.name} ${cnt[x.id]} 項（${fmt(qn[x.id])} 個）`).join('、');
    const notes = [notFound.length ? `${notFound.map(shortDate).join('、')} 還沒有排單表，沒有帶入` : '', unknown.size ? `${unknown.size} 個品名對不到產品（${[...unknown].slice(0, 3).join('、')}${unknown.size > 3 ? '…' : ''}）` : '', newProducts.length ? `新增產品 ${newProducts.length} 項` : ''].filter(Boolean).join('；');
    say(`門市入貨已從揀貨總表帶入（${range}）：${parts}${changed ? '' : '（數字都沒變）'}。批號照總公司當天的出貨扣批自動推定${notes ? '。' + notes : ''}`, false, 12000);
  } finally { storeOutBusy = false; }
}
function renderStoreOutInfo() {
  const el = $('storeOutInfo'); if (!el) return;
  const m = storeOutMeta();
  el.textContent = m.at ? `上次帶入：${new Date(m.at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（${m.by || '—'}）${m.first === m.last ? shortDate(m.first) : `${shortDate(m.first)}～${shortDate(m.last)}`}：${SHOPS.map(x => `${x.name} ${(m.counts || {})[x.id] || 0} 項`).join('、')}${(m.notFound || []).length ? `；${m.notFound.map(shortDate).join('、')} 沒有排單表` : ''}${(m.unknown || []).length ? `；對不到產品：${m.unknown.slice(0, 5).join('、')}` : ''}` : '還沒有帶入過。按右邊的按鈕，或用書籤同步入口網站時會自動帶入今天的。';
}
/* ---------- 門市入貨確認 ----------
   總公司那天寄門市的這個品號只有一個批號（扣掉交易明細客人的之後）→ 自動確認；出了好幾個批號 → 門市看盒子上的批號，跟推定的一樣按「確認」，不一樣就點正確的批號。
   確認的數量存在入貨紀錄的 scan，其他門市推定時會先扣掉。 */
const rcvDate = {};
// 總公司某天可能出給門市的批號：前一天結束還有的現貨（與半成品，當天轉現貨的批號）＋當天新做的
let candMemo = null;
function hqCandidates(product, date) {
  if (!candMemo || candMemo.data !== data) candMemo = { data, led: new Map(), out: new Map() };
  const key = product + '|' + date; if (candMemo.out.has(key)) return candMemo.out.get(key);
  const led = d => { if (!candMemo.led.has(d)) candMemo.led.set(d, calculateLedger(d)); return candMemo.led.get(d); };
  const lab = l => l.expiryDate === NO_EXPIRY ? '' : (l.pool === 'stock' || (l.batch && l.batch !== '—') ? l.batch : makeBatch(product, date) || ''), set = new Set();
  for (const l of led(addDays(date, -1)).lots) if (l.product === product && l.remaining > 1e-7 && l.expiryDate >= date) { const b = lab(l); if (b) set.add(b); }
  for (const l of led(date).lots) if (l.product === product && l.entryDate === date) { const b = lab(l); if (b) set.add(b); }
  const out = [...set].sort(); candMemo.out.set(key, out); return out;
}
function rcvDay(sid) { if (isDate(rcvDate[sid])) return rcvDate[sid]; const t = TODAY(), ds = [...new Set(data.shops.filter(r => r.shop === sid && r.type === 'in' && !r.aud && r.date <= t).map(r => r.date))].sort(); return ds.length ? ds[ds.length - 1] : t; }
// 待確認品項：每個可能的批號一格數量（先填推定的），門市照盒子上的批號改數量，合計要等於入貨數量，再按「確認」
// rcvDraft：還沒按確認前改的數量（畫面重新整理時保留）
const rcvDraft = {};
function renderReceive(sid, plan) {
  const day = rcvDay(sid), di = $('rcvDate-' + sid); if (document.activeElement !== di) di.value = day;
  const recs = data.shops.filter(r => r.shop === sid && r.type === 'in' && !r.aud && r.date === day).sort((a, b) => productOrder(a.product, b.product)), edit = can(shopPerm(sid));
  const shipPools = recs.length ? hqShipBatches(calculateLedger()) : new Map();
  let done = 0, auto = 0, wait = 0;
  const rows = recs.map(r => {
    const parts = plan.get(r.id) || [], conf = parts.filter(p => p.confirmed), guess = parts.filter(p => !p.confirmed && !p.unknown), unk = parts.filter(p => p.unknown);
    const cq = sumQ(conf, p => p.qty), allAuto = conf.length && conf.every(p => p.auto), manual = shopConfirmedQ(r) > 0, pending = cq < r.quantity - 1e-7 && (guess.length || unk.length);
    let st;
    if (!pending) { st = allAuto ? badge('自動確認（寄門市的只有一個批號）', 'ok') : badge('已確認', 'ok'); if (allAuto) auto++; else done++; }
    else { st = cq > 0 ? badge(`已確認 ${fmt(cq)}／${fmt(r.quantity)}`, 'due') : badge('待確認', 'bad'); wait++; }
    const md2 = b => batchMd(b) ? `${batchMd(b)} ` : '';
    const chips = [...conf.map(p => `<span class="pill ok exp-chip">${esc(md2(p.batch))}<span class="mono">${esc(p.batch)}</span> ×${fmt(p.qty)}${p.auto ? ' <span class="guess">自動</span>' : ''}</span>`), ...guess.map(p => `<span class="pill other exp-chip">${esc(md2(p.batch))}<span class="mono">${esc(guessLabel(p))}</span> ×${fmt(p.qty)} <span class="guess">推定</span></span>`), ...unk.map(p => `<span class="pill due exp-chip">批號不明 ×${fmt(p.qty)}</span>`)].join('');
    let ops = '';
    if (edit && pending) {
      // 可以填的批號：總公司那天出的＋那天可能出的；先填「已確認＋推定」的數量
      const shippedB = (shipPools.get(shopFrom(r) + '|' + baseCode(r.product)) || []).map(p => p.batch).filter(Boolean);
      const pre = {}; for (const p of parts) if (p.batch && !p.unknown) pre[p.batch] = clampQty((pre[p.batch] || 0) + p.qty);
      const alt = [...new Set([...Object.keys(pre), ...shippedB, ...hqCandidates(r.product, shopFrom(r))])].sort(), dr = rcvDraft[r.id] || {};
      const val = b => b in dr ? dr[b] : (pre[b] || 0), sum = clampQty(alt.reduce((t, b) => t + (Number(val(b)) || 0), 0));
      ops = `<div class="rq-row">${alt.map(b => `<label class="rq" title="批號 ${esc(b)}${batchDate(b) ? '，製造日期 ' + batchDate(b) : ''}">${batchMd(b) ? `<b>${esc(batchMd(b))}</b> ` : ''}<span class="mono rq-b">${esc(b)}</span><input type="number" inputmode="numeric" min="0" max="${r.quantity}" step="1" value="${esc(val(b))}" data-rq="${esc(r.id)}" data-batch="${esc(b)}" aria-label="${esc(b)} 數量"></label>`).join('')}<span class="rq-sum${Math.abs(sum - r.quantity) > 1e-7 ? ' bad' : ''}" data-rqsum="${esc(r.id)}" data-total="${r.quantity}">合計 ${fmt(sum)}／${fmt(r.quantity)}</span><button type="button" class="btn small primary" data-action="rcv-confirm" data-shop="${sid}" data-id="${esc(r.id)}" title="照左邊填的數量確認">確認</button></div>`;
    }
    if (edit && manual) ops += `<button type="button" class="btn small danger" data-action="rcv-clear" data-shop="${sid}" data-id="${esc(r.id)}">清除</button>`;
    return `<tr>${td(`<strong>${esc(r.product)}</strong>`)}<td class="num">${fmt(r.quantity)}</td>${td(st)}<td class="exp-cell"><div class="exp-chips">${chips || '<span class="who">—</span>'}</div></td><td class="exp-cell">${ops}</td></tr>`;
  });
  $('rcvInfo-' + sid).textContent = recs.length ? `${day} 入貨 ${recs.length} 項：自動確認 ${auto} 項（總公司那天寄門市的只有一個批號）、門市已確認 ${done} 項、待確認 ${wait} 項（寄門市的有好幾個批號）。待確認的照門市出庫單的「製造日期」（或盒子上的批號）填每個日期幾個（已先填推定的），合計對了按「確認」` : `${day} 沒有入貨紀錄`;
  $('rcvList-' + sid).innerHTML = table(['產品', '入貨#', '狀態', '批號（綠＝已確認、灰＝推定）', '每個製造日期（批號）幾個 → 確認'], rows, `${day} 沒有入貨紀錄`);
}
// 改數量：記到 rcvDraft，更新那一列的合計
function rcvInput(el) {
  const id = el.dataset.rq, b = el.dataset.batch; (rcvDraft[id] = rcvDraft[id] || {})[b] = el.value === '' ? '' : Number(el.value);
  const row = el.closest('tr'), sumEl = row && row.querySelector('[data-rqsum]'); if (!sumEl) return;
  const sum = clampQty([...row.querySelectorAll('[data-rq]')].reduce((t, x) => t + (Number(x.value) || 0), 0)), total = Number(sumEl.dataset.total);
  sumEl.textContent = `合計 ${fmt(sum)}／${fmt(total)}`; sumEl.classList.toggle('bad', Math.abs(sum - total) > 1e-7);
}
// 按「確認」：照那一列填的每個批號數量存成已確認（合計要等於入貨數量）
function rcvConfirm(sid, id, btn) {
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid); if (!r) return;
  const row = btn && btn.closest('tr'), inputs = row ? [...row.querySelectorAll('[data-rq]')] : [], scan = {};
  for (const x of inputs) { const n = Number(x.value); if (x.value === '' || !Number.isFinite(n) || n < 0) { toast('數量要填 0 以上的數字', true); return; } if (n > 0) scan[x.dataset.batch] = clampQty((scan[x.dataset.batch] || 0) + n); }
  const sum = sumQ(Object.values(scan), v => v);
  if (Math.abs(sum - r.quantity) > 1e-7) { toast(`${r.product}：每個批號加起來要等於入貨 ${fmt(r.quantity)} 個（現在是 ${fmt(sum)} 個）`, true, 6000); return; }
  act(() => {
    const { batch: _b, ...rest } = r; FEStore.save('shop', { ...rest, batch: '', scan, ...stampEdit() }); delete rcvDraft[r.id];
    toast(`已確認 ${r.product}：${Object.entries(scan).map(([b, q]) => `${b}×${fmt(q)}`).join('、')}`);
  });
}
function saveScan(r, batch, n) {
  const c = shopConfirmed(r), left = clampQty(r.quantity - sumQ(Object.values(c), v => v)), add = clampQty(Math.min(n, left));
  if (add <= 0) return 0;
  const { batch: _b, ...rest } = r, scan = { ...c }; scan[batch] = clampQty((scan[batch] || 0) + add);
  FEStore.save('shop', { ...rest, batch: '', scan, ...stampEdit() });
  return add;
}
function rcvPick(sid, id, batch) {
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid); if (!r) return;
  act(() => { const n = saveScan(r, batch, r.quantity); toast(`${r.product}：${fmt(n)} 個設成 ${batch}`); });
}
function rcvClear(sid, id) {
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid); if (!r) return;
  delete rcvDraft[r.id];
  act(() => { const { scan, ...rest } = r; FEStore.save('shop', { ...rest, batch: '', ...stampEdit() }); toast(`已清除 ${r.product} 的確認，改回自動推定`); });
}
/* ---------- 拍門市出庫單辨識 ----------
   用手機拍（或選）門市出庫單的照片 → 在瀏覽器裡用 Tesseract.js（繁體中文＋英數字，第一次會下載辨識資料約 30MB，之後留在手機裡）辨識文字
   → 每一行找品號（對照 App 的品號）、數量（2.00）、製造日期（11月13日）→ 批號＝品號碼＋製造日期（現貨批號就是用轉現貨那天編的）
   → 預覽可以修改 → 套用：同一個品號各製造日期的數量存成那天入貨的「已確認」。照片只在手機上辨識，不會上傳。 */
let ocrLibPromise = null;
function loadOcr() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!ocrLibPromise) ocrLibPromise = new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; sc.onload = () => window.Tesseract ? res(window.Tesseract) : rej(Error('辨識元件載入失敗')); sc.onerror = () => { ocrLibPromise = null; rej(Error('辨識元件載入失敗，請確認網路')); }; document.head.appendChild(sc); });
  return ocrLibPromise;
}
// 照片前處理：放大或縮小到適合辨識的寬度、轉灰階、加強對比
async function ocrPrepare(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(Error('讀不到這張照片')); i.src = url; });
    const k = Math.min(2.5, Math.max(0.4, 1300 / img.width)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
    for (let i = 0; i < px.length; i += 4) { const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2], v = y > 160 ? 255 : y < 100 ? 0 : (y - 100) * 4.25; px[i] = px[i + 1] = px[i + 2] = v; }
    g.putImageData(d, 0, 0); return c;
  } finally { URL.revokeObjectURL(url); }
}
// 從辨識出的文字讀出日期與每一行（品號、數量、製造日期）
function parseSlip(text, fallbackDate, hasRecs = () => true) {
  const codes = [...new Set(data.products.filter(p => !p.virtual).map(p => productCodeOf(p.name).split('|')[0]))].sort((a, b) => b.length - a.length);
  const res = codes.map(c => [c, new RegExp(c.replace(/[-]/g, '-?'))]);
  const T = String(text || '').replace(/[－—–]/g, '-');
  // 日期：表頭「日期 2026/11/13」或單號「…20261113010」；年份讀錯（差很多）就用今年；那天沒有入貨就用預設的入貨日
  const fix = (y, m, d) => { const now = TODAY(); let ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; if (!isDate(ds)) return ''; if (Math.abs(dayDiff(now, ds)) > 60) { const alt = `${now.slice(0, 4)}-${ds.slice(5)}`; ds = isDate(alt) && Math.abs(dayDiff(now, alt)) <= 60 ? alt : ''; } return ds; };
  const cands = [];
  for (const m of T.matchAll(/(20\d{2})\s*[\/.\-年]\s*(\d{1,2})\s*[\/.\-月]\s*(\d{1,2})/g)) cands.push(fix(m[1], Number(m[2]), Number(m[3])));
  for (const m of T.matchAll(/[A-Z]{0,3}(20\d{2})(\d{2})(\d{2})\d{3}/g)) cands.push(fix(m[1], Number(m[2]), Number(m[3])));
  const okDates = cands.filter(Boolean);
  const date = okDates.find(hasRecs) || (hasRecs(fallbackDate) ? fallbackDate : okDates[0]) || fallbackDate;
  // 品號比對：先完全一樣；再校正常見錯字（O→0、L/I→1、S→5、B→8、Z→2、G→6）；再從那天的入貨品項找只差一個字、而且只有一個的
  const norm = c => c.replace(/-/g, '');
  const dayCodes = [...new Set(typeof window.dayCodesOf === 'function' ? window.dayCodesOf(date) : [])];
  const lev = (x, y) => { const d = Array.from({ length: x.length + 1 }, (_, i) => [i]); for (let j = 1; j <= y.length; j++) d[0][j] = j; for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1)); return d[x.length][y.length]; };
  const fixDigits = t => t.slice(0, 2) + t.slice(2).replace(/[OQD]/g, '0').replace(/[LIJ|!]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2').replace(/G/g, '6');
  const lines = [];
  for (const raw of T.split(/\n/)) {
    const L = raw.toUpperCase().replace(/[|｜]/g, ' '), flat = L.replace(/\s+/g, '');
    const dm = raw.match(/(\d{1,2})\s*[月HB目]\s*(\d{1,2})\s*[日HB目曰]?/), qm = raw.match(/(\d{1,4})[.,](\d{1,2})(?!\d)/);
    let code = '', how = 'exact';
    const hit = res.find(([, re]) => re.test(flat)); if (hit) code = hit[0];
    if (!code && (dm || qm)) {
      const pre = (raw.split(/[\u3400-\u9fff|｜]/)[0] || '').toUpperCase().replace(/[^A-Z0-9-]/g, ''), tok = fixDigits(pre.replace(/-/g, ''));
      if (tok.length >= 3) {
        const exact = codes.find(c => norm(c) === tok);
        if (exact) { code = exact; how = 'fixed'; }
        else { const near = list => list.filter(c => lev(tok, norm(c)) <= 1), n1 = near(dayCodes), pick = n1.length === 1 ? n1 : (n1.length ? [] : near(codes)); if (pick.length === 1) { code = pick[0]; how = 'guess'; } else { code = pre || tok; how = 'unknown'; } }
      }
    }
    if (!code) continue;
    let mfg = '';
    if (dm) { let y = Number(date.slice(0, 4)); const mo = Number(dm[1]); if (mo > Number(date.slice(5, 7)) + 1) y--; const ds = `${y}-${String(mo).padStart(2, '0')}-${String(Number(dm[2])).padStart(2, '0')}`; if (isDate(ds)) mfg = ds; }
    lines.push({ code, qty: qm ? Number(qm[1]) : 0, mfg, how, raw: raw.trim().slice(0, 60) });
  }
  // 刪去法：讀不清楚的行，那天的入貨裡還沒對到、字形接近（差 2 個字以內）而且只有一個的品號，就猜它
  const used = new Set(lines.filter(x => x.how !== 'unknown').map(x => x.code));
  for (const x of lines.filter(x => x.how === 'unknown')) { const tok = fixDigits(x.code.replace(/[^A-Z0-9]/g, '')), left = dayCodes.filter(c => !used.has(c) && lev(tok, norm(c)) <= 2); if (left.length === 1) { x.code = left[0]; x.how = 'guess'; used.add(left[0]); } }
  return { date, lines };
}
async function ocrSlip(sid, file) {
  if (!can(shopPerm(sid)) || !file) return;
  toast('準備辨識…（第一次會下載辨識資料，約 30MB，請稍等）', false, 120000);
  let text = '';
  try {
    const T = await loadOcr(), canvas = await ocrPrepare(file);
    const w = await T.createWorker('chi_tra+eng', 1, { logger: m => { if (m.status === 'recognizing text') toast(`辨識中… ${Math.round((m.progress || 0) * 100)}%`, false, 120000); else if (/load|download/i.test(m.status || '')) toast(`下載辨識資料… ${Math.round((m.progress || 0) * 100)}%（只有第一次）`, false, 120000); } });
    try { await w.setParameters({ preserve_interword_spaces: '1' }); text = (await w.recognize(canvas)).data.text || ''; } finally { await w.terminate(); }
  } catch (e) { toast('辨識失敗：' + (e && e.message || e), true, 8000); return; }
  toast('辨識完成，請核對', false, 2500);
  window.dayCodesOf = d => data.shops.filter(r => r.shop === sid && r.type === 'in' && r.date === d).map(r => productCodeOf(r.product).split('|')[0]);
  const slip = parseSlip(text, rcvDay(sid), d => data.shops.some(r => r.shop === sid && r.type === 'in' && r.date === d));
  await ocrPreview(sid, slip, text);
}
// 預覽：每行可以改品號、數量、製造日期；對到那天的哪一筆入貨、換成哪個批號
async function ocrPreview(sid, slip, text) {
  const recsOn = d => data.shops.filter(r => r.shop === sid && r.type === 'in' && r.date === d);
  const optsFor = (d, code) => { const rs = recsOn(d), exact = rs.filter(r => productCodeOf(r.product) === code), base = rs.filter(r => productCodeOf(r.product).split('|')[0] === code.split('|')[0]); return exact.length ? [...exact, ...base.filter(r => !exact.includes(r))] : base; };
  const row = (x, i) => `<tr data-ol="${i}"><td><input class="ol-code" value="${esc(x.code)}" maxlength="30" style="width:110px;text-transform:uppercase">${x.how === 'guess' ? `<br><span class="pill due" title="讀到「${esc(x.raw.slice(0, 14))}」，照那天的入貨猜是這個">猜的，請確認</span>` : x.how === 'unknown' ? `<br><span class="pill bad" title="讀到「${esc(x.raw.slice(0, 20))}」">讀不清楚，請改品號</span>` : ''}</td><td><input class="ol-qty" type="number" min="0" step="1" value="${esc(x.qty)}" style="width:64px"></td><td><input class="ol-mfg" type="date" value="${esc(x.mfg)}"></td><td class="ol-out"></td></tr>`;
  const html = `<p class="modal-note">核對辨識結果（照片只在這台手機辨識，不會上傳）。每一行可以改品號、數量、製造日期；批號＝品號碼＋製造日期。按「套用」會把同一個品號各製造日期的數量，存成這天入貨的「已確認」。</p>
    <div class="field"><label for="ol-date">出庫單日期（入貨日）</label><input id="ol-date" type="date" value="${esc(slip.date)}"></div>
    <div class="table-scroll"><table class="data-table"><thead><tr><th>品號</th><th class="num">數量</th><th>製造日期</th><th>批號／對到的入貨</th></tr></thead><tbody id="ol-body">${slip.lines.map(row).join('') || '<tr><td colspan="4" class="who">沒有讀到任何品號，請再拍清楚一點（整張單攤平、光線充足、不要反光）</td></tr>'}</tbody></table></div>
    <details style="margin-top:10px"><summary class="who">看辨識出的原始文字</summary><pre style="white-space:pre-wrap;font-size:11px">${esc(text)}</pre></details><p class="modal-error" hidden></p>`;
  const pr = modal({ title: `${shopName(sid)}門市：出庫單辨識結果`, ok: '套用', wide: true, html,
    collect: b => {
      const date = b.querySelector('#ol-date').value; if (!isDate(date)) throw Error('請填出庫單日期');
      const rows = [...b.querySelectorAll('#ol-body tr[data-ol]')].map(tr => ({ code: cleanBatch(tr.querySelector('.ol-code').value).replace(/^([A-Z]{2})(\d)/, '$1-$2'), qty: Number(tr.querySelector('.ol-qty').value), mfg: tr.querySelector('.ol-mfg').value })).filter(x => x.code && x.qty > 0);
      if (!rows.length) throw Error('沒有可以套用的行');
      for (const x of rows) if (!isDate(x.mfg)) throw Error(`${x.code} 的製造日期沒填`);
      return { date, rows };
    } });
  const body = $('modalBody'), upd = () => {
    const d = body.querySelector('#ol-date').value;
    body.querySelectorAll('#ol-body tr[data-ol]').forEach(tr => {
      const code = cleanBatch(tr.querySelector('.ol-code').value).replace(/^([A-Z]{2})(\d)/, '$1-$2'), mfg = tr.querySelector('.ol-mfg').value, out = tr.querySelector('.ol-out'), o = isDate(d) ? optsFor(d, code) : [];
      const b = o[0] && isDate(mfg) ? makeBatch(o[0].product, mfg) : '', cands = o[0] ? hqCandidates(o[0].product, shopFrom(o[0])) : [];
      out.innerHTML = !o.length ? `<span class="pill bad">這天的入貨沒有 ${esc(code)}</span>` : `<span class="mono">${esc(b || '—')}</span> → ${esc(o[0].product)}${o.length > 1 ? ` <span class="who">（還有 ${o.length - 1} 個同品號的品項，會用這一個）</span>` : ''}${b && cands.length && !cands.includes(b) ? ' <span class="pill due">總公司那天沒有這個批號，請確認製造日期</span>' : ''}`;
    });
  };
  body.addEventListener('input', upd); upd();
  const res = await pr; if (!res) return;
  // 依入貨品項分組：{ 批號: 數量 }
  const by = new Map(), miss = [];
  for (const x of res.rows) { const r = optsFor(res.date, x.code)[0]; if (!r) { miss.push(x.code); continue; } const b = makeBatch(r.product, x.mfg); if (!b) { miss.push(x.code); continue; } const m = by.get(r.id) || { r, scan: {} }; m.scan[b] = clampQty((m.scan[b] || 0) + x.qty); by.set(r.id, m); }
  const warn = [];
  act(() => {
    const recs = [...by.values()].map(({ r, scan }) => { const sum = sumQ(Object.values(scan), v => v); if (Math.abs(sum - r.quantity) > 1e-7) warn.push(`${productCodeOf(r.product)} 出庫單 ${fmt(sum)}／入貨 ${fmt(r.quantity)}`); const { batch: _b, ...rest } = r; return { ...rest, batch: '', scan, ...stampEdit() }; });
    if (recs.length) FEStore.saveMany('shop', recs);
    rcvDate[sid] = res.date;
  });
  toast(`已套用 ${by.size} 個品項的批號${miss.length ? `；對不到：${miss.join('、')}` : ''}${warn.length ? `；數量跟入貨不一樣（以出庫單為準，多的部分不算）：${warn.join('、')}` : ''}`, !!(miss.length || warn.length), miss.length || warn.length ? 10000 : 4000);
}
/* ---------- 門市盤點（2026-11-20 起，每間門市頁的「門市盤點」分頁） ----------
   盤點單（audit 的 type 'session'，有 shop）：日期＋時間點（end＝當天結束、start＝當天開始前）＋狀態。
   實盤（type 'count'，有 shop）：每個產品＋批號一列（批號不明的一列），key＝「P|產品|批號」；實盤新增的列可以填入貨日（sellFrom，盤盈的可販售期第 1 天）。
   帳上：盤點時間點的門市庫存（當天結束＝含當天；當天開始前＝前一天結束），這張盤點單自己的調整也算進去，所以套用後就會一致。
   差異處理（門市沒有總表，App 自己調）：每個產品每列都盤了、跟帳上不一樣 →「套用盤點結果」：
     少的 → 盤虧（type 'loss'，照那個批號扣；批號不明的只扣批號不明的）
     多的 → 盤盈（type 'in'＋aud，批號照實盤）；同一個產品有盤虧的（其實是同一批貨、批號推定錯）照扣掉的那幾批的入貨日當可販售期第 1 天（可販售到不變），
            剩下真的多出來的（例如期初盤點的舊貨）用實盤時填的入貨日，沒填就保守用批號的製造日期，都沒有用盤點日。
     記在盤點日：當天結束的盤點記在當天最後（phase close），當天開始前的記在當天最一開始（phase open）。可以「取消這張的調整」還原。 */
const shopAudSel = {}, shopAudMode = Object.fromEntries(SHOPS.map(s => [s.id, 'all']));
let shopAudDirty = false;
const shopAudSessions = sid => data.audits.filter(r => r.type === 'session' && r.shop === sid).sort((a, b) => cmp(b.date, a.date) || b.seq - a.seq);
const shopAudSession = sid => shopAudSessions(sid).find(r => r.id === shopAudSel[sid]) || shopAudSessions(sid)[0] || null;
const shopAudKey = (product, batch) => `P|${product}|${batch || ''}`;
const shopAudAdj = sess => data.shops.filter(r => r.aud === sess.id);
function shopAudBook(sess) {
  const sid = sess.shop, list = data.shops.filter(r => r.shop === sid && (r.date < sess.date || (sess.phase === 'end' && r.date === sess.date) || r.aud === sess.id));
  const L = shopLedger(sid, list, shopBatchPlan()), m = new Map();
  for (const l of L.lots) {
    if (!(l.left > 1e-7)) continue;
    const key = shopAudKey(l.product, l.batch), x = m.get(key) || { key, product: l.product, batch: l.batch || '', book: 0, exps: new Set(), guess: false };
    x.book = clampQty(x.book + l.left); x.exps.add(l.expiry); if (l.guess && l.batch) x.guess = true; m.set(key, x);
  }
  return m;
}
function shopAudSheet(sess) {
  const book = shopAudBook(sess), counts = new Map(data.audits.filter(r => r.type === 'count' && r.session === sess.id).map(r => [r.key, r]));
  const lines = new Map([...book.values()].map(x => [x.key, { ...x, count: null, rec: null }]));
  for (const [k, c] of counts) { const x = lines.get(k) || { key: k, product: c.product, batch: c.batch || '', book: 0, exps: new Set(), guess: false, added: true }; x.count = c.qty; x.rec = c; if (c.sellFrom) x.sellFrom = c.sellFrom; lines.set(k, x); }
  const byP = new Map(); for (const x of lines.values()) { if (!byP.has(x.product)) byP.set(x.product, []); byP.get(x.product).push(x); }
  const prods = [...byP.entries()].map(([product, list]) => {
    list.sort((a, b) => (a.batch ? 0 : 1) - (b.batch ? 0 : 1) || cmp(batchDate(a.batch) || a.batch, batchDate(b.batch) || b.batch));
    const counted = list.filter(x => x.count !== null), bk = sumQ(list, x => x.book), cn = sumQ(counted, x => x.count);
    const st = !counted.length ? 'todo' : counted.length < list.length ? 'partial' : list.every(x => Math.abs(x.count - x.book) < 1e-7) ? 'ok' : Math.abs(cn - bk) < 1e-7 ? 'dist' : 'total';
    return { product, list, g: { st, book: bk, cnt: cn, counted: counted.length, n: list.length } };
  }).sort((a, b) => productOrder(a.product, b.product));
  return { prods };
}
const SAUD_ST = { todo: ['未盤', 'other'], partial: ['盤點中', 'due'], ok: ['一致', 'ok'], dist: ['批號不同（總數一樣）', 'due'], total: ['總數不同', 'bad'] };
function renderShopAudit(sid) {
  const listEl = $('saudList-' + sid); if (!listEl) return;
  const ss = shopAudSessions(sid), sess = shopAudSession(sid), editP = can(shopPerm(sid));
  $('saudListInfo-' + sid).textContent = ss.length ? `共 ${ss.length} 張盤點單，點一下打開` : '還沒有盤點單，按右邊「新增盤點單」開始。第一次盤點（期初盤點）請把架上所有的貨都盤，包含 App 帳上沒有的舊貨';
  listEl.innerHTML = ss.length ? table(['盤點日期', '時間點', '狀態', '調整', '建立人', ''], ss.map(r => `<tr${sess && r.id === sess.id ? ' class="row-on"' : ''}>${tdm(r.date)}${td(r.phase === 'start' ? '當天開始前' : '當天結束')}${td(r.status === 'done' ? badge('已完成', 'ok') : badge('盤點中', 'due'))}${td(shopAudAdj(r).length ? `${shopAudAdj(r).length} 筆` : '—')}${td(esc(r.by || '—'))}${td(`<button type="button" class="btn small" data-action="shop-aud-open" data-shop="${sid}" data-id="${esc(r.id)}">${sess && r.id === sess.id ? '目前這張' : '打開'}</button>`)}</tr>`), '') : '';
  const panel = $('saudSheet-' + sid); panel.hidden = !sess; if (!sess) return;
  const tbl = $('saudTable-' + sid);
  if (tbl.contains(document.activeElement) && document.activeElement.matches('[data-saud]')) { shopAudDirty = true; return; }
  const { prods } = shopAudSheet(sess), edit = editP && sess.status !== 'done', mode = shopAudMode[sid], cnt = st => prods.filter(p => p.g.st === st).length;
  document.querySelectorAll(`#saudSeg-${sid} [data-samode]`).forEach(b => b.classList.toggle('on', b.dataset.samode === mode));
  const adj = shopAudAdj(sess), need = prods.filter(p => p.g.st === 'dist' || p.g.st === 'total');
  $('saudTitle-' + sid).textContent = `盤點表：${sess.date}（${sess.phase === 'start' ? '當天開始前' : '當天結束'}）`;
  $('saudInfo-' + sid).textContent = `${sess.status === 'done' ? '已完成' : '盤點中'}｜帳上＝${sess.phase === 'start' ? `${addDays(sess.date, -1)} 結束` : `${sess.date} 結束`}的門市庫存｜一致 ${cnt('ok')} 項、批號不同 ${cnt('dist')} 項、總數不同 ${cnt('total')} 項、盤點中 ${cnt('partial')} 項、未盤 ${cnt('todo')} 項`;
  $('saudActions-' + sid).innerHTML = [
    need.length ? `<div class="notice warning"><strong>跟帳上不一樣 ${need.length} 項</strong>：${esc(need.map(p => `${productCodeOf(p.product)}（帳上 ${fmt(p.g.book)}／實盤 ${fmt(p.g.cnt)}）`).join('、'))}。按「套用盤點結果」會讓帳上照實盤：少的記成盤虧、多的記成盤盈（門市沒有總表，App 直接調整）。還沒盤完的品項不會調整。${editP ? ' <button type="button" class="btn small primary" data-action="shop-aud-apply" data-shop="' + sid + '">套用盤點結果</button>' : ''}</div>` : '',
    adj.length ? `<div class="notice">這張盤點單做過 ${adj.length} 筆調整（盤虧 ${adj.filter(r => r.type === 'loss').length} 筆、盤盈 ${adj.filter(r => r.type === 'in').length} 筆${sess.appliedAt ? `，${esc(new Date(sess.appliedAt).toLocaleString('zh-TW'))}` : ''}${sess.appliedBy ? '，' + esc(sess.appliedBy) : ''}），在「入貨／銷售／報廢匯入」分頁的紀錄看得到。${editP ? ` <button type="button" class="btn small danger" data-action="shop-aud-unapply" data-shop="${sid}">取消這張的調整</button>` : ''}</div>` : '',
    editP ? `<div class="form-actions">${edit ? `<button type="button" class="btn small" data-action="shop-aud-add" data-shop="${sid}">＋ 新增一列（帳上沒有的批號）</button><button type="button" class="btn small primary" data-action="shop-aud-done" data-shop="${sid}">完成盤點</button>` : `<button type="button" class="btn small" data-action="shop-aud-reopen" data-shop="${sid}">重新開啟</button>`}<button type="button" class="btn small danger" data-action="shop-aud-delete" data-shop="${sid}">刪除盤點單</button></div>` : ''].join('');
  const q = clean($('saudFilter-' + sid).value).toLowerCase();
  const show = p => { if (mode === 'diff' && !(p.g.st === 'dist' || p.g.st === 'total' || p.list.some(x => x.count !== null && Math.abs(x.count - x.book) > 1e-7))) return false; if (mode === 'todo' && !(p.g.st === 'todo' || p.g.st === 'partial')) return false; return !q || p.product.toLowerCase().includes(q) || p.list.some(x => x.batch.toLowerCase().includes(q)); };
  const rows = [];
  for (const p of prods.filter(show)) {
    const u = esc(getUnit(p.product));
    rows.push(`<tr class="aud-prod"><td colspan="5"><strong>${esc(p.product)}</strong>　${badge(SAUD_ST[p.g.st][0], SAUD_ST[p.g.st][1])} <span class="who">帳上 ${fmt(p.g.book)}／實盤 ${p.g.counted ? fmt(p.g.cnt) : '—'}</span></td></tr>`);
    for (const x of p.list) {
      const d = x.count === null ? null : clampQty(x.count - x.book), exps = [...x.exps].sort(), gone = exps.length && exps[0] < sess.date;
      const expTxt = exps.length ? exps.map(md).join('、') : x.added ? `（入貨日 ${md(x.sellFrom || batchDate(x.batch) || sess.date)}）` : '—';
      rows.push(`<tr>${td(`<span class="mono">${esc(x.batch || '批號不明')}</span>${x.guess ? ' ' + badge('推定', 'other') : ''}${x.added ? ' ' + badge('實盤新增', 'due') : ''}`)}${td(`<span class="mono">${esc(expTxt)}</span>${gone ? ' ' + badge('已過期', 'expired') : ''}`)}<td class="num">${fmt(x.book)} ${u}</td><td class="num">${edit ? `<input class="aud-in" type="number" inputmode="numeric" min="0" step="1" value="${x.count === null ? '' : esc(x.count)}" placeholder="未盤" data-saud="${esc(x.key)}" data-shop="${sid}" aria-label="${esc(p.product)} ${esc(x.batch || '批號不明')} 實盤">` : (x.count === null ? '—' : fmt(x.count))}</td><td class="num">${d === null ? '—' : Math.abs(d) < 1e-7 ? badge('0', 'ok') : badge((d > 0 ? '＋' : '－') + fmt(Math.abs(d)), 'bad')}</td></tr>`);
    }
  }
  tbl.innerHTML = table(['批號', '可販售到', '帳上#', '實盤#', '差異#'], rows, mode === 'all' ? '這個盤點時間點門市沒有庫存；帳上沒有的貨按「新增一列」加' : '沒有符合的品項');
}
function shopAudSave(el) {
  const sid = el.dataset.shop, sess = shopAudSession(sid); if (!sess || sess.status === 'done' || !can(shopPerm(sid))) return;
  const key = el.dataset.saud, line = shopAudSheet(sess).prods.flatMap(p => p.list).find(x => x.key === key); if (!line) return;
  const v = el.value.trim(), id = `scnt-${sess.id}-${key}`;
  if (v === '') { if (line.rec) act(() => FEStore.remove('audit', line.rec.id)); return; }
  const n = Number(v); if (!Number.isFinite(n) || n < 0) { toast('實盤數量要是 0 以上的數字', true); return; }
  act(() => FEStore.save('audit', { id, type: 'count', shop: sid, session: sess.id, date: sess.date, key, product: line.product, pool: 'stock', batch: line.batch, qty: n, added: !!line.added, ...(line.sellFrom ? { sellFrom: line.sellFrom } : {}), ...(line.rec ? { by: line.rec.by, at: line.rec.at, ...stampEdit() } : stampNew()) }));
}
async function shopAudNew(sid) {
  if (!can(shopPerm(sid))) return;
  const res = await modal({ title: `${shopName(sid)}門市：新增盤點單`, ok: '建立', html: `<div class="field"><label for="san-date">盤點日期</label><input id="san-date" type="date" value="${TODAY()}"></div><div class="field"><label for="san-phase">時間點</label><select id="san-phase"><option value="end">當天結束（已扣當天銷售，打烊後盤）</option><option value="start">當天開始前（開店前、還沒收貨前盤）</option></select></div><p class="modal-note">帳上數量照門市庫存在這個時間點的數字，每個產品＋批號一列。第一次盤點（期初盤點）請把架上所有的貨都盤，帳上沒有的批號按「新增一列」加。</p><p class="modal-error" hidden></p>`, collect: b => { const date = b.querySelector('#san-date').value, phase = b.querySelector('#san-phase').value; if (!isDate(date)) throw Error('請選盤點日期'); return { date, phase }; } });
  if (!res) return;
  const id = 'saud' + uid().replace(/[^A-Za-z0-9]/g, '').slice(-10);
  act(() => { FEStore.save('audit', { id, type: 'session', shop: sid, seq: nextSeq(), date: res.date, phase: res.phase, status: 'open', note: '', ...stampNew() }); shopAudSel[sid] = id; toast(`已建立${shopName(sid)} ${res.date} 的盤點單，開始填實盤數量`); });
}
async function shopAudAddLine(sid) {
  const sess = shopAudSession(sid); if (!sess || sess.status === 'done' || !can(shopPerm(sid))) return;
  const res = await modal({ title: '新增一列（帳上沒有的批號）', ok: '加入', html: `<div class="field"><label for="sal-product">產品</label><input id="sal-product" list="productNames" placeholder="輸入品號或品名" autocomplete="off"></div><div class="field"><label for="sal-batch">批號（盒子標籤上的；看不到就空白＝批號不明）</label><input id="sal-batch" placeholder="例如 CKAS9901" maxlength="30" style="text-transform:uppercase"></div><div class="field"><label for="sal-from">入貨日（可販售期的第 1 天；不知道就空白＝用批號的製造日期）</label><input id="sal-from" type="date"></div><div class="field"><label for="sal-qty">實盤數量</label><input id="sal-qty" type="number" min="0" step="1" inputmode="numeric"></div><p class="modal-note">多出來的貨套用後會記成「盤盈」。入貨日不知道時用批號的製造日期（最早可能的入貨日，可販售期比較保守）；批號也看不到就用盤點日。</p><p class="modal-error" hidden></p>`,
    collect: b => {
      const p = getProduct(b.querySelector('#sal-product').value), batch = cleanBatch(b.querySelector('#sal-batch').value), from = b.querySelector('#sal-from').value, qty = Number(b.querySelector('#sal-qty').value);
      if (!p) throw Error('請從清單選產品'); if (from && (!isDate(from) || from > sess.date)) throw Error('入貨日要在盤點日（含）以前'); if (!(qty >= 0) || !Number.isFinite(qty) || b.querySelector('#sal-qty').value === '') throw Error('請填實盤數量');
      return { product: p.name, batch, from, qty };
    } });
  if (!res) return;
  const key = shopAudKey(res.product, res.batch), old = data.audits.find(r => r.type === 'count' && r.session === sess.id && r.key === key);
  act(() => { FEStore.save('audit', { id: `scnt-${sess.id}-${key}`, type: 'count', shop: sid, session: sess.id, date: sess.date, key, product: res.product, pool: 'stock', batch: res.batch, qty: res.qty, added: old ? !!old.added : !shopAudBook(sess).has(key), ...(res.from ? { sellFrom: res.from } : {}), ...stampNew() }); toast('已加入'); });
}
// 套用盤點結果要新增的紀錄（還沒存）
function shopAudPlan(sess) {
  const { prods } = shopAudSheet(sess), date = sess.date, phase = sess.phase === 'start' ? 'open' : 'close', who = myName(), at = nowIso(), outs = [], ins = [];
  for (const p of prods) { if (p.g.st !== 'dist' && p.g.st !== 'total') continue; for (const x of p.list) { const d = clampQty(x.count - x.book); if (d < -1e-7) outs.push({ x, q: -d }); else if (d > 1e-7) ins.push({ x, q: d }); } }
  let n = shopAudAdj(sess).length;
  const base = (x, q) => ({ id: `saud-${sess.id}-${++n}`, shop: sess.shop, date, product: x.product, quantity: q, batch: x.batch || '', aud: sess.id, phase, seq: nextSeq(), by: who, at });
  const loss = outs.map(o => ({ ...base(o.x, o.q), type: 'loss', ...(o.x.batch ? {} : { unk: true }), note: `盤點盤虧（${sess.date}）` }));
  // 盤虧扣掉的是哪幾天入貨的（同一個產品的盤盈照這些入貨日，可販售到不變）
  const L = shopLedger(sess.shop, [...data.shops, ...loss]), src = new Map();
  for (const r of loss) for (const pt of ((L.outs.get(r.id) || {}).parts || [])) { if (!pt.date) continue; const a = src.get(r.product) || []; a.push({ date: pt.date, q: pt.q }); src.set(r.product, a); }
  const gain = [];
  for (const i of ins) {
    let need = i.q;
    for (const s of (src.get(i.x.product) || [])) { if (need <= 1e-7) break; if (s.q <= 1e-7) continue; const q = clampQty(Math.min(need, s.q)); s.q = clampQty(s.q - q); need = clampQty(need - q); gain.push({ ...base(i.x, q), type: 'in', sellFrom: s.date, expiryDate: shopExpiryFor(i.x.product, s.date), note: `盤點盤盈（${sess.date}，批號照實盤）` }); }
    if (need > 1e-7) { let sf = i.x.sellFrom || batchDate(i.x.batch) || date; if (sf > date) sf = date; gain.push({ ...base(i.x, need), type: 'in', sellFrom: sf, expiryDate: shopExpiryFor(i.x.product, sf), note: `盤點盤盈（${sess.date}）` }); }
  }
  return { loss, gain };
}
async function shopAudApply(sid) {
  const sess = shopAudSession(sid); if (!sess || !can(shopPerm(sid))) return;
  const { loss, gain } = shopAudPlan(sess); if (!loss.length && !gain.length) { toast('沒有要調整的（每列都盤完、跟帳上不一樣的品項才會調整）'); return; }
  const li = r => `<li>${esc(productCodeOf(r.product))} ${r.type === 'loss' ? '盤虧 －' : '盤盈 ＋'}${fmt(r.quantity)}　${esc(r.batch || '批號不明')}${r.type === 'in' ? `・可販售到 ${md(shopExpiryFor(r.product, r.sellFrom))}（入貨日 ${md(r.sellFrom)}）` : ''}</li>`;
  if (!await modal({ title: '套用盤點結果', ok: '套用', html: `<p>會新增 ${loss.length + gain.length} 筆調整（記在 ${esc(sess.date)} ${sess.phase === 'start' ? '最一開始' : '最後'}），讓帳上照實盤：</p><ul>${[...loss, ...gain].map(li).join('')}</ul><p class="modal-note">同一個產品有少有多（批號推定錯、其實是同一批貨）的，多的照扣掉的那幾批的入貨日，可販售到不變；真的多出來的用實盤時填的入貨日，沒填就用批號的製造日期（保守）。之後可以按「取消這張的調整」還原。</p>` })) return;
  act(() => { FEStore.saveMany('shop', [...loss, ...gain]); FEStore.save('audit', { ...sess, appliedAt: Date.now(), appliedBy: myName(), ...stampEdit() }); toast(`已套用：盤虧 ${loss.length} 筆、盤盈 ${gain.length} 筆，帳上已跟實盤一致`); });
}
async function shopAudUnapply(sid) {
  const sess = shopAudSession(sid); if (!sess || !can(shopPerm(sid))) return;
  const ids = shopAudAdj(sess).map(r => r.id); if (!ids.length) return;
  if (!await modal({ title: '取消這張的調整？', ok: '取消調整', danger: true, html: `<p>會刪掉這張盤點單做的 ${ids.length} 筆盤虧／盤盈，帳上回到調整前。</p>` })) return;
  act(() => { FEStore.removeMany('shop', ids); FEStore.save('audit', { ...sess, appliedAt: '', appliedBy: '', ...stampEdit() }); toast('已取消這張盤點單的調整'); });
}
function shopAudStatus(sid, status) { const sess = shopAudSession(sid); if (!sess || !can(shopPerm(sid))) return; act(() => { FEStore.save('audit', { ...sess, status, ...stampEdit() }); toast(status === 'done' ? '盤點單已完成（不能再改實盤；要改請按「重新開啟」）' : '已重新開啟盤點單'); }); }
async function shopAudDelete(sid) {
  const sess = shopAudSession(sid); if (!sess || !can(shopPerm(sid))) return;
  const cnts = data.audits.filter(r => r.type === 'count' && r.session === sess.id).map(r => r.id), adj = shopAudAdj(sess).length;
  if (!await modal({ title: '刪除這張盤點單？', ok: '刪除', danger: true, html: `<p>${esc(shopName(sid))} ${esc(sess.date)}（${sess.phase === 'start' ? '當天開始前' : '當天結束'}）的盤點單與 ${cnts.length} 筆實盤數量會刪除，不能復原。</p>${adj ? `<p class="modal-note">這張做過的 ${adj} 筆盤虧／盤盈不會刪掉；要還原請先按「取消這張的調整」。</p>` : ''}` })) return;
  act(() => { FEStore.removeMany('audit', [sess.id, ...cnts]); shopAudSel[sid] = ''; toast('已刪除盤點單'); });
}
function shopAudCsv(sid) {
  const sess = shopAudSession(sid); if (!sess) return;
  const rows = [];
  for (const p of shopAudSheet(sess).prods) for (const x of p.list) rows.push([shopName(sid), p.product, getUnit(p.product), x.batch || '批號不明', x.guess ? '推定' : '', [...x.exps].sort().join(' '), x.book, x.count === null ? '' : x.count, x.count === null ? '' : clampQty(x.count - x.book), SAUD_ST[p.g.st][0], x.added ? '實盤新增' : '', x.rec ? (x.rec.editBy || x.rec.by) : '']);
  const content = '﻿' + [['門市', '產品', '單位', '批號', '批號來源', '可販售到', '帳上', '實盤', '差異', '這項狀態', '備註', '盤點人'], ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
  downloadFile(`門市盤點_${shopName(sid)}_${sess.date}_${sess.phase === 'start' ? '開始前' : '結束'}.csv`, content, 'text/csv;charset=utf-8', '盤點表 CSV 已下載');
}
/* ---------- 門市批次匯入（銷售／報廢） ----------
   選檔案（POS 銷售明細 Excel／CSV）或從 Excel 複製貼上，欄位規則見 parseShopPaste。存成那天的銷售（或報廢）紀錄，id imp-類別-門市-日期-品號：
   同一間門市、同一天、同一類別再匯入一次會取代上次匯入的數字（上次有、這次沒有的品項會移除），手動登錄的紀錄不受影響。
   批號不用填：有 POS 批號就存成 pref（先扣那個批號），其餘照先到期先扣。之後有匯入連結時，帶入也用同一套規則。 */
function matchProductCell(cell) {
  const v = clean(cell); if (!v) return null;
  const up = v.toUpperCase(), list = data.products.filter(p => !p.virtual);
  return list.find(p => p.name === v)
    || list.find(p => productCodeOf(p.name).toUpperCase() === up)
    || list.find(p => clean(p.name.slice(productCodeOf(p.name).length)) === v)
    || list.find(p => up.startsWith(productCodeOf(p.name).toUpperCase() + ' ')) || null;
}
// 表格的日期格子：2026/11/18、2026-11-18、11/18/26（Excel 預設）、20261118、Excel 日期序號
function parseCellDate(v) {
  const t = clean(v); if (!t) return '';
  let m = t.match(/(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/); if (m) { const ds = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; return isDate(ds) ? ds : ''; }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3], ds = `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; return isDate(ds) ? ds : ''; }
  m = t.match(/^(20\d{2})(\d{2})(\d{2})$/); if (m) { const ds = `${m[1]}-${m[2]}-${m[3]}`; return isDate(ds) ? ds : ''; }
  if (/^\d{5}(\.\d+)?$/.test(t)) { const n = Math.floor(Number(t)); if (n > 40000 && n < 60000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.toISOString().slice(0, 10); } }
  return '';
}
// 分欄：有 Tab 用 Tab（從 Excel 複製、Excel 檔轉出），沒有用逗號（CSV）；引號裡的分隔符號、換行不算
function splitTable(text) {
  const t = String(text || '').replace(/^\ufeff/, ''), fs = t.includes('\t') ? '\t' : ',', rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"' && !cell.trim()) { q = true; cell = ''; continue; }
    if (ch === fs) { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows.map(r => r.map(c => clean(c.replace(/\s+/g, ' ')))).filter(r => r.some(Boolean));
}
const numCell = v => { const t = clean(v).replace(/[,，\s]/g, ''); return t === '' ? NaN : Number(t); };
/* 解析貼上的內容或檔案（Excel／CSV）：
   有標題列（品號／品名＋數量）就照欄位讀：日期欄 → 依每一列的日期分開匯入；倉庫欄（POS 代號，見 SHOPS.pos；1＝總公司）或門市欄 → 分門市（總公司和其他倉庫不匯入）；
   批號欄 → 存成 pref（門市帳先扣那個批號，不夠才先到期先扣）；不在產品清單的（運費、蠟燭、蛋捲…）不匯入。
   組合品（例如 CK-01|YB-86 6原|天蠍烙）：POS 會分成 CK-01、YB-86 兩行（品號跟一般 6原 一樣），用訂單單號對揀貨總表：
   這張訂單有寄這個組合品到這間門市（門市入貨紀錄的 orders），就把 POS 上這張單的 CK-01（和 YB-86）組回組合品，最多到寄來的數量；
   門市自己預留（揀貨總表刪單）、現場買的（沒有訂單單號）＝門市拿一般 6原 現場加烙印，扣一般 6原。
   舊的入貨紀錄沒有訂單資料時：同一張訂單 POS 上組合品的品號都有、而且門市收過這個組合品，才組合。
   沒有標題列：每一行找品號或品名，數量取那一行最後一個數字（舊做法）。
   回傳 groups：[{ shop, date（'' = 用畫面選的日期）, items: [{ product, quantity, pref }] }] */
function parseShopPaste(text, sid) {
  const rows = splitTable(text), skipped = [], untracked = new Map(), otherWh = new Map();
  let hi = -1, col = {};
  for (let i = 0; i < Math.min(rows.length, 8) && hi < 0; i++) {
    const f = re => rows[i].findIndex(c => re.test(c));
    const qty = f(/數量|件數|^數$|qty|quantity/i), code = f(/品號|商品編號|商品代碼|編號|代碼|貨號|sku/i), name = f(/品名|商品名稱|名稱|品項|商品/);
    if (qty >= 0 && (code >= 0 || name >= 0)) hi = i, col = { qty, code, name, date: f(/日期|date/i), wh: f(/倉庫|倉別|庫別/), shop: f(/門市|分店|店別|店名|store/i), batch: f(/批號|批次|^lot/i), order: f(/訂單單號|訂單編號|銷貨單號|^單號/), time: f(/交易時間|交易序號|交易編號/) };
  }
  const ents = [];
  rows.forEach((cells, i) => {
    if (hi >= 0 && i <= hi) return; // 標題列（和上面的抬頭）
    if (cells.some(c => /^(合計|小計|總計|總和|total)/i.test(c))) return; // 合計列
    const line = cells.join(' ').slice(0, 40);
    let shop = sid, date = '', p = null, q = NaN, batch = '', code = '', key = 'r' + i, ord = '';
    if (hi >= 0) {
      if (col.wh >= 0 || col.shop >= 0) {
        const v = col.wh >= 0 ? cells[col.wh] || '' : cells[col.shop] || '', s = col.wh >= 0 ? SHOPS.find(x => x.pos === v.replace(/^0+(?=\d)/, '')) : v && SHOPS.find(x => v.includes(x.name));
        if (!s) { const vk = v.replace(/^0+(?=\d)/, '') || '空白'; otherWh.set(vk, (otherWh.get(vk) || 0) + 1); return; }
        shop = s.id;
      }
      code = col.code >= 0 ? (cells[col.code] || '').toUpperCase() : '';
      p = (code && matchProductCell(code)) || (col.name >= 0 && matchProductCell(cells[col.name])) || null;
      q = numCell(cells[col.qty]);
      batch = col.batch >= 0 ? cleanBatch(cells[col.batch]) : '';
      ord = col.order >= 0 ? orderNo(cells[col.order]) : '';
      key = ord || (col.order >= 0 && cells[col.order]) || (col.time >= 0 && cells[col.time]) || key;
      if (col.date >= 0) { date = parseCellDate(cells[col.date]); if (!date) { if (p || q > 0) skipped.push(line); return; } }
    } else {
      let pi = -1;
      for (let k = 0; k < cells.length && !p; k++) { p = matchProductCell(cells[k]); if (p) pi = k; }
      for (let k = cells.length - 1; k >= 0; k--) { if (k === pi) continue; const n = numCell(cells[k]); if (Number.isFinite(n)) { q = n; break; } }
      if (p) code = productCodeOf(p.name).toUpperCase();
    }
    if (!(q > 0) || q >= 1e7) { if (p || (hi < 0 && cells.some(Boolean))) skipped.push(line); return; }
    if (p && isExcluded(p.name)) return;
    if (!p && !code) { skipped.push(line); return; }
    ents.push({ shop, date, key, ord, code, p, left: q, batch, label: p ? p.name : `${code} ${col.name >= 0 ? cells[col.name] || '' : ''}`.trim() });
  });
  // 組合品：照訂單單號對門市入貨（揀貨總表寄來的組合品）
  let comboN = 0;
  const out = new Map(), add = (shop, date, prod, q, batch) => {
    const k = shop + '|' + date, g = out.get(k) || { shop, date, m: new Map() }, x = g.m.get(prod.name) || { product: prod.name, quantity: 0, pref: {} };
    x.quantity = clampQty(x.quantity + q); if (batch) x.pref[batch] = clampQty((x.pref[batch] || 0) + q);
    g.m.set(prod.name, x); out.set(k, g);
  };
  if (hi >= 0) {
    const combos = data.products.filter(x => !x.virtual && !isExcluded(x.name) && productCodeOf(x.name).includes('|')).map(x => ({ p: x, codes: productCodeOf(x.name).toUpperCase().split('|') }));
    const byTxn = new Map(); for (const e of ents) { const k = `${e.shop}|${e.date}|${e.key}`; byTxn.set(k, [...(byTxn.get(k) || []), e]); }
    for (const g of byTxn.values()) for (const c of combos) {
      const { shop, date, ord } = g[0];
      if (!ord || !g.some(e => e.code === c.codes[0] && e.left > 0)) continue; // 沒有訂單單號（現場買）不組合
      const ins = data.shops.filter(r => r.shop === shop && r.type === 'in' && r.product === c.p.name && (!date || r.date <= date));
      if (!ins.length) continue;
      let cap = Infinity, need = c.codes;
      if (ins.some(r => r.orders)) {
        // 新版：這張訂單有寄這個組合品來才組，最多到寄來的數量；POS 上沒有的配件（盒子、腰帶）不用對
        cap = sumQ(ins, r => (r.orders && r.orders[ord]) || 0); if (!(cap > 0)) continue;
        need = c.codes.filter(cd => g.some(e => e.code === cd));
      }
      const got = need.map(cd => g.filter(e => e.code === cd && e.left > 0));
      if (got.some(a => !a.length)) continue;
      const n = Math.min(cap, ...got.map(a => sumQ(a, e => e.left))); if (!(n > 0)) continue;
      got.forEach((a, k) => { let left = n; for (const e of a) { const t = clampQty(Math.min(e.left, left)); e.left = clampQty(e.left - t); left = clampQty(left - t); if (k === 0) add(shop, date, c.p, t, e.batch); } });
      comboN = clampQty(comboN + n);
    }
  }
  for (const e of ents) {
    if (!(e.left > 0)) continue;
    if (e.p) add(e.shop, e.date, e.p, e.left, e.batch); else untracked.set(e.label, clampQty((untracked.get(e.label) || 0) + e.left));
  }
  const groups = [...out.values()].sort((x, y) => cmp(x.shop === sid ? '' : x.shop, y.shop === sid ? '' : y.shop) || cmp(x.date, y.date))
    .map(g => ({ shop: g.shop, date: g.date, items: [...g.m.values()].map(x => Object.keys(x.pref).length ? x : { product: x.product, quantity: x.quantity }).sort((a, b) => productOrder(a.product, b.product)) }));
  return { groups, items: groups.flatMap(g => g.items), skipped, untracked, otherWh, comboN, header: hi >= 0, dateCol: hi >= 0 && col.date >= 0, shopCol: hi >= 0 && (col.wh >= 0 || col.shop >= 0) };
}
const shopImportId = (sid, type, date, product) => `imp-${type}-${sid}-${date}-${productCodeOf(product)}`;
function shopImportRecords(sid, type, date, items, note = '批次匯入') {
  const who = myName(), at = nowIso(), old = new Map(data.shops.filter(r => r.shop === sid && r.type === type && r.date === date && String(r.id).startsWith(`imp-${type}-${sid}-${date}-`)).map(r => [r.id, r]));
  const recs = items.map(x => {
    const id = shopImportId(sid, type, date, x.product), o = old.get(id), pref = x.pref && Object.keys(x.pref).length ? x.pref : undefined;
    if (o) { const { pref: _drop, ...rest } = o; return { ...rest, product: x.product, quantity: x.quantity, ...(pref ? { pref } : {}), ...stampEdit() }; }
    return { id, shop: sid, type, date, product: x.product, quantity: x.quantity, batch: '', ...(pref ? { pref } : {}), note, seq: nextSeq(), by: who, at };
  });
  const keep = new Set(recs.map(r => r.id));
  return { recs, removes: [...old.keys()].filter(id => !keep.has(id)), replaced: old.size };
}
// 讀檔案：Excel（.xlsx／.xls，第一個有資料的工作表）或 CSV／文字檔（UTF-8，讀起來是亂碼就改用 Big5）→ 轉成用 Tab 分隔的文字（格子裡的換行改成空白）
async function readTableFile(file) {
  const nm = (file.name || '').toLowerCase();
  if (/\.(xlsx|xlsm|xls|ods)$/.test(nm)) {
    const XLSX = await loadXLSX(), wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.SheetNames.map(n => wb.Sheets[n]).find(w => w && w['!ref']) || wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: false }).map(r => r.map(c => String(c ?? '').replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
  }
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.includes('\ufffd')) { try { t = new TextDecoder('big5').decode(buf); } catch (e) {} }
  return t.replace(/^\ufeff/, '');
}
const prefText = pref => pref ? Object.entries(pref).map(([b, q]) => `${b}×${fmt(q)}`).join('、') : '';
async function openShopImport(sid) {
  if (!can(shopPerm(sid))) return;
  const name = shopName(sid), whNote = SHOPS.map(x => `${x.pos}＝${x.name}`).join('、');
  const pr = modal({ title: `${name}門市：匯入銷售／報廢`, ok: '匯入', wide: true,
    html: `<p class="modal-note"><strong>選擇檔案</strong>（POS 銷售明細等 Excel .xls／.xlsx 或 CSV）或從 Excel <strong>直接複製貼上</strong>。有標題列就照欄位讀：<strong>品號</strong>（或品名）、<strong>數量</strong>；有<strong>日期</strong>欄照每一列的日期分開匯入；有<strong>倉庫</strong>欄照代號分門市（${esc(whNote)}；1＝總公司不匯入，總公司的出貨照入口網站總表的實際揀貨）；有<strong>批號</strong>欄就先扣那個批號，門市沒有那個批號才照先到期先扣。<strong>組合品</strong>（6原|天蠍烙 等）照<strong>訂單單號</strong>對揀貨總表：總公司有寄這個組合品來才組合，門市自己預留或現場買的扣一般 6原。不在產品清單的（運費、蠟燭…）不匯入。同一天、同一類別再匯入一次會<strong>取代</strong>上次匯入的數字；手動登錄的不受影響。</p>
      <div class="form-grid"><div class="field"><label for="si-date">日期（檔案裡沒有日期欄時用）</label><input id="si-date" type="date" value="${TODAY()}"></div><div class="field"><label for="si-type">類別</label><select id="si-type"><option value="sale">銷售</option><option value="waste">報廢</option><option value="take">領取</option></select></div><div class="field span2"><label for="si-file">選擇檔案</label><input id="si-file" type="file" accept=".xlsx,.xls,.xlsm,.ods,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"></div></div>
      <label id="si-allrow" class="tog" for="si-all" hidden><input id="si-all" type="checkbox" checked> <span id="si-alltext">同時匯入其他門市</span></label>
      <div class="field"><label for="si-text">或貼上資料（選了檔案會自動帶進來，可以再改）</label><textarea id="si-text" rows="6" wrap="off" placeholder="例如：&#10;品號	品名	數量&#10;CK-01	6原	5&#10;CK-01|YB-86	6原|天蠍烙(閃耀)	3"></textarea></div>
      <div id="si-preview"></div><p class="modal-error" hidden></p>`,
    collect: b => {
      const date = b.querySelector('#si-date').value, type = b.querySelector('#si-type').value, r = parseShopPaste(b.querySelector('#si-text').value, sid), all = b.querySelector('#si-all').checked;
      const gs = r.groups.filter(g => g.shop === sid || (all && can(shopPerm(g.shop))));
      if (!gs.length) throw Error(r.items.length ? `檔案裡沒有${name}的資料（倉庫代號 ${SHOPS.find(x => x.id === sid).pos}）` : '沒有對到任何產品和數量，請確認內容有品號（或品名）和數量');
      if (!r.dateCol && !isDate(date)) throw Error('請選日期');
      return { type, groups: gs.map(g => ({ shop: g.shop, date: g.date || date, items: g.items })) };
    } });
  const body = $('modalBody'), upd = () => {
    const date = body.querySelector('#si-date').value, type = body.querySelector('#si-type').value, r = parseShopPaste(body.querySelector('#si-text').value, sid), box = body.querySelector('#si-preview');
    const others = [...new Set(r.groups.map(g => g.shop))].filter(x => x !== sid && can(shopPerm(x))), allRow = body.querySelector('#si-allrow');
    allRow.hidden = !others.length; body.querySelector('#si-alltext').textContent = `同時匯入其他門市（${others.map(shopName).join('、')}）`;
    const all = body.querySelector('#si-all').checked;
    if (!r.items.length && !r.skipped.length && !r.untracked.size && !r.otherWh.size) { box.innerHTML = ''; return; }
    const gs = r.groups.filter(g => g.shop === sid || (all && others.includes(g.shop))).map(g => ({ shop: g.shop, date: g.date || date, items: g.items })).filter(g => isDate(g.date));
    let list = data.shops; const done = [];
    for (const g of gs) { const x = shopImportRecords(g.shop, type, g.date, g.items); list = [...list.filter(y => !x.removes.includes(y.id) && !x.recs.some(z => z.id === y.id)), ...x.recs]; done.push({ ...g, ...x }); }
    const Ls = new Map([...new Set(done.map(g => g.shop))].map(x => [x, shopLedger(x, list)])), outOf = (g, rec) => rec && Ls.get(g.shop).outs.get(rec.id);
    const short = sumQ(done.flatMap(g => g.recs.map(rec => (outOf(g, rec) || {}).short || 0)), v => v), replaced = sumQ(done, g => g.replaced), multi = new Set(done.map(g => g.shop)).size > 1;
    const rows = done.flatMap(g => g.items.map(x => { const rec = g.recs.find(y => y.product === x.product), o = outOf(g, rec); return `<tr>${multi ? td(esc(shopName(g.shop))) : ''}${tdm(g.date)}${td(`<strong>${esc(x.product)}</strong>`)}<td class="num">${fmt(x.quantity)}</td>${tdm(prefText(x.pref) || '—')}${td(esc(o ? shopPartsText(o.parts) || '—' : '—'))}<td class="num">${o && o.short ? badge(fmt(o.short), 'bad') : '—'}</td></tr>`; }));
    const perShop = [...new Set(done.map(g => g.shop))].map(x => `${shopName(x)} ${fmt(sumQ(done.filter(g => g.shop === x).flatMap(g => g.items)))} 個`).join('、');
    const wh = [...r.otherWh.entries()].map(([k, n]) => `${k}${posWhName(k) ? ' ' + posWhName(k) : ''}（${n} 列）`).join('、'), un = [...r.untracked.keys()];
    const dates = [...new Set(done.map(g => g.date))];
    box.innerHTML = `<div class="notice${short || r.skipped.length ? ' warning' : ''}">${r.dateCol ? `檔案裡的日期：${esc(dates.map(shortDate).join('、') || '—')}。` : ''}會匯入 ${done.reduce((s, g) => s + g.items.length, 0)} 筆${multi || r.shopCol ? `：${esc(perShop)}` : `、共 ${fmt(sumQ(done.flatMap(g => g.items)))} 個`}${r.comboN ? `；照訂單單號組成組合品 ${fmt(r.comboN)} 個` : ''}${replaced ? `；會取代上次匯入的 ${replaced} 筆` : ''}${short ? `；有 ${fmt(short)} 個庫存不夠扣（缺口${type === 'sale' ? '，過了可販售期的不能銷售' : ''}）` : ''}${r.skipped.length ? `；略過 ${r.skipped.length} 行（數量或日期讀不到）：${esc(r.skipped.slice(0, 3).join('｜'))}${r.skipped.length > 3 ? '…' : ''}` : ''}</div>
      ${wh || un.length ? `<p class="modal-note">${wh ? `不是門市的倉庫沒有匯入：${esc(wh)}${[...r.otherWh.keys()].some(posWhName) ? '（總公司的出貨已經照入口網站總表的實際揀貨帶入）' : ''}。` : ''}${un.length ? `不在產品清單、沒有匯入的 ${un.length} 種：${esc(un.slice(0, 8).join('、'))}${un.length > 8 ? '…' : ''}` : ''}</p>` : ''}
      <div class="table-scroll">${table([...(multi ? ['門市'] : []), '日期', '產品', '數量#', 'POS 批號', '預估扣除（批號優先，再先到期先扣）', '缺口#'], rows, '')}</div>`;
  };
  for (const id of ['si-date', 'si-type', 'si-text']) body.querySelector('#' + id).addEventListener('input', upd);
  for (const id of ['si-type', 'si-all']) body.querySelector('#' + id).addEventListener('change', upd);
  body.querySelector('#si-file').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { body.querySelector('#si-text').value = await readTableFile(f); upd(); toast(`已讀入「${f.name}」，請看下面的預覽`, false, 3000); }
    catch (err) { toast('檔案讀取失敗：' + (err && err.message || err), true, 7000); }
  });
  const res = await pr;
  if (!res) return;
  act(() => {
    const sum = new Map();
    for (const g of res.groups) {
      if (!can(shopPerm(g.shop))) continue;
      const { recs, removes } = shopImportRecords(g.shop, res.type, g.date, g.items);
      if (removes.length) FEStore.removeMany('shop', removes);
      FEStore.saveMany('shop', recs);
      const x = sum.get(g.shop) || { n: 0, q: 0, rm: 0, ids: [], dates: [] }; x.n += recs.length; x.q += sumQ(recs); x.rm += removes.length; x.ids.push(...recs.map(r => r.id)); x.dates.push(g.date); sum.set(g.shop, x);
    }
    let short = 0;
    const msg = [...sum.entries()].map(([shop, x]) => { const L = shopLedger(shop), sh = sumQ(x.ids, id => (L.outs.get(id) || {}).short || 0); short += sh; const ds = [...new Set(x.dates)].sort(); return `${shopName(shop)} ${ds.length > 1 ? `${shortDate(ds[0])}～${shortDate(ds[ds.length - 1])}` : shortDate(ds[0])} ${x.n} 筆、${fmt(x.q)} 個${x.rm ? `（移除上次匯入、這次沒有的 ${x.rm} 筆）` : ''}${sh ? `，缺口 ${fmt(sh)} 個` : ''}`; }).join('；');
    toast(`已匯入${SHOP_TYPES[res.type]}：${msg}`, !!short, short ? 9000 : 6000);
  });
}
// 可販售期設定（只用在門市：入貨那天算第 1 天）
async function editShopRule() {
  if (!can('setting')) return;
  const r = sellRule(), f = (id, lab, v, max) => `<div class="field"><label for="${id}">${lab}</label><input id="${id}" type="number" min="1" max="${max}" step="1" value="${v}"></div>`;
  const res = await modal({ title: '可販售期', ok: '儲存',
    html: `<p class="modal-note">只用在<strong>門市</strong>：入貨那天算第 1 天，最後可販售日＝入貨日＋可販售天數－1。生巧克力＝品號 CL 開頭，其他都算蛋糕類。改了之後，門市現有的庫存也會照新規則重算。總公司不受影響（照半成品、現貨的有效日期）。</p>${f('sl-cd', '蛋糕類：可販售幾天', r.cake.days, 365)}${f('sl-cw', '蛋糕類：第幾天開始提醒', r.cake.warnFrom, 365)}${f('sl-hd', '生巧克力：可販售幾天', r.choc.days, 365)}${f('sl-hw', '生巧克力：第幾天開始提醒', r.choc.warnFrom, 365)}<p class="modal-error" hidden></p>`,
    collect: b => {
      const v = id => Number(b.querySelector('#' + id).value), out = { cake: { days: v('sl-cd'), warnFrom: v('sl-cw') }, choc: { days: v('sl-hd'), warnFrom: v('sl-hw') } };
      for (const [k, x] of Object.entries(out)) { if (!Number.isInteger(x.days) || x.days < 1 || x.days > 365) throw Error(`${SELL_NAMES[k]}的可販售天數要是 1～365 的整數`); if (!Number.isInteger(x.warnFrom) || x.warnFrom < 1 || x.warnFrom > x.days) throw Error(`${SELL_NAMES[k]}的提醒日要在第 1～${x.days} 天之間`); }
      return out;
    } });
  if (!res) return;
  act(() => { FEStore.save('settings', { id: 'sell', ...res }); toast(`可販售期已更新：蛋糕類 ${res.cake.days} 天（第 ${res.cake.warnFrom} 天起提醒）、生巧克力 ${res.choc.days} 天（第 ${res.choc.warnFrom} 天起提醒）`); });
}
// 表單：入貨要批號（列出工廠現貨的批號），到期日自動＝日期＋門市保存天數；銷售、報廢的批號選填（選門市現有的批號）
function shopFormSync(sid) {
  const type = $('shType-' + sid).value, date = $('shDate-' + sid).value, p = getProduct($('shProduct-' + sid).value), box = $('shPreview-' + sid), q = Number($('shQty-' + sid).value), batch = cleanBatch($('shBatch-' + sid).value);
  $('shBatchLab-' + sid).textContent = type === 'in' ? '批號（選填）' : '批號（選填）';
  $('shBatch-' + sid).placeholder = type === 'in' ? '不填＝自動推定' : '不填＝先到期先扣';
  const opts = !p ? [] : type === 'in' ? factoryBatches(p.name).map(x => [x.batch, `工廠 ${x.date} 入庫${x.left > 0 ? `，還剩 ${fmt(x.left)}` : '，已出完'}`])
    : [...new Map(shopLedger(sid).lots.filter(l => l.product === p.name && l.left > 0 && l.batch).map(l => [l.batch, `門市到期 ${l.expiry}，剩 ${fmt(l.left)}`])).entries()];
  $('shBatchList-' + sid).innerHTML = opts.map(([v, l]) => `<option value="${esc(v)}" label="${esc(l)}"></option>`).join('');
  if (!p || !isDate(date)) { box.hidden = true; return; }
  if (type === 'in') {
    let guess = '';
    if (!batch && q > 0) { const tmp = { id: '__preview__', shop: sid, type: 'in', date, product: p.name, quantity: q, batch: '', expiryDate: shopExpiryFor(p.name, date), seq: Date.now() }; guess = shopInText(tmp, shopBatchPlan([...data.shops, tmp])); }
    box.hidden = false; box.className = `notice${guess.includes('批號不明') ? ' warning' : ''}`;
    box.textContent = `可販售到：${shopExpiryFor(p.name, date)}（${date} 入貨算第 1 天，${SELL_NAMES[sellKind(p.name)]}可販售 ${sellOf(p.name).days} 天、第 ${sellOf(p.name).warnFrom} 天起提醒）${batch ? `｜批號 ${batch}` : guess ? `｜${guess}（照總公司 ${date} 的出貨扣批）${guess.includes('批號不明') ? '：總公司當天這個品號的出貨不夠分，多的標「批號不明」' : ''}` : '｜批號不填會自動推定'}${batch && opts.length && !opts.some(([v]) => v === batch) ? '（不在工廠現貨的批號清單裡，請再確認）' : ''}`;
    return;
  }
  if (!(q > 0)) { box.hidden = true; return; }
  const o = shopLedger(sid, [...data.shops, { id: '__preview__', shop: sid, type, date, product: p.name, quantity: q, batch, seq: Date.now() }]).outs.get('__preview__');
  box.hidden = false; box.className = `notice${o.short ? ' warning' : ''}`;
  box.textContent = `預估會扣：${shopPartsText(o.parts) || '沒有可扣的庫存'}${o.short ? `；缺 ${fmt(o.short)} ${getUnit(p.name)}${type === 'sale' ? '（已過期的不能銷售，要用「報廢」扣）' : ''}` : ''}`;
}
function resetShopForm(sid, keep = false) {
  if (!keep) { $('shDate-' + sid).value = TODAY(); $('shType-' + sid).value = 'in'; $('shProduct-' + sid).value = ''; }
  for (const f of ['shBatch-', 'shQty-', 'shNote-']) $(f + sid).value = '';
  shopFormSync(sid);
}
function saveShop(e, sid) { e.preventDefault(); if (!can(shopPerm(sid))) return; act(() => {
  const date = $('shDate-' + sid).value, type = $('shType-' + sid).value, product = clean($('shProduct-' + sid).value), quantity = inputPositive('shQty-' + sid), note = clean($('shNote-' + sid).value), batch = cleanBatch($('shBatch-' + sid).value);
  if (!isDate(date) || !product) throw Error('請輸入日期與產品');
  if (!SHOP_TYPES[type]) throw Error('請選擇類別');
  if (!getProduct(product)) throw Error('此產品尚未建檔，請從清單選擇（可輸入品號或品名搜尋）');
  const rec = { id: uid(), shop: sid, type, date, product, quantity, batch, note, seq: nextSeq(), ...stampNew() };
  if (type === 'in') rec.expiryDate = shopExpiryFor(product, date);
  const o = type === 'in' ? null : shopLedger(sid, [...data.shops, rec]).outs.get(rec.id);
  FEStore.save('shop', rec);
  resetShopForm(sid, true);
  toast(o && o.short ? `已登錄${SHOP_TYPES[type]}：扣 ${fmt(o.done)}，缺 ${fmt(o.short)}（庫存不夠${batch ? '、這個批號不夠' : ''}${type === 'sale' ? '，或剩下的已過期' : ''}）` : type === 'in' ? `已登錄${shopName(sid)}門市入貨 ${fmt(quantity)} ${getUnit(product)}（${shopInText(rec)}），可販售到 ${rec.expiryDate}` : `已登錄${shopName(sid)}門市${SHOP_TYPES[type]} ${fmt(quantity)} ${getUnit(product)}`, !!(o && o.short), o && o.short ? 7000 : 5000);
}); }

/* ---------- 批號產生（依「活頁簿1.xlsx」的批號規則） ----------
   批號 8 碼：第 1、2、7、8 碼＝品號碼；第 3 碼＝月碼；第 4 碼＝年碼；第 5、6 碼＝日期碼
   例：CK-08 在 2026-11-11 生產 → 品號碼 CK08、月碼 A、年碼 S、日期碼 1B → CKAS1B08
   品號碼預設取品號第一段（CK-08 → CK＋08），可在「批號產生」頁逐項自訂（存在 settings 'batch'.codes，以品號為 key） */
const MONTH_CODES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'A', 'B'];
const YEAR_BASE = 2024, YEAR_CODES = 'QRSTUVWXYZ'; // 2024＝Q … 2033＝Z
const monthCode = m => MONTH_CODES[m - 1] || '';
const yearCode = y => YEAR_CODES[y - YEAR_BASE] || '';
const dayCode = d => d >= 1 && d <= 31 ? String(d % 10) + (d < 10 ? String(d) : String.fromCharCode(65 + d - 10)) : '';
// 反過來：從批號讀出日期（現貨批號＝轉現貨那天＝出庫單上的「製造日期」），讀不出來回傳 ''
function batchDate(b) {
  b = String(b || ''); if (b.length !== 8) return '';
  const m = MONTH_CODES.indexOf(b[2]) + 1, y = YEAR_BASE + YEAR_CODES.indexOf(b[3]), c = b[5], d = /[0-9]/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
  if (m < 1 || YEAR_CODES.indexOf(b[3]) < 0 || !(d >= 1 && d <= 31) || dayCode(d) !== b.slice(4, 6)) return '';
  const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isDate(ds) ? ds : '';
}
const batchMd = b => { const d = batchDate(b); return d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8))}` : ''; };
const batchMeta = () => FEStore.get('settings', 'batch') || {};
const customCodes = () => { const c = batchMeta().codes; return c && typeof c === 'object' ? c : {}; };
const BCODE_RE = /^[A-Z0-9]{4}$/;
// 自動品號碼：品號第一段「英文 2 碼－數字 1～2 碼」→ 英文＋兩位數字（CK-08 → CK08、KA-1 → KA01）
function autoProductCode(name) { const m = /^([A-Za-z]{2})-?(\d{1,2})(?![\d])/.exec(productCodeOf(name).split('|')[0]); return m ? (m[1] + m[2].padStart(2, '0')).toUpperCase() : ''; }
function productBatchCode(name) { const c = customCodes()[productCodeOf(name)]; return BCODE_RE.test(c || '') ? c : autoProductCode(name); }
// 產生批號；品號碼或日期不能編碼時回傳 ''
function makeBatch(name, date) {
  if (!isDate(date)) return '';
  const pc = productBatchCode(name), [y, m, d] = date.split('-').map(Number), mc = monthCode(m), yc = yearCode(y), dc = dayCode(d);
  return pc && mc && yc && dc ? pc.slice(0, 2) + mc + yc + dc + pc.slice(2) : '';
}
const batchFor = (name, date) => makeBatch(name, date) || String(date).replace(/-/g, '');
function renderBatchRule(today) {
  for (const id of ['brDate', 'brListDate']) if (!$(id).value) $(id).value = today;
  // 1. 查批號
  const name = clean($('brProduct').value), date = $('brDate').value, p = getProduct(name), box = $('brResult');
  if (!name || !p || !isDate(date)) box.innerHTML = `<div class="empty">${name && !p ? '找不到這個產品，請從清單選擇（可輸入品號或品名）' : '選產品和生產日期，就會產生批號與有效日期'}</div>`;
  else {
    const b = makeBatch(p.name, date), pc = productBatchCode(p.name), [y, m, d] = date.split('-').map(Number), exp = addDays(date, p.shelfDays);
    box.innerHTML = b ? `<div class="br-code mono">${esc(b)}</div><div class="br-parts"><span><b class="mono">${esc(pc.slice(0, 2))}</b>品號碼（1-2 碼）</span><span><b class="mono">${esc(monthCode(m))}</b>${m} 月（第 3 碼）</span><span><b class="mono">${esc(yearCode(y))}</b>${y} 年（第 4 碼）</span><span><b class="mono">${esc(dayCode(d))}</b>${d} 日（第 5-6 碼）</span><span><b class="mono">${esc(pc.slice(2))}</b>品號碼（7-8 碼）</span></div><p class="br-exp">半成品有效日期：<strong>${esc(exp)}</strong>（${esc(date)} ＋ 保存 ${fmt(p.shelfDays)} 天）｜當天轉現貨的話，現貨有效日期：<strong>${esc(addDays(date, stockDaysOf()))}</strong>（＋${stockDaysOf()} 天）</p>`
      : `<div class="notice warning">${!pc ? `「${esc(p.name)}」的品號沒辦法自動變成 4 碼品號碼，請在下方「品號碼對照」設定。` : `${y} 年沒有年碼（規則只到 ${YEAR_BASE}～${YEAR_BASE + YEAR_CODES.length - 1} 年），請更新批號規則。`}</div>`;
  }
  // 2. 某一天的生產批號
  const ld = $('brListDate').value, prods = data.movements.filter(r => r.type === 'production' && r.date === ld).sort((a, b) => productOrder(a.product, b.product) || cmp(a.batch, b.batch));
  $('brListCount').textContent = isDate(ld) ? `${ld} 共 ${prods.length} 筆生產（入口網站同步後自動帶入批號與有效日期）` : '請選日期';
  $('brList').innerHTML = table(['產品', '類別', '數量#', '批號', '製作日期', '有效日期'], prods.map(r => `<tr>${td(`<strong>${esc(r.product)}</strong>`)}${td(esc(prodKind(r) || '生產'))}<td class="num">${fmt(r.quantity)} ${esc(getUnit(r.product))}</td>${td(r.batch === '—' ? `— ${badge('半成品', 'other')}` : `<span class="mono">${esc(r.batch)}</span>${r.batch === makeBatch(r.product, r.date) ? '' : ' ' + badge('舊格式', 'other')}`)}${tdm(r.manufactureDate)}${tdm(expShow(prodExp(r)))}</tr>`), '這天沒有生產紀錄');
  // 3. 品號碼對照
  const codes = customCodes(), list = searchable(byProductName(data.products.filter(x => !x.virtual)), $('brFilter').value, ['name']);
  $('brCodeCount').textContent = `共 ${list.length} 項產品；品號碼預設取品號（CK-08 → CK08），需要時可自訂`;
  $('brCodes').innerHTML = table(['產品', '品號碼', '來源', `今天（${shortDate(today)}）的批號`, '保存天數#', '今天生產的有效日期', ...(can('setting') ? ['管理'] : [])], list.map(x => {
    const custom = BCODE_RE.test(codes[productCodeOf(x.name)] || ''), pc = productBatchCode(x.name), b = makeBatch(x.name, today);
    return `<tr>${td(`<strong>${esc(x.name)}</strong>`)}${td(pc ? `<span class="mono">${esc(pc)}</span>` : badge('無法自動產生', 'bad'))}${td(custom ? badge('自訂', 'future') : badge('自動', 'other'))}${td(b ? `<span class="mono">${esc(b)}</span>` : '—')}<td class="num">${fmt(x.shelfDays)}</td>${tdm(addDays(today, x.shelfDays))}${can('setting') ? td(`<button type="button" class="btn small" data-action="edit-bcode" data-id="${esc(x.name)}">修改</button>`) : ''}</tr>`;
  }), '沒有產品');
}
function renderBatchRefs() {
  const cell = (k, v) => `<div class="br-ref-cell"><span>${esc(k)}</span><b class="mono">${esc(v)}</b></div>`;
  $('brRefs').innerHTML = `<div class="br-ref"><h3>月碼（第 3 碼）</h3><div class="br-ref-grid">${MONTH_CODES.map((c, i) => cell(`${i + 1} 月`, c)).join('')}</div></div>`
    + `<div class="br-ref"><h3>年碼（第 4 碼）</h3><div class="br-ref-grid">${[...YEAR_CODES].map((c, i) => cell(`${YEAR_BASE + i}`, c)).join('')}</div></div>`
    + `<div class="br-ref"><h3>日期碼（第 5、6 碼）</h3><div class="br-ref-grid">${Array.from({ length: 31 }, (_, i) => cell(`${i + 1} 日`, dayCode(i + 1))).join('')}</div></div>`;
}
async function editBatchCode(name) {
  if (!can('setting')) return;
  const code = productCodeOf(name), cur = customCodes()[code] || '', auto = autoProductCode(name);
  const res = await modal({ title: `「${name}」的品號碼`, ok: '儲存',
    html: `<p class="modal-note">品號碼是批號的第 1、2、7、8 碼，共 4 碼英文或數字。留空＝用自動的${auto ? `「${esc(auto)}」` : '（這個品號沒辦法自動產生，一定要填）'}。同一個品號（${esc(code)}）的產品都會用這個品號碼。</p><div class="field"><label for="bc-code">品號碼</label><input id="bc-code" value="${esc(cur)}" maxlength="4" placeholder="${esc(auto || '例如 CK08')}" autocomplete="off" style="text-transform:uppercase"></div><p class="modal-error" hidden></p>`,
    collect: b => { const v = clean(b.querySelector('#bc-code').value).toUpperCase(); if (v && !BCODE_RE.test(v)) throw Error('品號碼要剛好 4 碼英文或數字'); return { v }; } });
  if (!res) return;
  const meta = batchMeta(), codes = { ...customCodes() };
  if (res.v && res.v !== auto) codes[code] = res.v; else delete codes[code];
  act(() => { FEStore.save('settings', { ...meta, id: 'batch', codes }); toast(res.v && res.v !== auto ? `已設定品號碼 ${res.v}；之後同步的生產會用新的批號` : '已改回自動品號碼'); });
}

/* ---------- 入口網站同步（書籤帶入 半成品入庫＝生產、實際揀貨＝出貨）---------- */
const PORTAL_URL = 'https://cheeseduke.flowings.app/logistics-console';
const PORTAL_DAYS = 14;
const CODE_RE = /^[\w.|\-]{1,60}$/;
const canPortal = () => can('produce') || can('ship');
const PORTAL_BM_V = 5; // 目前書籤的版本（書籤裡的 v）；上次同步用比這個舊的書籤，畫面上方會一直提醒換書籤
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
// 書籤資料整理乾淨：{ v:5, t: 書籤當天, d: { 日期: [[品號, 品名, 半成品入庫, 實際揀貨, 期初現貨, 生產轉現貨, 半成品轉現貨, 半成品增減(±), 現貨增減(±), 半成品轉試吃,
//                                        手動半成品(±), 手動現貨(±), 隔夜差異半成品(±), 隔夜差異現貨(±)], ...] }, ng: 沒讀到前一天、算不出隔夜差異的日期, w: 讀取失敗的日期說明 }
// 隔夜差異＝總表當天的期初 − 前一天的期末（總表自己對不上的數字，例如盤點後直接改期初）
// （舊書籤：v:1 只有前 4 欄，不動現貨紀錄；v:2 沒有半成品轉現貨，不動轉現貨紀錄；v:3 沒有增減，不動增減紀錄；v:4 沒有手動與隔夜差異，不動那些紀錄）
function cleanPortal(p) {
  if (!p || ![1, 2, 3, 4, 5].includes(p.v) || !p.d || typeof p.d !== 'object') throw Error('資料格式不對，請重新拖曳最新的書籤');
  const qty = v => { v = Number(v); return v > 0 && v < 1e7 ? clampQty(v) : 0; }, sqty = v => { v = Number(v); return Number.isFinite(v) && Math.abs(v) < 1e7 ? clampQty(v) : 0; };
  const days = {};
  for (const ds of Object.keys(p.d).slice(0, 62)) {
    if (!isDate(ds) || !Array.isArray(p.d[ds])) continue;
    const rows = [], seen = new Set();
    for (const a of p.d[ds].slice(0, 3000)) {
      if (!Array.isArray(a)) continue;
      const code = clean(a[0]);
      if (!CODE_RE.test(code) || seen.has(code)) continue;
      seen.add(code);
      rows.push({ code, name: clean(a[1]).slice(0, 40), inQ: qty(a[2]), outQ: qty(a[3]), openStock: qty(a[4]), toStock: qty(a[5]), semiToStock: qty(a[6]), semiAdj: sqty(a[7]), stockAdj: sqty(a[8]), toTasting: qty(a[9]), manSemi: sqty(a[10]), manStock: sqty(a[11]), gapSemi: sqty(a[12]), gapStock: sqty(a[13]) });
    }
    days[ds] = rows;
  }
  if (!Object.keys(days).length) throw Error('沒有讀到任何日期的總表');
  return { days, v: p.v, hasStock: p.v >= 2, hasConvert: p.v >= 3, hasAdjust: p.v >= 4, hasExtra: p.v >= 5, noGap: new Set(p.v >= 5 && Array.isArray(p.ng) ? p.ng.filter(isDate) : []), warn: typeof p.w === 'string' ? p.w.slice(0, 300) : '' };
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
    const saves = [], removes = [], who = myName(), at = nowIso(), sum = { pN: 0, pQ: 0, sN: 0, sQ: 0, qN: 0, qQ: 0, cN: 0, cQ: 0, jN: 0, gN: 0 };
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
        if (c.hasAdjust && okP) {
          // 半成品增減（±）、半成品轉試吃（減）、現貨增減（±）、總表的手動數字（±）：記成「增減」紀錄（包裝區，出貨前算）
          // 隔夜差異（±）：總表當天期初跟前一天期末對不上的數字，算在當天一開始（phase 'open'）；增加的不知道是哪一批，製作日期用前一天
          const adjOne = (suffix, signed, pool, label, phase = 'pack') => {
            if (!signed) return;
            const p = productFor(r.code, r.name), id = `pt-j${suffix}-${ds}-${r.code}`, old = existing.get(id), dir = signed > 0 ? 'add' : 'sub', q = clampQty(Math.abs(signed)), mfg = phase === 'open' ? addDays(ds, -1) : ds;
            want.add(id); sum.jN++; if (phase === 'open') sum.gN++;
            const body = { type: 'adjust', dir, date: ds, product: p.name, quantity: q, note: `入口網站：${label}`, phase, ...(pool === 'stock' ? { pool: 'stock' } : {}), ...(dir === 'add' ? { batch: '—', manufactureDate: mfg, expiryDate: addDays(mfg, pool === 'stock' ? stockDaysOf() : p.shelfDays) } : { fromMfg: '', fromExp: '' }) };
            const rec = old ? { ...old, ...body } : { id, seq: nextSeq(), ...body, by: who, at };
            if (!old || old.quantity !== rec.quantity || old.dir !== rec.dir || old.product !== rec.product || (old.pool || '') !== (rec.pool || '') || old.note !== rec.note || old.phase !== rec.phase || old.manufactureDate !== rec.manufactureDate || old.expiryDate !== rec.expiryDate) saves.push(rec);
          };
          adjOne('s', r.semiAdj, 'semi', r.semiAdj > 0 ? '半成品增加' : '半成品減少');
          adjOne('t', -r.toTasting, 'semi', '半成品轉試吃');
          adjOne('k', r.stockAdj, 'stock', r.stockAdj > 0 ? '現貨增加' : '現貨減少');
          if (c.hasExtra) {
            adjOne('m', r.manSemi, 'semi', r.manSemi > 0 ? '總表手動・半成品增加' : '總表手動・半成品減少');
            adjOne('n', r.manStock, 'stock', r.manStock > 0 ? '總表手動・現貨增加' : '總表手動・現貨減少');
            // 起算日當天的期初已經用 App 的期初庫存（與期初現貨），不再算隔夜差異
            if (ds !== from && !c.noGap.has(ds)) {
              adjOne('g', r.gapSemi, 'semi', r.gapSemi > 0 ? '隔夜差異・半成品增加' : '隔夜差異・半成品減少', 'open');
              adjOne('h', r.gapStock, 'stock', r.gapStock > 0 ? '隔夜差異・現貨增加' : '隔夜差異・現貨減少', 'open');
            }
          }
        }
        if (stockMode) {
          // 全現貨模式：當天生產＝半成品入庫＋生產轉現貨，一個有效期的現貨批次
          const q = clampQty(r.inQ + r.toStock);
          if (okP && q > 0) {
            const p = productFor(r.code, r.name), id = `pt-p-${ds}-${r.code}`, old = existing.get(id);
            want.add(id); sum.pN++; sum.pQ += q;
            const rec = old ? { ...old, product: p.name, quantity: q, batch: batchFor(p.name, ds), note: '入口網站：當天生產（全現貨模式）' } : { id, type: 'production', seq: nextSeq(), date: ds, product: p.name, batch: batchFor(p.name, ds), manufactureDate: ds, expiryDate: addDays(ds, p.shelfDays), quantity: q, note: '入口網站：當天生產（全現貨模式）', by: who, at };
            if (!old || old.quantity !== rec.quantity || old.product !== rec.product || old.note !== rec.note || old.batch !== rec.batch) saves.push(rec);
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
          const p = productFor(r.code, r.name), id = `pt-q-${ds}-${r.code}`, old = existing.get(id), exp = addDays(ds, stockDaysOf());
          want.add(id); sum.qN++; sum.qQ += r.toStock;
          const rec = old ? { ...old, product: p.name, quantity: r.toStock, batch: batchFor(p.name, ds), expiryDate: old.editBy ? old.expiryDate : exp } : { id, type: 'production', pool: 'stock', seq: nextSeq(), date: ds, product: p.name, batch: batchFor(p.name, ds), manufactureDate: ds, expiryDate: exp, quantity: r.toStock, note: '入口網站：生產轉現貨', by: who, at };
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
          const rec = old ? { ...old, product: p.name, quantity: r.inQ, batch: '—', note: '入口網站：半成品入庫' } : { id, type: 'production', seq: nextSeq(), date: ds, product: p.name, batch: '—', manufactureDate: ds, expiryDate: addDays(ds, p.shelfDays), quantity: r.inQ, note: '入口網站：半成品入庫', by: who, at };
          if (!old || old.quantity !== rec.quantity || old.product !== rec.product || old.note !== rec.note || old.batch !== rec.batch) saves.push(rec);
        }
        if (okS && r.outQ > 0) {
          const p = productFor(r.code, r.name), id = `pt-s-${ds}-${r.code}`, old = existing.get(id);
          want.add(id); sum.sN++; sum.sQ += r.outQ;
          const rec = old ? { ...old, product: p.name, quantity: r.outQ } : { id, type: 'shipment', seq: nextSeq(), date: ds, product: p.name, quantity: r.outQ, orderNo: '入口網站：實際揀貨', note: '', by: who, at };
          if (!old || old.quantity !== rec.quantity || old.product !== rec.product) saves.push(rec);
        }
      }
      for (const [id, r] of existing) if (r.date === ds && !want.has(id) && ((r.type === 'production' && okP && (c.hasStock || !id.startsWith('pt-q-'))) || (r.type === 'convert' && okP && (c.hasConvert || stockMode)) || (r.type === 'adjust' && okP && c.hasAdjust && (c.hasExtra || !/^pt-j[mngh]-/.test(id)) && !(/^pt-j[gh]-/.test(id) && c.noGap.has(ds))) || (r.type === 'shipment' && okS))) removes.push(id);
    }
    if (newProducts.length) FEStore.saveMany('products', newProducts.map(p => ({ id: p.id, name: p.name, unit: p.unit, shelfDays: p.shelfDays, lowStock: 0 })));
    if (openSaves.length) FEStore.saveMany('opening', openSaves.map(recordBody));
    if (openRemoves.length) FEStore.removeMany('opening', openRemoves);
    if (saves.length) FEStore.saveMany('moves', saves.map(recordBody));
    if (removes.length) FEStore.removeMany('moves', removes);
    const meta = portalMeta(), changed = saves.length + removes.length + openSaves.length + openRemoves.length;
    FEStore.save('settings', { ...meta, id: 'portal', order: portalOrderMerge(c.days, meta.order), at: Date.now(), by: who, bv: c.v, first: dates[0] || '', last: dates[dates.length - 1] || '', days: dates.length, ...sum, pQ: clampQty(sum.pQ), sQ: clampQty(sum.sQ), qQ: clampQty(sum.qQ), cQ: clampQty(sum.cQ), ...(stockOpen.set ? { stockOpenDate: from, stockOpenN: stockOpen.n, stockOpenQ: clampQty(stockOpen.q) } : {}), newProducts: newProducts.length, changed, warn: c.warn });
    const range = dates.length ? `${shortDate(dates[0])}～${shortDate(dates[dates.length - 1])}` : '沒有可匯入的日期';
    const parts = [okP ? `${modeB === dates.length && dates.length ? '當天生產' : modeB ? '半成品入庫／當天生產' : '半成品入庫'} ${sum.pN} 筆（${fmt(sum.pQ)} 個）` : '', okP && c.hasStock && sum.qN ? `生產轉現貨 ${sum.qN} 筆（${fmt(sum.qQ)} 個）` : '', okP && c.hasConvert && sum.cN ? `半成品轉現貨 ${sum.cN} 筆（${fmt(sum.cQ)} 個）` : '', okP && c.hasAdjust && sum.jN ? `半成品／現貨增減 ${sum.jN} 筆${sum.gN ? `（其中隔夜差異 ${sum.gN} 筆）` : ''}` : '', okS ? `出貨 ${sum.sN} 筆（${fmt(sum.sQ)} 個）` : ''].filter(Boolean).join('、');
    const notes = [modeB ? `${modeB === dates.length ? '全部' : `其中 ${modeB} 天`}用全現貨模式（${stockFromDate()} 起）` : '', stockOpen.set ? `期初現貨 ${stockOpen.n} 個品號（${fmt(stockOpen.q)} 個，${from}）` : '', !c.hasExtra ? '這是舊版書籤，' + (!c.hasStock ? '沒有帶入現貨' : !c.hasConvert ? '沒有帶入半成品轉現貨' : !c.hasAdjust ? '沒有帶入半成品／現貨增減' : '沒有帶入總表的手動數字與隔夜差異') + '，請到「入口網站同步」重新拖曳書籤' : '', dates.some(d => c.noGap.has(d)) ? `${dates.filter(d => c.noGap.has(d)).map(shortDate).join('、')} 沒讀到前一天的總表，隔夜差異沒有更新` : '', newProducts.length ? `新增產品 ${newProducts.length} 項` : '', skippedCodes.size ? `略過 ${prefixes.join('、')} 以外的品號 ${skippedCodes.size} 個` : '', excludedCodes.size ? `略過${EXCLUDE_WORDS.join('、')} ${excludedCodes.size} 個品號` : '', before.length ? `起算日 ${from} 以前的 ${before.length} 天沒有匯入` : '', !okP ? '你沒有生產權限，生產數字沒有存' : '', !okS ? '你沒有出貨權限，出貨數字沒有存' : '', c.warn ? '注意：' + c.warn : ''].filter(Boolean).join('；');
    toast(`已同步入口網站 ${range}：${parts}${changed ? '' : '（數字都沒變）'}${notes ? '。' + notes : ''}`, false, 10000);
    go('portal');
    // 接著帶入門市出庫（揀貨總表：今天＋最近 3 天還沒帶入的），結果在入口網站的提示之後顯示
    if (dates.length) setTimeout(() => syncStoreOut(storeOutDates(), { quiet: true, delay: 7000 }), 50);
  } catch (e) { toast('入口網站資料讀取失敗：' + e.message, true, 8000); }
  finally { portalApplying = false; }
}
// 書籤：在入口網站讀最近 14 天的總表（只讀；多讀前一天算隔夜差異），每天每個品號 [品號, 品名, 半成品入庫, 實際揀貨, 期初現貨, 生產轉現貨, 半成品轉現貨, 半成品增減, 現貨增減, 半成品轉試吃, 手動半成品, 手動現貨, 隔夜差異半成品, 隔夜差異現貨]，放在網址 #portal= 後開啟 App
function portalBookmarklet() {
  const app = location.origin + location.pathname;
  const code = "(async()=>{" +
    "if(location.hostname.indexOf('flowings.app')<0){if(confirm('這顆書籤要在「入口網站」的頁面按，你現在在別的網站。\\n\\n要現在打開入口網站嗎？打開後請登入，再按一次這顆書籤。'))window.open('" + PORTAL_URL + "','_blank');return}" +
    "var ov=document.createElement('div');ov.textContent='正在讀取總表最近 " + PORTAL_DAYS + " 天的現貨、半成品入庫與實際揀貨…';ov.style.cssText='position:fixed;left:50%;top:20px;transform:translateX(-50%);z-index:2147483647;background:#153b48;color:#fff;padding:12px 18px;border-radius:10px;font:14px sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.3)';document.body.appendChild(ov);" +
    "try{var p=function(n){return String(n).padStart(2,'0')},f=function(d){return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())},N=function(v){return Number(v)||0},now=new Date(),R={},D={},bad=[],days=[],ng=[];" +
    // 多讀一天（最舊那天只用來算隔夜差異：當天期初 − 前一天期末）
    "for(var i=" + PORTAL_DAYS + ";i>=0;i--)days.push(f(new Date(now.getFullYear(),now.getMonth(),now.getDate()-i)));" +
    "await Promise.all(days.map(async function(ds){var u=location.origin+'/api/internal/logistics-console/hq-ledger?date='+ds;" +
    "try{var r=await fetch(u,{credentials:'include',headers:{Accept:'application/json'}});if(!r.ok){bad.push(ds+' HTTP '+r.status);return}" +
    "var j=await r.json(),M={};(j.rows||[]).forEach(function(x){if(x&&x.code)M[x.code]=x});R[ds]=M}catch(e1){bad.push(ds+' '+e1.message)}}));" +
    "days.forEach(function(ds,i){if(!i||!R[ds])return;var M=R[ds],P=R[days[i-1]],L=[],seen={};if(!P)ng.push(ds);" +
    "Object.keys(M).concat(P?Object.keys(P):[]).forEach(function(cd){if(seen[cd])return;seen[cd]=1;var x=M[cd]||{code:cd,name:P[cd].name},w=x.row||{},o=w.opening||{},k=w.packing||{},mn=w.manual||{},q=P&&P[cd]?((P[cd].row||{}).closing||{}):{}," +
    "a=N(w.semiIn),b=N(w.actualPick),c=N(o.stock),e=N(k.productionToStock),kk=N(k.semiToStock),sa=N(k.semiAdjust),ta=N(k.stockAdjust),tt=N(k.semiToTasting),ms=N(mn.semi),mk=N(mn.stock),gs=P?N(o.semi)-N(q.semi):0,gk=P?N(o.stock)-N(q.stock):0;" +
    "if(a>0||b>0||c>0||e>0||kk>0||sa||ta||tt>0||ms||mk||gs||gk)L.push([cd,String(x.name||'').slice(0,30),a,b,c,e,kk,sa,ta,tt,ms,mk,gs,gk])});D[ds]=L});" +
    "if(!Object.keys(D).length)throw new Error('總表沒有讀到任何日期'+(bad.length?'（'+bad.join('；')+'）':''));" +
    "var s=btoa(unescape(encodeURIComponent(JSON.stringify({v:5,t:f(now),d:D,ng:ng,w:bad.length?'這幾天沒讀到：'+bad.join('；'):''})))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');" +
    "ov.textContent='讀取完成，正在開啟庫存效期 App…';location.href='" + app + "#portal='+s}catch(e){ov.remove();alert('讀取入口網站失敗：'+e.message+'\\n\\n請確認已經登入入口網站，並在入口網站的頁面（例如物管駕駛艙總表）按這個書籤')}})()";
  return 'javascript:' + encodeURIComponent(code);
}
const FLOW_SEMI = '<strong>半成品模式</strong>：<strong>半成品入庫</strong>登錄成有效期的半成品批次；<strong>半成品轉現貨</strong>照總表的實際數量，從效期最早的半成品轉成現貨（<strong>轉現貨那天算第一天</strong>：製作日期與批號用轉現貨日，有效日期＝轉現貨日＋保存天數；轉多了沒出完的留到隔天）；<strong>生產轉現貨</strong>是當天生產直接做成的現貨；<strong>半成品增減、半成品轉試吃、現貨增減、總表的手動數字</strong>記到「半成品／現貨增減」頁；總表當天期初跟前一天期末對不上的<strong>隔夜差異</strong>也記到那頁，算在當天一開始（換盒的情況：同一天同品號開頭的半成品減少會變成另一個品號的現貨增加，也是換盒那天算第一天）；起算日的<strong>期初現貨</strong>沒有效期資料。<strong>實際揀貨</strong>登錄成出貨：<strong>①現貨（含當天轉好的）→ ②現貨不夠再直接扣半成品（效期最早的先）→ ③當天的生產轉現貨</strong>，當天的半成品入庫是出完貨剩下的。';
const FLOW_STOCK = '<strong>全現貨模式</strong>：沒有半成品，<strong>當天生產</strong>（總表的半成品入庫＋生產轉現貨）登錄成有效期的現貨批次；<strong>實際揀貨</strong>登錄成出貨：<strong>①既有現貨（效期最早的先）→ ②不夠再從當天生產直接取</strong>，剩下的就是現貨入庫。';
// 隔夜差異：半成品／現貨各自的 ±（沒有就 —）
const gapText = g => { const f = (v, l) => v ? `${l}${v > 0 ? '＋' : '－'}${fmt(Math.abs(clampQty(v)))}` : ''; return [f(clampQty(g.gSemi), '半'), f(clampQty(g.gStock), '現')].filter(Boolean).join(' ') || '—'; };
function renderPortal() {
  renderStoreOutInfo();
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
    if (!by.has(r.date)) by.set(r.date, { date: r.date, pQ: 0, qQ: 0, cQ: 0, sQ: 0, fromStock: 0, fromSemi: 0, fromToday: 0, short: 0, jSemi: 0, jStock: 0, gSemi: 0, gStock: 0 });
    const g = by.get(r.date), B = isStockModeDay(r.date);
    if (r.type === 'production') { if (r.pool === 'stock') g.qQ += r.quantity; else g.pQ += r.quantity; }
    else if (r.type === 'convert') g.cQ += r.quantity;
    else if (r.type === 'adjust') { const v = r.dir === 'add' ? r.quantity : -r.quantity, k = r.phase === 'open' ? 'g' : 'j'; if (r.pool === 'stock') g[k + 'Stock'] += v; else g[k + 'Semi'] += v; }
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
  const n = v => `<td class="num">${v ? fmt(clampQty(v)) : '—'}</td>`, sn = v => `<td class="num">${v ? (v > 0 ? '＋' : '－') + fmt(clampQty(Math.abs(v))) : '—'}</td>`;
  $('portalTable').innerHTML = table(['日期', '流程', '半成品入庫／當天生產#', '生產轉現貨#', '半成品轉現貨#', '半成品增減#', '現貨增減#', '隔夜差異', '實際揀貨#', '扣現貨#', '扣半成品#', '扣當天生產#', '出貨缺口#'], rows.map(g => `<tr>${tdm(g.date)}${td(isStockModeDay(g.date) ? badge('全現貨', 'due') : badge('半成品', 'other'))}${n(g.pQ)}${n(g.qQ)}${n(g.cQ)}${sn(g.jSemi)}${sn(g.jStock)}${td(gapText(g))}${n(g.sQ)}${n(g.fromStock)}${n(g.fromSemi)}${n(g.fromToday)}<td class="num">${g.short ? badge(fmt(clampQty(g.short)), 'bad') : '—'}</td></tr>`), '還沒有從入口網站同步過');
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
  if (a === 'alloc-day') { if (isDate(el.dataset.date)) { allocDate = el.dataset.date; scheduleRender(); } return; }
  if (a === 'edit-bcode') return editBatchCode(id);
  if (a === 'adjust-detail') return openAdjustDetail(id);
  if (a === 'adjust-delete') return deleteAdjust(id);
  if (a === 'shop-rule') return editShopRule();
  if (a === 'shop-detail') return openShopDetail(el.dataset.shop, id);
  if (a === 'shop-import') return openShopImport(el.dataset.shop);
  if (a === 'audit-new') return auditNew();
  if (a === 'audit-open') { auditSel = id; return scheduleRender(); }
  if (a === 'audit-add') return auditAddLine();
  if (a === 'audit-apply') return auditApply();
  if (a === 'audit-unapply') return auditUnapply();
  if (a === 'audit-done') return auditStatus('done');
  if (a === 'audit-reopen') return auditStatus('open');
  if (a === 'audit-delete') return auditDelete();
  if (a === 'audit-csv') return auditCsv();
  if (a === 'rcv-pick') return rcvPick(el.dataset.shop, id, el.dataset.batch);
  if (a === 'rcv-confirm') return rcvConfirm(el.dataset.shop, id, el);
  if (a === 'ocr-slip') { const f = $('ocrFile-' + el.dataset.shop); if (f) { f.value = ''; f.click(); } return; }
  if (a === 'rcv-clear') return rcvClear(el.dataset.shop, id);
  if (a === 'shop-delete') return deleteShopRec(el.dataset.shop, id);
  if (a === 'shop-batch') return editShopBatch(el.dataset.shop, id);
  if (a === 'store-out') return syncStoreOut(storeOutDates());
  if (a === 'tx-import' || a === 'sys-import') return openSysImport();
  if (a === 'tx-rematch') return txRematchNow();
  if (a.startsWith('shop-aud-')) { const sid = el.dataset.shop, k = a.slice(9);
    if (k === 'new') return shopAudNew(sid); if (k === 'open') { shopAudSel[sid] = el.dataset.id; return scheduleRender(); } if (k === 'add') return shopAudAddLine(sid); if (k === 'apply') return shopAudApply(sid); if (k === 'unapply') return shopAudUnapply(sid);
    if (k === 'done') return shopAudStatus(sid, 'done'); if (k === 'reopen') return shopAudStatus(sid, 'open'); if (k === 'delete') return shopAudDelete(sid); if (k === 'csv') return shopAudCsv(sid); return; }
  if (a === 'chk-go') { const v = el.dataset.view, d = el.dataset.date; if (v === 'allocations') { if (isDate(d)) allocDate = d; return go('allocations'); } if (v.startsWith('shop-')) { const sid = v.slice(5); if (isDate(d)) { rcvDate[sid] = d; } return go(v); } return go(v); }
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
  document.addEventListener('input', e => { const el = e.target.closest && e.target.closest('[data-rq]'); if (el) rcvInput(el); });
  document.addEventListener('change', e => { const el = e.target.closest && e.target.closest('[data-aud]'); if (el) auditSave(el); const sl = e.target.closest && e.target.closest('[data-saud]'); if (sl) shopAudSave(sl); });
  document.addEventListener('focusout', e => { if (e.target.matches && e.target.matches('[data-saud]') && shopAudDirty) { shopAudDirty = false; setTimeout(scheduleRender, 50); } });
  document.addEventListener('focusout', e => { if (e.target.matches && e.target.matches('[data-aud]') && auditDirty) setTimeout(scheduleRender, 50); });
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
  $('adjustForm').addEventListener('submit', saveAdjust);
  for (const id of ['adDir', 'adPool', 'adDate', 'adProduct', 'adMfg']) $(id).addEventListener('change', () => adjFormSync(id !== 'adDate'));
  for (const id of ['adQty', 'adFrom']) $(id).addEventListener('input', () => adjFormSync(false));
  $('adFrom').addEventListener('change', () => adjFormSync(false));
  $('adjustFilter').addEventListener('input', scheduleRender);
  $('auditFilter').addEventListener('input', scheduleRender);
  $('auditSeg').addEventListener('click', e => { const b = e.target.closest('[data-amode]'); if (!b) return; auditMode = b.dataset.amode; scheduleRender(); });
  for (const id of ['brProduct', 'brDate', 'brListDate', 'brFilter']) $(id).addEventListener('input', scheduleRender);
  $('allocationDate').addEventListener('change', e => { if (isDate(e.target.value)) { allocDate = e.target.value; scheduleRender(); } });
  renderBatchRefs();
  for (const { id } of SHOPS) {
    $('shopForm-' + id).addEventListener('submit', e => saveShop(e, id));
    $('shType-' + id).addEventListener('change', () => shopFormSync(id));
    for (const f of ['shDate-', 'shProduct-']) $(f + id).addEventListener('change', () => shopFormSync(id));
    for (const f of ['shQty-', 'shBatch-']) $(f + id).addEventListener('input', () => shopFormSync(id));
    for (const f of ['shopFilter-', 'shopRecFilter-']) $(f + id).addEventListener('input', scheduleRender);
    $('shopSeg-' + id).addEventListener('click', e => { const b = e.target.closest('[data-smode]'); if (!b) return; shopMode[id] = b.dataset.smode; scheduleRender(); });
    $('stabs-' + id).addEventListener('click', e => { const b = e.target.closest('[data-stab]'); if (b) setShopTab(id, b.dataset.stab); });
    $('ocrFile-' + id).addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) ocrSlip(id, f); });
    $('rcvDate-' + id).addEventListener('change', e => { if (isDate(e.target.value)) { rcvDate[id] = e.target.value; scheduleRender(); } });
    $('saudSeg-' + id).addEventListener('click', e => { const b = e.target.closest('[data-samode]'); if (!b) return; shopAudMode[id] = b.dataset.samode; scheduleRender(); });
    $('saudFilter-' + id).addEventListener('input', scheduleRender);
  }
  $('settingsForm').addEventListener('submit', e => { e.preventDefault(); if (!can('setting')) return; const mw = Number($('semiWarn').value), sh = Number($('defaultShelf').value), k = Number($('stockDays').value), kw = Number($('stockWarn').value); if (!Number.isInteger(mw) || mw < 1 || mw > 365 || !Number.isInteger(sh) || sh < 0 || sh > 36500) { toast('請填寫有效的半成品警示天數（1～365）與保存天數（整數）', true); return; } if (!Number.isInteger(k) || k < 1 || k > 365 || !Number.isInteger(kw) || kw < 0 || kw > 60) { toast('現貨可放天數要是 1～365、現貨提醒天數要是 0～60 的整數', true); return; } act(() => { FEStore.save('settings', { id: 'main', warnDays: data.settings.warnDays, defaultShelf: sh, stockDays: k, stockWarn: kw, semiWarn: mw }); toast(`系統設定已儲存：現貨可放 ${k} 天、剩 ${kw} 天內提醒；半成品剩 ${mw} 天內警示`); }); });
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
/* ---------- 寬表格：左右捲動條固定在畫面下緣 ----------
   表格比畫面寬時，在表格後面放一條同步的左右捲動條（position: sticky; bottom: 0），
   捲到表格中間也看得到、拖得到，不用先捲到表格最下面。只在有滑鼠的電腦上顯示；手機直接用手指左右滑表格。 */
const HBAR_MQ = window.matchMedia ? window.matchMedia('(pointer: fine)') : null;
let hbarRaf = 0;
function hbarSync(sc) {
  let bar = sc.nextElementSibling;
  if (!bar || !bar.classList.contains('hbar')) {
    bar = document.createElement('div'); bar.className = 'hbar'; bar.hidden = true; bar.setAttribute('aria-hidden', 'true'); bar.appendChild(document.createElement('div')); sc.after(bar);
    bar.addEventListener('scroll', () => { if (sc.scrollLeft !== bar.scrollLeft) sc.scrollLeft = bar.scrollLeft; }, { passive: true });
    sc.addEventListener('scroll', () => { if (bar.scrollLeft !== sc.scrollLeft) bar.scrollLeft = sc.scrollLeft; }, { passive: true });
  }
  const on = (!HBAR_MQ || HBAR_MQ.matches) && sc.scrollWidth > sc.clientWidth + 1;
  if (bar.hidden === on) bar.hidden = !on;
  sc.classList.toggle('has-hbar', on);
  if (on) { const w = sc.scrollWidth + 'px'; if (bar.firstChild.style.width !== w) bar.firstChild.style.width = w; if (bar.scrollLeft !== sc.scrollLeft) bar.scrollLeft = sc.scrollLeft; }
}
const hbarRO = 'ResizeObserver' in window ? new ResizeObserver(() => hbarQueue()) : null;
function hbarQueue() {
  if (hbarRaf) return;
  hbarRaf = setTimeout(() => { hbarRaf = 0; document.querySelectorAll('.table-scroll').forEach(sc => { if (!sc.hbarOn) { sc.hbarOn = true; if (hbarRO) hbarRO.observe(sc); } hbarSync(sc); }); }, 40);
}
function hbarInit() {
  // 表格內容換掉（重新整理、搜尋、切換頁面、打開明細）都重算一次
  new MutationObserver(hbarQueue).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', hbarQueue);
  if (HBAR_MQ && HBAR_MQ.addEventListener) HBAR_MQ.addEventListener('change', hbarQueue);
  hbarQueue();
}

buildShops(); bind(); resetForms(); hbarInit(); showView(location.hash.slice(1) || 'dashboard'); renderSync();
FEAuth.ready.then(() => { applyPerms(); rebuild(); resetForms(); render(); applyPortalPending(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('service-worker.js').catch(() => {}); });
}
// 跨日（App 開著過午夜）時，「今天」與效期判斷跟著更新
let lastDay = TODAY();
setInterval(() => { const d = TODAY(); if (d !== lastDay) { lastDay = d; resetForms(); scheduleRender(); } }, 60000);
