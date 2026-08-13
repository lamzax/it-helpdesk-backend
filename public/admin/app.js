// ============================================================
// IT Helpdesk admin panelis -- tīrs JS, bez build soļa.
// Sauc to pašu REST API, ko lieto mobilā aplikācija.
// ============================================================

const API = ''; // tukšs, jo admin panelis tiek serverēts no tā paša backend (relatīvie /api/... ceļi)

const STATUS_LABELS_LV = { in_stock: 'Noliktavā', in_use: 'Lietošanā', in_repair: 'Remontā', retired: 'Izņemts', disposed: 'Utilizēts' };
const TICKET_STATUS_LV = { new: 'Jauns', in_progress: 'Darbā', waiting: 'Gaida', resolved: 'Atrisināts', closed: 'Slēgts' };

let state = { token: localStorage.getItem('admin_token') || null, user: null, tab: 'tickets', categories: [] };

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

// ---------- Pieteikšanās ----------
function buildDevToken(provider, email, displayName) {
  return btoa(JSON.stringify({ provider, externalId: 'dev-' + email, email, displayName }));
}

async function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  const email = document.getElementById('loginEmail').value.trim();
  const provider = document.getElementById('loginProvider').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!name || !email) { errEl.textContent = 'Ievadiet vārdu un e-pastu.'; return; }
  state.token = buildDevToken(provider, email, name);
  try {
    const { user } = await api('/api/users/me');
    if (user.role !== 'admin' && user.role !== 'agent') {
      errEl.textContent = 'Šim lietotājam nav admin/agent tiesību. Pievienojiet e-pastu ADMIN_EMAILS failā backend/.env un pieslēdzieties vēlreiz.';
      state.token = null;
      return;
    }
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
  document.getElementById('whoAmI').textContent = state.user.display_name + ' (' + state.user.role + ')';
  const catRes = await api('/api/assets/categories/list');
  state.categories = catRes.categories;
  renderNav();
  renderTab();
}

function renderNav() {
  const tabs = [
    ['tickets', 'Ticketi'],
    ['assets', 'Iekārtas'], ['applications', 'Aplikācijas'], ['phones', 'Tālruņu numuri'],
    ['access', 'Piekļuves tiesības'], ['employees', 'Darbinieki'], ['categories', 'Kategorijas'],
    ['customFields', 'Pielāgotie lauki'],
  ];
  const nav = document.getElementById('mainNav');
  nav.innerHTML = tabs.map(([key, label]) =>
    `<button class="${state.tab === key ? 'active' : ''}" onclick="setTab('${key}')">${label}</button>`
  ).join('');
}

function setTab(tab) { state.tab = tab; renderNav(); renderTab(); }

function renderTab() {
  const map = { tickets: renderTicketsTab, assets: renderAssetsTab, applications: renderApplicationsTab, phones: renderPhonesTab, access: renderAccessTab, employees: renderEmployeesTab, categories: renderCategoriesTab, customFields: renderCustomFieldsTab };
  map[state.tab]();
}

function closeModal() { document.getElementById('overlay').classList.remove('open'); }
function openModal(html) { document.getElementById('modalContent').innerHTML = html; document.getElementById('overlay').classList.add('open'); }

function fmtDate(d) { return d ? new Date(d).toLocaleDateString('lv-LV') : '—'; }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString('lv-LV') : '—'; }
function esc(s) { return (s ?? '').toString().replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ============================================================
// TICKETI
// ============================================================
let ticketsCache = [];
const PRIORITY_LABELS_LV = { low: 'Zema', medium: 'Vidēja', high: 'Augsta', critical: 'Kritiska' };
const PRIORITY_COLORS = { low: '#888', medium: '#e8a33d', high: '#e0641f', critical: 'var(--red)' };
const STATUS_COLORS = { new: 'var(--blue)', in_progress: '#e8a33d', waiting: '#888', resolved: 'var(--green)', closed: '#555' };

async function renderTicketsTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <div>
        <select id="ticketStatusFilter" onchange="loadTickets()">
          <option value="">Visi statusi</option>
          ${Object.entries(TICKET_STATUS_LV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <select id="ticketCategoryFilter" onchange="loadTickets()">
          <option value="">Visas kategorijas</option>
          <option value="lan">LAN tīkls</option><option value="wifi">WiFi</option>
          <option value="cameras">Novērošanas kameras</option><option value="internal_app">Iekšējā lietojumprogramma</option>
          <option value="other">Cits IT jautājums</option>
        </select>
      </div>
      <div></div>
    </div>
    <table id="ticketsTable"><thead><tr>
      <th>Nr</th><th>Nosaukums</th><th>Kategorija</th><th>Prioritāte</th><th>Statuss</th><th>Pieteica</th><th>Datums</th>
    </tr></thead><tbody></tbody></table>`;
  await loadTickets();
}

async function loadTickets() {
  const status = document.getElementById('ticketStatusFilter').value;
  const category = document.getElementById('ticketCategoryFilter').value;
  const params = new URLSearchParams({ pageSize: '100' });
  if (status) params.set('status', status);
  if (category) params.set('category', category);
  const { tickets } = await api('/api/tickets?' + params.toString());
  ticketsCache = tickets;
  const tbody = document.querySelector('#ticketsTable tbody');
  tbody.innerHTML = tickets.length ? tickets.map((t) => `
    <tr class="clickable" onclick="openTicketDetail('${t.id}')">
      <td>${esc(t.ticket_number)}</td>
      <td>${esc(t.title)}</td>
      <td>${esc(t.category_name)}</td>
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
    <p class="muted">${esc(ticket.category_name)} · Pieteica: ${esc(ticket.reporter_name)} (${esc(ticket.reporter_email)}) · ${fmtDateTime(ticket.created_at)}</p>
    ${ticket.device_name ? `<p class="muted">Iekārta: ${esc(ticket.device_name)}${ticket.device_location ? ' · ' + esc(ticket.device_location) : ''}</p>` : ''}
    ${ticket.description ? `<p>${esc(ticket.description)}</p>` : ''}

    <div class="section-title">Statuss</div>
    <div class="tabs-inline">
      ${Object.entries(TICKET_STATUS_LV).map(([k, v]) => `<button class="${ticket.status === k ? 'active' : ''}" onclick="changeTicketStatus('${id}','${k}')">${v}</button>`).join('')}
    </div>

    <div class="section-title">Pielikumi</div>
    ${attachments.length ? attachments.map((a) => `<div class="history-item"><a href="${esc(a.file_url)}" target="_blank">${esc(a.file_name || a.file_url)}</a></div>`).join('') : '<p class="muted">Nav pielikumu</p>'}

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
// PIELĀGOTIE LAUKI (custom fields) -- kopīgas palīgfunkcijas
// ============================================================
let customFieldDefsCache = {};

async function loadCustomFieldDefs(table) {
  const { fields } = await api('/api/custom-fields?table=' + table);
  customFieldDefsCache[table] = fields;
  return fields;
}

function renderCustomFieldsHTML(table, existingValues = {}) {
  const defs = customFieldDefsCache[table] || [];
  if (defs.length === 0) return '';
  return `
    <div class="section-title">Pielāgotie lauki</div>
    ${defs.map((f) => {
      const val = existingValues[f.field_key];
      const id = `cf_${table}_${f.field_key}`;
      if (f.field_type === 'boolean') {
        return `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:8px">
          <input type="checkbox" id="${id}" style="width:auto" ${val ? 'checked' : ''} /> ${esc(f.label)}
        </label>`;
      }
      if (f.field_type === 'select') {
        return `<label>${esc(f.label)}${f.is_required ? ' *' : ''}</label>
          <select id="${id}">
            <option value="">— nav izvēlēts —</option>
            ${(f.options || []).map((o) => `<option value="${esc(o)}" ${val === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          </select>`;
      }
      const inputType = f.field_type === 'number' ? 'number' : f.field_type === 'date' ? 'date' : 'text';
      return `<label>${esc(f.label)}${f.is_required ? ' *' : ''}</label>
        <input type="${inputType}" id="${id}" value="${val !== undefined && val !== null ? esc(val) : ''}" />`;
    }).join('')}`;
}

function collectCustomFieldValues(table) {
  const defs = customFieldDefsCache[table] || [];
  const values = {};
  for (const f of defs) {
    const el = document.getElementById(`cf_${table}_${f.field_key}`);
    if (!el) continue;
    values[f.field_key] = f.field_type === 'boolean' ? el.checked : el.value;
  }
  return values;
}

// ============================================================
// PIELĀGOTO LAUKU DEFINĪCIJU CILNE (admin pārvalda pašus laukus)
// ============================================================
const CUSTOM_FIELD_TABLES = [
  ['assets', 'Iekārtas'], ['tickets', 'Ticketi'], ['applications', 'Aplikācijas'], ['phone_numbers', 'Tālruņu numuri'],
];
let customFieldsTabTable = 'assets';
let customFieldsFullCache = [];

async function renderCustomFieldsTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <div class="tabs-inline" id="cfTableTabs"></div>
      <button class="btn btn-green" onclick="openCustomFieldForm()">+ Pievienot lauku</button>
    </div>
    <p class="muted">Šeit pievienotie lauki automātiski parādīsies attiecīgās sadaļas add/edit formā admin panelī, un ticketu laukiem — arī mobilajā aplikācijā.</p>
    <table id="customFieldsTable"><thead><tr><th>#</th><th>Nosaukums</th><th>Kods</th><th>Tips</th><th>Statuss</th><th></th></tr></thead><tbody></tbody></table>`;

  document.getElementById('cfTableTabs').innerHTML = CUSTOM_FIELD_TABLES.map(([code, label]) =>
    `<button class="${customFieldsTabTable === code ? 'active' : ''}" onclick="switchCustomFieldsTable('${code}')">${label}</button>`
  ).join('');

  await loadCustomFieldsTab();
}

function switchCustomFieldsTable(table) {
  customFieldsTabTable = table;
  renderCustomFieldsTab();
}

async function loadCustomFieldsTab() {
  const { fields } = await api('/api/custom-fields/all?table=' + customFieldsTabTable);
  customFieldsFullCache = fields;
  const typeLabels = { text: 'Teksts', number: 'Skaitlis', boolean: 'Jā/Nē', date: 'Datums', select: 'Izvēlne' };
  const tbody = document.querySelector('#customFieldsTable tbody');
  tbody.innerHTML = fields.length ? fields.map((f, idx) => `
    <tr>
      <td>
        <button class="btn btn-sm btn-outline" ${idx === 0 ? 'disabled' : ''} onclick="moveCustomField(${idx}, -1)">↑</button>
        <button class="btn btn-sm btn-outline" ${idx === fields.length - 1 ? 'disabled' : ''} onclick="moveCustomField(${idx}, 1)">↓</button>
      </td>
      <td>${esc(f.label)}</td>
      <td><code>${esc(f.field_key)}</code></td>
      <td>${typeLabels[f.field_type]}</td>
      <td>${f.is_active ? '<span class="badge" style="background:var(--green)">aktīvs</span>' : '<span class="badge" style="background:#999">paslēpts</span>'}</td>
      <td><button class="btn btn-sm btn-outline" onclick="openCustomFieldForm('${f.id}')">Rediģēt</button></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Šai sadaļai vēl nav pielāgotu lauku</td></tr>`;
}

async function moveCustomField(idx, direction) {
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= customFieldsFullCache.length) return;
  const reordered = [...customFieldsFullCache];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  try {
    await api('/api/custom-fields/reorder', { method: 'POST', body: { tableName: customFieldsTabTable, orderedIds: reordered.map((f) => f.id) } });
    loadCustomFieldsTab();
  } catch (e) { alert(e.message); }
}

function openCustomFieldForm(id) {
  const field = id ? customFieldsFullCache.find((f) => f.id === id) : null;
  openModal(`
    <h2>${field ? 'Rediģēt lauku' : 'Jauns pielāgots lauks'}</h2>
    <p class="muted">Sadaļa: ${CUSTOM_FIELD_TABLES.find(([c]) => c === customFieldsTabTable)[1]}</p>
    ${!field ? `
      <label>Lauka kods (tikai mazie burti, cipari, "_") *</label>
      <input id="f_cfKey" placeholder="piem. warranty_type" />
      <label>Lauka tips *</label>
      <select id="f_cfType" onchange="document.getElementById('cfOptionsRow').style.display = this.value === 'select' ? 'block' : 'none'">
        <option value="text">Teksts (char)</option>
        <option value="number">Skaitlis</option>
        <option value="boolean">Jā/Nē (bit)</option>
        <option value="date">Datums</option>
        <option value="select">Izvēlne (fiksētas vērtības)</option>
      </select>
    ` : `<p class="muted">Kods: <code>${esc(field.field_key)}</code> · Tips: ${esc(field.field_type)} (nemaināms pēc izveides)</p>`}
    <label>Redzamais nosaukums *</label>
    <input id="f_cfLabel" value="${field ? esc(field.label) : ''}" placeholder="piem. Garantijas veids" />
    <div id="cfOptionsRow" style="display:${field && field.field_type === 'select' ? 'block' : (!field ? 'none' : 'none')}">
      <label>Izvēles vērtības (katru jaunā rindā)</label>
      <textarea id="f_cfOptions" rows="3">${field && field.options ? field.options.join('\n') : ''}</textarea>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:10px">
      <input type="checkbox" id="f_cfRequired" style="width:auto" ${field && field.is_required ? 'checked' : ''} /> Obligāts lauks
    </label>
    ${field ? `<label style="display:flex;align-items:center;gap:6px;font-weight:400;margin-top:6px">
      <input type="checkbox" id="f_cfActive" style="width:auto" ${field.is_active ? 'checked' : ''} /> Aktīvs (redzams formā)
    </label>` : ''}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveCustomField(${field ? `'${field.id}'` : 'null'})">Saglabāt</button>
    </div>`);
  if (field && field.field_type === 'select') {
    setTimeout(() => { document.getElementById('cfOptionsRow').style.display = 'block'; }, 0);
  }
}

async function saveCustomField(id) {
  const label = document.getElementById('f_cfLabel').value.trim();
  if (!label) { alert('Nosaukums ir obligāts'); return; }
  try {
    if (id) {
      const field = customFieldsFullCache.find((f) => f.id === id);
      const payload = { label, isRequired: document.getElementById('f_cfRequired').checked, isActive: document.getElementById('f_cfActive').checked };
      if (field.field_type === 'select') {
        payload.options = document.getElementById('f_cfOptions').value.split('\n').map((s) => s.trim()).filter(Boolean);
      }
      await api('/api/custom-fields/' + id, { method: 'PATCH', body: payload });
    } else {
      const fieldKey = document.getElementById('f_cfKey').value.trim();
      const fieldType = document.getElementById('f_cfType').value;
      if (!fieldKey) { alert('Lauka kods ir obligāts'); return; }
      const payload = {
        tableName: customFieldsTabTable, fieldKey, label, fieldType,
        isRequired: document.getElementById('f_cfRequired').checked,
      };
      if (fieldType === 'select') {
        payload.options = document.getElementById('f_cfOptions').value.split('\n').map((s) => s.trim()).filter(Boolean);
      }
      await api('/api/custom-fields', { method: 'POST', body: payload });
    }
    closeModal(); loadCustomFieldsTab();
  } catch (e) { alert(e.message); }
}

// ============================================================
// KATEGORIJAS (ar secību, kādā rādās ticketa formā)
// ============================================================
let categoriesFullCache = [];

async function renderCategoriesTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <p class="muted" style="margin:0">Secība šeit nosaka, kādā kārtībā kategorijas parādās, aizpildot ticketu mobilajā aplikācijā.</p>
      <button class="btn btn-green" onclick="openCategoryForm()">+ Pievienot kategoriju</button>
    </div>
    <table id="categoriesTable"><thead><tr><th>#</th><th>Nosaukums (LV)</th><th>Nosaukums (EN)</th><th>Noklusētā prioritāte</th><th>Statuss</th><th></th></tr></thead><tbody></tbody></table>`;
  await loadCategories();
}

async function loadCategories() {
  const { categories } = await api('/api/categories/all');
  categoriesFullCache = categories;
  const tbody = document.querySelector('#categoriesTable tbody');
  tbody.innerHTML = categories.map((c, idx) => `
    <tr>
      <td>
        <button class="btn btn-sm btn-outline" ${idx === 0 ? 'disabled' : ''} onclick="moveCategory(${c.id}, -1)">↑</button>
        <button class="btn btn-sm btn-outline" ${idx === categories.length - 1 ? 'disabled' : ''} onclick="moveCategory(${c.id}, 1)">↓</button>
      </td>
      <td>${esc(c.name_lv)}</td>
      <td>${esc(c.name_en)}</td>
      <td>${PRIORITY_LABELS_LV[c.default_priority]}</td>
      <td>${c.is_active ? '<span class="badge" style="background:var(--green)">aktīva</span>' : '<span class="badge" style="background:#999">paslēpta</span>'}</td>
      <td><button class="btn btn-sm btn-outline" onclick="openCategoryForm(${c.id})">Rediģēt</button></td>
    </tr>`).join('');
}

async function moveCategory(id, direction) {
  const idx = categoriesFullCache.findIndex((c) => c.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= categoriesFullCache.length) return;
  const reordered = [...categoriesFullCache];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  try {
    await api('/api/categories/reorder', { method: 'POST', body: { orderedIds: reordered.map((c) => c.id) } });
    loadCategories();
  } catch (e) { alert(e.message); }
}

function openCategoryForm(id) {
  const cat = id ? categoriesFullCache.find((c) => c.id === id) : null;
  openModal(`
    <h2>${cat ? 'Rediģēt kategoriju' : 'Jauna kategorija'}</h2>
    ${!cat ? `<label>Kods (unikāls, bez atstarpēm) *</label><input id="f_catCode" placeholder="piem. printers" />` : ''}
    <label>Nosaukums latviski *</label><input id="f_catNameLv" value="${cat ? esc(cat.name_lv) : ''}" />
    <label>Nosaukums angliski *</label><input id="f_catNameEn" value="${cat ? esc(cat.name_en) : ''}" />
    <label>Noklusētā prioritāte</label>
    <select id="f_catPriority">
      ${Object.entries(PRIORITY_LABELS_LV).map(([k, v]) => `<option value="${k}" ${cat && cat.default_priority === k ? 'selected' : ''}>${v}</option>`).join('')}
    </select>
    ${cat ? `<label>Statuss</label><select id="f_catActive"><option value="true" ${cat.is_active ? 'selected' : ''}>Aktīva (redzama formā)</option><option value="false" ${!cat.is_active ? 'selected' : ''}>Paslēpta</option></select>` : ''}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveCategory(${cat ? cat.id : 'null'})">Saglabāt</button>
    </div>`);
}

async function saveCategory(id) {
  const payload = {
    nameLv: document.getElementById('f_catNameLv').value,
    nameEn: document.getElementById('f_catNameEn').value,
    defaultPriority: document.getElementById('f_catPriority').value,
  };
  if (!payload.nameLv || !payload.nameEn) { alert('Abi nosaukumi ir obligāti'); return; }
  try {
    if (id) {
      payload.isActive = document.getElementById('f_catActive').value === 'true';
      await api('/api/categories/' + id, { method: 'PATCH', body: payload });
    } else {
      payload.code = document.getElementById('f_catCode').value.trim();
      if (!payload.code) { alert('Kods ir obligāts'); return; }
      await api('/api/categories', { method: 'POST', body: payload });
    }
    closeModal(); loadCategories();
    const catRes = await api('/api/assets/categories/list');
    state.categories = catRes.categories;
  } catch (e) { alert(e.message); }
}

// ============================================================
// QR UZLĪMJU DRUKĀŠANA
// ============================================================
function printAssetLabels(assets) {
  const printable = assets.filter((a) => a.qr_code);
  if (printable.length === 0) { alert('Nevienai no izvēlētajām iekārtām nav QR koda.'); return; }

  const win = window.open('', '_blank');
  const labelsHtml = printable.map((a, i) => `
    <div class="label">
      <canvas id="qr${i}"></canvas>
      <div class="label-text">
        <div class="label-name">${esc(a.name)}</div>
        <div class="label-tag">${esc(a.asset_tag)}</div>
      </div>
    </div>`).join('');

  win.document.write(`
    <!DOCTYPE html><html><head><title>QR uzlīmes</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js"><\/script>
    <style>
      body { font-family: Arial, sans-serif; margin: 10mm; }
      .sheet { display: flex; flex-wrap: wrap; gap: 4mm; }
      .label { width: 45mm; height: 25mm; border: 1px dashed #999; display: flex; align-items: center; gap: 3mm; padding: 2mm; page-break-inside: avoid; }
      .label canvas { width: 20mm; height: 20mm; flex-shrink: 0; }
      .label-text { overflow: hidden; }
      .label-name { font-size: 8pt; font-weight: 700; line-height: 1.1; }
      .label-tag { font-size: 7pt; color: #555; margin-top: 2px; }
      @media print { .label { border: 1px solid #ccc; } }
    </style></head>
    <body><div class="sheet">${labelsHtml}</div>
    <script>
      window.onload = function() {
        ${printable.map((a, i) => `new QRious({ element: document.getElementById('qr${i}'), value: ${JSON.stringify(a.qr_code)}, size: 200 });`).join('\n')}
        setTimeout(function(){ window.print(); }, 300);
      };
    <\/script>
    </body></html>`);
  win.document.close();
}

// ============================================================
// IEKĀRTAS (ASSETS)
// ============================================================
let assetsCache = [];

async function renderAssetsTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <div>
        <input type="text" id="assetSearch" placeholder="Meklēt (nosaukums, Nr, sērijas Nr)..." oninput="loadAssets()" />
        <select id="assetCategoryFilter" onchange="loadAssets()">
          <option value="">Visas kategorijas</option>
          ${state.categories.map((c) => `<option value="${c.code}">${esc(c.name_lv)}</option>`).join('')}
        </select>
        <select id="assetStatusFilter" onchange="loadAssets()">
          <option value="">Visi statusi</option>
          ${Object.entries(STATUS_LABELS_LV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </div>
      <div>
        <button class="btn btn-outline" onclick="printAssetLabels(assetsCache)">🖶 Drukāt QR uzlīmes (sarakstam)</button>
        <button class="btn btn-outline" onclick="openImportModal('assets')">⬆ Importēt no CSV (Monday)</button>
        <button class="btn btn-green" onclick="openAssetForm()">+ Pievienot iekārtu</button>
      </div>
    </div>
    <table id="assetsTable"><thead><tr>
      <th>Inv. Nr</th><th>Nosaukums</th><th>Kategorija</th><th>Statuss</th><th>Turētājs</th><th>Atrašanās vieta</th><th></th>
    </tr></thead><tbody></tbody></table>`;
  await loadAssets();
}

async function loadAssets() {
  const search = document.getElementById('assetSearch').value;
  const category = document.getElementById('assetCategoryFilter').value;
  const status = document.getElementById('assetStatusFilter').value;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (category) params.set('category', category);
  if (status) params.set('status', status);
  const { assets } = await api('/api/assets?' + params.toString());
  assetsCache = assets;
  const tbody = document.querySelector('#assetsTable tbody');
  tbody.innerHTML = assets.length ? assets.map((a) => `
    <tr class="clickable" onclick="openAssetDetail('${a.id}')">
      <td>${esc(a.asset_tag)}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.category_name)}</td>
      <td><span class="badge" style="background:#888">${STATUS_LABELS_LV[a.status] || a.status}</span></td>
      <td>${esc(a.current_holder) || 'IT nodaļa'}</td>
      <td>${esc(a.location) || '—'}</td>
      <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openAssetForm('${a.id}')">Rediģēt</button></td>
    </tr>`).join('') : `<tr><td colspan="7" class="empty">Nav rezultātu</td></tr>`;
}

async function openAssetForm(id) {
  const asset = id ? assetsCache.find((a) => a.id === id) : null;
  await loadCustomFieldDefs('assets');
  // Iekārtu sarakstā "attributes" nav iekļauts (lai saraksta pieprasījums
  // paliktu ātrs) -- ja rediģē esošu iekārtu, paņemam pilnos datus atsevišķi.
  let existingAttributes = {};
  if (asset) {
    const { asset: fullAsset } = await api('/api/assets/' + id);
    existingAttributes = fullAsset.attributes || {};
  }
  openModal(`
    <h2>${asset ? 'Rediģēt iekārtu' : 'Jauna iekārta'}</h2>
    <label>Inventāra Nr *</label><input id="f_assetTag" value="${asset ? esc(asset.asset_tag) : ''}" ${asset ? 'disabled' : ''} />
    <label>Kategorija *</label>
    <select id="f_categoryCode" ${asset ? 'disabled' : ''}>
      ${state.categories.map((c) => `<option value="${c.code}" ${asset && asset.category_code === c.code ? 'selected' : ''}>${esc(c.name_lv)}</option>`).join('')}
    </select>
    <label>Nosaukums *</label><input id="f_name" value="${asset ? esc(asset.name) : ''}" />
    <label>Ražotājs</label><input id="f_manufacturer" value="${asset ? esc(asset.manufacturer) : ''}" />
    <label>Modelis</label><input id="f_model" value="${asset ? esc(asset.model) : ''}" />
    <label>Sērijas numurs</label><input id="f_serialNumber" value="${asset ? esc(asset.serial_number) : ''}" />
    <label>Atrašanās vieta</label><input id="f_location" value="${asset ? esc(asset.location) : ''}" />
    <label>Piegādātājs</label><input id="f_vendor" value="${asset ? esc(asset.vendor) : ''}" />
    <label>Iepirkuma datums</label><input type="date" id="f_purchaseDate" value="${asset && asset.purchase_date ? asset.purchase_date.slice(0, 10) : ''}" />
    <label>Garantija līdz</label><input type="date" id="f_warrantyUntil" value="${asset && asset.warranty_until ? asset.warranty_until.slice(0, 10) : ''}" />
    ${asset ? `<label>Statuss</label><select id="f_status">${Object.entries(STATUS_LABELS_LV).map(([k, v]) => `<option value="${k}" ${asset.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>` : ''}
    <label>Piezīmes</label><textarea id="f_notes" rows="2">${asset ? esc(asset.notes) : ''}</textarea>
    ${renderCustomFieldsHTML('assets', existingAttributes)}
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveAsset(${asset ? `'${asset.id}'` : 'null'})">Saglabāt</button>
    </div>`);
}

async function saveAsset(id) {
  const payload = {
    name: document.getElementById('f_name').value,
    manufacturer: document.getElementById('f_manufacturer').value,
    model: document.getElementById('f_model').value,
    serialNumber: document.getElementById('f_serialNumber').value,
    location: document.getElementById('f_location').value,
    vendor: document.getElementById('f_vendor').value,
    purchaseDate: document.getElementById('f_purchaseDate').value || null,
    warrantyUntil: document.getElementById('f_warrantyUntil').value || null,
    notes: document.getElementById('f_notes').value,
    customFields: collectCustomFieldValues('assets'),
  };
  try {
    if (id) {
      payload.status = document.getElementById('f_status').value;
      await api('/api/assets/' + id, { method: 'PATCH', body: payload });
    } else {
      payload.assetTag = document.getElementById('f_assetTag').value;
      payload.categoryCode = document.getElementById('f_categoryCode').value;
      if (!payload.assetTag || !payload.name) { alert('Inventāra Nr un nosaukums ir obligāti'); return; }
      await api('/api/assets', { method: 'POST', body: payload });
    }
    closeModal(); loadAssets();
  } catch (e) { alert(e.message); }
}

async function openAssetDetail(id) {
  const { asset, assignments, lifecycle, tickets } = await api('/api/assets/' + id);
  const { users } = await api('/api/users');
  openModal(`
    <h2>${esc(asset.name)}</h2>
    <p class="muted">${esc(asset.asset_tag)} · ${esc(asset.category_name)} · ${STATUS_LABELS_LV[asset.status]}</p>

    <div class="section-title">Piešķiršana</div>
    <p class="muted" style="margin:4px 0">Ja iekārta nav piešķirta nevienam darbiniekam, tā skaitās kā IT nodaļas rīcībā esoša iekārta.</p>
    <div class="map-row">
      <select id="assignUser"><option value="">— izvēlēties darbinieku —</option>${users.map((u) => `<option value="${u.id}">${esc(u.display_name)} (${esc(u.email)})</option>`).join('')}</select>
      <button class="btn btn-sm btn-green" onclick="assignAsset('${id}')">Piešķirt</button>
      <button class="btn btn-sm btn-outline" onclick="unassignAsset('${id}')">Atgriezt</button>
    </div>

    <div class="section-title">Piešķīrumu vēsture</div>
    ${assignments.length ? assignments.map((a) => `<div class="history-item">${esc(a.user_name)} — ${fmtDateTime(a.assigned_at)} ${a.unassigned_at ? '→ ' + fmtDateTime(a.unassigned_at) : '<b>(pašlaik)</b>'}</div>`).join('') : '<p class="muted">Nav ierakstu</p>'}

    <div class="section-title">Dzīves cikla vēsture</div>
    ${lifecycle.length ? lifecycle.map((l) => `<div class="history-item">${fmtDateTime(l.event_at)} — ${esc(l.event_type)}: ${esc(l.description)}</div>`).join('') : '<p class="muted">Nav ierakstu</p>'}

    <div class="section-title">Saistītie ticketi</div>
    ${tickets.length ? tickets.map((t) => `<div class="history-item">${esc(t.ticket_number)} — ${esc(t.title)} <span class="badge" style="background:#888">${TICKET_STATUS_LV[t.status]}</span></div>`).join('') : '<p class="muted">Nav ticketu</p>'}

    <div class="modal-actions">
      <button class="btn btn-outline" onclick="printAssetLabels([asset])">🖶 Drukāt QR uzlīmi</button>
      <button class="btn btn-red" onclick="deleteAsset('${id}')">Dzēst</button>
      <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
    </div>`);
}

async function assignAsset(id) {
  const userId = document.getElementById('assignUser').value;
  if (!userId) { alert('Izvēlieties darbinieku'); return; }
  try { await api('/api/assets/' + id + '/assign', { method: 'POST', body: { userId } }); openAssetDetail(id); loadAssets(); }
  catch (e) { alert(e.message); }
}
async function unassignAsset(id) {
  try { await api('/api/assets/' + id + '/unassign', { method: 'POST' }); openAssetDetail(id); loadAssets(); }
  catch (e) { alert(e.message); }
}
async function deleteAsset(id) {
  if (!confirm('Tiešām dzēst (izslēgt no aktīvās lietošanas) šo iekārtu?')) return;
  try { await api('/api/assets/' + id, { method: 'DELETE' }); closeModal(); loadAssets(); }
  catch (e) { alert(e.message); }
}

// ============================================================
// APLIKĀCIJAS
// ============================================================
let appsCache = [];

async function renderApplicationsTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <input type="text" id="appSearch" placeholder="Meklēt aplikāciju..." oninput="loadApplications()" />
      <div>
        <button class="btn btn-outline" onclick="openImportModal('applications')">⬆ Importēt no CSV</button>
        <button class="btn btn-green" onclick="openAppForm()">+ Pievienot aplikāciju</button>
      </div>
    </div>
    <table id="appsTable"><thead><tr><th>Nosaukums</th><th>Ražotājs</th><th>Kategorija</th><th>Aktīvie lietotāji</th><th>Licences (vietas)</th><th></th></tr></thead><tbody></tbody></table>`;
  await loadApplications();
}

async function loadApplications() {
  const search = document.getElementById('appSearch').value;
  const { applications } = await api('/api/applications' + (search ? '?search=' + encodeURIComponent(search) : ''));
  appsCache = applications;
  const tbody = document.querySelector('#appsTable tbody');
  tbody.innerHTML = applications.length ? applications.map((a) => `
    <tr class="clickable" onclick="openAppDetail('${a.id}')">
      <td>${esc(a.name)}</td><td>${esc(a.vendor) || '—'}</td><td>${esc(a.category) || '—'}</td>
      <td>${a.active_assignments}</td><td>${a.seats_total}</td>
      <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openAppForm('${a.id}')">Rediģēt</button></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Nav rezultātu</td></tr>`;
}

async function openAppForm(id) {
  const app = id ? appsCache.find((a) => a.id === id) : null;
  await loadCustomFieldDefs('applications');
  openModal(`
    <h2>${app ? 'Rediģēt aplikāciju' : 'Jauna aplikācija'}</h2>
    <label>Nosaukums *</label><input id="f_appName" value="${app ? esc(app.name) : ''}" />
    <label>Ražotājs</label><input id="f_appVendor" value="${app ? esc(app.vendor) : ''}" />
    <label>Kategorija</label><input id="f_appCategory" value="${app ? esc(app.category) : ''}" placeholder="piem. productivity, security" />
    <label>Apraksts</label><textarea id="f_appDescription" rows="2">${app ? esc(app.description) : ''}</textarea>
    ${renderCustomFieldsHTML('applications', app?.custom_fields || {})}
    <div class="modal-actions">
      ${app ? `<button class="btn btn-red" onclick="deleteApp('${app.id}')">Dzēst</button>` : ''}
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveApp(${app ? `'${app.id}'` : 'null'})">Saglabāt</button>
    </div>`);
}

async function saveApp(id) {
  const payload = {
    name: document.getElementById('f_appName').value,
    vendor: document.getElementById('f_appVendor').value,
    category: document.getElementById('f_appCategory').value,
    description: document.getElementById('f_appDescription').value,
    customFields: collectCustomFieldValues('applications'),
  };
  if (!payload.name) { alert('Nosaukums ir obligāts'); return; }
  try {
    if (id) await api('/api/applications/' + id, { method: 'PATCH', body: payload });
    else await api('/api/applications', { method: 'POST', body: payload });
    closeModal(); loadApplications();
  } catch (e) { alert(e.message); }
}

async function deleteApp(id) {
  if (!confirm('Dzēst šo aplikāciju?')) return;
  try { await api('/api/applications/' + id, { method: 'DELETE' }); closeModal(); loadApplications(); }
  catch (e) { alert(e.message); }
}

async function openAppDetail(id) {
  const { application, licenses, assignments } = await api('/api/applications/' + id);
  const { users } = await api('/api/users');
  openModal(`
    <h2>${esc(application.name)}</h2>
    <p class="muted">${esc(application.vendor) || ''} · ${esc(application.category) || ''}</p>

    <div class="section-title">Piešķirt lietotājam</div>
    <div class="map-row">
      <select id="appAssignUser"><option value="">— izvēlēties darbinieku —</option>${users.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select>
      <button class="btn btn-sm btn-green" onclick="assignApp('${id}')">Piešķirt</button>
    </div>

    <div class="section-title">Licences</div>
    ${licenses.length ? licenses.map((l) => `<div class="history-item">${l.seats_total} vietas · derīga līdz ${fmtDate(l.expires_at)} ${l.vendor ? '· ' + esc(l.vendor) : ''}</div>`).join('') : '<p class="muted">Nav reģistrētu licenču</p>'}
    <button class="btn btn-sm btn-outline" onclick="addLicense('${id}')">+ Pievienot licenci</button>

    <div class="section-title">Piešķīrumu vēsture</div>
    ${assignments.length ? assignments.map((a) => `<div class="history-item">${esc(a.user_name || a.asset_name)} — ${fmtDateTime(a.assigned_at)} ${a.unassigned_at ? '→ ' + fmtDateTime(a.unassigned_at) : '<b>(pašlaik)</b>'} ${a.is_current ? `<button class="btn btn-sm btn-outline" onclick="revokeApp('${a.id}', '${id}')">Atsaukt</button>` : ''}</div>`).join('') : '<p class="muted">Nav ierakstu</p>'}

    <div class="modal-actions"><button class="btn btn-outline" onclick="closeModal()">Aizvērt</button></div>`);
}

async function assignApp(appId) {
  const userId = document.getElementById('appAssignUser').value;
  if (!userId) { alert('Izvēlieties darbinieku'); return; }
  try { await api('/api/applications/' + appId + '/assign', { method: 'POST', body: { userId } }); openAppDetail(appId); loadApplications(); }
  catch (e) { alert(e.message); }
}
async function revokeApp(assignmentId, appId) {
  try { await api('/api/applications/assignments/' + assignmentId + '/revoke', { method: 'POST' }); openAppDetail(appId); }
  catch (e) { alert(e.message); }
}
async function addLicense(appId) {
  const seats = prompt('Cik lietotāju vietas (seats)?', '1');
  if (seats === null) return;
  try { await api('/api/applications/' + appId + '/licenses', { method: 'POST', body: { seatsTotal: parseInt(seats, 10) || 1 } }); openAppDetail(appId); }
  catch (e) { alert(e.message); }
}

// ============================================================
// TĀLRUŅU NUMURI
// ============================================================
let phonesCache = [];

async function renderPhonesTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <div></div>
      <div>
        <button class="btn btn-outline" onclick="openImportModal('phone-numbers')">⬆ Importēt no CSV</button>
        <button class="btn btn-green" onclick="openPhoneForm()">+ Pievienot numuru</button>
      </div>
    </div>
    <table id="phonesTable"><thead><tr><th>Numurs</th><th>Operators</th><th>Plāns</th><th>Turētājs</th><th></th></tr></thead><tbody></tbody></table>`;
  await loadPhones();
}

async function loadPhones() {
  const { phoneNumbers } = await api('/api/phone-numbers');
  phonesCache = phoneNumbers;
  const tbody = document.querySelector('#phonesTable tbody');
  tbody.innerHTML = phoneNumbers.length ? phoneNumbers.map((p) => `
    <tr>
      <td>${esc(p.number)}</td><td>${esc(p.carrier) || '—'}</td><td>${esc(p.plan_name) || '—'}</td>
      <td>${esc(p.current_holder) || '—'}</td>
      <td>
        <button class="btn btn-sm btn-outline" onclick="openPhoneAssign('${p.id}')">Piešķirt</button>
        <button class="btn btn-sm btn-outline" onclick="openPhoneForm('${p.id}')">Rediģēt</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="5" class="empty">Nav rezultātu</td></tr>`;
}

async function openPhoneForm(id) {
  const p = id ? phonesCache.find((x) => x.id === id) : null;
  await loadCustomFieldDefs('phone_numbers');
  openModal(`
    <h2>${p ? 'Rediģēt numuru' : 'Jauns numurs'}</h2>
    <label>Numurs *</label><input id="f_phoneNumber" value="${p ? esc(p.number) : ''}" ${p ? 'disabled' : ''} />
    <label>Operators</label><input id="f_carrier" value="${p ? esc(p.carrier) : ''}" />
    <label>Plāns</label><input id="f_planName" value="${p ? esc(p.plan_name) : ''}" />
    <label>Mēneša maksa (EUR)</label><input type="number" step="0.01" id="f_monthlyCost" value="${p ? p.monthly_cost || '' : ''}" />
    ${renderCustomFieldsHTML('phone_numbers', p?.custom_fields || {})}
    <div class="modal-actions">
      ${p ? `<button class="btn btn-red" onclick="deletePhone('${p.id}')">Dzēst</button>` : ''}
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="savePhone(${p ? `'${p.id}'` : 'null'})">Saglabāt</button>
    </div>`);
}

async function savePhone(id) {
  const payload = {
    carrier: document.getElementById('f_carrier').value,
    planName: document.getElementById('f_planName').value,
    monthlyCost: parseFloat(document.getElementById('f_monthlyCost').value) || null,
    customFields: collectCustomFieldValues('phone_numbers'),
  };
  try {
    if (id) await api('/api/phone-numbers/' + id, { method: 'PATCH', body: payload });
    else {
      payload.number = document.getElementById('f_phoneNumber').value;
      if (!payload.number) { alert('Numurs ir obligāts'); return; }
      await api('/api/phone-numbers', { method: 'POST', body: payload });
    }
    closeModal(); loadPhones();
  } catch (e) { alert(e.message); }
}
async function deletePhone(id) {
  if (!confirm('Dzēst šo numuru?')) return;
  try { await api('/api/phone-numbers/' + id, { method: 'DELETE' }); closeModal(); loadPhones(); }
  catch (e) { alert(e.message); }
}
async function openPhoneAssign(id) {
  const { users } = await api('/api/users');
  openModal(`
    <h2>Piešķirt numuru</h2>
    <label>Darbinieks</label>
    <select id="phoneAssignUser">${users.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join('')}</select>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="confirmPhoneAssign('${id}')">Piešķirt</button>
    </div>`);
}
async function confirmPhoneAssign(id) {
  const userId = document.getElementById('phoneAssignUser').value;
  try { await api('/api/phone-numbers/' + id + '/assign', { method: 'POST', body: { userId } }); closeModal(); loadPhones(); }
  catch (e) { alert(e.message); }
}

// ============================================================
// PIEKĻUVES TIESĪBAS
// ============================================================
async function renderAccessTab() {
  const { users } = await api('/api/users');
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <select id="accessUserSelect" onchange="loadAccessForUser()">
        <option value="">— izvēlēties darbinieku —</option>
        ${users.map((u) => `<option value="${u.id}">${esc(u.display_name)} (${esc(u.email)})</option>`).join('')}
      </select>
      <button class="btn btn-green" onclick="openGrantAccessForm()">+ Piešķirt piekļuvi</button>
    </div>
    <div id="accessList" class="muted">Izvēlieties darbinieku, lai redzētu piekļuves tiesības.</div>`;
}

async function loadAccessForUser() {
  const userId = document.getElementById('accessUserSelect').value;
  const listEl = document.getElementById('accessList');
  if (!userId) { listEl.innerHTML = '<p class="muted">Izvēlieties darbinieku.</p>'; return; }
  const { accessRights } = await api('/api/access-rights?userId=' + userId);
  listEl.innerHTML = accessRights.length ? `<table><thead><tr><th>Sistēma</th><th>Līmenis</th><th>Piešķirts</th><th>Statuss</th><th></th></tr></thead><tbody>
    ${accessRights.map((a) => `<tr>
      <td>${esc(a.system_name)}</td><td>${esc(a.access_level)}</td><td>${fmtDate(a.granted_at)}</td>
      <td>${a.is_current ? '<span class="badge" style="background:var(--green)">aktīva</span>' : '<span class="badge" style="background:#999">atsaukta ' + fmtDate(a.revoked_at) + '</span>'}</td>
      <td>${a.is_current ? `<button class="btn btn-sm btn-outline" onclick="revokeAccess('${a.id}')">Atsaukt</button>` : ''}</td>
    </tr>`).join('')}</tbody></table>` : '<p class="muted">Nav piešķirtu piekļuvju.</p>';
}

async function revokeAccess(id) {
  try { await api('/api/access-rights/' + id + '/revoke', { method: 'PATCH' }); loadAccessForUser(); }
  catch (e) { alert(e.message); }
}

async function openGrantAccessForm() {
  const userId = document.getElementById('accessUserSelect').value;
  if (!userId) { alert('Vispirms izvēlieties darbinieku'); return; }
  const { systems } = await api('/api/access-rights/systems');
  openModal(`
    <h2>Piešķirt piekļuvi</h2>
    <label>Sistēma</label>
    <select id="f_systemCode">${systems.map((s) => `<option value="${s.code}">${esc(s.name)}</option>`).join('')}</select>
    <label>Līmenis</label>
    <select id="f_accessLevel"><option value="read">Lasīšana</option><option value="user" selected>Lietotājs</option><option value="power_user">Pieredzējis lietotājs</option><option value="admin">Administrators</option></select>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="grantAccess('${userId}')">Piešķirt</button>
    </div>`);
}

async function grantAccess(userId) {
  const systemCode = document.getElementById('f_systemCode').value;
  const accessLevel = document.getElementById('f_accessLevel').value;
  try { await api('/api/access-rights', { method: 'POST', body: { userId, systemCode, accessLevel } }); closeModal(); loadAccessForUser(); }
  catch (e) { alert(e.message); }
}

// ============================================================
// DARBINIEKI
// ============================================================
async function renderEmployeesTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar"><input type="text" id="empSearch" placeholder="Meklēt darbinieku..." oninput="loadEmployees()" /><div></div></div>
    <table id="empTable"><thead><tr><th>Vārds</th><th>E-pasts</th><th>Nodaļa</th><th>Konta veids</th><th>Loma</th><th></th></tr></thead><tbody></tbody></table>`;
  await loadEmployees();
}

async function loadEmployees() {
  const search = document.getElementById('empSearch').value;
  const { users } = await api('/api/users' + (search ? '?search=' + encodeURIComponent(search) : ''));
  const tbody = document.querySelector('#empTable tbody');
  tbody.innerHTML = users.length ? users.map((u) => `
    <tr class="clickable" onclick="openEmployeeProfile('${u.id}')">
      <td>${esc(u.display_name)}</td><td>${esc(u.email)}</td><td>${esc(u.department) || '—'}</td>
      <td>${u.auth_provider === 'microsoft' ? 'MS365 (iekšējais)' : 'Google (ārējais)'}</td>
      <td>${esc(u.role)}</td><td></td>
    </tr>`).join('') : `<tr><td colspan="6" class="empty">Nav rezultātu</td></tr>`;
}

async function openEmployeeProfile(id) {
  const { user, assets, applications, phoneNumbers, accessRights, tickets } = await api('/api/users/' + id + '/profile');
  openModal(`
    <h2>${esc(user.display_name)}</h2>
    <p class="muted">${esc(user.email)} · ${user.auth_provider === 'microsoft' ? 'MS365 (iekšējais)' : 'Google (ārējais)'}</p>

    <div class="section-title">Piešķirtās iekārtas</div>
    ${assets.length ? assets.map((a) => `<div class="history-item">${esc(a.name)} (${esc(a.category_name)}) — kopš ${fmtDate(a.assigned_at)}</div>`).join('') : '<p class="muted">Nav</p>'}

    <div class="section-title">Aplikācijas</div>
    ${applications.length ? applications.map((a) => `<div class="history-item">${esc(a.name)} — kopš ${fmtDate(a.assigned_at)}</div>`).join('') : '<p class="muted">Nav</p>'}

    <div class="section-title">Tālruņa numuri</div>
    ${phoneNumbers.length ? phoneNumbers.map((p) => `<div class="history-item">${esc(p.number)} (${esc(p.carrier) || '—'})</div>`).join('') : '<p class="muted">Nav</p>'}

    <div class="section-title">Piekļuves tiesības</div>
    ${accessRights.length ? accessRights.map((a) => `<div class="history-item">${esc(a.system_name)} — ${esc(a.access_level)}</div>`).join('') : '<p class="muted">Nav</p>'}

    <div class="section-title">Pēdējie ticketi</div>
    ${tickets.length ? tickets.map((t) => `<div class="history-item">${esc(t.ticket_number)} — ${esc(t.title)} <span class="badge" style="background:#888">${TICKET_STATUS_LV[t.status]}</span></div>`).join('') : '<p class="muted">Nav</p>'}

    <div class="modal-actions"><button class="btn btn-outline" onclick="closeModal()">Aizvērt</button></div>`);
}

// ============================================================
// CSV IMPORTS (Monday.com un citi)
// ============================================================
const IMPORT_FIELD_SETS = {
  assets: [
    ['assetTag', 'Inventāra Nr'], ['categoryCode', 'Kategorija'], ['name', 'Nosaukums *'],
    ['manufacturer', 'Ražotājs'], ['model', 'Modelis'], ['serialNumber', 'Sērijas numurs'],
    ['location', 'Atrašanās vieta'], ['vendor', 'Piegādātājs'], ['purchaseDate', 'Iepirkuma datums'],
    ['warrantyUntil', 'Garantija līdz'], ['status', 'Statuss'], ['notes', 'Piezīmes'],
  ],
  applications: [['name', 'Nosaukums *'], ['vendor', 'Ražotājs'], ['category', 'Kategorija'], ['description', 'Apraksts']],
  'phone-numbers': [['number', 'Numurs *'], ['carrier', 'Operators'], ['planName', 'Plāns'], ['monthlyCost', 'Mēneša maksa']],
};

let importState = { target: null, csvRows: [], csvHeaders: [] };

function openImportModal(target) {
  importState = { target, csvRows: [], csvHeaders: [] };
  openModal(`
    <h2>Importēt no CSV</h2>
    <p class="muted">Eksportējiet sarakstu no Monday.com kā CSV (board → ⋯ izvēlne → Export board / Export to Excel/CSV), tad augšupielādējiet šeit failu.</p>
    <input type="file" id="csvFile" accept=".csv" onchange="handleCsvFile(event)" />
    <div id="importMappingArea"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Aizvērt</button>
    </div>`);
}

function handleCsvFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      importState.csvRows = results.data;
      importState.csvHeaders = results.meta.fields || [];
      renderImportMapping();
    },
    error: (err) => alert('Neizdevās nolasīt CSV: ' + err.message),
  });
}

function renderImportMapping() {
  const fields = IMPORT_FIELD_SETS[importState.target];
  const headers = importState.csvHeaders;
  const area = document.getElementById('importMappingArea');
  area.innerHTML = `
    <p class="muted">${importState.csvRows.length} rindas atrastas. Sasaistiet CSV kolonnas ar sistēmas laukiem:</p>
    ${fields.map(([key, label]) => `
      <div class="map-row">
        <label>${label}</label>
        <select id="map_${key}">
          <option value="">— neizmantot —</option>
          ${headers.map((h) => `<option value="${esc(h)}" ${h.toLowerCase() === label.toLowerCase().replace(' *', '') ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select>
      </div>`).join('')}
    <div class="import-preview"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${importState.csvRows.slice(0, 5).map((r) => `<tr>${headers.map((h) => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <button class="btn btn-primary" onclick="runImport()">Importēt ${importState.csvRows.length} rindas</button>
    <div id="importResult"></div>`;
}

async function runImport() {
  const fields = IMPORT_FIELD_SETS[importState.target];
  const mapping = {};
  fields.forEach(([key]) => { mapping[key] = document.getElementById('map_' + key).value; });

  const rows = importState.csvRows.map((row) => {
    const mapped = {};
    fields.forEach(([key]) => { if (mapping[key]) mapped[key] = row[mapping[key]]; });
    return mapped;
  });

  try {
    const result = await api('/api/import/' + importState.target, { method: 'POST', body: { rows } });
    document.getElementById('importResult').innerHTML = `
      <div class="result-box">
        ✅ Pievienots: ${result.inserted} &nbsp; 🔄 Atjaunināts: ${result.updated} &nbsp; ⚠️ Kļūdas: ${result.errors.length}
        ${result.errors.length ? '<br>' + result.errors.map((e) => `Rinda ${e.row}: ${esc(e.error)}`).join('<br>') : ''}
      </div>`;
    if (importState.target === 'assets') loadAssets();
    if (importState.target === 'applications') loadApplications();
    if (importState.target === 'phone-numbers') loadPhones();
  } catch (e) { alert(e.message); }
}

// ---------- Startēšana ----------
if (state.token) {
  api('/api/users/me').then(({ user }) => { state.user = user; boot(); })
    .catch(() => { localStorage.removeItem('admin_token'); state.token = null; });
}
