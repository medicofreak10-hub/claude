/* Surgical Case Log: offline case logbook (IndexedDB + PWA) */
'use strict';

const CATEGORIES = ['Hepatobiliary', 'Colorectal', 'Breast', 'Endocrine', 'Vascular/Varicose (EVLT)', 'Hernia', 'Emergency', 'Other'];
const ROLES = ['Performed', 'Assisted', 'Supervised'];
const HOSPITALS = ['AIIMS BBN', 'DCMS', 'Hexa Health', 'Other'];
const APPROACHES = ['Open', 'Laparoscopic', 'Robotic', 'Endovenous'];
const CD_GRADES = ['None', 'I', 'II', 'IIIa', 'IIIb', 'IVa', 'IVb', 'V'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FIELDS = ['date', 'hospital', 'hospitalOther', 'age', 'sex', 'uhid', 'diagnosis', 'procedure', 'category',
  'approach', 'setting', 'role', 'asa', 'duration', 'bloodLoss', 'cd', 'complication', 'outcome', 'notes'];
const NUMERIC = ['age', 'duration', 'bloodLoss'];

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- Storage (IndexedDB) ---------- */
const DB_NAME = 'surgical-case-log';
const STORE = 'cases';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaction aborted'));
  });
}
const reqP = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const dbAll = () => tx('readonly', s => reqP(s.getAll()));
const dbPut = item => tx('readwrite', s => { s.put(item); });
const dbPutMany = items => tx('readwrite', s => { items.forEach(i => s.put(i)); });
const dbDelete = id => tx('readwrite', s => { s.delete(id); });
const dbClear = () => tx('readwrite', s => { s.clear(); });

/* ---------- Small prefs in localStorage (best effort) ---------- */
function prefGet(key, fallback) {
  try { const v = localStorage.getItem('scl.' + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function prefSet(key, val) {
  try { localStorage.setItem('scl.' + key, JSON.stringify(val)); } catch { /* ignore */ }
}

/* ---------- Helpers ---------- */
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d} ${MONTHS[+m - 1]} ${y}`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const hospitalName = c => (c.hospital === 'Other' && c.hospitalOther) ? c.hospitalOther : (c.hospital || '');
const hasComplication = c => !!c.cd && c.cd !== 'None';
const isMajor = c => /^(III|IV|V)/.test(c.cd || '');
const pct = (n, d) => d ? (Math.round((n / d) * 1000) / 10) + '%' : '0%';
const ageSex = c => [c.age !== '' && c.age != null ? c.age : '', c.sex || ''].filter(Boolean).join('/');

function sortCases(list) {
  return list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function confirmDialog({ title, message, ok = 'Delete' }) {
  const dlg = $('#confirmDlg');
  $('#confirmTitle').textContent = title;
  $('#confirmMsg').textContent = message;
  $('#confirmOk').textContent = ok;
  return new Promise(resolve => {
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
    $('#confirmCancel').focus();
  });
}

/* ---------- State ---------- */
let cases = [];
const filters = { q: '', from: '', to: '', category: '', role: '', hospital: '' };

async function reload() {
  cases = sortCases(await dbAll());
  $('#caseCount').textContent = `${cases.length} case${cases.length === 1 ? '' : 's'}`;
  refreshDatalists();
  renderList();
  renderDashboard();
  updateExportScope();
}

function filtersActive() {
  return !!(filters.from || filters.to || filters.category || filters.role || filters.hospital || filters.q);
}
function applyFilters(list) {
  const q = filters.q.trim().toLowerCase();
  return list.filter(c => {
    if (filters.from && c.date < filters.from) return false;
    if (filters.to && c.date > filters.to) return false;
    if (filters.category && c.category !== filters.category) return false;
    if (filters.role && c.role !== filters.role) return false;
    if (filters.hospital && c.hospital !== filters.hospital) return false;
    if (q) {
      const hay = [c.procedure, c.diagnosis, c.uhid, c.notes, c.complication, hospitalName(c), c.category, c.approach]
        .join(' ').toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
}

/* ---------- Navigation ---------- */
function showView(name) {
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  $$('.tab').forEach(t => {
    const on = t.dataset.view === name;
    t.classList.toggle('active', on);
    if (on) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
}

/* ---------- Form ---------- */
const form = $('#caseForm');

function setRadio(name, value) {
  $$(`input[name="${name}"]`, form).forEach(r => { r.checked = r.value === value; });
}
function getRadio(name) {
  const r = $(`input[name="${name}"]:checked`, form);
  return r ? r.value : '';
}

function readForm() {
  const data = {};
  for (const f of FIELDS) {
    const el = form.elements[f];
    if (!el) continue;
    if (el instanceof RadioNodeList || (el.length && el[0] && el[0].type === 'radio')) data[f] = getRadio(f);
    else data[f] = (el.value || '').trim();
  }
  for (const n of NUMERIC) data[n] = data[n] === '' ? '' : Number(data[n]);
  if (data.hospital !== 'Other') data.hospitalOther = '';
  if (!hasComplication(data)) data.complication = '';
  return data;
}

function clearErrors() {
  $$('.invalid', form).forEach(e => e.classList.remove('invalid'));
  $$('.err', form).forEach(e => e.remove());
}
function markError(name, msg) {
  const el = form.elements[name];
  const node = el && (el.length && el[0] && el[0].type === 'radio' ? el[0] : el);
  const field = node && node.closest('.field');
  if (!field) return null;
  field.classList.add('invalid');
  const p = document.createElement('div');
  p.className = 'err';
  p.textContent = msg;
  field.appendChild(p);
  return field;
}

function validate(d) {
  clearErrors();
  const errs = [];
  if (!d.date) errs.push(['date', 'Date is required']);
  if (!d.hospital) errs.push(['hospital', 'Choose a hospital']);
  else if (d.hospital === 'Other' && !d.hospitalOther) errs.push(['hospitalOther', 'Enter the hospital name']);
  if (!d.procedure) errs.push(['procedure', 'Procedure is required']);
  if (!d.category) errs.push(['category', 'Choose a category']);
  if (!d.role) errs.push(['role', 'Choose your role']);
  if (d.age !== '' && (!Number.isFinite(d.age) || d.age < 0 || d.age > 120)) errs.push(['age', 'Age 0–120']);
  if (d.duration !== '' && (!Number.isFinite(d.duration) || d.duration < 0)) errs.push(['duration', 'Invalid duration']);
  if (d.bloodLoss !== '' && (!Number.isFinite(d.bloodLoss) || d.bloodLoss < 0)) errs.push(['bloodLoss', 'Invalid blood loss']);
  let first = null;
  for (const [name, msg] of errs) {
    if (['duration', 'bloodLoss'].includes(name)) $('#moreDetails').open = true;
    const f = markError(name, msg);
    if (!first) first = f;
  }
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return errs.length === 0;
}

function syncConditionalFields() {
  form.elements.hospitalOther.hidden = getRadio('hospital') !== 'Other';
  const cd = getRadio('cd');
  form.elements.complication.hidden = !cd || cd === 'None';
}

function resetForm() {
  form.reset();
  clearErrors();
  form.elements.id.value = '';
  form.elements.date.value = isoDate();
  const lastHosp = prefGet('lastHospital', '');
  if (lastHosp) setRadio('hospital', lastHosp);
  form.elements.hospitalOther.value = prefGet('lastHospitalOther', '');
  const lastRole = prefGet('lastRole', '');
  if (lastRole) setRadio('role', lastRole);
  setRadio('cd', 'None');
  $('#moreDetails').open = false;
  $('#editBanner').hidden = true;
  $('#saveBtn').textContent = 'Save case';
  syncConditionalFields();
}

function loadIntoForm(c) {
  form.reset();
  clearErrors();
  form.elements.id.value = c.id;
  for (const f of FIELDS) {
    const el = form.elements[f];
    if (!el) continue;
    if (el.length && el[0] && el[0].type === 'radio') setRadio(f, c[f] || '');
    else el.value = c[f] ?? '';
  }
  const optional = ['asa', 'duration', 'bloodLoss', 'outcome', 'notes', 'complication'];
  $('#moreDetails').open = optional.some(k => c[k] !== '' && c[k] != null) || hasComplication(c);
  $('#editBanner').hidden = false;
  $('#saveBtn').textContent = 'Update case';
  syncConditionalFields();
  showView('add');
}

form.addEventListener('change', e => {
  const t = e.target;
  if (t.name === 'category' && t.value === 'Emergency') setRadio('setting', 'Emergency');
  if (t.type === 'radio') {
    const field = t.closest('.field');
    if (field && field.classList.contains('invalid')) { field.classList.remove('invalid'); $('.err', field)?.remove(); }
  }
  syncConditionalFields();
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const d = readForm();
  if (!validate(d)) { toast('Please fill the required fields', true); return; }
  const id = form.elements.id.value;
  const now = new Date().toISOString();
  const existing = id ? cases.find(c => c.id === id) : null;
  const record = { ...d, id: id || uid(), createdAt: existing ? existing.createdAt : now, updatedAt: now };
  try {
    await dbPut(record);
  } catch (err) {
    console.error(err);
    toast('Could not save: ' + (err && err.message || err), true);
    return;
  }
  prefSet('lastHospital', d.hospital);
  prefSet('lastHospitalOther', d.hospitalOther);
  prefSet('lastRole', d.role);
  await reload();
  toast(existing ? 'Case updated' : `Case saved (#${cases.length})`);
  resetForm();
  if (existing) showView('cases');
  else window.scrollTo({ top: 0, behavior: 'smooth' });
});

$('#resetBtn').addEventListener('click', resetForm);
$('#cancelEdit').addEventListener('click', () => { resetForm(); showView('cases'); });

function refreshDatalists() {
  const top = key => {
    const counts = new Map();
    cases.forEach(c => { const v = (c[key] || '').trim(); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([v]) => `<option value="${esc(v)}"></option>`).join('');
  };
  $('#dxList').innerHTML = top('diagnosis');
  $('#pxList').innerHTML = top('procedure');
}

/* ---------- Case list ---------- */
function caseCard(c) {
  const tags = [
    `<span class="tag role">${esc(c.role)}</span>`,
    `<span class="tag">${esc(c.category)}</span>`,
    c.approach && `<span class="tag">${esc(c.approach)}</span>`,
    c.setting && c.setting !== c.category && `<span class="tag">${esc(c.setting)}</span>`,
    `<span class="tag">${esc(hospitalName(c))}</span>`,
    ageSex(c) && `<span class="tag">${esc(ageSex(c))}</span>`,
    c.uhid && `<span class="tag">UHID ${esc(c.uhid)}</span>`,
    c.asa && `<span class="tag">ASA ${esc(c.asa)}</span>`,
    c.duration !== '' && c.duration != null && `<span class="tag">${esc(c.duration)} min</span>`,
    c.bloodLoss !== '' && c.bloodLoss != null && `<span class="tag">EBL ${esc(c.bloodLoss)} mL</span>`,
    hasComplication(c) && `<span class="tag cd">CD ${esc(c.cd)}</span>`,
    c.outcome && `<span class="tag">${esc(c.outcome)}</span>`,
  ].filter(Boolean).join('');
  const notes = [c.complication && `Complication: ${c.complication}`, c.notes].filter(Boolean).join('\n');
  return `<article class="case" data-id="${esc(c.id)}">
    <div class="case-top"><h3 class="case-proc">${esc(c.procedure)}</h3><span class="case-date">${esc(fmtDate(c.date))}</span></div>
    ${c.diagnosis ? `<p class="case-dx">${esc(c.diagnosis)}</p>` : '<div style="height:8px"></div>'}
    <div class="tags">${tags}</div>
    ${notes ? `<p class="case-notes">${esc(notes)}</p>` : ''}
    <div class="case-actions">
      <button type="button" class="btn ghost" data-act="edit">Edit</button>
      <button type="button" class="btn danger-ghost" data-act="delete">Delete</button>
    </div>
  </article>`;
}

let renderLimit = 100;
function renderList() {
  const list = applyFilters(cases);
  $('#resultCount').textContent = `${list.length} case${list.length === 1 ? '' : 's'}` + (filtersActive() ? ` (of ${cases.length})` : '');
  $('#filterDot').hidden = !(filters.from || filters.to || filters.category || filters.role || filters.hospital);
  $('#emptyState').hidden = cases.length > 0;
  const shown = list.slice(0, renderLimit);
  let html = shown.map(caseCard).join('');
  if (list.length > shown.length) html += `<button type="button" class="btn ghost block" id="showMore">Show more (${list.length - shown.length} remaining)</button>`;
  if (cases.length && !list.length) html = '<p class="empty">No cases match these filters.</p>';
  $('#caseList').innerHTML = html;
}

$('#caseList').addEventListener('click', async e => {
  if (e.target.id === 'showMore') { renderLimit += 100; renderList(); return; }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.case').dataset.id;
  const c = cases.find(x => x.id === id);
  if (!c) return;
  if (btn.dataset.act === 'edit') loadIntoForm(c);
  if (btn.dataset.act === 'delete') {
    const ok = await confirmDialog({
      title: 'Delete this case?',
      message: `${c.procedure} on ${fmtDate(c.date)} (${hospitalName(c)}). This cannot be undone.`,
    });
    if (!ok) return;
    await dbDelete(id);
    if (form.elements.id.value === id) resetForm();
    await reload();
    toast('Case deleted');
  }
});

/* ---------- Filters ---------- */
function fillSelect(sel, values) {
  sel.insertAdjacentHTML('beforeend', values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join(''));
}
fillSelect($('#fCategory'), CATEGORIES);
fillSelect($('#fRole'), ROLES);
fillSelect($('#fHospital'), HOSPITALS);

function syncFilterInputs() {
  $('#fFrom').value = filters.from;
  $('#fTo').value = filters.to;
  $('#fCategory').value = filters.category;
  $('#fRole').value = filters.role;
  $('#fHospital').value = filters.hospital;
  $('#search').value = filters.q;
  $$('.chip-btn[data-preset]').forEach(b => b.classList.remove('on'));
}
function onFiltersChanged() {
  renderLimit = 100;
  renderList();
  renderDashboard();
  updateExportScope();
}

let searchTimer;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filters.q = e.target.value; onFiltersChanged(); }, 120);
});
$('#filterToggle').addEventListener('click', e => {
  const panel = $('#filters');
  panel.hidden = !panel.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!panel.hidden));
});
[['#fFrom', 'from'], ['#fTo', 'to'], ['#fCategory', 'category'], ['#fRole', 'role'], ['#fHospital', 'hospital']].forEach(([sel, key]) => {
  $(sel).addEventListener('change', e => {
    filters[key] = e.target.value;
    if (key === 'from' || key === 'to') $$('.chip-btn[data-preset]').forEach(b => b.classList.remove('on'));
    onFiltersChanged();
  });
});
$$('.chip-btn[data-preset]').forEach(btn => btn.addEventListener('click', () => {
  const now = new Date();
  const p = btn.dataset.preset;
  if (p === 'month') { filters.from = isoDate(new Date(now.getFullYear(), now.getMonth(), 1)); filters.to = ''; }
  if (p === 'year') { filters.from = `${now.getFullYear()}-01-01`; filters.to = ''; }
  if (p === '12m') { filters.from = isoDate(new Date(now.getFullYear() - 1, now.getMonth(), now.getDate() + 1)); filters.to = ''; }
  if (p === 'all') { filters.from = ''; filters.to = ''; }
  syncFilterInputs();
  btn.classList.add('on');
  onFiltersChanged();
}));
function clearAllFilters() {
  Object.assign(filters, { q: '', from: '', to: '', category: '', role: '', hospital: '' });
  syncFilterInputs();
  onFiltersChanged();
}
$('#clearFilters').addEventListener('click', clearAllFilters);
$('#dashClear').addEventListener('click', clearAllFilters);

/* ---------- Dashboard ---------- */
function countBy(list, keyFn, order) {
  const m = new Map();
  (order || []).forEach(k => m.set(k, 0));
  list.forEach(c => { const k = keyFn(c) || 'Not recorded'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()];
}
function barList(el, entries, total, { hideZero = true } = {}) {
  const rows = entries.filter(([, n]) => !hideZero || n > 0);
  if (!rows.length) { el.innerHTML = '<p class="nodata">No data yet</p>'; return; }
  const max = Math.max(...rows.map(([, n]) => n), 1);
  el.innerHTML = rows.map(([k, n]) => `<div class="bar-row">
      <span class="bar-name" title="${esc(k)}">${esc(k)}</span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${(n / max) * 100}%"></span></span>
      <span class="bar-val">${n} · ${pct(n, total)}</span></div>`).join('');
}
function renderDashboard() {
  const list = applyFilters(cases);
  const total = list.length;
  $('#dashFilterNote').hidden = !filtersActive();
  $('#tTotal').textContent = total;
  $('#tPerformed').textContent = list.filter(c => c.role === 'Performed').length;
  $('#tComp').textContent = pct(list.filter(hasComplication).length, total);
  $('#tMajor').textContent = pct(list.filter(isMajor).length, total);

  // last 12 months
  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MONTHS[d.getMonth()], y: d.getFullYear(), n: 0 });
  }
  const idx = new Map(months.map((m, i) => [m.key, i]));
  list.forEach(c => { const i = idx.get((c.date || '').slice(0, 7)); if (i != null) months[i].n++; });
  const max = Math.max(...months.map(m => m.n), 1);
  $('#chartMonths').innerHTML = months.map(m => `<div class="col" title="${m.label} ${m.y}: ${m.n}">
      <span class="col-v">${m.n || ''}</span>
      <span class="col-bar" style="height:${(m.n / max) * 120}px"></span>
      <span class="col-l">${m.label}</span></div>`).join('');

  barList($('#chartCategory'), countBy(list, c => c.category, CATEGORIES), total);
  barList($('#chartRole'), countBy(list, c => c.role, ROLES), total);
  barList($('#chartApproach'), countBy(list, c => c.approach, APPROACHES), total);
  barList($('#chartHospital'), countBy(list, hospitalName, HOSPITALS.slice(0, 3)), total);
  barList($('#chartCD'), countBy(list, c => c.cd, CD_GRADES), total);
}

/* ---------- File output ---------- */
async function saveBlob(blob, filename) {
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (coarse && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportList() {
  return applyFilters(cases).slice().sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
}
function periodText(list) {
  if (filters.from || filters.to) return `${filters.from ? fmtDate(filters.from) : 'Start'} to ${filters.to ? fmtDate(filters.to) : fmtDate(isoDate())}`;
  if (!list.length) return '-';
  return `${fmtDate(list[0].date)} to ${fmtDate(list[list.length - 1].date)}`;
}
function updateExportScope() {
  const n = applyFilters(cases).length;
  $('#exportScope').textContent = filtersActive() ? `${n} filtered case${n === 1 ? '' : 's'}` : `all ${n} case${n === 1 ? '' : 's'}`;
}
function profile() {
  return prefGet('profile', { name: '', desig: '', reg: '', inst: '' });
}
function fileStamp() { return isoDate().replace(/-/g, ''); }

$('#exportXlsx').addEventListener('click', async () => {
  if (typeof XLSX === 'undefined') { toast('Excel library not loaded', true); return; }
  const list = exportList();
  if (!list.length) { toast('No cases to export', true); return; }
  const rows = list.map((c, i) => ({
    'Sl No': i + 1,
    'Date': c.date,
    'Hospital': hospitalName(c),
    'IP/UHID': c.uhid,
    'Age': c.age,
    'Sex': c.sex,
    'Diagnosis': c.diagnosis,
    'Procedure': c.procedure,
    'Category': c.category,
    'Approach': c.approach,
    'Elective/Emergency': c.setting,
    'Role': c.role,
    'ASA': c.asa,
    'Duration (min)': c.duration,
    'Blood loss (mL)': c.bloodLoss,
    'Clavien-Dindo': c.cd || 'None',
    'Complication details': c.complication,
    'Outcome': c.outcome,
    'Notes': c.notes,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [6, 11, 16, 14, 6, 5, 30, 32, 22, 13, 12, 11, 6, 9, 9, 10, 26, 12, 40].map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: ws['!ref'] };

  const p = profile();
  const total = list.length;
  const summary = [
    ['Surgical Case Log: summary'],
    ['Surgeon', p.name], ['Qualification', p.desig], ['Reg. no.', p.reg], ['Department', p.inst],
    ['Period', periodText(list)], ['Generated', fmtDate(isoDate())], [],
    ['Total cases', total],
    ['Complication rate (CD >= I)', pct(list.filter(hasComplication).length, total)],
    ['Major complications (CD >= III)', pct(list.filter(isMajor).length, total)], [],
    ['Category', ...ROLES, 'Total'],
    ...CATEGORIES.map(cat => {
      const sub = list.filter(c => c.category === cat);
      return [cat, ...ROLES.map(r => sub.filter(c => c.role === r).length), sub.length];
    }),
    ['Total', ...ROLES.map(r => list.filter(c => c.role === r).length), total], [],
    ['Approach', 'Cases'], ...APPROACHES.map(a => [a, list.filter(c => c.approach === a).length]), [],
    ['Hospital', 'Cases'], ...countBy(list, hospitalName),
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(summary);
  ws2['!cols'] = [{ wch: 32 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Cases');
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  await saveBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `surgical-case-log-${fileStamp()}.xlsx`);
  toast(`Exported ${total} cases to Excel`);
});

// jsPDF's built-in fonts are Latin-1 only; replace anything else.
const pdfText = s => String(s ?? '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');

$('#exportPdf').addEventListener('click', async () => {
  if (!window.jspdf) { toast('PDF library not loaded', true); return; }
  const list = exportList();
  if (!list.length) { toast('No cases to export', true); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const p = profile();
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 12;
  const teal = [11, 110, 116];

  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...teal);
  doc.text('SURGICAL CASE LOGBOOK', pageW / 2, 16, { align: 'center' });
  doc.setTextColor(20, 35, 46); doc.setFontSize(10);
  let y = 24;
  const meta = [
    ['Name', p.name || '____________________________'],
    ['Qualification / Designation', p.desig || '____________________________'],
    ['Medical Council Reg. No.', p.reg || '______________'],
    ['Department / Institution', p.inst || '____________________________'],
  ];
  const meta2 = [
    ['Period', periodText(list)],
    ['Total cases', String(list.length)],
    ['Generated on', fmtDate(isoDate())],
  ];
  meta.forEach(([k, v], i) => {
    doc.setFont('helvetica', 'bold'); doc.text(pdfText(k + ':'), M, y + i * 5.5);
    doc.setFont('helvetica', 'normal'); doc.text(pdfText(v), M + 52, y + i * 5.5);
  });
  meta2.forEach(([k, v], i) => {
    doc.setFont('helvetica', 'bold'); doc.text(pdfText(k + ':'), pageW / 2 + 30, y + i * 5.5);
    doc.setFont('helvetica', 'normal'); doc.text(pdfText(v), pageW / 2 + 58, y + i * 5.5);
  });
  y += meta.length * 5.5 + 2;

  const head = [['#', 'Date', 'Hospital', 'IP/UHID', 'Age/Sex', 'Diagnosis', 'Procedure', 'Category', 'Approach', 'E/Em', 'Role', 'ASA', 'CD', 'Outcome']];
  const body = list.map((c, i) => [
    i + 1, fmtDate(c.date), hospitalName(c), c.uhid, ageSex(c), c.diagnosis, c.procedure,
    c.category === 'Vascular/Varicose (EVLT)' ? 'Vascular/EVLT' : c.category,
    c.approach === 'Laparoscopic' ? 'Lap' : c.approach,
    c.setting === 'Emergency' ? 'Em' : (c.setting === 'Elective' ? 'E' : ''),
    c.role, c.asa, hasComplication(c) ? c.cd : '-', c.outcome,
  ].map(pdfText));

  doc.autoTable({
    head, body, startY: y, margin: { left: M, right: M, bottom: 16 },
    theme: 'grid',
    styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.4, overflow: 'linebreak', valign: 'top', lineColor: [200, 210, 216], lineWidth: 0.15 },
    headStyles: { fillColor: teal, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [244, 248, 249] },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' }, 1: { cellWidth: 18 }, 2: { cellWidth: 20 }, 3: { cellWidth: 20 },
      4: { cellWidth: 13 }, 5: { cellWidth: 44 }, 6: { cellWidth: 50 }, 7: { cellWidth: 22 },
      8: { cellWidth: 17 }, 9: { cellWidth: 10 }, 10: { cellWidth: 17 }, 11: { cellWidth: 9 },
      12: { cellWidth: 9 }, 13: { cellWidth: 'auto' },
    },
  });

  // Summary
  let sy = doc.lastAutoTable.finalY + 8;
  if (sy > pageH - 70) { doc.addPage(); sy = 18; }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...teal);
  doc.text('SUMMARY', M, sy);
  doc.setTextColor(20, 35, 46);
  const sumBody = CATEGORIES.map(cat => {
    const sub = list.filter(c => c.category === cat);
    return [cat, ...ROLES.map(r => sub.filter(c => c.role === r).length), sub.length];
  }).filter(r => r[r.length - 1] > 0);
  sumBody.push(['Total', ...ROLES.map(r => list.filter(c => c.role === r).length), list.length]);
  doc.autoTable({
    head: [['Category', ...ROLES, 'Total']], body: sumBody.map(r => r.map(pdfText)), startY: sy + 3,
    margin: { left: M }, tableWidth: 130, theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: teal, textColor: 255 },
    columnStyles: { 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'center' }, 4: { halign: 'center', fontStyle: 'bold' } },
    didParseCell: d => { if (d.section === 'body' && d.row.index === sumBody.length - 1) d.cell.styles.fontStyle = 'bold'; },
  });
  const total = list.length;
  doc.autoTable({
    head: [['Indicator', 'Value']],
    body: [
      ['Open / Lap / Robotic / Endovenous', APPROACHES.map(a => list.filter(c => c.approach === a).length).join(' / ')],
      ['Elective / Emergency', `${list.filter(c => c.setting === 'Elective').length} / ${list.filter(c => c.setting === 'Emergency').length}`],
      ['Complication rate (CD >= I)', pct(list.filter(hasComplication).length, total)],
      ['Major complications (CD >= III)', pct(list.filter(isMajor).length, total)],
      ['Mortality (CD V)', pct(list.filter(c => c.cd === 'V').length, total)],
    ].map(r => r.map(pdfText)),
    startY: sy + 3, margin: { left: M + 140 }, tableWidth: pageW - 2 * M - 140, theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 1.6 }, headStyles: { fillColor: teal, textColor: 255 },
  });

  // Certification
  let cy = doc.lastAutoTable.finalY + 10;
  if (cy > pageH - 40) { doc.addPage(); cy = 24; }
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
  doc.text(pdfText('Certified that the above cases were performed / assisted / supervised by the candidate as indicated.'), M, cy);
  cy += 22;
  doc.setDrawColor(120);
  doc.line(M, cy, M + 75, cy);
  doc.line(pageW - M - 95, cy, pageW - M, cy);
  doc.text('Signature of candidate', M, cy + 5);
  doc.text('Signature of Head of Department / Supervisor (with seal)', pageW - M - 95, cy + 5);
  doc.text('Date: ______________', M, cy + 11);

  // Footer with page numbers
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(pdfText(`Surgical Case Log - ${p.name || ''}`), M, pageH - 7);
    doc.text(`Page ${i} of ${pages}`, pageW - M, pageH - 7, { align: 'right' });
  }
  await saveBlob(doc.output('blob'), `surgical-logbook-${fileStamp()}.pdf`);
  toast(`PDF logbook: ${total} cases`);
});

/* ---------- Profile ---------- */
(function initProfile() {
  const p = profile();
  const map = { pName: 'name', pDesig: 'desig', pReg: 'reg', pInst: 'inst' };
  Object.entries(map).forEach(([id, key]) => {
    const el = $('#' + id);
    el.value = p[key] || '';
    el.addEventListener('input', () => { const cur = profile(); cur[key] = el.value.trim(); prefSet('profile', cur); });
  });
})();

/* ---------- Backup / restore ---------- */
function updateBackupInfo() {
  const last = prefGet('lastBackup', '');
  $('#backupInfo').textContent = last
    ? `Last backup: ${fmtDate(last.slice(0, 10))}. Data lives only on this device, so back up regularly.`
    : 'No backup yet. Data lives only on this device, so back up regularly.';
}
$('#backupBtn').addEventListener('click', async () => {
  const payload = { app: 'surgical-case-log', version: 1, exportedAt: new Date().toISOString(), profile: profile(), cases };
  await saveBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `surgical-case-log-backup-${fileStamp()}.json`);
  prefSet('lastBackup', new Date().toISOString());
  updateBackupInfo();
  toast(`Backup created (${cases.length} cases)`);
});

function sanitizeCase(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = {};
  for (const f of FIELDS) {
    let v = raw[f];
    if (NUMERIC.includes(f)) { v = (v === '' || v == null || !Number.isFinite(Number(v))) ? '' : Number(v); }
    else v = v == null ? '' : String(v).slice(0, 2000);
    c[f] = v;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || !c.procedure) return null;
  c.id = raw.id ? String(raw.id) : uid();
  c.createdAt = raw.createdAt ? String(raw.createdAt) : new Date().toISOString();
  c.updatedAt = raw.updatedAt ? String(raw.updatedAt) : c.createdAt;
  return c;
}

$('#restoreFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Not a valid JSON file', true); return; }
  const rawList = Array.isArray(data) ? data : data && Array.isArray(data.cases) ? data.cases : null;
  if (!rawList) { toast('This file is not a Surgical Case Log backup', true); return; }
  const incoming = rawList.map(sanitizeCase).filter(Boolean);
  const skipped = rawList.length - incoming.length;
  if (!incoming.length) { toast('No valid cases found in backup', true); return; }

  const dlg = $('#restoreDlg');
  $('#restoreMsg').textContent = `Backup contains ${incoming.length} case${incoming.length === 1 ? '' : 's'}` +
    (skipped ? ` (${skipped} invalid entries skipped)` : '') + `. You currently have ${cases.length}.`;
  dlg.returnValue = '';
  dlg.showModal();
  const choice = await new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
  if (choice === 'merge') {
    const byId = new Map(cases.map(c => [c.id, c]));
    const toWrite = incoming.filter(c => { const ex = byId.get(c.id); return !ex || (c.updatedAt || '') > (ex.updatedAt || ''); });
    await dbPutMany(toWrite);
    await reload();
    toast(`Merged: ${toWrite.length} added/updated, ${incoming.length - toWrite.length} already present`);
  } else if (choice === 'replace') {
    const ok = await confirmDialog({ title: 'Replace all cases?', message: `This deletes your current ${cases.length} cases and loads ${incoming.length} from the backup.`, ok: 'Replace' });
    if (!ok) return;
    await dbClear();
    await dbPutMany(incoming);
    await reload();
    toast(`Restored ${incoming.length} cases`);
  } else {
    return;
  }
  if (data.profile && typeof data.profile === 'object' && !profile().name) {
    const p = { name: '', desig: '', reg: '', inst: '' };
    Object.keys(p).forEach(k => { p[k] = String(data.profile[k] || '').slice(0, 120); });
    prefSet('profile', p);
    $('#pName').value = p.name; $('#pDesig').value = p.desig; $('#pReg').value = p.reg; $('#pInst').value = p.inst;
  }
});

$('#wipeBtn').addEventListener('click', async () => {
  if (!cases.length) { toast('No cases to delete'); return; }
  const ok = await confirmDialog({ title: `Delete all ${cases.length} cases?`, message: 'Download a backup first. This permanently removes every case from this device.', ok: 'Delete all' });
  if (!ok) return;
  await dbClear();
  resetForm();
  await reload();
  toast('All cases deleted');
});

/* ---------- Init ---------- */
$$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) showView(g.dataset.goto); });

(async function init() {
  resetForm();
  updateBackupInfo();
  try {
    await reload();
  } catch (err) {
    console.error(err);
    toast('Storage unavailable: ' + (err && err.message || err), true);
  }
  if (navigator.storage && navigator.storage.persist) {
    try {
      const persisted = await navigator.storage.persist();
      $('#storageInfo').textContent = persisted ? 'Storage: persistent (protected from automatic clean-up).' : 'Storage: best-effort. Keep regular backups.';
    } catch { /* ignore */ }
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
  }
})();
