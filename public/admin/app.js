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
function buildDevToken(identifier) {
  const payload = JSON.stringify({ identifier });
  return btoa(unescape(encodeURIComponent(payload)));
}

async function doLogin() {
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!identifier) { errEl.textContent = 'Ievadiet e-pastu vai telefona numuru.'; return; }
  state.token = buildDevToken(identifier);
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
  const nav = document.getElementById('mainNav');
  const fixedTabs = [['tickets', 'Ticketi']];
  if (isOwnerOrAdmin()) fixedTabs.push(['users', 'Lietotāji'], ['access_requests', 'Piekļuves pieprasījumi']);
  let html = `<div class="sidebar-section">` +
    fixedTabs.map(([key, label]) => `<button class="nav-item ${state.tab === key ? 'active' : ''}" onclick="switchFixedTab('${key}')">${label}</button>`).join('') +
    `</div>`;
  html += `<div class="sidebar-section sidebar-tree">${renderModuleTreeNav(null, 0)}</div>`;
  if (isOwnerOrAdmin()) html += `<button class="nav-add-root" onclick="addRootModule()">+ Jauna kategorija</button>`;
  // Fiksēta sadaļa: Kiberdrošība (neatkarīga no kategoriju koka)
  html += `<div class="sidebar-section" style="border-top:1px solid rgba(255,255,255,0.15); margin-top:6px; padding-top:6px;">
      <button class="nav-item ${state.tab === 'cyber' ? 'active' : ''}" onclick="switchFixedTab('cyber')">🛡️ Kiberdrošība</button>
    </div>`;
  nav.innerHTML = html;
}

// Rekursīvi renderē VISU koku (jebkurš dziļums) kreisajā sānjoslā -- katrs
// mezgls ir tieši klikšķināms, lai pa vidu paliktu tikai tabula.
function renderModuleTreeNav(parentId, depth) {
  const children = state.modulesTree.filter((m) => m.parent_id === parentId && m.system_key !== 'users').sort((a, b) => a.sort_order - b.sort_order);
  return children.map((m) => {
    const isActive = state.tab === 'module' && state.currentModuleId === m.id;
    return `
      <div class="tree-node">
        <div class="tree-node-row ${isActive ? 'active' : ''}" style="padding-left:${18 + depth * 14}px" onclick="switchModuleTab('${m.id}')">
          <span class="tree-node-label">${m.icon ? m.icon + ' ' : ''}${esc(m.name)}</span>
          ${isOwnerOrAdmin() ? `<span class="tree-node-actions">
            <button onclick="event.stopPropagation(); addSubModule('${m.id}')" title="Pievienot apakškategoriju">+</button>
            <button onclick="event.stopPropagation(); renameModulePrompt('${m.id}')" title="Pārsaukt">✎</button>
            <button onclick="event.stopPropagation(); deleteModulePrompt('${m.id}')" title="Dzēst">🗑</button>
          </span>` : ''}
        </div>
        ${renderModuleTreeNav(m.id, depth + 1)}
      </div>`;
  }).join('');
}

function switchFixedTab(key) { state.tab = key; renderNav(); renderTab(); }
function switchModuleTab(moduleId) { state.tab = 'module'; state.currentModuleId = moduleId; renderNav(); renderTab(); }

async function addRootModule() {
  const name = prompt('Jaunās pamatkategorijas nosaukums:');
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
  if (state.tab === 'cyber') return renderCyberTab();
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
  state.tab = 'module'; state.currentModuleId = moduleId;
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
// MODUĻA SKATS -- navigācija notiek sānjoslā, šeit paliek TIKAI tabula
// ============================================================
let currentModuleFields = [];
let currentModuleRecords = [];

async function renderModuleView(moduleId) {
  const main = document.getElementById('mainContent');
  const module = state.modulesTree.find((m) => m.id === moduleId);
  if (!module) { main.innerHTML = '<p class="empty">Izvēlieties kategoriju kreisajā sānjoslā</p>'; return; }

  currentModuleFields = (await api('/api/modules/' + moduleId + '/fields')).fields;

  main.innerHTML = `
    <div class="breadcrumb">${renderBreadcrumb(moduleId)}</div>
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
  return chain.map((c, i) => `${i > 0 ? '<span class="sep">/</span>' : ''}<span>${esc(c.name)}</span>`).join('');
}

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
// Pēc lauku pievienošanas/dzēšanas jāatsvaidzina tabula zem tās, lai jaunā
// kolonna uzreiz redzama, nevis tikai pēc cilnes pārslēgšanas.
async function closeFieldsModalAndRefresh(moduleId) {
  closeModal();
  if (moduleId === usersModuleId) {
    await renderUsersTab();
  } else {
    await renderModuleView(state.currentModuleId);
  }
}

async function openFieldsModal(moduleId) {
  const { fields } = await api('/api/modules/' + moduleId + '/fields');
  window.__fieldsModalCache = fields; // vajadzīgs kārtošanas pogām
  const typeLabels = { text: 'Teksts', number: 'Skaitlis', boolean: 'Jā/Nē', date: 'Datums', select: 'Izvēlne' };
  openModal(`
    <h2>Lauki (kolonnas)</h2>
    <p class="muted">Bultiņas maina secību, kādā kolonnas rādās gan tabulā, gan pievienošanas formā.</p>
    <div id="fieldsList">
      ${fields.length ? fields.map((f, idx) => `<div class="history-item" style="display:flex; justify-content:space-between; align-items:center;">
        <div>
          <button class="btn btn-sm btn-outline" ${idx === 0 ? 'disabled' : ''} onclick="moveField('${moduleId}', ${idx}, -1)">↑</button>
          <button class="btn btn-sm btn-outline" ${idx === fields.length - 1 ? 'disabled' : ''} onclick="moveField('${moduleId}', ${idx}, 1)">↓</button>
          ${esc(f.label)} <span class="muted">(${typeLabels[f.field_type]})</span>
        </div>
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
      <button class="btn btn-outline" onclick="closeFieldsModalAndRefresh('${moduleId}')">Aizvērt</button>
      <button class="btn btn-primary" onclick="addField('${moduleId}')">+ Pievienot lauku</button>
    </div>`);
}

async function moveField(moduleId, idx, direction) {
  const fields = window.__fieldsModalCache;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= fields.length) return;
  const reordered = [...fields];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  try {
    await api('/api/modules/' + moduleId + '/fields/reorder', { method: 'POST', body: { orderedIds: reordered.map((f) => f.id) } });
    await openFieldsModal(moduleId);
  } catch (e) { alert(e.message); }
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
    <label>E-pasts</label><input id="f_userEmail" value="${user ? esc(user.email) : ''}" placeholder="janis@uznemums.lv" />
    <label>Telefona numurs</label><input id="f_userPhone" value="${user ? esc(user.phone) : ''}" placeholder="+371..." />
    <p class="muted">Vismaz viens no laukiem (e-pasts vai telefons) ir obligāts.</p>
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
        email: document.getElementById('f_userEmail').value.trim() || '',
        phone: document.getElementById('f_userPhone').value.trim() || '',
        role: document.getElementById('f_userRole').value,
        isBlocked: document.getElementById('f_userBlocked').checked,
        data,
      };
      if (!payload.email && !payload.phone) { alert('Jānorāda e-pasts vai telefons'); return; }
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

// ============================================================
// KIBERDROŠĪBA — Instrukcijas / Testi / Pikšķerēšanas pārbaudes
// ============================================================
let cyberSub = 'articles';

// Ļoti vienkāršs Markdown → HTML (## virsraksti, **treknraksts**, saraksti).
function miniMarkdown(md) {
  const lines = (md || '').split('\n');
  let html = '', inUl = false, inOl = false;
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) { closeLists(); html += `<h4 style="margin:14px 0 6px;color:var(--blue)">${inline(line.replace(/^##\s+/, ''))}</h4>`; }
    else if (/^\d+\.\s+/.test(line)) { if (!inOl) { closeLists(); html += '<ol style="line-height:1.6">'; inOl = true; } html += `<li>${inline(line.replace(/^\d+\.\s+/, ''))}</li>`; }
    else if (/^[-*]\s+/.test(line)) { if (!inUl) { closeLists(); html += '<ul style="line-height:1.6">'; inUl = true; } html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`; }
    else if (line === '') { closeLists(); }
    else { closeLists(); html += `<p>${inline(line)}</p>`; }
  }
  closeLists();
  return html;
}

function renderCyberTab() {
  const main = document.getElementById('mainContent');
  const subs = [['articles', '📖 Instrukcijas'], ['tests', '📝 Testi']];
  if (isOwnerOrAdmin()) subs.push(['phishing', '🎣 Pikšķerēšanas pārbaudes']);
  main.innerHTML = `
    <h2 style="margin:0 0 4px">🛡️ Kiberdrošība</h2>
    <div class="tabs-inline" style="margin-top:12px">
      ${subs.map(([k, l]) => `<button class="${cyberSub === k ? 'active' : ''}" onclick="switchCyberSub('${k}')">${l}</button>`).join('')}
    </div>
    <div id="cyberContent"></div>`;
  renderCyberSub();
}
function switchCyberSub(k) { cyberSub = k; renderCyberTab(); }
function renderCyberSub() {
  if (cyberSub === 'articles') return renderCyberArticles();
  if (cyberSub === 'tests') return renderCyberTests();
  if (cyberSub === 'phishing' && isOwnerOrAdmin()) return renderCyberPhishing();
}

// ---------- Instrukcijas ----------
async function renderCyberArticles() {
  const box = document.getElementById('cyberContent');
  box.innerHTML = '<p class="muted">Ielādē…</p>';
  try {
    const { articles } = await api('/api/training/articles');
    box.innerHTML = `
      ${isOwnerOrAdmin() ? `<div class="toolbar"><div></div><button class="btn btn-primary" onclick="openArticleModal()">+ Jauna instrukcija</button></div>` : ''}
      ${articles.length ? articles.map((a) => `
        <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:18px 22px;margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
            <h3 style="margin:0 0 6px;color:var(--blue)">${esc(a.title)}</h3>
            ${isOwnerOrAdmin() ? `<div style="flex-shrink:0">
              <button class="btn btn-sm btn-outline" onclick='openArticleModal(${JSON.stringify(a).replace(/'/g, "&#39;")})'>✎</button>
              <button class="btn btn-sm btn-red" onclick="deleteArticle('${a.id}')">🗑</button>
            </div>` : ''}
          </div>
          <div class="article-body">${miniMarkdown(a.content)}</div>
        </div>`).join('') : '<p class="empty">Vēl nav instrukciju.</p>'}`;
  } catch (e) { box.innerHTML = `<p class="empty">Kļūda: ${esc(e.message)}</p>`; }
}
function openArticleModal(article) {
  const a = article || { title: '', content: '', sort_order: 0 };
  openModal(`
    <h2>${article ? 'Rediģēt instrukciju' : 'Jauna instrukcija'}</h2>
    <label>Virsraksts</label>
    <input id="artTitle" value="${esc(a.title)}" />
    <label>Saturs (atbalsta ## virsrakstus, **treknrakstu**, sarakstus)</label>
    <textarea id="artContent" rows="12">${esc(a.content)}</textarea>
    <label>Kārtas numurs</label>
    <input id="artSort" type="number" value="${a.sort_order || 0}" />
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveArticle(${article ? `'${a.id}'` : 'null'})">Saglabāt</button>
    </div>`);
}
async function saveArticle(id) {
  const body = {
    title: document.getElementById('artTitle').value.trim(),
    content: document.getElementById('artContent').value,
    sortOrder: Number(document.getElementById('artSort').value) || 0,
  };
  if (!body.title || !body.content) { alert('Aizpildiet virsrakstu un saturu'); return; }
  try {
    if (id) await api('/api/training/articles/' + id, { method: 'PATCH', body });
    else await api('/api/training/articles', { method: 'POST', body });
    closeModal(); renderCyberArticles();
  } catch (e) { alert(e.message); }
}
async function deleteArticle(id) {
  if (!confirm('Dzēst šo instrukciju?')) return;
  try { await api('/api/training/articles/' + id, { method: 'DELETE' }); renderCyberArticles(); }
  catch (e) { alert(e.message); }
}

// ---------- Testi ----------
async function renderCyberTests() {
  const box = document.getElementById('cyberContent');
  box.innerHTML = '<p class="muted">Ielādē…</p>';
  try {
    if (isOwnerOrAdmin()) {
      const { tests } = await api('/api/training/tests/all');
      box.innerHTML = `
        <div class="toolbar"><div></div><button class="btn btn-primary" onclick="openTestModal()">+ Jauns tests</button></div>
        <table><thead><tr><th>Tests</th><th>Jautājumi</th><th>Aizpildījumi</th><th>Aktīvs</th><th></th></tr></thead><tbody>
        ${tests.length ? tests.map((t) => `
          <tr>
            <td><b>${esc(t.title)}</b><br><span class="muted">${esc(t.description) || ''}</span></td>
            <td>${t.question_count}</td>
            <td>${t.attempt_count}</td>
            <td>${t.is_active ? '✓' : '—'}</td>
            <td style="white-space:nowrap">
              <button class="btn btn-sm btn-outline" onclick="takeTest('${t.id}')">Pildīt</button>
              <button class="btn btn-sm btn-outline" onclick="viewTestReport('${t.id}','${esc(t.title).replace(/'/g,"")}')">Atskaite</button>
              <button class="btn btn-sm btn-red" onclick="deleteTest('${t.id}')">🗑</button>
            </td>
          </tr>`).join('') : '<tr><td colspan="5" class="empty">Vēl nav testu.</td></tr>'}
        </tbody></table>`;
    } else {
      const { tests } = await api('/api/training/tests');
      box.innerHTML = `${tests.length ? `<div class="folder-grid">${tests.map((t) => `
        <div class="folder-card" onclick="takeTest('${t.id}')" style="min-width:200px;text-align:left">
          <div class="folder-name">${esc(t.title)}</div>
          <div class="muted">${esc(t.description) || ''}</div>
          <div class="muted" style="margin-top:6px">${t.question_count} jautājumi</div>
        </div>`).join('')}</div>` : '<p class="empty">Pašlaik nav pieejamu testu.</p>'}`;
    }
  } catch (e) { box.innerHTML = `<p class="empty">Kļūda: ${esc(e.message)}</p>`; }
}

async function takeTest(id) {
  try {
    const { test, questions } = await api('/api/training/tests/' + id + '/take');
    openModal(`
      <h2>${esc(test.title)}</h2>
      ${test.description ? `<p class="muted">${esc(test.description)}</p>` : ''}
      <div id="testQuestions">
        ${questions.map((q, i) => `
          <div class="section-title">${i + 1}. ${esc(q.question)}</div>
          ${(q.options || []).map((opt, oi) => `
            <label style="display:flex;align-items:center;gap:8px;font-weight:400;margin:4px 0">
              <input type="radio" name="q_${q.id}" value="${oi}" style="width:auto" /> ${esc(opt)}
            </label>`).join('')}
        `).join('')}
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
        <button class="btn btn-primary" onclick="submitTest('${id}', ${JSON.stringify(questions.map((q) => q.id))})">Iesniegt</button>
      </div>`);
  } catch (e) { alert(e.message); }
}
async function submitTest(id, questionIds) {
  const answers = {};
  for (const qid of questionIds) {
    const sel = document.querySelector(`input[name="q_${qid}"]:checked`);
    if (sel) answers[qid] = Number(sel.value);
  }
  try {
    const { score, total, review } = await api('/api/training/tests/' + id + '/attempt', { method: 'POST', body: { answers } });
    const pct = total ? Math.round((score / total) * 100) : 0;
    openModal(`
      <h2>Rezultāts: ${score} / ${total} (${pct}%)</h2>
      <div class="result-box" style="background:${pct >= 70 ? '#eaf7ee' : '#fdecea'}">
        ${pct >= 70 ? '✅ Lielisks darbs! Jūs labi protat atpazīt draudus.' : '⚠️ Ieteicams vēlreiz pārskatīt instrukcijas un mēģināt no jauna.'}
      </div>
      ${review.map((r, i) => `
        <div class="history-item">
          <b>${i + 1}. ${esc(r.question)}</b><br>
          ${(r.options || []).map((opt, oi) => {
            let mark = '';
            if (oi === r.correctIndex) mark = ' ✅';
            else if (oi === r.selectedIndex) mark = ' ❌';
            const color = oi === r.correctIndex ? 'var(--green)' : (oi === r.selectedIndex ? 'var(--red)' : '#333');
            return `<span style="color:${color}">${esc(opt)}${mark}</span><br>`;
          }).join('')}
          ${r.explanation ? `<span class="muted">💡 ${esc(r.explanation)}</span>` : ''}
        </div>`).join('')}
      <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">Aizvērt</button></div>`);
  } catch (e) { alert(e.message); }
}
async function deleteTest(id) {
  if (!confirm('Dzēst šo testu un visus tā rezultātus?')) return;
  try { await api('/api/training/tests/' + id, { method: 'DELETE' }); renderCyberTests(); }
  catch (e) { alert(e.message); }
}

// Testa veidošana (owner/admin) — dinamiski jautājumi
let testBuilderQuestions = [];
function openTestModal() {
  testBuilderQuestions = [{ question: '', options: ['', ''], correctIndex: 0, explanation: '' }];
  renderTestBuilder();
}
function renderTestBuilder() {
  openModal(`
    <h2>Jauns tests</h2>
    <label>Nosaukums</label><input id="testTitle" />
    <label>Apraksts (neobligāts)</label><input id="testDesc" />
    <div id="qBuilder">${testBuilderQuestions.map((q, qi) => renderQBuilder(q, qi)).join('')}</div>
    <button class="btn btn-outline btn-sm" style="margin-top:8px" onclick="addBuilderQuestion()">+ Pievienot jautājumu</button>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveTest()">Saglabāt testu</button>
    </div>`);
}
function renderQBuilder(q, qi) {
  return `<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:10px">
    <div style="display:flex;justify-content:space-between"><b>Jautājums ${qi + 1}</b>
      ${testBuilderQuestions.length > 1 ? `<button class="btn btn-sm btn-red" onclick="removeBuilderQuestion(${qi})">✕</button>` : ''}</div>
    <input placeholder="Jautājuma teksts" value="${esc(q.question)}" oninput="testBuilderQuestions[${qi}].question=this.value" />
    <div style="margin-top:6px">
      ${q.options.map((opt, oi) => `
        <div style="display:flex;align-items:center;gap:6px;margin:3px 0">
          <input type="radio" name="correct_${qi}" ${q.correctIndex === oi ? 'checked' : ''} onclick="testBuilderQuestions[${qi}].correctIndex=${oi}" style="width:auto" title="Pareizā atbilde" />
          <input style="flex:1" placeholder="Atbilde ${oi + 1}" value="${esc(opt)}" oninput="testBuilderQuestions[${qi}].options[${oi}]=this.value" />
          ${q.options.length > 2 ? `<button class="btn btn-sm btn-outline" onclick="removeBuilderOption(${qi},${oi})">✕</button>` : ''}
        </div>`).join('')}
      <button class="btn btn-sm btn-outline" onclick="addBuilderOption(${qi})">+ Atbilde</button>
    </div>
    <input style="margin-top:6px" placeholder="Skaidrojums (neobligāts)" value="${esc(q.explanation)}" oninput="testBuilderQuestions[${qi}].explanation=this.value" />
    <div class="muted" style="margin-top:4px">Atzīmējiet pareizo atbildi ar aplīti kreisajā pusē.</div>
  </div>`;
}
function addBuilderQuestion() { testBuilderQuestions.push({ question: '', options: ['', ''], correctIndex: 0, explanation: '' }); refreshBuilder(); }
function removeBuilderQuestion(qi) { testBuilderQuestions.splice(qi, 1); refreshBuilder(); }
function addBuilderOption(qi) { testBuilderQuestions[qi].options.push(''); refreshBuilder(); }
function removeBuilderOption(qi, oi) {
  testBuilderQuestions[qi].options.splice(oi, 1);
  if (testBuilderQuestions[qi].correctIndex >= testBuilderQuestions[qi].options.length) testBuilderQuestions[qi].correctIndex = 0;
  refreshBuilder();
}
function refreshBuilder() {
  // Saglabā nosaukumu/aprakstu pirms pārzīmēšanas
  const title = document.getElementById('testTitle')?.value || '';
  const desc = document.getElementById('testDesc')?.value || '';
  document.getElementById('qBuilder').innerHTML = testBuilderQuestions.map((q, qi) => renderQBuilder(q, qi)).join('');
  if (document.getElementById('testTitle')) document.getElementById('testTitle').value = title;
  if (document.getElementById('testDesc')) document.getElementById('testDesc').value = desc;
}
async function saveTest() {
  const title = document.getElementById('testTitle').value.trim();
  const description = document.getElementById('testDesc').value.trim();
  if (!title) { alert('Ievadiet testa nosaukumu'); return; }
  const questions = testBuilderQuestions.filter((q) => q.question.trim() && q.options.filter((o) => o.trim()).length >= 2);
  if (questions.length === 0) { alert('Pievienojiet vismaz vienu jautājumu ar 2 atbildēm'); return; }
  try {
    await api('/api/training/tests', { method: 'POST', body: { title, description, questions } });
    closeModal(); renderCyberTests();
  } catch (e) { alert(e.message); }
}
async function viewTestReport(id, title) {
  try {
    const { results } = await api('/api/training/tests/' + id + '/report');
    openModal(`
      <h2>Atskaite: ${esc(title)}</h2>
      <div class="toolbar"><div class="muted">${results.length} dalībnieki</div>
        <button class="btn btn-outline btn-sm" onclick="window.open('/api/training/tests/${id}/report/export','_blank')">⬇ CSV</button></div>
      <table><thead><tr><th>Vārds</th><th>Rezultāts</th><th>%</th><th>Datums</th></tr></thead><tbody>
        ${results.length ? results.map((r) => {
          const pct = r.total_questions ? Math.round((r.score / r.total_questions) * 100) : 0;
          return `<tr><td>${esc(r.display_name)}</td><td>${r.score}/${r.total_questions}</td>
            <td><span class="badge" style="background:${pct >= 70 ? 'var(--green)' : 'var(--red)'}">${pct}%</span></td>
            <td>${fmtDateTime(r.completed_at)}</td></tr>`;
        }).join('') : '<tr><td colspan="4" class="empty">Neviens vēl nav pildījis šo testu.</td></tr>'}
      </tbody></table>
      <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">Aizvērt</button></div>`);
  } catch (e) { alert(e.message); }
}

// ---------- Pikšķerēšanas pārbaudes (tikai owner/admin) ----------
async function renderCyberPhishing() {
  const box = document.getElementById('cyberContent');
  box.innerHTML = '<p class="muted">Ielādē…</p>';
  try {
    const { campaigns } = await api('/api/phishing/campaigns');
    box.innerHTML = `
      <div class="result-box" style="background:#fbf6e8;margin-bottom:14px">
        ℹ️ Šis ir <b>iekšējs drošības apmācību rīks</b>: nosūta darbiniekiem simulētu pikšķerēšanas e-pastu un uzskaita, kurš to atvēra vai uzklikšķināja. <b>Netiek vākti nekādi dati vai paroles</b> — pēc klikšķa darbinieks uzreiz redz izglītojošu paskaidrojumu.
      </div>
      <div class="toolbar"><div></div><button class="btn btn-primary" onclick="openCampaignModal()">+ Jauna kampaņa</button></div>
      <table><thead><tr><th>Nosaukums</th><th>Statuss</th><th>Nosūtīts</th><th>Atvēra</th><th>Uzklikšķināja</th><th></th></tr></thead><tbody>
        ${campaigns.length ? campaigns.map((c) => `
          <tr>
            <td><b>${esc(c.name)}</b><br><span class="muted">${esc(c.subject)}</span></td>
            <td>${c.status === 'sent' ? '✅ Nosūtīta' : c.status === 'sending' ? '⏳ Sūta…' : '📝 Melnraksts'}</td>
            <td>${c.total}</td>
            <td>${c.opened}</td>
            <td>${c.clicked}</td>
            <td style="white-space:nowrap">
              ${c.status === 'draft' ? `<button class="btn btn-sm btn-green" onclick="sendCampaign('${c.id}')">Nosūtīt</button>` : ''}
              <button class="btn btn-sm btn-outline" onclick="viewCampaignStats('${c.id}')">Statistika</button>
              <button class="btn btn-sm btn-red" onclick="deleteCampaign('${c.id}')">🗑</button>
            </td>
          </tr>`).join('') : '<tr><td colspan="6" class="empty">Vēl nav kampaņu.</td></tr>'}
      </tbody></table>`;
  } catch (e) { box.innerHTML = `<p class="empty">Kļūda: ${esc(e.message)}</p>`; }
}
async function openCampaignModal() {
  let users = [];
  try { users = (await api('/api/users?search=')).users || []; } catch (e) { alert(e.message); return; }
  const emailUsers = users.filter((u) => u.email);
  openModal(`
    <h2>Jauna pikšķerēšanas kampaņa</h2>
    <label>Kampaņas nosaukums (iekšējai lietošanai)</label>
    <input id="campName" placeholder="piem. Q4 pārbaude" />
    <label>Sūtītāja vārds (kā darbinieks redzēs)</label>
    <input id="campSender" placeholder="piem. IT atbalsts" />
    <label>E-pasta temats</label>
    <input id="campSubject" placeholder="piem. Steidzami: apstipriniet savu kontu" />
    <label>E-pasta saturs (HTML). Izmantojiet {{NAME}} un {{LINK}}</label>
    <textarea id="campBody" rows="7">Sveiki, {{NAME}}!

Jūsu konts jāapstiprina 24 stundu laikā, citādi tas tiks bloķēts.

&lt;a href="{{LINK}}"&gt;Apstiprināt kontu&lt;/a&gt;

Paldies,
IT atbalsts</textarea>
    <label>Saņēmēji (${emailUsers.length} ar e-pastu)</label>
    <div style="max-height:160px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:8px">
      <label style="font-weight:600;display:flex;align-items:center;gap:6px"><input type="checkbox" id="campAll" style="width:auto" onclick="toggleAllTargets(this.checked)" /> Izvēlēties visus</label>
      ${emailUsers.map((u) => `<label style="font-weight:400;display:flex;align-items:center;gap:6px;margin-top:3px">
        <input type="checkbox" class="camp-target" value="${u.id}" style="width:auto" /> ${esc(u.display_name)} <span class="muted">(${esc(u.email)})</span></label>`).join('')}
    </div>
    <p class="muted" style="margin-top:8px">Darbinieki bez e-pasta netiek rādīti — simulāciju var sūtīt tikai uz e-pastu.</p>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveCampaign()">Saglabāt melnrakstu</button>
    </div>`);
}
function toggleAllTargets(checked) { document.querySelectorAll('.camp-target').forEach((c) => { c.checked = checked; }); }
async function saveCampaign() {
  const body = {
    name: document.getElementById('campName').value.trim(),
    senderName: document.getElementById('campSender').value.trim(),
    subject: document.getElementById('campSubject').value.trim(),
    bodyHtml: document.getElementById('campBody').value,
    userIds: Array.from(document.querySelectorAll('.camp-target:checked')).map((c) => c.value),
  };
  if (!body.name || !body.subject || !body.bodyHtml) { alert('Aizpildiet nosaukumu, tematu un saturu'); return; }
  if (body.userIds.length === 0) { alert('Izvēlieties vismaz vienu saņēmēju'); return; }
  try { await api('/api/phishing/campaigns', { method: 'POST', body }); closeModal(); renderCyberPhishing(); }
  catch (e) { alert(e.message); }
}
async function sendCampaign(id) {
  if (!confirm('Nosūtīt simulācijas e-pastus izvēlētajiem darbiniekiem?')) return;
  try {
    const r = await api('/api/phishing/campaigns/' + id + '/send', { method: 'POST' });
    alert(r.note ? r.note : `Nosūtīts ${r.sent} no ${r.total} e-pastiem.`);
    renderCyberPhishing();
  } catch (e) { alert(e.message); }
}
async function viewCampaignStats(id) {
  try {
    const { campaign, summary, targets } = await api('/api/phishing/campaigns/' + id + '/stats');
    openModal(`
      <h2>${esc(campaign.name)}</h2>
      <div class="result-box">Nosūtīts: <b>${summary.total}</b> · Atvēra: <b>${summary.opened}</b> · Uzklikšķināja: <b>${summary.clicked}</b></div>
      <div class="toolbar" style="margin-top:12px"><div></div>
        <button class="btn btn-outline btn-sm" onclick="window.open('/api/phishing/campaigns/${id}/export','_blank')">⬇ CSV</button></div>
      <table><thead><tr><th>Vārds</th><th>Nosūtīts</th><th>Atvēra</th><th>Uzklikšķināja</th></tr></thead><tbody>
        ${targets.map((t) => `<tr>
          <td>${esc(t.display_name)}</td>
          <td>${t.sent_at ? '✓' : '—'}</td>
          <td>${t.opened_at ? '👁' : '—'}</td>
          <td>${t.clicked_at ? '<span style="color:var(--red)">⚠️ jā</span>' : '—'}</td>
        </tr>`).join('')}
      </tbody></table>
      <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">Aizvērt</button></div>`);
  } catch (e) { alert(e.message); }
}
async function deleteCampaign(id) {
  if (!confirm('Dzēst šo kampaņu un tās statistiku?')) return;
  try { await api('/api/phishing/campaigns/' + id, { method: 'DELETE' }); renderCyberPhishing(); }
  catch (e) { alert(e.message); }
}

// ---------- Startēšana ----------
if (state.token) {
  api('/api/users/me').then(({ user }) => { state.user = user; boot(); })
    .catch(() => { localStorage.removeItem('admin_token'); state.token = null; });
}
