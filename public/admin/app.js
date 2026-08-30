// ============================================================
// IT Helpdesk admin panelis v2 -- universāls, moduļu (kategoriju) vadīts.
// Owner/Admin paši veido visu struktūru no nulles: pamatkategorijas kļūst
// par cilnēm, apakškategorijas -- par ligzdotām "mapēm" ar bezgalīgu
// dziļumu, katrai ar pašas laukiem, ierakstiem, vēsturi un CSV importu/eksportu.
// ============================================================

const API = '';
const TICKET_STATUS_LV = { new: 'Jauns', in_progress: 'Darbā', waiting: 'Gaida', resolved: 'Atrisināts', closed: 'Slēgts' };
const STATUS_COLORS = { new: '#0f6cbd', in_progress: '#e8a33d', waiting: '#888', resolved: '#2e9e4c', closed: '#555' };
const PRIORITY_LABELS_LV = { low: 'Zema', medium: 'Vidēja', high: 'Augsta', critical: 'Kritiska' };
const PRIORITY_COLORS = { low: '#888', medium: '#e8a33d', high: '#e0641f', critical: 'var(--red)' };
const ROLE_LABELS_LV = { owner: 'Owner', admin: 'Admin', user: 'User' };
const ROLE_COLORS = { owner: '#6b21a8', admin: '#0f6cbd', user: '#888' };

let state = {
  token: localStorage.getItem('admin_token') || null,
  user: null,
  tab: 'tickets',
  modulesTree: [],
  currentModuleId: null,
};

// ---------- API palīgfunkcija ----------
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Kļūda (' + res.status + ')'));
  return data;
}

function esc(s) { return (s ?? '').toString().replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString('lv-LV') : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString('lv-LV') : '—'; }
function closeModal() { document.getElementById('overlay').classList.remove('open'); }
function openModal(html) { document.getElementById('modalContent').innerHTML = html; document.getElementById('overlay').classList.add('open'); }

// ---------- Pieteikšanās ----------
// btoa() atbalsta tikai Latin1 diapazonu -- latviešu burti (ā,č,ē,ī,ņ,š,ū,ž utt.)
// to salauž. Tāpēc UTF-8 tekstu vispirms pārvēršam par baitiem ar
// encodeURIComponent/unescape trikiu, un tikai tad kodējam base64.
function buildDevToken(identifier, displayName) {
  const payload = JSON.stringify({ identifier, displayName });
  return btoa(unescape(encodeURIComponent(payload)));
}

async function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!identifier) { errEl.textContent = 'Ievadiet e-pastu vai telefona numuru.'; return; }
  state.token = buildDevToken(identifier, name);
  try {
    const { user } = await api('/api/users/me');
    localStorage.setItem('admin_token', state.token);
    state.user = user;
    await boot();
  } catch (e) {
    errEl.textContent = e.message;
    state.token = null;
  }
}

function logout() {
  localStorage.removeItem('admin_token');
  state.token = null; state.user = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('loginScreen').style.display = 'block';
}

// ---------- Sākotnējā ielāde ----------
async function boot() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('whoAmI').innerHTML =
    esc(state.user.display_name) + ' <span class="role-badge" style="background:' + ROLE_COLORS[state.user.role] + '">' + ROLE_LABELS_LV[state.user.role] + '</span>';
  await loadModulesTree();
  renderNav();
  renderTab();
}

async function loadModulesTree() {
  const { modules } = await api('/api/modules');
  state.modulesTree = modules;
}

function isOwnerOrAdmin() { return state.user.role === 'owner' || state.user.role === 'admin'; }

// ---------- Navigācija ----------
function renderNav() {
  const roots = state.modulesTree.filter((m) => !m.parent_id && m.system_key !== 'users').sort((a, b) => a.sort_order - b.sort_order);
  const nav = document.getElementById('mainNav');
  const fixedTabs = [['tickets', 'Ticketi']];
  if (isOwnerOrAdmin()) {
    fixedTabs.push(['users', 'Lietotāji'], ['access_requests', 'Piekļuves pieprasījumi']);
  }
  let html = fixedTabs.map(([key, label]) => `<button class="${state.tab === key ? 'active' : ''}" onclick="switchFixedTab('${key}')">${label}</button>`).join('');
  html += roots.map((m) => `<button class="${state.tab === m.id ? 'active' : ''}" onclick="switchModuleTab('${m.id}')">${m.icon ? m.icon + ' ' : ''}${esc(m.name)}</button>`).join('');
  if (isOwnerOrAdmin()) {
    html += `<button onclick="addRootModule()" title="Pievienot jaunu pamatkategoriju (cilni)">+ Jauna kategorija</button>`;
  }
  nav.innerHTML = html;
}

function switchFixedTab(key) { state.tab = key; renderNav(); renderTab(); }
function switchModuleTab(moduleId) { state.tab = moduleId; state.currentModuleId = moduleId; renderNav(); renderTab(); }

async function addRootModule() {
  const name = prompt('Jaunās pamatkategorijas (cilnes) nosaukums:');
  if (!name || !name.trim()) return;
  try {
    const { module } = await api('/api/modules', { method: 'POST', body: { name: name.trim() } });
    await loadModulesTree();
    switchModuleTab(module.id);
  } catch (e) { alert(e.message); }
}

function renderTab() {
  if (state.tab === 'tickets') return renderTicketsTab();
  if (state.tab === 'users') return renderUsersTab();
  if (state.tab === 'access_requests') return renderAccessRequestsTab();
  return renderModuleView(state.currentModuleId);
}

// ============================================================
// GLOBĀLĀ MEKLĒŠANA
// ============================================================
let globalSearchTimer = null;
function handleGlobalSearch() {
  clearTimeout(globalSearchTimer);
  const q = document.getElementById('globalSearchInput').value.trim();
  const resultsEl = document.getElementById('globalSearchResults');
  if (q.length < 2) { resultsEl.style.display = 'none'; return; }
  globalSearchTimer = setTimeout(async () => {
    try {
      const { results } = await api('/api/modules/search/global?q=' + encodeURIComponent(q));
      resultsEl.innerHTML = results.length
        ? results.map((r) => `<div class="gs-item" onclick="jumpToRecord('${r.module_id}','${r.id}')"><div>${esc(r.name)}</div><div class="gs-module">${esc(r.module_name)}</div></div>`).join('')
        : '<div class="gs-item muted">Nav rezultātu</div>';
      resultsEl.style.display = 'block';
    } catch (e) { /* klusē */ }
  }, 250);
}
async function jumpToRecord(moduleId, recordId) {
  document.getElementById('globalSearchResults').style.display = 'none';
  document.getElementById('globalSearchInput').value = '';
  // Atrod moduli tā, lai state.tab norādītu uz pareizo SAKNES cilni
  let m = state.modulesTree.find((x) => x.id === moduleId);
  let rootId = moduleId;
  while (m && m.parent_id) { rootId = m.parent_id; m = state.modulesTree.find((x) => x.id === m.parent_id); }
  state.tab = rootId; state.currentModuleId = moduleId;
  renderNav();
  await renderModuleView(moduleId);
  openRecordDetail(recordId, moduleId);
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('#globalSearchResults') && e.target.id !== 'globalSearchInput') {
    document.getElementById('globalSearchResults').style.display = 'none';
  }
});

// ============================================================
// MODUĻA SKATS (kategorijas/apakškategorijas -- bezgalīgi ligzdojams)
// ============================================================
let currentModuleFields = [];
let currentModuleRecords = [];

async function renderModuleView(moduleId) {
  const main = document.getElementById('mainContent');
  const module = state.modulesTree.find((m) => m.id === moduleId);
  if (!module) { main.innerHTML = '<p class="empty">Modulis nav atrasts</p>'; return; }

  const children = state.modulesTree.filter((m) => m.parent_id === moduleId).sort((a, b) => a.sort_order - b.sort_order);
  currentModuleFields = (await api('/api/modules/' + moduleId + '/fields')).fields;

  main.innerHTML = `
    <div class="breadcrumb">${renderBreadcrumb(moduleId)}</div>

    <div class="folder-grid">
      ${children.map((c) => `
        <div class="folder-card" onclick="switchModuleTab('${c.id}')">
          <div class="folder-actions">
            <button onclick="event.stopPropagation(); renameModulePrompt('${c.id}')">✎</button>
            <button onclick="event.stopPropagation(); deleteModulePrompt('${c.id}')">🗑</button>
          </div>
          <div class="folder-icon">${c.icon || '📁'}</div>
          <div class="folder-name">${esc(c.name)}</div>
        </div>`).join('')}
      ${isOwnerOrAdmin() ? `<div class="folder-card add-new" onclick="addSubModule('${moduleId}')">
          <div class="folder-icon">+</div><div class="folder-name">Jauna apakškategorija</div>
        </div>` : ''}
    </div>

    <hr class="section-divider" />

    <div class="toolbar">
      <input type="text" id="recordSearch" placeholder="Meklēt šajā kategorijā..." oninput="loadModuleRecords('${moduleId}')" />
      <div>
        ${isOwnerOrAdmin() ? `
          <button class="btn btn-outline" onclick="openFieldsModal('${moduleId}')">🗂 Lauki</button>
          <button class="btn btn-outline" onclick="window.open('/api/modules/${moduleId}/export','_blank')">⬇ Eksportēt CSV</button>
          <button class="btn btn-outline" onclick="openImportModal('${moduleId}')">⬆ Importēt CSV</button>
          <button class="btn btn-green" onclick="openRecordForm('${moduleId}')">+ Pievienot ierakstu</button>
        ` : ''}
      </div>
    </div>
    <table id="recordsTable"><thead><tr id="recordsTableHead"></tr></thead><tbody></tbody></table>`;

  await loadModuleRecords(moduleId);
}

function renderBreadcrumb(moduleId) {
  const chain = [];
  let m = state.modulesTree.find((x) => x.id === moduleId);
  while (m) { chain.unshift(m); m = state.modulesTree.find((x) => x.id === m.parent_id); }
  return chain.map((c, i) => `${i > 0 ? '<span class="sep">/</span>' : ''}<a onclick="switchModuleTabInline('${c.id}')">${esc(c.name)}</a>`).join('');
}
function switchModuleTabInline(moduleId) { state.currentModuleId = moduleId; renderModuleView(moduleId); }

async function addSubModule(parentId) {
  const name = prompt('Jaunās apakškategorijas nosaukums:');
  if (!name || !name.trim()) return;
  try {
    await api('/api/modules', { method: 'POST', body: { name: name.trim(), parentId } });
    await loadModulesTree();
    await renderModuleView(parentId);
  } catch (e) { alert(e.message); }
}
async function renameModulePrompt(moduleId) {
  const m = state.modulesTree.find((x) => x.id === moduleId);
  const name = prompt('Jaunais nosaukums:', m.name);
  if (!name || !name.trim()) return;
  try {
    await api('/api/modules/' + moduleId, { method: 'PATCH', body: { name: name.trim() } });
    await loadModulesTree(); renderNav();
    await renderModuleView(state.currentModuleId);
  } catch (e) { alert(e.message); }
}
async function deleteModulePrompt(moduleId) {
  if (!confirm('Dzēst šo kategoriju? Tiks dzēstas arī VISAS tās apakškategorijas un ieraksti tajās.')) return;
  try {
    await api('/api/modules/' + moduleId, { method: 'DELETE' });
    await loadModulesTree(); renderNav();
    await renderModuleView(state.currentModuleId);
  } catch (e) { alert(e.message); }
}

async function loadModuleRecords(moduleId) {
  const search = document.getElementById('recordSearch')?.value || '';
  const { records } = await api('/api/modules/' + moduleId + '/records' + (search ? '?search=' + encodeURIComponent(search) : ''));
  currentModuleRecords = records;

  document.getElementById('recordsTableHead').innerHTML =
    `<th>Nosaukums</th>` + currentModuleFields.map((f) => `<th>${esc(f.label)}</th>`).join('') + `<th></th>`;

  const tbody = document.querySelector('#recordsTable tbody');
  tbody.innerHTML = records.length ? records.map((r) => `
    <tr class="clickable" onclick="openRecordDetail('${r.id}', '${moduleId}')">
      <td>${esc(r.name)}</td>
      ${currentModuleFields.map((f) => {
        const val = (r.data || {})[f.field_key];
        const display = f.field_type === 'boolean' ? (val ? '✓' : '—') : (val ?? '—');
        return `<td>${esc(display)}</td>`;
      }).join('')}
      <td>${isOwnerOrAdmin() ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openRecordForm('${moduleId}','${r.id}')">Rediģēt</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="${2 + currentModuleFields.length}" class="empty">Nav ierakstu</td></tr>`;
}

function openRecordForm(moduleId, recordId) {
  const record = recordId ? currentModuleRecords.find((r) => r.id === recordId) : null;
  openModal(`
    <h2>${record ? 'Rediģēt ierakstu' : 'Jauns ieraksts'}</h2>
    <label>Nosaukums *</label><input id="f_recordName" value="${record ? esc(record.name) : ''}" />
    ${currentModuleFields.map((f) => {
      const val = record ? (record.data || {})[f.field_key] : undefined;
      const id = 'f_field_' + f.field_key;
      if (f.field_type === 'boolean') {
        return `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:8px">
          <input type="checkbox" id="${id}" style="width:auto" ${val ? 'checked' : ''} /> ${esc(f.label)}</label>`;
      }
      if (f.field_type === 'select') {
        return `<label>${esc(f.label)}${f.is_required ? ' *' : ''}</label>
          <select id="${id}"><option value="">— nav izvēlēts —</option>
          ${(f.options || []).map((o) => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          </select>`;
      }
      const inputType = f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text';
      return `<label>${esc(f.label)}${f.is_required ? ' *' : ''}</label>
        <input type="${inputType}" id="${id}" value="${val !== undefined && val !== null ? esc(val) : ''}" />`;
    }).join('')}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveRecord('${moduleId}', ${recordId ? `'${recordId}'` : 'null'})">Saglabāt</button>
    </div>`);
}

async function saveRecord(moduleId, recordId) {
  const name = document.getElementById('f_recordName').value.trim();
  if (!name) { alert('Nosaukums ir obligāts'); return; }
  const data = {};
  currentModuleFields.forEach((f) => {
    const el = document.getElementById('f_field_' + f.field_key);
    if (!el) return;
    data[f.field_key] = f.field_type === 'boolean' ? el.checked : el.value;
  });
  try {
    if (recordId) await api('/api/modules/records/' + recordId, { method: 'PATCH', body: { name, data } });
    else await api('/api/modules/' + moduleId + '/records', { method: 'POST', body: { name, data } });
    closeModal();
    await loadModuleRecords(moduleId);
  } catch (e) { alert(e.message); }
}

async function openRecordDetail(recordId, moduleId) {
  const { record, history, tickets } = await api('/api/modules/records/' + recordId);
  openModal(`
    <h2>${esc(record.name)}</h2>
    ${currentModuleFields.map((f) => {
      const val = (record.data || {})[f.field_key];
      if (val === undefined || val === null || val === '') return '';
      return `<p class="muted">${esc(f.label)}: ${f.field_type === 'boolean' ? (val ? 'Jā' : 'Nē') : esc(val)}</p>`;
    }).join('')}

    <div class="section-title">Saistītie ticketi</div>
    ${tickets.length ? tickets.map((t) => `<div class="history-item">${esc(t.ticket_number)} — ${esc(t.title)} <span class="badge" style="background:#888">${TICKET_STATUS_LV[t.status]}</span></div>`).join('') : '<p class="muted">Nav ticketu</p>'}

    <div class="section-title">Vēsture</div>
    ${history.length ? history.map((h) => `<div class="history-item">${fmtDateTime(h.changed_at)} — <b>${esc(h.action)}</b>${h.field_name ? ': ' + esc(h.field_name) + ' "' + esc(h.old_value) + '" → "' + esc(h.new_value) + '"' : ''}${h.notes ? ' (' + esc(h.notes) + ')' : ''}${h.changed_by_name ? '<br><span class="muted">Veica: ' + esc(h.changed_by_name) + '</span>' : ''}</div>`).join('') : '<p class="muted">Nav ierakstu</p>'}

    <div class="modal-actions">
      <button class="btn btn-outline" onclick="window.open('/api/modules/records/${recordId}/history/export','_blank')">⬇ Eksportēt vēsturi</button>
      ${isOwnerOrAdmin() ? `<button class="btn btn-red" onclick="deleteRecord('${moduleId}','${recordId}')">Dzēst</button>` : ''}
      <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
    </div>`);
}

async function deleteRecord(moduleId, recordId) {
  if (!confirm('Dzēst šo ierakstu?')) return;
  try {
    await api('/api/modules/records/' + recordId, { method: 'DELETE' });
    closeModal();
    await loadModuleRecords(moduleId);
  } catch (e) { alert(e.message); }
}

// ---------- Lauku pārvaldība (pielāgotās kolonnas katram modulim) ----------
async function openFieldsModal(moduleId) {
  const { fields } = await api('/api/modules/' + moduleId + '/fields');
  const typeLabels = { text: 'Teksts', number: 'Skaitlis', boolean: 'Jā/Nē', date: 'Datums', select: 'Izvēlne' };
  openModal(`
    <h2>Lauki (kolonnas)</h2>
    <div id="fieldsList">
      ${fields.length ? fields.map((f) => `<div class="history-item" style="display:flex; justify-content:space-between; align-items:center;">
        <div>${esc(f.label)} <span class="muted">(${typeLabels[f.field_type]})</span></div>
        <button class="btn btn-sm btn-red" onclick="deleteField('${f.id}','${moduleId}')">Dzēst</button>
      </div>`).join('') : '<p class="muted">Vēl nav pielāgotu lauku</p>'}
    </div>
    <hr class="section-divider" />
    <label>Jauna lauka kods (a-z, cipari, _) *</label><input id="f_newFieldKey" placeholder="piem. serijas_numurs" />
    <label>Redzamais nosaukums *</label><input id="f_newFieldLabel" />
    <label>Tips *</label>
    <select id="f_newFieldType" onchange="document.getElementById('newFieldOptionsRow').style.display = this.value === 'select' ? 'block' : 'none'">
      <option value="text">Teksts</option><option value="number">Skaitlis</option>
      <option value="boolean">Jā/Nē</option><option value="date">Datums</option>
      <option value="select">Izvēlne</option>
    </select>
    <div id="newFieldOptionsRow" style="display:none">
      <label>Izvēles vērtības (katru jaunā rindā)</label>
      <textarea id="f_newFieldOptions" rows="3"></textarea>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
      <button class="btn btn-primary" onclick="addField('${moduleId}')">+ Pievienot lauku</button>
    </div>`);
}

async function addField(moduleId) {
  const fieldKey = document.getElementById('f_newFieldKey').value.trim();
  const label = document.getElementById('f_newFieldLabel').value.trim();
  const fieldType = document.getElementById('f_newFieldType').value;
  if (!fieldKey || !label) { alert('Kods un nosaukums ir obligāti'); return; }
  const options = fieldType === 'select' ? document.getElementById('f_newFieldOptions').value.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  try {
    await api('/api/modules/' + moduleId + '/fields', { method: 'POST', body: { fieldKey, label, fieldType, options } });
    await openFieldsModal(moduleId);
    currentModuleFields = (await api('/api/modules/' + moduleId + '/fields')).fields;
  } catch (e) { alert(e.message); }
}
async function deleteField(fieldId, moduleId) {
  if (!confirm('Dzēst šo lauku? Jau ievadītie dati paliks, bet vairs nebūs redzami.')) return;
  try {
    await api('/api/modules/fields/' + fieldId, { method: 'DELETE' });
    await openFieldsModal(moduleId);
  } catch (e) { alert(e.message); }
}

// ---------- CSV imports ----------
let importState = { moduleId: null, csvRows: [], csvHeaders: [] };

function openImportModal(moduleId) {
  importState = { moduleId, csvRows: [], csvHeaders: [] };
  openModal(`
    <h2>Importēt no CSV</h2>
    <p class="muted">Eksportējiet sarakstu no jūsu avota sistēmas (piem. Monday.com) kā CSV, tad augšupielādējiet failu.</p>
    <input type="file" id="csvFile" accept=".csv" onchange="handleCsvFile(event)" />
    <div id="importMappingArea"></div>
    <div class="modal-actions"><button class="btn btn-outline" onclick="closeModal()">Aizvērt</button></div>`);
}

function handleCsvFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true, skipEmptyLines: true,
    complete: (results) => { importState.csvRows = results.data; importState.csvHeaders = results.meta.fields || []; renderImportMapping(); },
    error: (err) => alert('Neizdevās nolasīt CSV: ' + err.message),
  });
}

async function renderImportMapping() {
  const { fields } = await api('/api/modules/' + importState.moduleId + '/fields');
  importState.fields = fields;
  const headers = importState.csvHeaders;
  const area = document.getElementById('importMappingArea');
  area.innerHTML = `
    <p class="muted">${importState.csvRows.length} rindas atrastas. Sasaistiet CSV kolonnas:</p>
    <div class="map-row"><label>Nosaukums *</label><select id="map_name"><option value="">— neizmantot —</option>${headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('')}</select></div>
    ${fields.map((f) => `<div class="map-row"><label>${esc(f.label)}</label><select id="map_field_${f.field_key}"><option value="">— neizmantot —</option>${headers.map((h) => `<option value="${esc(h)}">${esc(h)}</option>`).join('')}</select></div>`).join('')}
    <button class="btn btn-primary" onclick="runImport()">Importēt ${importState.csvRows.length} rindas</button>
    <div id="importResult"></div>`;
}

async function runImport() {
  const nameCol = document.getElementById('map_name').value;
  const fieldMap = {};
  importState.fields.forEach((f) => { fieldMap[f.field_key] = document.getElementById('map_field_' + f.field_key).value; });

  const rows = importState.csvRows.map((row) => {
    const data = {};
    importState.fields.forEach((f) => { if (fieldMap[f.field_key]) data[f.field_key] = row[fieldMap[f.field_key]]; });
    return { name: nameCol ? row[nameCol] : '', data };
  });

  try {
    const result = await api('/api/modules/' + importState.moduleId + '/import', { method: 'POST', body: { rows } });
    document.getElementById('importResult').innerHTML = `<div class="result-box">✅ Pievienots: ${result.inserted} &nbsp; 🔄 Atjaunināts: ${result.updated} &nbsp; ⚠️ Kļūdas: ${result.errors.length}
      ${result.errors.length ? '<br>' + result.errors.map((e) => `Rinda ${e.row}: ${esc(e.error)}`).join('<br>') : ''}</div>`;
    await loadModuleRecords(importState.moduleId);
  } catch (e) { alert(e.message); }
}

// ============================================================
// TICKETI
// ============================================================
let ticketsCache = [];

async function renderTicketsTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <select id="ticketStatusFilter" onchange="loadTickets()">
        <option value="">Visi statusi</option>
        ${Object.entries(TICKET_STATUS_LV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
      </select>
      <div></div>
    </div>
    <table id="ticketsTable"><thead><tr><th>Nr</th><th>Nosaukums</th><th>Kategorija</th><th>Prioritāte</th><th>Statuss</th><th>Pieteica</th><th>Datums</th></tr></thead><tbody></tbody></table>`;
  await loadTickets();
  clearInterval(window.__ticketsPoll);
  window.__ticketsPoll = setInterval(() => { if (state.tab === 'tickets') loadTickets(); }, 10000);
}

async function loadTickets() {
  const status = document.getElementById('ticketStatusFilter')?.value;
  const params = new URLSearchParams({ pageSize: '100' });
  if (status) params.set('status', status);
  const { tickets } = await api('/api/tickets?' + params.toString());
  ticketsCache = tickets;
  const tbody = document.querySelector('#ticketsTable tbody');
  tbody.innerHTML = tickets.length ? tickets.map((t) => `
    <tr class="clickable" onclick="openTicketDetail('${t.id}')">
      <td>${esc(t.ticket_number)}</td>
      <td>${esc(t.title)}${t.attachment_count > 0 ? ` <span class="muted">${t.has_image ? '🖼️' : ''}${t.has_video ? '🎥' : ''}${t.has_audio ? '🎙️' : ''}</span>` : ''}</td>
      <td>${esc(t.module_name) || '—'}</td>
      <td><span class="badge" style="background:${PRIORITY_COLORS[t.priority]}">${PRIORITY_LABELS_LV[t.priority]}</span></td>
      <td><span class="badge" style="background:${STATUS_COLORS[t.status]}">${TICKET_STATUS_LV[t.status]}</span></td>
      <td>${esc(t.reporter_name)}</td>
      <td>${fmtDateTime(t.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">Nav ticketu</td></tr>`;
}

async function openTicketDetail(id) {
  const { ticket, comments, attachments } = await api('/api/tickets/' + id);
  openModal(`
    <h2>${esc(ticket.ticket_number)} — ${esc(ticket.title)}</h2>
    <p class="muted">${esc(ticket.module_name) || ''} · Pieteica: ${esc(ticket.reporter_name)} (${esc(ticket.reporter_email)}) · ${fmtDateTime(ticket.created_at)}</p>
    ${ticket.record_name ? `<p class="muted">Ieraksts: ${esc(ticket.record_name)}</p>` : ''}
    ${ticket.description ? `<p>${esc(ticket.description)}</p>` : ''}

    <div class="section-title">Statuss</div>
    <div class="tabs-inline">
      ${Object.entries(TICKET_STATUS_LV).map(([k, v]) => `<button class="${ticket.status === k ? 'active' : ''}" onclick="changeTicketStatus('${id}','${k}')">${v}</button>`).join('')}
    </div>

    <div class="section-title">Pielikumi</div>
    ${attachments.length ? `<div class="attachments-grid">${attachments.map((a) => {
      const isImage = (a.mime_type || '').startsWith('image/');
      const isVideo = (a.mime_type || '').startsWith('video/');
      const icon = isImage ? '' : isVideo ? '🎥' : '🎙️';
      return isImage
        ? `<a href="${esc(a.file_url)}" target="_blank"><img src="${esc(a.file_url)}" class="attachment-thumb" /></a>`
        : `<a href="${esc(a.file_url)}" target="_blank" class="attachment-icon-link"><span class="attachment-icon">${icon}</span><span>${esc(a.file_name || 'fails')}</span></a>`;
    }).join('')}</div>` : '<p class="muted">Nav pielikumu</p>'}

    <div class="section-title">Komentāri</div>
    <div id="ticketComments">
      ${comments.length ? comments.map((c) => `<div class="history-item"><b>${esc(c.author_name)}</b>${c.is_internal ? ' <span class="badge" style="background:#888">iekšējs</span>' : ''} — ${fmtDateTime(c.created_at)}<br>${esc(c.body)}</div>`).join('') : '<p class="muted">Nav komentāru</p>'}
    </div>
    <textarea id="newCommentBody" rows="2" placeholder="Pievienot komentāru..."></textarea>
    <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:6px">
      <input type="checkbox" id="newCommentInternal" style="width:auto" /> Iekšējs komentārs (neredz pieteicējs)
    </label>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
      <button class="btn btn-primary" onclick="submitTicketComment('${id}')">Nosūtīt komentāru</button>
    </div>`);
}

async function changeTicketStatus(id, status) {
  try { await api('/api/tickets/' + id + '/status', { method: 'PATCH', body: { status } }); openTicketDetail(id); loadTickets(); }
  catch (e) { alert(e.message); }
}
async function submitTicketComment(id) {
  const body = document.getElementById('newCommentBody').value.trim();
  const isInternal = document.getElementById('newCommentInternal').checked;
  if (!body) return;
  try { await api('/api/tickets/' + id + '/comments', { method: 'POST', body: { body, isInternal } }); openTicketDetail(id); }
  catch (e) { alert(e.message); }
}

// ============================================================
// LIETOTĀJI
// ============================================================
let usersCache = [];
let usersModuleId = null;
let usersFields = [];

async function renderUsersTab() {
  const { moduleId } = await api('/api/users/fields-module');
  usersModuleId = moduleId;
  usersFields = (await api('/api/modules/' + moduleId + '/fields')).fields;

  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <input type="text" id="userSearch" placeholder="Meklēt darbinieku..." oninput="loadUsers()" />
      <div>
        <button class="btn btn-outline" onclick="openFieldsModal(usersModuleId)">🗂 Lauki</button>
        <button class="btn btn-outline" onclick="window.open('/api/users/export','_blank')">⬇ Eksportēt CSV</button>
        <button class="btn btn-green" onclick="openUserForm()">+ Pievienot lietotāju</button>
      </div>
    </div>
    <table id="usersTable"><thead><tr id="usersTableHead"></tr></thead><tbody></tbody></table>`;
  await loadUsers();
}

async function loadUsers() {
  const search = document.getElementById('userSearch')?.value || '';
  const { users } = await api('/api/users' + (search ? '?search=' + encodeURIComponent(search) : ''));
  usersCache = users;

  document.getElementById('usersTableHead').innerHTML =
    `<th>Vārds</th><th>E-pasts</th><th>Telefons</th><th>Loma</th><th>Statuss</th>` +
    usersFields.map((f) => `<th>${esc(f.label)}</th>`).join('') + `<th></th>`;

  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = users.length ? users.map((u) => `
    <tr class="clickable" onclick="openUserDetail('${u.id}')">
      <td>${esc(u.display_name)}</td><td>${esc(u.email) || '—'}</td><td>${esc(u.phone) || '—'}</td>
      <td><span class="role-badge" style="background:${ROLE_COLORS[u.role]}">${ROLE_LABELS_LV[u.role]}</span></td>
      <td>${u.is_blocked ? '<span class="badge" style="background:var(--red)">Bloķēts</span>' : '<span class="badge" style="background:var(--green)">Aktīvs</span>'}</td>
      ${usersFields.map((f) => {
        const val = (u.data || {})[f.field_key];
        const display = f.field_type === 'boolean' ? (val ? '✓' : '—') : (val ?? '—');
        return `<td>${esc(display)}</td>`;
      }).join('')}
      <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openUserForm('${u.id}')">Rediģēt</button></td>
    </tr>`).join('') : `<tr><td colspan="${6 + usersFields.length}" class="empty">Nav rezultātu</td></tr>`;
}

function openUserForm(userId) {
  const user = userId ? usersCache.find((u) => u.id === userId) : null;
  const canEditRole = state.user.role === 'owner';
  openModal(`
    <h2>${user ? 'Rediģēt lietotāju' : 'Jauns lietotājs'}</h2>
    <label>Vārds Uzvārds *</label><input id="f_userName" value="${user ? esc(user.display_name) : ''}" />
    ${!user ? `
      <label>E-pasts</label><input id="f_userEmail" placeholder="janis@uznemums.lv" />
      <label>Telefona numurs</label><input id="f_userPhone" placeholder="+371..." />
    ` : `<p class="muted">${esc(user.email) || esc(user.phone)}</p>`}
    <label>Loma</label>
    <select id="f_userRole" ${canEditRole ? '' : 'disabled'}>
      <option value="user" ${user && user.role === 'user' ? 'selected' : ''}>User</option>
      <option value="admin" ${user && user.role === 'admin' ? 'selected' : ''}>Admin</option>
      <option value="owner" ${user && user.role === 'owner' ? 'selected' : ''}>Owner</option>
    </select>
    ${!canEditRole ? '<p class="muted">Tikai Owner var mainīt Admin/Owner tiesības.</p>' : ''}
    ${usersFields.map((f) => {
      const val = user ? (user.data || {})[f.field_key] : undefined;
      const id = 'f_field_' + f.field_key;
      if (f.field_type === 'boolean') return `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:8px"><input type="checkbox" id="${id}" style="width:auto" ${val ? 'checked' : ''} /> ${esc(f.label)}</label>`;
      if (f.field_type === 'select') return `<label>${esc(f.label)}</label><select id="${id}"><option value="">—</option>${(f.options || []).map((o) => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      const inputType = f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text';
      return `<label>${esc(f.label)}</label><input type="${inputType}" id="${id}" value="${val ?? ''}" />`;
    }).join('')}
    ${user ? `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:10px"><input type="checkbox" id="f_userBlocked" style="width:auto" ${user.is_blocked ? 'checked' : ''} /> Bloķēts</label>` : ''}
    <div class="modal-actions">
      ${user && user.role !== 'owner' ? `<button class="btn btn-red" onclick="deleteUser('${user.id}')">Dzēst</button>` : ''}
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveUser(${user ? `'${user.id}'` : 'null'})">Saglabāt</button>
    </div>`);
}

async function saveUser(userId) {
  const data = {};
  usersFields.forEach((f) => {
    const el = document.getElementById('f_field_' + f.field_key);
    if (!el) return;
    data[f.field_key] = f.field_type === 'boolean' ? el.checked : el.value;
  });
  try {
    if (userId) {
      const payload = {
        displayName: document.getElementById('f_userName').value,
        role: document.getElementById('f_userRole').value,
        isBlocked: document.getElementById('f_userBlocked').checked,
        data,
      };
      await api('/api/users/' + userId, { method: 'PATCH', body: payload });
    } else {
      const payload = {
        displayName: document.getElementById('f_userName').value,
        email: document.getElementById('f_userEmail').value.trim() || undefined,
        phone: document.getElementById('f_userPhone').value.trim() || undefined,
        role: document.getElementById('f_userRole').value,
        data,
      };
      if (!payload.displayName) { alert('Vārds ir obligāts'); return; }
      if (!payload.email && !payload.phone) { alert('Jānorāda e-pasts vai telefons'); return; }
      await api('/api/users', { method: 'POST', body: payload });
    }
    closeModal();
    await loadUsers();
  } catch (e) { alert(e.message); }
}

async function deleteUser(userId) {
  if (!confirm('Deaktivizēt šo lietotāju?')) return;
  try { await api('/api/users/' + userId, { method: 'DELETE' }); closeModal(); await loadUsers(); }
  catch (e) { alert(e.message); }
}

async function openUserDetail(userId) {
  const user = usersCache.find((u) => u.id === userId);
  const { history } = await api('/api/users/' + userId + '/history');
  openModal(`
    <h2>${esc(user.display_name)}</h2>
    <p class="muted">${esc(user.email) || ''} ${esc(user.phone) || ''} · <span class="role-badge" style="background:${ROLE_COLORS[user.role]}">${ROLE_LABELS_LV[user.role]}</span></p>
    <div class="section-title">Vēsture</div>
    ${history.length ? history.map((h) => `<div class="history-item">${fmtDateTime(h.changed_at)} — <b>${esc(h.action)}</b>${h.field_name ? ': ' + esc(h.field_name) + ' "' + esc(h.old_value) + '" → "' + esc(h.new_value) + '"' : ''}${h.notes ? ' (' + esc(h.notes) + ')' : ''}${h.changed_by_name ? '<br><span class="muted">Veica: ' + esc(h.changed_by_name) + '</span>' : ''}</div>`).join('') : '<p class="muted">Nav ierakstu</p>'}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="openUserForm('${userId}')">Rediģēt</button>
      <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
    </div>`);
}

// ============================================================
// PIEKĻUVES PIEPRASĪJUMI
// ============================================================
async function renderAccessRequestsTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `<div class="toolbar"><h3 style="margin:0">Neatrisinātie piekļuves pieprasījumi</h3><div></div></div>
    <table id="requestsTable"><thead><tr><th>Identifikators</th><th>Vārds</th><th>Mēģinājumi</th><th>Pēdējā reize</th><th>E-pasts nosūtīts</th><th></th></tr></thead><tbody></tbody></table>`;
  await loadAccessRequests();
}

async function loadAccessRequests() {
  const { requests } = await api('/api/access-requests?resolved=false');
  const tbody = document.querySelector('#requestsTable tbody');
  tbody.innerHTML = requests.length ? requests.map((r) => `
    <tr>
      <td>${esc(r.identifier)}</td><td>${esc(r.display_name) || '—'}</td><td>${r.attempt_count}</td>
      <td>${fmtDateTime(r.attempted_at)}</td><td>${r.notified_email ? '✓' : '—'}</td>
      <td>
        <button class="btn btn-sm btn-green" onclick="approveAccessRequest('${r.id}')">Atbloķēt (izveidot kontu)</button>
        <button class="btn btn-sm btn-outline" onclick="dismissAccessRequest('${r.id}')">Ignorēt</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Nav neatrisinātu pieprasījumu</td></tr>`;
}
async function approveAccessRequest(id) {
  try { await api('/api/access-requests/' + id + '/approve', { method: 'POST', body: { role: 'user' } }); await loadAccessRequests(); }
  catch (e) { alert(e.message); }
}
async function dismissAccessRequest(id) {
  try { await api('/api/access-requests/' + id + '/dismiss', { method: 'POST' }); await loadAccessRequests(); }
  catch (e) { alert(e.message); }
}

// ---------- Startēšana ----------
if (state.token) {
  api('/api/users/me').then(({ user }) => { state.user = user; boot(); })
    .catch(() => { localStorage.removeItem('admin_token'); state.token = null; });
}
