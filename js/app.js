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

// 門市：每間一頁，權限代號 shop_代號（例如 shop_a11）
const SHOPS = [{ id: 'a11', name: 'A11' }, { id: 'jz', name: '京站' }, { id: 'dq', name: '東橋' }];
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
const blankState = () => ({ version: 1, products: [], opening: [], movements: [], shops: [], settings: { warnDays: 30, defaultShelf: 30 } });

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
  if (r.type === 'adjust') { // 半成品增減：add 增加一批（有製作日期、有效日期）；sub 減少（可指定哪一批 fromMfg／fromExp）
    if (!isDate(r.date) || (r.dir !== 'add' && r.dir !== 'sub')) return null;
    // pool 'stock'＝現貨增減（入口網站「現貨增減」）；phase 'pack'＝入口網站帶入的包裝區增減，跟轉現貨同時算（出貨前）；
    // phase 'open'＝隔夜差異（總表當天期初跟前一天期末對不上），算在當天一開始
    const extra = { ...(r.pool === 'stock' ? { pool: 'stock' } : {}), ...(r.phase === 'pack' || r.phase === 'open' ? { phase: r.phase } : {}) };
    if (r.dir === 'add') return isDate(r.manufactureDate) && isDate(r.expiryDate) ? { ...base, ...extra, type: 'adjust', dir: 'add', date: r.date, batch: '—', manufactureDate: r.manufactureDate, expiryDate: r.expiryDate } : null;
    return { ...base, ...extra, type: 'adjust', dir: 'sub', date: r.date, fromMfg: isDate(r.fromMfg) ? r.fromMfg : '', fromExp: isDate(r.fromExp) ? r.fromExp : '' };
  }
  if (!isDate(r.manufactureDate) || !isDate(r.expiryDate)) return null;
  // 還沒轉現貨的半成品沒有批號，只看製作日期與有效日期；現貨（期初現貨、生產轉現貨、全現貨模式的當天生產）才有批號
  const semi = r.pool !== 'stock' && !(r.type === 'production' && isStockModeDay(r.date));
  const lot = { ...base, batch: semi ? '—' : clean(r.batch) || '—', manufactureDate: r.manufactureDate, expiryDate: r.expiryDate, ...(r.pool === 'stock' ? { pool: 'stock' } : {}) };
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
  const shops = [];
  for (const r of FEStore.list('shop')) { const x = sanitizeShop(r); if (x && !isExcluded(x.product)) shops.push(x); }
  data = addVirtualProducts({ version: 1, products, opening, movements, shops, settings });
}

/* ---------- 寫入（先存這台裝置，背景上傳雲端） ---------- */
const kindOfRec = r => r.type === 'opening' ? 'opening' : 'moves';
function recordBody(rec) {
  const b = { id: rec.id, type: rec.type, seq: rec.seq, product: rec.product, quantity: rec.quantity, note: rec.note || '', by: rec.by || '', at: rec.at || '' };
  if (rec.editBy) { b.editBy = rec.editBy; b.editAt = rec.editAt; }
  if (rec.type === 'shipment') { b.date = rec.date; b.orderNo = rec.orderNo || ''; }
  else if (rec.type === 'convert') b.date = rec.date;
  else if (rec.type === 'adjust') { b.date = rec.date; b.dir = rec.dir; if (rec.pool === 'stock') b.pool = 'stock'; if (rec.phase === 'pack' || rec.phase === 'open') b.phase = rec.phase; if (rec.dir === 'add') { b.manufactureDate = rec.manufactureDate; b.expiryDate = rec.expiryDate; } else { b.fromMfg = rec.fromMfg || ''; b.fromExp = rec.fromExp || ''; } }
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
    ...(Array.isArray(st.shops) ? { shop: uniq(st.shops, r => r.id).map(strip) } : {}), // 舊備份沒有門市資料時不動門市
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
  return { version: 1, products: data.products.map(({ virtual, ...p }) => p), opening: data.opening.map(({ type, ...r }) => r), movements: data.movements.map(r => ({ ...r })), shops: data.shops.map(r => ({ ...r })), settings: { ...data.settings }, nextSeq: maxSeq + 1 };
}

/* ---------- 庫存引擎：依日期重放所有事件；同日先入庫，再依出貨順序扣最早到期者 ---------- */
// 同一天的順序：入庫（期初、生產、半成品增加）→ 半成品轉現貨 → 出貨 → 半成品減少（當天結束時盤點扣）
// 批次 pool：'stock' 現貨、'semi' 半成品（全現貨模式的有效期批次也記成 semi，但出貨時一律當現貨看）
// lot.used＝已扣（出貨＋轉成現貨）、lot.shipped＝只算出貨、lot.converted＝轉成現貨的量
// 增減的順序：半成品增加＝當天一開始；入口網站的半成品減少（含轉試吃）＝跟轉現貨同時（出貨前）；現貨增加＝轉現貨之後、出貨前；
//            手動的半成品減少、現貨減少＝當天結束（出貨之後）；隔夜差異（phase 'open'）＝當天最一開始（比當天入庫還早）
const adjPriority = x => x.phase === 'open' ? -1 : x.dir === 'add' ? (x.pool === 'stock' ? 1.5 : 0) : (x.pool !== 'stock' && x.phase === 'pack' ? 0.9 : 3);
const baseCode = name => productCodeOf(name).split('|')[0];
function calculateLedger(asOf = '9999-12-31', st = data) {
  const events = [], prio = { production: 0, convert: 1, shipment: 2 };
  for (const x of st.opening) if (x.entryDate <= asOf) events.push({ date: x.entryDate, priority: 0, seq: x.seq || 0, type: 'opening', item: x });
  for (const x of st.movements) if (x.date <= asOf) events.push({ date: x.date, priority: x.type === 'adjust' ? adjPriority(x) : prio[x.type] ?? 2, seq: x.seq || 0, type: x.type, item: x });
  events.sort((a, b) => cmp(a.date, b.date) || a.priority - b.priority || a.seq - b.seq || cmp(String(a.item.id), String(b.item.id)));
  const lots = [], shipments = new Map(), converts = new Map(), adjusts = new Map(), byProduct = new Map(), packPool = new Map();
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
    if (e.type === 'adjust') {
      const isStock = x.pool === 'stock', lotBase = { source: 'adjust', product: x.product, entryDate: e.date, used: 0, shipped: 0, converted: 0, adjusted: 0, seq: x.seq || 0, unit: getUnit(x.product, st) };
      if (x.dir === 'add' && !isStock) { addLot({ ...lotBase, id: x.id, pool: 'semi', batch: '—', manufactureDate: x.manufactureDate, expiryDate: x.expiryDate, quantity: Number(x.quantity), remaining: Number(x.quantity) }); continue; }
      if (x.dir === 'add') {
        // 現貨增加：同一天、同一個品號開頭（例如 CK-01 與 CK-01|YB-86 換盒）在包裝區減掉的半成品，照順序變成這裡的現貨（沿用那批的製作日期與有效日期）；
        //           沒有對應的就當天製作、有效日期＝當天＋保存天數。批號用當天（轉現貨當天）
        const pool = packPool.get(baseCode(x.product) + '|' + e.date) || [], parts = []; let need = Number(x.quantity), k = 0;
        for (const p of pool) { if (need <= 1e-7) break; if (p.left <= 1e-7) continue; const q = clampQty(Math.min(need, p.left)); p.left = clampQty(p.left - q); need = clampQty(need - q); addLot({ ...lotBase, id: `${x.id}#${k++}`, pool: 'stock', batch: makeBatch(x.product, e.date) || '—', manufactureDate: p.manufactureDate, expiryDate: p.expiryDate, quantity: q, remaining: q }); parts.push({ manufactureDate: p.manufactureDate, expiryDate: p.expiryDate, quantity: q, from: p.product }); }
        if (need > 1e-7) { addLot({ ...lotBase, id: `${x.id}#${k++}`, pool: 'stock', batch: makeBatch(x.product, e.date) || '—', manufactureDate: x.manufactureDate, expiryDate: x.expiryDate, quantity: need, remaining: need }); parts.push({ manufactureDate: x.manufactureDate, expiryDate: x.expiryDate, quantity: need }); }
        adjusts.set(x.id, { required: Number(x.quantity), done: Number(x.quantity), shortage: 0, parts });
        continue;
      }
      // 減少：指定那一批（製作日期／有效日期）就只扣那批，否則從效期最早的扣；已過期的也可以扣
      const from = (byProduct.get(x.product) || []).filter(l => l.pool === (isStock ? 'stock' : 'semi') && l.remaining > 1e-7 && l.entryDate <= e.date && (!x.fromMfg || l.manufactureDate === x.fromMfg) && (!x.fromExp || l.expiryDate === x.fromExp)).sort((a, b) => noExpFirst(a, b) || tie(a, b));
      const required = Number(x.quantity), parts = []; let need = required;
      for (const lot of from) { if (need <= 1e-7) break; const q = clampQty(Math.min(need, lot.remaining)); lot.remaining = clampQty(lot.remaining - q); lot.used = clampQty(lot.used + q); lot.adjusted = clampQty((lot.adjusted || 0) + q); need = clampQty(need - q); parts.push({ manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, quantity: q, batch: lot.batch }); }
      adjusts.set(x.id, { required, done: clampQty(required - need), shortage: clampQty(need), parts });
      if (!isStock && x.phase === 'pack' && !String(x.id).startsWith('pt-jt-')) { const key = baseCode(x.product) + '|' + e.date; if (!packPool.has(key)) packPool.set(key, []); packPool.get(key).push(...parts.map(p => ({ ...p, product: x.product, left: p.quantity }))); }
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
        // 半成品轉現貨：批號用轉現貨當天，有效日期沿用那批半成品
        addLot({ id: x.id + '#' + lot.id, source: 'convert', pool: 'stock', product: lot.product, batch: makeBatch(lot.product, e.date) || '—', manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, entryDate: e.date, quantity: q, used: 0, shipped: 0, converted: 0, remaining: q, seq: x.seq || 0, unit: lot.unit, fromLot: lot.id });
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
  return { lots, shipments, converts, adjusts };
}
// 依「產品＋現貨／半成品＋批號＋製作日＋有效日」彙整；inQty＝入庫（期初＋生產＋轉入現貨），shipped＝出貨，converted＝轉成現貨
function groupLots(ledger) { const g = new Map(); for (const lot of ledger.lots) { const key = JSON.stringify([lot.product, lot.pool, lot.batch, lot.manufactureDate, lot.expiryDate]); if (!g.has(key)) g.set(key, { product: lot.product, pool: lot.pool, batch: lot.batch, manufactureDate: lot.manufactureDate, expiryDate: lot.expiryDate, opening: 0, production: 0, convert: 0, adjust: 0, inQty: 0, used: 0, shipped: 0, converted: 0, adjusted: 0, remaining: 0, unit: lot.unit }); const r = g.get(key); r[lot.source] = clampQty((r[lot.source] || 0) + lot.quantity); r.inQty = clampQty(r.inQty + lot.quantity); r.used = clampQty(r.used + lot.used); r.shipped = clampQty(r.shipped + lot.shipped); r.converted = clampQty(r.converted + lot.converted); r.adjusted = clampQty(r.adjusted + (lot.adjusted || 0)); r.remaining = clampQty(r.remaining + lot.remaining); } return [...g.values()].sort((a, b) => productOrder(a.product, b.product) || cmp(a.expiryDate, b.expiryDate) || cmp(a.pool, b.pool) || cmp(a.manufactureDate, b.manufactureDate)); }
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
VIEWS.adjust = ['半成品／現貨增減', '總公司半成品與現貨的增加、減少（入口網站帶入或手動登錄），庫存、轉現貨與出貨扣批跟著重算。'];
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
  renderDashboard(today, current, groups, prod); renderOpening(); renderProduction(); renderShipments(full); renderBatches(groups, today); renderAllocations(full); renderProducts(prod); renderSettings(); renderPortal(); renderShops(today); renderBatchRule(today); renderAdjust(full);
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
const lotLabel = r => r.batch && r.batch !== '—' ? r.batch : `製 ${md(r.manufactureDate)}`;
const openingChip = r => `<span class="pill ${r.pool === 'stock' ? 'future' : 'other'} exp-chip" title="${esc(`入帳 ${r.entryDate}｜製作 ${r.manufactureDate}｜效期 ${expShow(r.expiryDate)}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`)}"><span class="mono">${esc(lotLabel(r))}</span> ${r.expiryDate === NO_EXPIRY ? '' : '效期 ' + esc(md(r.expiryDate)) + ' '}${esc(fmt(r.quantity))} ${unitOf(r)}</span>`;
const prodKind = r => r.pool === 'stock' ? '生產轉現貨' : /當天生產/.test(r.note) ? '當天生產' : /半成品入庫/.test(r.note) ? '半成品入庫' : '';
const prodChip = r => `<span class="pill ${r.pool === 'stock' ? 'future' : 'ok'} exp-chip" title="${esc(`${r.date}${r.batch !== '—' ? '｜批號 ' + r.batch : '｜半成品（轉現貨後才有批號）'}｜製作 ${r.manufactureDate}｜效期 ${expShow(r.expiryDate)}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`)}"><span class="mono">${esc(md(r.date))}</span> ${esc(fmt(r.quantity))} ${unitOf(r)}${prodKind(r) === '生產轉現貨' ? '（轉現貨）' : ''}</span>`;
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
const SOON_DAYS = 15;
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
  const s = expiryStatus(e.expiry, e.total, today), mfg = [...e.mfgs].sort(), q = `${esc(fmt(e.total))} ${esc(unit)}`;
  if (e.kind === 'stock') {
    if (e.expiry === NO_EXPIRY) return `<span class="pill ${s.cls} exp-chip" title="期初現貨（入口網站帶入，沒有批號與效期資料）"><span class="mono">期初現貨</span> ${q}</span>`;
    return `<span class="pill ${s.cls} exp-chip" title="${esc(`現貨｜批號 ${e.batch}｜有效日期 ${e.expiry}｜${s.label}`)}"><span class="mono">${esc(e.batch)}</span> 現貨・效期 <span class="mono">${esc(e.expiry)}</span>・${q}</span>`;
  }
  return `<span class="pill ${s.cls} exp-chip" title="${esc(`半成品（轉現貨後才有批號）｜製作 ${mfg.join('、')}｜有效日期 ${e.expiry}｜${s.label}`)}"><span class="mono">製 ${esc(md(mfg[0]))}</span> 半成品・效期 <span class="mono">${esc(e.expiry)}</span>・${q}</span>`;
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
  const list = [...byP.values()].map(p => { const all = p.exps, exps = all.filter(inMode), first = all.find(e => e.expiry !== NO_EXPIRY) || all[0]; return { ...p, exps, match: clampQty(exps.reduce((s, e) => s + e.total, 0)), first: first ? first.expiry : '', expText: all.map(e => `${e.expiry} ${e.batch}`).join(' ') }; });
  const base = batchMode !== 'all' ? list.filter(p => p.exps.length) : $('batchLive').checked ? list.filter(p => p.total > 0) : list;
  const rows = searchable(base, $('batchFilter').value, ['product', 'expText']).sort((a, b) => (a.total > 0 ? 0 : 1) - (b.total > 0 ? 0 : 1) || productOrder(a.product, b.product));
  const nExp = list.reduce((s, p) => s + p.exps.length, 0), modeName = batchMode === 'soon' ? `${SOON_DAYS} 天內到期` : '已過期';
  document.querySelectorAll('#batchSeg [data-bmode]').forEach(b => b.classList.toggle('on', b.dataset.bmode === batchMode));
  $('batchCount').textContent = batchMode === 'all' ? `目前有庫存的產品 ${list.filter(p => p.total > 0).length} 項、共 ${nExp} 個批次（現貨寫批號與有效日期，半成品寫製作日期與有效日期）；依品號 ${SORT_PREFIXES.join('、')} 排列` : `${modeName}：${base.length} 項產品、${nExp} 個批次，共 ${fmt(clampQty(base.reduce((s, p) => s + p.match, 0)))} 個；只顯示「${modeName}」的有效日期`;
  const chip = (e, unit) => expChip(e, unit, today);
  const filtered = batchMode !== 'all';
  $('batchTable').innerHTML = table(['產品', filtered ? `${modeName}的有效日期與數量` : '各批次（現貨：批號＋有效日期；半成品：製作日期＋有效日期；由早到晚，顏色＝效期狀態）', ...(filtered ? [`${modeName}數量#`] : []), '剩餘庫存#', ...(split ? ['現貨#', '半成品#'] : []), '最早效期狀態'], rows.map(p => { const s = p.total > 0 ? expiryStatus(p.first || NO_EXPIRY, p.total, today) : { label: '已用完', cls: 'other' }; return `<tr>${td(`<strong>${esc(p.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${p.exps.map(e => chip(e, p.unit)).join('') || '<span class="who">—</span>'}</div></td>${filtered ? `<td class="num">${fmt(p.match)} ${esc(p.unit)}</td>` : ''}<td class="num">${fmt(p.total)} ${esc(p.unit)}</td>${split ? `<td class="num">${p.stock ? fmt(p.stock) : '—'}</td><td class="num">${p.semi ? fmt(p.semi) : '—'}</td>` : ''}${td(badge(s.label, s.cls))}</tr>`; }), batchMode === 'soon' ? `目前沒有 ${SOON_DAYS} 天內到期的庫存` : batchMode === 'expired' ? '目前沒有已過期的庫存' : '尚無批次庫存紀錄');
}
function allocationRows(ledger) { const rows = []; for (const sh of [...data.movements.filter(x => x.type === 'shipment')].sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product) || b.seq - a.seq)) { const r = ledger.shipments.get(sh.id); if (!r) continue; for (const a of r.allocations) rows.push({ date: sh.date, orderNo: sh.orderNo || '', product: sh.product, batch: a.batch, pool: poolLabel(a.pool, sh.date), manufactureDate: a.manufactureDate, expiryDate: a.expiryDate, quantity: a.quantity, unit: getUnit(sh.product), kind: 'allocated' }); if (r.shortage) rows.push({ date: sh.date, orderNo: sh.orderNo || '', product: sh.product, batch: '未分配', manufactureDate: '', expiryDate: '', quantity: r.shortage, unit: getUnit(sh.product), kind: 'shortage' }); } return rows; }
// 出貨扣批明細：一次看一天（預設最近一天有出貨的日子），每個品號一列，列出那天扣了哪些批號／製作日期（現貨／半成品）
let allocDate = '';
const shipDates = () => [...new Set(data.movements.filter(x => x.type === 'shipment').map(x => x.date))].sort();
function allocDay() { if (isDate(allocDate)) return allocDate; const t = TODAY(), ds = shipDates().filter(d => d <= t); return ds.length ? ds[ds.length - 1] : t; }
function renderAllocations(ledger) {
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
  if (kind === 'batches') return ['批次庫存', ['產品', '單位', '類別', '批號', '製作日期', '有效日期', '期初庫存', '新增生產', '半成品轉入', '半成品增加', '已出貨', '轉成現貨', '半成品減少', '剩餘量', '狀態'], groups.map(x => [x.product, x.unit, poolLabel(x.pool), x.batch, x.manufactureDate, expShow(x.expiryDate), x.opening, x.production, x.convert, x.adjust, x.shipped, x.converted, x.adjusted, x.remaining, expiryStatus(x.expiryDate, x.remaining).label])];
  if (kind === 'allocation') return ['出貨扣批明細', ['出貨日期', '出貨單號', '產品', '單位', '批號', '製作日期', '有效日期', '扣貨量', '類別'], allocationRows(led).map(x => [x.date, x.orderNo, x.product, x.unit, x.batch, x.manufactureDate, expShow(x.expiryDate), x.quantity, x.kind === 'shortage' ? '缺口' : '已分配'])];
  if (kind === 'adjust') return ['半成品現貨增減', ['日期', '產品', '單位', '類別', '增加／減少', '數量', '製作日期', '有效日期', '指定扣除的批', '實際扣除／來源', '缺口', '原因／備註', '登錄人'], data.movements.filter(r => r.type === 'adjust').sort((a, b) => cmp(b.date, a.date) || productOrder(a.product, b.product)).map(r => { const o = led.adjusts.get(r.id); return [r.date, r.product, getUnit(r.product), poolName(r.pool), r.dir === 'add' ? '增加' : '減少', r.quantity, r.manufactureDate || '', r.expiryDate || '', r.fromMfg ? `製 ${r.fromMfg}／效期 ${r.fromExp}` : '', o ? adjPartsText(o.parts) : '', o ? o.shortage : '', r.note, r.by]; })];
  if (kind === 'shop') { const outs = new Map(); for (const x of SHOPS) for (const [k, v] of shopLedger(x.id).outs) outs.set(k, v); return ['門市紀錄', ['門市', '日期', '類別', '產品', '單位', '批號', '數量', '門市到期日', '扣除的批號', '缺口', '備註', '登錄人'], [...data.shops].sort((a, b) => SHOPS.findIndex(x => x.id === a.shop) - SHOPS.findIndex(x => x.id === b.shop) || cmp(b.date, a.date) || productOrder(a.product, b.product)).map(r => { const o = outs.get(r.id); return [shopName(r.shop), r.date, SHOP_TYPES[r.type], r.product, getUnit(r.product), r.type === 'in' ? shopInText(r) : r.batch, r.quantity, r.expiryDate || '', o ? shopPartsText(o.parts) : '', o ? o.short : '', r.note, r.by]; })]; }
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
   換盒：同一天、同一個品號開頭（CK-01 → CK-01|YB-86）入口網站的半成品減少，會變成現貨增加的來源，沿用原本的製作日期與有效日期。 */
const poolName = pool => pool === 'stock' ? '現貨' : '半成品';
// 某個產品在某天結束時還有的批（給「減少」選）
function lotsLeftOf(product, date, pool) {
  const L = calculateLedger(isDate(date) ? date : '9999-12-31'), m = new Map();
  for (const l of L.lots) if (l.product === product && l.pool === pool && l.remaining > 1e-7) { const k = l.manufactureDate + '|' + l.expiryDate, x = m.get(k) || { mfg: l.manufactureDate, exp: l.expiryDate, left: 0, batches: new Set() }; x.left = clampQty(x.left + l.remaining); if (l.batch && l.batch !== '—') x.batches.add(l.batch); m.set(k, x); }
  return [...m.values()].sort((a, b) => cmp(a.exp, b.exp) || cmp(a.mfg, b.mfg));
}
const adjPartsText = parts => parts.map(p => `${p.from ? `沿用 ${productCodeOf(p.from)} ` : ''}${p.expiryDate === NO_EXPIRY ? '期初現貨' : `製 ${md(p.manufactureDate)}（效期 ${md(p.expiryDate)}）`}×${fmt(p.quantity)}`).join('、');
function adjFormSync(fillExpiry) {
  const dir = $('adDir').value, pool = $('adPool').value, date = $('adDate').value, p = getProduct($('adProduct').value), box = $('adPreview');
  $('adMfgWrap').hidden = $('adExpWrap').hidden = dir !== 'add'; $('adFromWrap').hidden = dir !== 'sub';
  if (dir === 'add') {
    if (!$('adMfg').value && isDate(date)) $('adMfg').value = date;
    if (fillExpiry && p && isDate($('adMfg').value)) $('adExp').value = addDays($('adMfg').value, p.shelfDays);
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

/* ---------- 門市庫存（A11、京站、東橋，各一頁） ----------
   門市規則：門市的有效日期從「配送到門市（入貨）」那天開始算，入貨日＋門市保存天數（預設 15 天），跟工廠製作日期算出來的效期無關。
   門市人員登錄：入貨（批號選填；沒填就照總公司當天的出貨扣批「推定」）、銷售、報廢。資料存在 shop_YYYYMM，每筆入貨記下當時算好的有效日期（之後改規則不影響已入貨的）。
   銷售、報廢可指定批號；沒指定就從最早到期的扣（先到期先出）。已過期的不能銷售，只能報廢；不夠扣的列為缺口，不會變負庫存。 */
const SHOP_TYPES = { in: '入貨', sale: '銷售', waste: '報廢' };
const shopMode = Object.fromEntries(SHOPS.map(s => [s.id, 'all']));
const shopName = id => (SHOPS.find(s => s.id === id) || {}).name || id;
// 門市規則存在 settings 'shop'：shelfDays 門市保存天數（入貨日起算）、warnDays 剩幾天內提醒
function shopRule() { const r = FEStore.get('settings', 'shop') || {}, sd = Number(r.shelfDays), wd = Number(r.warnDays); return { shelfDays: Number.isInteger(sd) && sd >= 1 && sd <= 365 ? sd : 15, warnDays: Number.isInteger(wd) && wd >= 0 && wd <= 60 ? wd : 3 }; }
const shopExpiry = date => addDays(date, shopRule().shelfDays);
const cleanBatch = v => clean(v).toUpperCase().replace(/\s+/g, '').slice(0, 30);
function shopStatus(expiry, today) {
  const d = dayDiff(today, expiry), w = shopRule().warnDays;
  if (d < 0) return { label: `已過期 ${-d} 天`, cls: 'expired', d };
  if (d === 0) return { label: '今天到期', cls: 'critical', d };
  return { label: `剩 ${d} 天`, cls: d <= w ? 'critical' : d <= w + 4 ? 'due' : 'ok', d };
}
function sanitizeShop(r) {
  if (!r || typeof r !== 'object' || !r.id || !SHOPS.some(s => s.id === r.shop) || !SHOP_TYPES[r.type] || !isDate(r.date)) return null;
  const q = Number(r.quantity), product = clean(r.product);
  if (!product || !(q > 0) || !Number.isFinite(q)) return null;
  const x = { id: String(r.id), seq: Number(r.seq) || 0, shop: r.shop, type: r.type, date: r.date, product, quantity: q, batch: cleanBatch(r.batch), note: clean(r.note), by: clean(r.by), at: r.at || '', ...(r.editBy ? { editBy: clean(r.editBy), editAt: r.editAt || '' } : {}) };
  if (r.type === 'in') { if (!isDate(r.expiryDate)) return null; x.expiryDate = r.expiryDate; if (isDate(r.fromDate)) x.fromDate = r.fromDate; }
  return x;
}
// 重放一間門市的紀錄：同一天先入貨再扣；回傳 lots（每筆入貨的剩餘量）與 outs（每筆銷售／報廢扣了哪些批號、缺多少）
function shopLedger(shop, list = data.shops) {
  const recs = list.filter(r => r.shop === shop).sort((a, b) => cmp(a.date, b.date) || (a.type === 'in' ? 0 : 1) - (b.type === 'in' ? 0 : 1) || a.seq - b.seq);
  const lots = [], outs = new Map(), plan = shopBatchPlan(list);
  for (const r of recs) {
    if (r.type === 'in') {
      // 有填批號＝門市人員確認過的；沒填＝照總公司出貨扣批推定（可能拆成好幾個批號）
      const parts = r.batch ? [{ batch: r.batch, qty: r.quantity }] : (plan.get(r.id) || [{ batch: '', qty: r.quantity, unknown: true }]);
      parts.forEach((p, k) => lots.push({ id: `${r.id}#${k}`, recId: r.id, product: r.product, batch: p.batch || '', guess: !r.batch, opening: !!p.opening, expiry: r.expiryDate, date: r.date, qty: p.qty, left: p.qty }));
      continue;
    }
    let need = r.quantity; const parts = [];
    const cand = lots.filter(l => l.product === r.product && l.left > 0 && l.date <= r.date && (!r.batch || l.batch === r.batch) && (r.type === 'waste' || l.expiry >= r.date)).sort((a, b) => cmp(a.expiry, b.expiry) || cmp(a.date, b.date));
    for (const l of cand) { if (need <= 0) break; const q = clampQty(Math.min(l.left, need)); l.left = clampQty(l.left - q); need = clampQty(need - q); parts.push({ batch: l.batch, expiry: l.expiry, q }); }
    outs.set(r.id, { done: clampQty(r.quantity - need), short: need, parts });
  }
  return { lots, outs };
}
const shopPartsText = parts => parts.map(p => `${p.batch || '批號不明'}（到期 ${md(p.expiry)}）×${fmt(p.q)}`).join('、');
/* ---------- 門市入貨的推定批號 ----------
   入貨沒填批號時：從總公司「轉出日」（預設＝入貨日）這個品號的實際揀貨扣到的批號裡，照效期最早的先分給門市
   （出貨扣批本來就是先到期先出，所以門市拿到的就是那天出去的批）。同一天好幾間門市照 A11 → 京站 → 東橋 的順序分。
   批號：現貨用那批的批號；直接從半成品出的貨用出貨當天的批號；期初現貨沒有批號資料（標「期初現貨」）。
   有填批號（門市人員更正過）的入貨先佔掉那個批號的量，剩下的才分給推定的；分不夠的標「批號不明」。
   門市到期日一律＝入貨日＋門市保存天數，跟批號無關，所以就算批號推錯，剩幾天還是對的。 */
const shopFrom = r => isDate(r.fromDate) ? r.fromDate : r.date;
function hqShipBatches(ledger) {
  const m = new Map();
  for (const r of data.movements) {
    if (r.type !== 'shipment') continue;
    const s = ledger.shipments.get(r.id); if (!s) continue;
    const k = r.date + '|' + r.product, list = m.get(k) || [];
    for (const a of s.allocations) {
      const opening = a.expiryDate === NO_EXPIRY, batch = opening ? '' : (a.batch && a.batch !== '—' ? a.batch : makeBatch(r.product, r.date) || '');
      const x = list.find(p => p.batch === batch && p.opening === opening);
      if (x) { x.qty = clampQty(x.qty + a.quantity); if (a.expiryDate < x.exp) x.exp = a.expiryDate; } else list.push({ batch, exp: a.expiryDate, qty: a.quantity, used: 0, opening });
    }
    m.set(k, list);
  }
  for (const list of m.values()) list.sort((a, b) => (a.opening ? 0 : 1) - (b.opening ? 0 : 1) || cmp(a.exp, b.exp) || cmp(a.batch, b.batch));
  return m;
}
let shopPlanMemo = null;
function shopBatchPlan(list = data.shops) {
  if (list === data.shops && shopPlanMemo && shopPlanMemo.data === data) return shopPlanMemo.plan;
  const pools = hqShipBatches(calculateLedger()), plan = new Map(), order = r => SHOPS.findIndex(s => s.id === r.shop);
  const ins = list.filter(r => r.type === 'in').sort((a, b) => cmp(shopFrom(a), shopFrom(b)) || order(a) - order(b) || a.seq - b.seq);
  const poolOf = r => pools.get(shopFrom(r) + '|' + r.product) || [];
  const take = (p, need) => { const q = clampQty(Math.min(need, p.qty - p.used)); if (q > 1e-7) p.used = clampQty(p.used + q); return q > 1e-7 ? q : 0; };
  for (const r of ins) if (r.batch) { let need = r.quantity; for (const p of poolOf(r)) { if (need <= 1e-7) break; if (p.batch === r.batch) need = clampQty(need - take(p, need)); } }
  for (const r of ins) {
    if (r.batch) continue;
    let need = r.quantity; const parts = [];
    for (const p of poolOf(r)) {
      if (need <= 1e-7) break;
      const q = take(p, need); if (!q) continue; need = clampQty(need - q);
      const x = parts.find(y => y.batch === p.batch && !!y.opening === p.opening); if (x) x.qty = clampQty(x.qty + q); else parts.push({ batch: p.batch, qty: q, factoryExp: p.exp, opening: p.opening });
    }
    if (need > 1e-7) parts.push({ batch: '', qty: need, unknown: true });
    plan.set(r.id, parts);
  }
  if (list === data.shops) shopPlanMemo = { data, plan };
  return plan;
}
const guessLabel = p => p.batch || (p.opening ? '期初現貨' : '批號不明');
const shopInText = (r, plan) => r.batch ? r.batch : '推定 ' + ((plan || shopBatchPlan()).get(r.id) || [{ batch: '', qty: r.quantity, unknown: true }]).map(p => `${guessLabel(p)}×${fmt(p.qty)}`).join('、');
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
    <div class="notice"><span id="shopRule-${id}"></span> <button type="button" class="btn small need-setting" data-action="shop-rule">修改門市規則</button> <button type="button" class="btn small need-storeout" data-action="store-out" title="讀揀貨總表的排單表，把各門市的出庫量帶入成入貨（批號自動推定）">從揀貨總表帶入今天的入貨</button></div>
    <div id="shopKpi-${id}" class="grid-kpi"></div>
    <div class="panel form-area need-shop_${id}"><div class="panel-head"><div><h2>登錄${n}門市入貨／銷售／報廢</h2><p>入貨的批號可以不填：會照總公司當天的出貨扣批自動推定（先到期先出），之後看到貨上標籤不一樣再到「明細」更正。</p></div></div><div class="panel-body"><form id="shopForm-${id}" class="form-grid" novalidate>
      <div class="field"><label for="shDate-${id}">日期 *</label><input id="shDate-${id}" type="date" required></div>
      <div class="field"><label for="shType-${id}">類別 *</label><select id="shType-${id}"><option value="in">入貨（配送到門市）</option><option value="sale">銷售</option><option value="waste">報廢</option></select></div>
      <div class="field span2"><label for="shProduct-${id}">產品 *</label><input id="shProduct-${id}" list="productNames" required placeholder="輸入品號或品名，從清單選擇" maxlength="80" autocomplete="off"></div>
      <div class="field"><label for="shBatch-${id}" id="shBatchLab-${id}">批號 *</label><input id="shBatch-${id}" list="shBatchList-${id}" placeholder="例如 CKAS1B08" maxlength="30" autocomplete="off" style="text-transform:uppercase"><datalist id="shBatchList-${id}"></datalist></div>
      <div class="field"><label for="shQty-${id}">數量 *</label><input id="shQty-${id}" type="number" inputmode="decimal" required step="0.001" min="0.001" placeholder="0"></div>
      <div class="field span2"><label for="shNote-${id}">備註</label><input id="shNote-${id}" maxlength="180" placeholder="選填"></div>
      <div class="field span4"><div id="shPreview-${id}" class="notice" hidden></div><div class="form-actions"><button type="submit" class="btn primary">＋ 儲存</button></div></div>
    </form></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${n}門市庫存（依批號）</h2><p id="shopCount-${id}"></p></div><div class="toolbar"><div class="seg" id="shopSeg-${id}" role="group" aria-label="到期篩選"><button type="button" data-smode="all" class="on">全部</button><button type="button" data-smode="soon"><span class="seg-lab">快到期</span><span class="seg-n" hidden></span></button><button type="button" data-smode="expired">已過期<span class="seg-n" hidden></span></button></div><input id="shopFilter-${id}" class="search" type="search" placeholder="搜尋產品／批號" aria-label="搜尋${n}門市庫存"></div></div><div id="shopStock-${id}" class="table-scroll"></div></div>
    <div class="panel"><div class="panel-head"><div><h2>${n}門市入貨／銷售／報廢紀錄</h2><p id="shopRecCount-${id}"></p></div><div class="toolbar"><input id="shopRecFilter-${id}" class="search" type="search" placeholder="搜尋日期／產品／批號／備註" aria-label="搜尋${n}門市紀錄"><button type="button" class="btn small" data-action="csv-shop" title="三間門市的紀錄一起匯出">匯出 CSV</button></div></div><div id="shopRecs-${id}" class="table-scroll"></div></div>
  </section>`;
}
function buildShops() {
  document.querySelector('.nav-btn[data-view="manage"]').insertAdjacentHTML('beforebegin', '<div class="nav-title">門市庫存</div>' + SHOPS.map(s => `<a class="nav-btn" href="#shop-${s.id}" data-view="shop-${s.id}"><span class="nav-ico" aria-hidden="true">⌂</span>${esc(s.name)}門市</a>`).join(''));
  $('users').insertAdjacentHTML('beforebegin', SHOPS.map(shopSectionHtml).join(''));
}
const shopChip = (r, out, plan) => {
  const u = esc(getUnit(r.product)), short = out && out.short > 0, isIn = r.type === 'in', unk = shopUnknownQ(r, plan);
  const cls = isIn ? (unk ? 'due' : 'ok') : short ? 'bad' : r.type === 'waste' ? 'expired' : 'other';
  const extra = isIn ? `（到期 ${esc(md(r.expiryDate))}）` : short ? `（缺 ${esc(fmt(out.short))}）` : '';
  const btxt = isIn ? shopInText(r, plan) : r.batch;
  const tip = `${r.date}｜${SHOP_TYPES[r.type]} ${fmt(r.quantity)}${btxt ? '｜批號 ' + btxt : ''}${isIn ? '｜門市到期 ' + r.expiryDate : out ? '｜扣 ' + (shopPartsText(out.parts) || '—') + (short ? '｜缺 ' + fmt(out.short) : '') : ''}${r.note ? '｜' + r.note : ''}${r.by ? '｜' + r.by : ''}`;
  return `<span class="pill ${cls} exp-chip" title="${esc(tip)}"><span class="mono">${esc(md(r.date))}</span> ${SHOP_TYPES[r.type]}${btxt ? ` <span class="mono">${esc(btxt)}</span>` : ''} ${esc(fmt(r.quantity))} ${u}${extra}</span>`;
};
function renderShops(today) {
  const rule = shopRule(), inRange = (e, m) => { const d = dayDiff(today, e.expiry); return m === 'soon' ? d >= 0 && d <= rule.warnDays : d < 0; };
  for (const s of SHOPS) {
    const id = s.id, L = shopLedger(id), mode = shopMode[id], plan = shopBatchPlan();
    $('shopRule-' + id).innerHTML = `<strong>門市規則：</strong>有效日期＝配送到門市（入貨）那天＋<strong>${rule.shelfDays} 天</strong>，跟工廠的製作日期無關；剩 <strong>${rule.warnDays} 天</strong>以內算「快到期」。入貨會從<strong>揀貨總表</strong>帶入今天的門市出庫（同步入口網站時一起帶，或按「從揀貨總表帶入今天的入貨」），批號照總公司當天的出貨扣批推定。銷售、報廢可以指定批號，沒指定就從最早到期的扣；已過期的不能銷售，只能報廢。`;
    // 庫存：每個品號一列，每個「批號＋到期日」一個標籤（只算今天以前入貨的）
    const byP = new Map();
    for (const l of L.lots) {
      if (!(l.left > 0) || l.date > today) continue;
      if (!byP.has(l.product)) byP.set(l.product, { product: l.product, total: 0, exps: new Map() });
      const p = byP.get(l.product), k = l.batch + '|' + l.expiry + '|' + (l.guess ? 1 : 0) + (l.opening ? 'o' : ''), e = p.exps.get(k) || { batch: l.batch, expiry: l.expiry, guess: l.guess, opening: l.opening, total: 0, dates: new Set() };
      e.total = clampQty(e.total + l.left); e.dates.add(l.date); p.exps.set(k, e); p.total = clampQty(p.total + l.left);
    }
    const list = [...byP.values()].map(p => ({ ...p, exps: [...p.exps.values()].sort((a, b) => cmp(a.expiry, b.expiry) || cmp(a.batch, b.batch)) }));
    const cnt = m => list.filter(p => p.exps.some(e => inRange(e, m))).length, nSoon = cnt('soon'), nExp = cnt('expired');
    $('shopSeg-' + id).querySelectorAll('[data-smode]').forEach(b => {
      const m = b.dataset.smode, n = m === 'soon' ? nSoon : m === 'expired' ? nExp : 0, el = b.querySelector('.seg-n'), lab = b.querySelector('.seg-lab');
      b.classList.toggle('on', m === mode);
      if (lab) lab.textContent = `${rule.warnDays} 天內到期`;
      if (el) { el.hidden = !n; el.textContent = n; b.title = n ? `${n} 項產品${m === 'soon' ? ` ${rule.warnDays} 天內到期` : '已過期'}` : ''; }
    });
    const modeName = mode === 'soon' ? `${rule.warnDays} 天內到期` : '已過期';
    const shown = list.map(p => ({ ...p, show: mode === 'all' ? p.exps : p.exps.filter(e => inRange(e, mode)), text: p.exps.map(e => `${e.batch} ${e.expiry}`).join(' ') })).filter(p => p.show.length);
    const rows = searchable(shown, $('shopFilter-' + id).value, ['product', 'text']).sort((a, b) => productOrder(a.product, b.product));
    const chip = (e, u) => { const st = shopStatus(e.expiry, today), b = guessLabel(e); return `<span class="pill ${st.cls} exp-chip" title="${esc(`批號 ${b}${e.guess ? '（推定：照總公司出貨扣批，門市人員可在明細更正）' : ''}｜入貨 ${[...e.dates].sort().join('、')}｜門市到期 ${e.expiry}｜${st.label}`)}"><span class="mono">${esc(b)}</span>${e.guess && e.batch ? '<span class="guess">推定</span>' : ''}・到期 ${esc(md(e.expiry))}（${esc(st.label)}）・${esc(fmt(e.total))} ${u}</span>`; };
    $('shopCount-' + id).textContent = mode === 'all' ? `目前有庫存的產品 ${list.length} 項，共 ${fmt(sumQ(list, p => p.total))} 個；每個批號一個標籤，寫門市到期日與剩幾天` : `${modeName}：${shown.length} 項產品，共 ${fmt(sumQ(shown, p => sumQ(p.show, e => e.total)))} 個`;
    $('shopStock-' + id).innerHTML = table(['產品', mode === 'all' ? '各批號（門市到期日、剩幾天、數量；由早到晚）' : `${modeName}的批號`, '剩餘庫存#', '最早到期'], rows.map(p => {
      const u = esc(getUnit(p.product)), st = shopStatus(p.exps[0].expiry, today);
      return `<tr>${td(`<strong>${esc(p.product)}</strong>`)}<td class="exp-cell"><div class="exp-chips">${p.show.map(e => chip(e, u)).join('')}</div></td><td class="num">${fmt(p.total)} ${u}</td>${td(badge(st.label, st.cls))}</tr>`;
    }), mode === 'all' ? `${s.name}門市目前沒有庫存` : `${s.name}門市沒有${modeName}的庫存`);
    // 摘要
    const recs = data.shops.filter(r => r.shop === id), todayQ = t => sumQ(recs.filter(r => r.date === today && r.type === t));
    $('shopKpi-' + id).innerHTML = [
      ['目前庫存', `${fmt(sumQ(list, p => p.total))} 個`, `${list.length} 項產品、${list.reduce((n, p) => n + p.exps.length, 0)} 個批號`, ''],
      ['今日入貨／銷售', `${fmt(todayQ('in'))}／${fmt(todayQ('sale'))}`, todayQ('waste') ? `報廢 ${fmt(todayQ('waste'))} 個` : '今天還沒有報廢', ''],
      [`${rule.warnDays} 天內到期`, `${nSoon} 項`, nSoon ? '請優先銷售' : '沒有', nSoon ? 'warn' : ''],
      ['已過期', `${nExp} 項`, nExp ? '請報廢下架' : '沒有', nExp ? 'bad' : ''],
    ].map(([l, v, d, c]) => `<article class="kpi ${c}"><div class="kpi-label">${esc(l)}</div><div class="kpi-value" style="font-size:20px">${esc(v)}</div><div class="kpi-desc">${esc(d)}</div></article>`).join('');
    // 紀錄：每個品號一列
    const groups = groupByProduct(recs.map(r => ({ ...r, kind: SHOP_TYPES[r.type], btxt: r.type === 'in' ? shopInText(r, plan) : r.batch })), $('shopRecFilter-' + id).value, ['date', 'kind', 'note', 'btxt', 'expiryDate']);
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
    return `<tr>${tdm(r.date)}${td(esc(SHOP_TYPES[r.type]))}${td(bcell)}<td class="num">${fmt(r.quantity)} ${u}</td>${td(esc(isIn ? '到期 ' + r.expiryDate + (shopFrom(r) !== r.date ? `（總公司 ${shopFrom(r)} 轉出）` : '') : (o && shopPartsText(o.parts)) || '—'))}<td class="num">${o && o.short ? fmt(o.short) : '—'}</td>${td(esc(r.note || '—'))}${tdWho(r)}${canEdit ? td(`<div class="segment">${btns}</div>`) : ''}</tr>`;
  }));
  await modal({ title: `${shopName(sid)}門市「${product}」的紀錄（${rows.length} 筆）`, html: `<div class="table-scroll">${html}</div>`, ok: '關閉', wide: true, noCancel: true });
}
// 更正入貨的批號：填貨上標籤的批號（整筆都是這個批號）；清空＝改回自動推定
async function editShopBatch(sid, id) {
  closeModal();
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid && x.type === 'in'); if (!r) return;
  const pool = (hqShipBatches(calculateLedger()).get(shopFrom(r) + '|' + r.product) || []).filter(p => p.batch);
  const om = new Map(pool.map(p => [p.batch, `總公司 ${shopFrom(r)} 出貨 ${fmt(p.qty)} 個`]));
  for (const x of factoryBatches(r.product)) if (!om.has(x.batch)) om.set(x.batch, `工廠 ${x.date} 入庫`);
  const opts = [...om.entries()];
  const res = await modal({ title: `更正入貨批號：${r.product}`, ok: '儲存',
    html: `<p>${esc(`${shopName(sid)}門市｜${r.date} 入貨 ${fmt(r.quantity)} ${getUnit(r.product)}｜門市到期 ${r.expiryDate}`)}</p><p class="modal-note">目前：${esc(shopInText(r))}。填貨上標籤的批號（這筆全部都是這個批號）；如果其實是好幾個批號，請把這筆刪掉，一個批號登錄一筆。清空＝改回自動推定。門市到期日不會變。</p><div class="field"><label for="sb-batch">批號</label><input id="sb-batch" list="sb-list" value="${esc(r.batch || '')}" placeholder="例如 CKAS1B08" maxlength="30" autocomplete="off" style="text-transform:uppercase"><datalist id="sb-list">${opts.map(([v, l]) => `<option value="${esc(v)}" label="${esc(l)}"></option>`).join('')}</datalist></div><p class="modal-error" hidden></p>`,
    collect: b => ({ batch: cleanBatch(b.querySelector('#sb-batch').value) }) });
  if (!res || res.batch === (r.batch || '')) return;
  act(() => { FEStore.save('shop', { ...r, batch: res.batch, ...stampEdit() }); toast(res.batch ? `已更正為批號 ${res.batch}，門市庫存已重算` : '已改回自動推定，門市庫存已重算'); });
}
async function deleteShopRec(sid, id) {
  closeModal();
  if (!can(shopPerm(sid))) return;
  const r = data.shops.find(x => x.id === id && x.shop === sid); if (!r) return;
  if (!await modal({ title: '刪除這筆門市紀錄？', html: `<p>${esc(`${shopName(sid)}門市｜${r.date}｜${SHOP_TYPES[r.type]} ${r.product}${r.batch ? ' 批號 ' + r.batch : ''} ${fmt(r.quantity)} ${getUnit(r.product)}${r.type === 'in' ? '｜到期 ' + r.expiryDate : ''}`)}</p><p class="modal-note">刪除後，這間門市的庫存與扣除會重新計算。</p>`, ok: '刪除', danger: true })) return;
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
// 只帶入今天的門市出庫（跟「商品總計」看到的一樣）；過去的日子不補，已經帶入的保留不動
function storeOutDates() { const t = TODAY(), from = syncFromDate(); return !from || t >= from ? [t] : []; }
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
        const merged = new Map();
        for (const x of ((d.stores || {})[sh.name] || [])) {
          if (!Array.isArray(x)) continue;
          const code = clean(x[0]), name = clean(x[1]), q = Number(x[2]);
          if (!(q > 0) || q >= 1e7 || isExcluded(name) || (code && !prefixes.includes(codePrefix(code)))) continue;
          const p = productFor(code, name);
          if (!p) { unknown.add(name); continue; }
          if (!prefixes.includes(codePrefix(productCodeOf(p.name))) || isExcluded(p.name)) continue;
          merged.set(p.name, clampQty((merged.get(p.name) || 0) + q));
        }
        for (const [pname, q] of merged) {
          const id = `pt-in-${sh.id}-${ds}-${productCodeOf(pname)}`, old = existing.get(id);
          want.add(id); cnt[sh.id]++; qn[sh.id] = clampQty(qn[sh.id] + q);
          const rec = old ? { ...old, product: pname, quantity: q } : { id, shop: sh.id, type: 'in', date: ds, fromDate: ds, product: pname, quantity: q, batch: '', expiryDate: shopExpiry(ds), note: '揀貨總表：門市出庫', seq: nextSeq(), by: who, at };
          if (!old || old.quantity !== q || old.product !== pname) saves.push(rec);
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
async function editShopRule() {
  if (!can('setting')) return;
  const r = shopRule();
  const res = await modal({ title: '門市規則', ok: '儲存',
    html: `<p class="modal-note">門市的有效日期從配送到門市（入貨）那天開始算，跟工廠的製作日期無關。改了只影響之後的入貨，已經入貨的到期日不變。</p><div class="field"><label for="sr-shelf">門市保存天數（入貨日＋幾天）</label><input id="sr-shelf" type="number" min="1" max="365" step="1" value="${r.shelfDays}"></div><div class="field"><label for="sr-warn">剩幾天以內算「快到期」</label><input id="sr-warn" type="number" min="0" max="60" step="1" value="${r.warnDays}"></div><p class="modal-error" hidden></p>`,
    collect: b => { const sd = Number(b.querySelector('#sr-shelf').value), wd = Number(b.querySelector('#sr-warn').value); if (!Number.isInteger(sd) || sd < 1 || sd > 365) throw Error('門市保存天數要是 1～365 的整數'); if (!Number.isInteger(wd) || wd < 0 || wd > 60) throw Error('快到期天數要是 0～60 的整數'); return { sd, wd }; } });
  if (!res) return;
  act(() => { FEStore.save('settings', { id: 'shop', shelfDays: res.sd, warnDays: res.wd }); toast(`門市規則已更新：入貨日＋${res.sd} 天，剩 ${res.wd} 天內提醒`); });
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
    if (!batch && q > 0) { const tmp = { id: '__preview__', shop: sid, type: 'in', date, product: p.name, quantity: q, batch: '', expiryDate: shopExpiry(date), seq: Date.now() }; guess = shopInText(tmp, shopBatchPlan([...data.shops, tmp])); }
    box.hidden = false; box.className = `notice${guess.includes('批號不明') ? ' warning' : ''}`;
    box.textContent = `門市到期日：${shopExpiry(date)}（${date} 入貨＋${shopRule().shelfDays} 天）${batch ? `｜批號 ${batch}` : guess ? `｜${guess}（照總公司 ${date} 的出貨扣批）${guess.includes('批號不明') ? '：總公司當天這個品號的出貨不夠分，多的標「批號不明」' : ''}` : '｜批號不填會自動推定'}${batch && opts.length && !opts.some(([v]) => v === batch) ? '（不在工廠現貨的批號清單裡，請再確認）' : ''}`;
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
  if (type === 'in') rec.expiryDate = shopExpiry(date);
  const o = type === 'in' ? null : shopLedger(sid, [...data.shops, rec]).outs.get(rec.id);
  FEStore.save('shop', rec);
  resetShopForm(sid, true);
  toast(o && o.short ? `已登錄${SHOP_TYPES[type]}：扣 ${fmt(o.done)}，缺 ${fmt(o.short)}（庫存不夠${batch ? '、這個批號不夠' : ''}${type === 'sale' ? '，或剩下的已過期' : ''}）` : type === 'in' ? `已登錄${shopName(sid)}門市入貨 ${fmt(quantity)} ${getUnit(product)}（${shopInText(rec)}），門市到期 ${rec.expiryDate}` : `已登錄${shopName(sid)}門市${SHOP_TYPES[type]} ${fmt(quantity)} ${getUnit(product)}`, !!(o && o.short), o && o.short ? 7000 : 5000);
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
    box.innerHTML = b ? `<div class="br-code mono">${esc(b)}</div><div class="br-parts"><span><b class="mono">${esc(pc.slice(0, 2))}</b>品號碼（1-2 碼）</span><span><b class="mono">${esc(monthCode(m))}</b>${m} 月（第 3 碼）</span><span><b class="mono">${esc(yearCode(y))}</b>${y} 年（第 4 碼）</span><span><b class="mono">${esc(dayCode(d))}</b>${d} 日（第 5-6 碼）</span><span><b class="mono">${esc(pc.slice(2))}</b>品號碼（7-8 碼）</span></div><p class="br-exp">有效日期：<strong>${esc(exp)}</strong>（${esc(date)} ＋ 保存 ${fmt(p.shelfDays)} 天）</p>`
      : `<div class="notice warning">${!pc ? `「${esc(p.name)}」的品號沒辦法自動變成 4 碼品號碼，請在下方「品號碼對照」設定。` : `${y} 年沒有年碼（規則只到 ${YEAR_BASE}～${YEAR_BASE + YEAR_CODES.length - 1} 年），請更新批號規則。`}</div>`;
  }
  // 2. 某一天的生產批號
  const ld = $('brListDate').value, prods = data.movements.filter(r => r.type === 'production' && r.date === ld).sort((a, b) => productOrder(a.product, b.product) || cmp(a.batch, b.batch));
  $('brListCount').textContent = isDate(ld) ? `${ld} 共 ${prods.length} 筆生產（入口網站同步後自動帶入批號與有效日期）` : '請選日期';
  $('brList').innerHTML = table(['產品', '類別', '數量#', '批號', '製作日期', '有效日期'], prods.map(r => `<tr>${td(`<strong>${esc(r.product)}</strong>`)}${td(esc(prodKind(r) || '生產'))}<td class="num">${fmt(r.quantity)} ${esc(getUnit(r.product))}</td>${td(r.batch === '—' ? `— ${badge('半成品', 'other')}` : `<span class="mono">${esc(r.batch)}</span>${r.batch === makeBatch(r.product, r.date) ? '' : ' ' + badge('舊格式', 'other')}`)}${tdm(r.manufactureDate)}${tdm(expShow(r.expiryDate))}</tr>`), '這天沒有生產紀錄');
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
  return { days, hasStock: p.v >= 2, hasConvert: p.v >= 3, hasAdjust: p.v >= 4, hasExtra: p.v >= 5, noGap: new Set(p.v >= 5 && Array.isArray(p.ng) ? p.ng.filter(isDate) : []), warn: typeof p.w === 'string' ? p.w.slice(0, 300) : '' };
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
            const body = { type: 'adjust', dir, date: ds, product: p.name, quantity: q, note: `入口網站：${label}`, phase, ...(pool === 'stock' ? { pool: 'stock' } : {}), ...(dir === 'add' ? { batch: '—', manufactureDate: mfg, expiryDate: addDays(mfg, p.shelfDays) } : { fromMfg: '', fromExp: '' }) };
            const rec = old ? { ...old, ...body } : { id, seq: nextSeq(), ...body, by: who, at };
            if (!old || old.quantity !== rec.quantity || old.dir !== rec.dir || old.product !== rec.product || (old.pool || '') !== (rec.pool || '') || old.note !== rec.note || old.phase !== rec.phase || old.manufactureDate !== rec.manufactureDate) saves.push(rec);
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
          const p = productFor(r.code, r.name), id = `pt-q-${ds}-${r.code}`, old = existing.get(id), exp = addDays(ds, p.shelfDays);
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
    FEStore.save('settings', { ...meta, id: 'portal', at: Date.now(), by: who, first: dates[0] || '', last: dates[dates.length - 1] || '', days: dates.length, ...sum, pQ: clampQty(sum.pQ), sQ: clampQty(sum.sQ), qQ: clampQty(sum.qQ), cQ: clampQty(sum.cQ), ...(stockOpen.set ? { stockOpenDate: from, stockOpenN: stockOpen.n, stockOpenQ: clampQty(stockOpen.q) } : {}), newProducts: newProducts.length, changed, warn: c.warn });
    const range = dates.length ? `${shortDate(dates[0])}～${shortDate(dates[dates.length - 1])}` : '沒有可匯入的日期';
    const parts = [okP ? `${modeB === dates.length && dates.length ? '當天生產' : modeB ? '半成品入庫／當天生產' : '半成品入庫'} ${sum.pN} 筆（${fmt(sum.pQ)} 個）` : '', okP && c.hasStock && sum.qN ? `生產轉現貨 ${sum.qN} 筆（${fmt(sum.qQ)} 個）` : '', okP && c.hasConvert && sum.cN ? `半成品轉現貨 ${sum.cN} 筆（${fmt(sum.cQ)} 個）` : '', okP && c.hasAdjust && sum.jN ? `半成品／現貨增減 ${sum.jN} 筆${sum.gN ? `（其中隔夜差異 ${sum.gN} 筆）` : ''}` : '', okS ? `出貨 ${sum.sN} 筆（${fmt(sum.sQ)} 個）` : ''].filter(Boolean).join('、');
    const notes = [modeB ? `${modeB === dates.length ? '全部' : `其中 ${modeB} 天`}用全現貨模式（${stockFromDate()} 起）` : '', stockOpen.set ? `期初現貨 ${stockOpen.n} 個品號（${fmt(stockOpen.q)} 個，${from}）` : '', !c.hasExtra ? '這是舊版書籤，' + (!c.hasStock ? '沒有帶入現貨' : !c.hasConvert ? '沒有帶入半成品轉現貨' : !c.hasAdjust ? '沒有帶入半成品／現貨增減' : '沒有帶入總表的手動數字與隔夜差異') + '，請到「入口網站同步」重新拖曳書籤' : '', dates.some(d => c.noGap.has(d)) ? `${dates.filter(d => c.noGap.has(d)).map(shortDate).join('、')} 沒讀到前一天的總表，隔夜差異沒有更新` : '', newProducts.length ? `新增產品 ${newProducts.length} 項` : '', skippedCodes.size ? `略過 ${prefixes.join('、')} 以外的品號 ${skippedCodes.size} 個` : '', excludedCodes.size ? `略過${EXCLUDE_WORDS.join('、')} ${excludedCodes.size} 個品號` : '', before.length ? `起算日 ${from} 以前的 ${before.length} 天沒有匯入` : '', !okP ? '你沒有生產權限，生產數字沒有存' : '', !okS ? '你沒有出貨權限，出貨數字沒有存' : '', c.warn ? '注意：' + c.warn : ''].filter(Boolean).join('；');
    toast(`已同步入口網站 ${range}：${parts}${changed ? '' : '（數字都沒變）'}${notes ? '。' + notes : ''}`, false, 10000);
    go('portal');
    // 接著帶入今天的門市出庫（揀貨總表），結果在入口網站的提示之後顯示
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
const FLOW_SEMI = '<strong>半成品模式</strong>：<strong>半成品入庫</strong>登錄成有效期的半成品批次；<strong>半成品轉現貨</strong>照總表的實際數量，從效期最早的半成品轉成現貨（保留原本的批號與有效日期，轉多了沒出完的留到隔天）；<strong>生產轉現貨</strong>是當天生產直接做成的現貨；<strong>半成品增減、半成品轉試吃、現貨增減、總表的手動數字</strong>記到「半成品／現貨增減」頁；總表當天期初跟前一天期末對不上的<strong>隔夜差異</strong>也記到那頁，算在當天一開始（換盒的情況：同一天同品號開頭的半成品減少會變成另一個品號的現貨增加，沿用原本的效期）；起算日的<strong>期初現貨</strong>沒有效期資料。<strong>實際揀貨</strong>登錄成出貨：<strong>①現貨（含當天轉好的）→ ②現貨不夠再直接扣半成品（效期最早的先）→ ③當天的生產轉現貨</strong>，當天的半成品入庫是出完貨剩下的。';
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
  if (a === 'shop-delete') return deleteShopRec(el.dataset.shop, id);
  if (a === 'shop-batch') return editShopBatch(el.dataset.shop, id);
  if (a === 'store-out') return syncStoreOut(storeOutDates());
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
  $('adjustForm').addEventListener('submit', saveAdjust);
  for (const id of ['adDir', 'adPool', 'adDate', 'adProduct', 'adMfg']) $(id).addEventListener('change', () => adjFormSync(id !== 'adDate'));
  for (const id of ['adQty', 'adFrom']) $(id).addEventListener('input', () => adjFormSync(false));
  $('adFrom').addEventListener('change', () => adjFormSync(false));
  $('adjustFilter').addEventListener('input', scheduleRender);
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
  }
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
