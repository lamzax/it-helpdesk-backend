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
    ['assets', 'Iekārtas'], ['applications', 'Programmas'], ['phones', 'Tālruņu numuri'],
    ['access', 'Piekļuves tiesības'], ['employees', 'Darbinieki'], ['categories', 'Kategorijas'],
    ['customFields', 'Pielāgotie lauki'],
  ];
  const nav = document.getElementById('mainNav');
  nav.innerHTML = tabs.map(([key, label]) =>
    `<button class="${state.tab === key ? 'active' : ''}" onclick="setTab('${key}')">${label}</button>`
  ).join('');
}

function setTab(tab) {
  clearInterval(ticketsPollInterval);
  state.tab = tab; renderNav(); renderTab();
}

function renderTab() {
  const map = { tickets: renderTicketsTab, assets: renderAssetsTab, applications: renderApplicationsTab, phones: renderPhonesTab, access: renderAccessTab, employees: renderEmployeesTab, categories: renderCategoriesTab, customFields: renderCustomFieldsTab };
  map[state.tab]();
}

function closeModal() {
  document.getElementById('overlay').classList.remove('open');
  clearInterval(ticketDetailPollInterval);
  currentTicketDetailId = null;
}
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

let ticketsPollInterval = null;
const TICKETS_POLL_MS = 15000; // saraksts atsvaidzinās automātiski, lai admin redzētu jaunus/mainītus ticketus bez manuālas pārlādes

async function renderTicketsTab() {
  const { categories: ticketCats } = await api('/api/categories');
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
          ${ticketCats.map((c) => `<option value="${c.code}">${esc(c.name_lv)}</option>`).join('')}
        </select>
      </div>
      <div></div>
    </div>
    <table id="ticketsTable"><thead><tr>
      <th>Nr</th><th>Nosaukums</th><th>Kategorija</th><th>Apakškat. / Programma</th><th>Prioritāte</th><th>Statuss</th><th>Pieteica</th><th>Datums</th>
    </tr></thead><tbody></tbody></table>`;
  await loadTickets();
  clearInterval(ticketsPollInterval);
  ticketsPollInterval = setInterval(loadTickets, TICKETS_POLL_MS);
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
      <td>${esc(t.title)}${t.attachment_count > 0 ? ` <span class="muted">${t.has_image ? '🖼️' : ''}${t.has_video ? '🎥' : ''}${t.has_audio ? '🎙️' : ''}</span>` : ''}</td>
      <td>${esc(t.category_name)}</td>
      <td>${esc(t.subcategory_name) || esc(t.application_name) || '—'}</td>
      <td><span class="badge" style="background:${PRIORITY_COLORS[t.priority]}">${PRIORITY_LABELS_LV[t.priority]}</span></td>
      <td><span class="badge" style="background:${STATUS_COLORS[t.status]}">${TICKET_STATUS_LV[t.status]}</span></td>
      <td>${esc(t.reporter_name)}</td>
      <td>${fmtDateTime(t.created_at)}</td>
    </tr>`).join('') : `<tr><td colspan="8" class="empty">Nav ticketu</td></tr>`;
}

let ticketDetailPollInterval = null;
let currentTicketDetailId = null;
const TICKET_DETAIL_POLL_MS = 8000;

function attachmentIconOrThumb(a) {
  const mime = a.mime_type || '';
  const fullUrl = a.file_url;
  if (mime.startsWith('image/')) {
    return `<a href="${esc(fullUrl)}" target="_blank"><img src="${esc(fullUrl)}" class="attachment-thumb" alt="${esc(a.file_name || '')}" /></a>`;
  }
  const icon = mime.startsWith('video/') ? '🎥' : mime.startsWith('audio/') ? '🎙️' : '📎';
  return `<a href="${esc(fullUrl)}" target="_blank" class="attachment-icon-link">
    <span class="attachment-icon">${icon}</span><span>${esc(a.file_name || fullUrl)}</span>
  </a>`;
}

async function openTicketDetail(id) {
  currentTicketDetailId = id;
  const { ticket, comments, attachments } = await api('/api/tickets/' + id);
  openModal(`
    <h2>${esc(ticket.ticket_number)} — ${esc(ticket.title)}</h2>
    <p class="muted">${esc(ticket.category_name)} · Pieteica: ${esc(ticket.reporter_name)} (${esc(ticket.reporter_email)}) · ${fmtDateTime(ticket.created_at)}</p>
    ${ticket.subcategory_name ? `<p class="muted">Apakškategorija: ${esc(ticket.subcategory_name)}</p>` : ''}
    ${ticket.application_name ? `<p class="muted">Programma: ${esc(ticket.application_name)}</p>` : ''}
    ${ticket.device_name ? `<p class="muted">Iekārta: ${esc(ticket.device_name)}${ticket.device_location ? ' · ' + esc(ticket.device_location) : ''}</p>` : ''}
    ${ticket.description ? `<p>${esc(ticket.description)}</p>` : ''}

    <div class="section-title">Statuss</div>
    <div class="tabs-inline">
      ${Object.entries(TICKET_STATUS_LV).map(([k, v]) => `<button class="${ticket.status === k ? 'active' : ''}" onclick="changeTicketStatus('${id}','${k}')">${v}</button>`).join('')}
    </div>

    <div class="section-title">Pielikumi</div>
    <div class="attachments-grid">
      ${attachments.length ? attachments.map((a) => attachmentIconOrThumb(a)).join('') : '<p class="muted">Nav pielikumu</p>'}
    </div>

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
  clearInterval(ticketDetailPollInterval);
  ticketDetailPollInterval = setInterval(() => {
    if (currentTicketDetailId === id) openTicketDetail(id);
  }, TICKET_DETAIL_POLL_MS);
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
  ['assets', 'Iekārtas'], ['tickets', 'Ticketi'], ['applications', 'Programmas'], ['phone_numbers', 'Tālruņu numuri'],
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
// KATEGORIJAS -- vienots skats: pamatkategorijas UN apakškategorijas
// vienā sarakstā, ar meklēšanu, pievienošanu (izvēloties tipu) un
// REĀLU dzēšanu (nevis tikai paslēpšanu).
// ============================================================
let categoryTreeCache = [];

async function renderCategoriesTab() {
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <input type="text" id="categorySearch" placeholder="Meklēt kategoriju vai apakškategoriju..." oninput="loadCategoryTree()" />
      <button class="btn btn-green" onclick="openCategoryForm()">+ Pievienot kategoriju</button>
    </div>
    <table id="categoriesTable"><thead><tr><th></th><th>Nosaukums</th><th>Tips</th><th></th></tr></thead><tbody></tbody></table>`;
  await loadCategoryTree();
}

async function loadCategoryTree() {
  const search = document.getElementById('categorySearch')?.value.trim() || '';
  const { categories } = await api('/api/categories/all' + (search ? '?search=' + encodeURIComponent(search) : ''));
  categoryTreeCache = categories; // plakans saraksts: { id, name_lv, name_en, parent_id, parent_name, sort_order }
  renderCategoryRows();
}

function renderCategoryRows() {
  const tbody = document.querySelector('#categoriesTable tbody');
  const search = document.getElementById('categorySearch')?.value.trim() || '';
  const isProgramsRow = (c) => c.code === 'programs' || c.parent_code === 'programs';
  const actionsFor = (c, isRoot) => isProgramsRow(c)
    ? `<span class="muted">Pārvaldiet "Programmas" sadaļā</span>`
    : `<button class="btn btn-sm btn-outline" onclick="openCategoryForm(${c.id})">Rediģēt</button>
       <button class="btn btn-sm btn-red" onclick="deleteCategory(${c.id}, ${isRoot})">Dzēst</button>`;

  if (search) {
    // Meklēšanas režīmā serveris atgriež TIKAI atbilstošās rindas (var būt
    // apakškategorija bez tās pamatkategorijas klāt) -- tāpēc rādām plakanu
    // sarakstu, katrai apakškategorijai parādot pamatkategorijas nosaukumu.
    const rows = categoryTreeCache.map((c) => `
      <tr>
        <td></td>
        <td>${c.parent_id ? `<span class="muted">${esc(c.parent_name || '')} ›</span> ` : ''}${esc(c.name_lv)}</td>
        <td>${c.parent_id ? 'Apakškategorija' : 'Pamatkategorija'}</td>
        <td>${actionsFor(c, !c.parent_id)}</td>
      </tr>`).join('');
    tbody.innerHTML = rows || `<tr><td colspan="4" class="empty">Nav rezultātu</td></tr>`;
    return;
  }

  const roots = categoryTreeCache.filter((c) => !c.parent_id);
  const rows = [];

  roots.forEach((cat, catIdx) => {
    const children = categoryTreeCache.filter((c) => c.parent_id === cat.id);
    rows.push(`
      <tr>
        <td>
          <button class="btn btn-sm btn-outline" ${catIdx === 0 ? 'disabled' : ''} onclick="moveCategory(${cat.id}, -1)">↑</button>
          <button class="btn btn-sm btn-outline" ${catIdx === roots.length - 1 ? 'disabled' : ''} onclick="moveCategory(${cat.id}, 1)">↓</button>
        </td>
        <td><b>${esc(cat.name_lv)}</b>${cat.code === 'programs' ? ' <span class="muted">(sinhronizēts ar "Programmas" sadaļu)</span>' : ''}</td>
        <td>Pamatkategorija</td>
        <td>${actionsFor(cat, true)}</td>
      </tr>`);

    children.forEach((sub, subIdx) => {
      rows.push(`
        <tr>
          <td>
            <button class="btn btn-sm btn-outline" ${subIdx === 0 ? 'disabled' : ''} onclick="moveSubcategory(${cat.id}, ${sub.id}, -1)">↑</button>
            <button class="btn btn-sm btn-outline" ${subIdx === children.length - 1 ? 'disabled' : ''} onclick="moveSubcategory(${cat.id}, ${sub.id}, 1)">↓</button>
          </td>
          <td style="padding-left: 28px">↳ ${esc(sub.name_lv)}</td>
          <td>Apakškategorija</td>
          <td>${actionsFor({ ...sub, parent_code: cat.code }, false)}</td>
        </tr>`);
    });
  });

  tbody.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="4" class="empty">Nav rezultātu</td></tr>`;
}

async function moveCategory(id, direction) {
  const roots = categoryTreeCache.filter((c) => !c.parent_id);
  const idx = roots.findIndex((c) => c.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= roots.length) return;
  const reordered = [...roots];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  try {
    await api('/api/categories/reorder', { method: 'POST', body: { orderedIds: reordered.map((c) => c.id) } });
    loadCategoryTree();
  } catch (e) { alert(e.message); }
}

async function moveSubcategory(parentId, subId, direction) {
  const children = categoryTreeCache.filter((c) => c.parent_id === parentId);
  const idx = children.findIndex((s) => s.id === subId);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= children.length) return;
  const reordered = [...children];
  [reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]];
  try {
    await api('/api/categories/reorder-children', { method: 'POST', body: { parentId, orderedIds: reordered.map((s) => s.id) } });
    loadCategoryTree();
  } catch (e) { alert(e.message); }
}

// "Pievienot kategoriju" -- viena forma abiem gadījumiem: lietotājs vispirms
// izvēlas, vai tā ir pamatkategorija vai apakškategorija (un, ja apakš --
// kurai pamatkategorijai tā pieder).
function openCategoryForm(editCategoryId) {
  const editing = editCategoryId ? categoryTreeCache.find((c) => c.id === editCategoryId) : null;
  const roots = categoryTreeCache.filter((c) => !c.parent_id && c.code !== 'programs');
  openModal(`
    <h2>${editing ? 'Rediģēt kategoriju' : 'Jauna kategorija'}</h2>
    ${!editing ? `
      <label>Tips *</label>
      <select id="f_catType" onchange="document.getElementById('parentCatRow').style.display = this.value === 'sub' ? 'block' : 'none'">
        <option value="main">Pamatkategorija</option>
        <option value="sub">Apakškategorija</option>
      </select>
      <div id="parentCatRow" style="display:none">
        <label>Pieder pie pamatkategorijas *</label>
        <select id="f_catParent">
          ${roots.map((c) => `<option value="${c.id}">${esc(c.name_lv)}</option>`).join('')}
        </select>
        <p class="muted">("Programmas" nav sarakstā -- programmas pievieno "Programmas" sadaļā)</p>
      </div>
    ` : `<p class="muted">${editing.parent_id ? 'Apakškategorija (' + esc(editing.parent_name) + ')' : 'Pamatkategorija'}</p>`}
    <label>Nosaukums *</label>
    <input id="f_catName" value="${editing ? esc(editing.name_lv) : ''}" placeholder="piem. Skeneri" />
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Atcelt</button>
      <button class="btn btn-primary" onclick="saveCategoryForm(${editCategoryId || 'null'})">Saglabāt</button>
    </div>`);
}

async function saveCategoryForm(editCategoryId) {
  const nameLv = document.getElementById('f_catName').value.trim();
  if (!nameLv) { alert('Nosaukums ir obligāts'); return; }
  try {
    if (editCategoryId) {
      await api('/api/categories/' + editCategoryId, { method: 'PATCH', body: { nameLv } });
    } else {
      const type = document.getElementById('f_catType').value;
      const parentId = type === 'sub' ? document.getElementById('f_catParent').value : undefined;
      await api('/api/categories', { method: 'POST', body: { nameLv, parentId } });
    }
    closeModal();
    await loadCategoryTree();
  } catch (e) { alert(e.message); }
}

async function deleteCategory(id, isRoot) {
  const msg = isRoot
    ? 'Tiešām dzēst šo PAMATKATEGORIJU? Tiks dzēstas arī VISAS tās apakškategorijas. Vecajiem ticketiem kategorija kļūs tukša.'
    : 'Tiešām dzēst šo apakškategoriju? Vecajiem ticketiem tā kļūs tukša.';
  if (!confirm(msg)) return;
  try {
    await api('/api/categories/' + id, { method: 'DELETE' });
    await loadCategoryTree();
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
let assetCategoryTreeCache = [];

async function loadAssetCategoryTree() {
  const { categories } = await api('/api/assets/categories/list');
  assetCategoryTreeCache = categories; // plakans saraksts (root+bērni), IZŅEMOT "Programmas"
  return categories;
}

// Renderē <select> ar <optgroup> pa pamatkategorijām -- "smuki", lai redz,
// kas zem kā, izmantojot TIEŠI tās kategorijas, kas reģistrētas Kategoriju sadaļā.
function renderAssetCategorySelect(selectedId, disabled) {
  const roots = assetCategoryTreeCache.filter((c) => !c.parent_id);
  const optgroups = roots.map((root) => {
    const children = assetCategoryTreeCache.filter((c) => c.parent_id === root.id);
    const rootOption = `<option value="${root.id}" ${String(selectedId) === String(root.id) ? 'selected' : ''}>(vispārīgi) ${esc(root.name_lv)}</option>`;
    const childOptions = children.map((ch) =>
      `<option value="${ch.id}" ${String(selectedId) === String(ch.id) ? 'selected' : ''}>— ${esc(ch.name_lv)}</option>`
    ).join('');
    return `<optgroup label="${esc(root.name_lv)}">${rootOption}${childOptions}</optgroup>`;
  }).join('');
  return `<select id="f_categoryId" ${disabled ? 'disabled' : ''}>
    <option value="">— nav izvēlēts —</option>${optgroups}
  </select>`;
}

async function renderAssetsTab() {
  await loadAssetCategoryTree();
  const roots = assetCategoryTreeCache.filter((c) => !c.parent_id);
  const main = document.getElementById('mainContent');
  main.innerHTML = `
    <div class="toolbar">
      <div>
        <input type="text" id="assetSearch" placeholder="Meklēt (nosaukums, Nr, sērijas Nr)..." oninput="loadAssets()" />
        <select id="assetCategoryFilter" onchange="loadAssets()">
          <option value="">Visas kategorijas</option>
          ${roots.map((root) => {
            const children = assetCategoryTreeCache.filter((c) => c.parent_id === root.id);
            return `<optgroup label="${esc(root.name_lv)}">
              <option value="${root.id}">(vispārīgi) ${esc(root.name_lv)}</option>
              ${children.map((ch) => `<option value="${ch.id}">— ${esc(ch.name_lv)}</option>`).join('')}
            </optgroup>`;
          }).join('')}
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
    <table id="assetsTable"><thead><tr id="assetsTableHead"></tr></thead><tbody></tbody></table>`;
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
  const [{ assets }, customFieldDefs] = await Promise.all([
    api('/api/assets?' + params.toString()),
    loadCustomFieldDefs('assets'),
  ]);
  assetsCache = assets;

  // Saraksta kolonnas SASKAN ar pievienošanas/rediģēšanas formas laukiem.
  document.getElementById('assetsTableHead').innerHTML =
    `<th>Inv. Nr</th><th>Nosaukums</th><th>Kategorija</th><th>Ražotājs</th><th>Modelis</th>
     <th>Sērijas Nr</th><th>Statuss</th><th>Turētājs</th><th>Atrašanās vieta</th>
     <th>Piegādātājs</th><th>Iepirkuma datums</th><th>Garantija līdz</th><th>Piezīmes</th>` +
    customFieldDefs.map((f) => `<th>${esc(f.label)}</th>`).join('') +
    `<th></th>`;

  const tbody = document.querySelector('#assetsTable tbody');
  tbody.innerHTML = assets.length ? assets.map((a) => `
    <tr class="clickable" onclick="openAssetDetail('${a.id}')">
      <td>${esc(a.asset_tag)}</td>
      <td>${esc(a.name)}</td>
      <td>${esc(a.category_name) || '—'}</td>
      <td>${esc(a.manufacturer) || '—'}</td>
      <td>${esc(a.model) || '—'}</td>
      <td>${esc(a.serial_number) || '—'}</td>
      <td><span class="badge" style="background:#888">${STATUS_LABELS_LV[a.status] || a.status}</span></td>
      <td>${esc(a.current_holder) || 'IT nodaļa'}</td>
      <td>${esc(a.location) || '—'}</td>
      <td>${esc(a.vendor) || '—'}</td>
      <td>${fmtDate(a.purchase_date)}</td>
      <td>${fmtDate(a.warranty_until)}</td>
      <td>${esc(a.notes) || '—'}</td>
      ${customFieldDefs.map((f) => {
        const val = (a.attributes || {})[f.field_key];
        const display = f.field_type === 'boolean' ? (val ? '✓' : '—') : (val ?? '—');
        return `<td>${esc(display)}</td>`;
      }).join('')}
      <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openAssetForm('${a.id}')">Rediģēt</button></td>
    </tr>`).join('') : `<tr><td colspan="${14 + customFieldDefs.length}" class="empty">Nav rezultātu</td></tr>`;
}

async function openAssetForm(id) {
  const asset = id ? assetsCache.find((a) => a.id === id) : null;
  await Promise.all([loadCustomFieldDefs('assets'), loadAssetCategoryTree()]);
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
    <label>Kategorija</label>
    ${renderAssetCategorySelect(asset ? asset.category_id : null, false)}
    <label>Nosaukums *</label><input id="f_name" value="${asset ? esc(asset.name) : ''}" />
    <label>Ražotājs</label><input id="f_manufacturer" value="${asset ? esc(asset.manufacturer) : ''}" />
    <label>Modelis</label><input id="f_model" value="${asset ? esc(asset.model) : ''}" />
    <label>Sērijas numurs</label><input id="f_serialNumber" value="${asset ? esc(asset.serial_number) : ''}" />
    <label>Turētājs</label>
    <p class="muted" style="margin:2px 0">Turētāju maina ar pogu "Piešķirt"/"Atgriezt" iekārtas kartītē (skatīt vēsturi).</p>
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
    categoryId: document.getElementById('f_categoryId').value || null,
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
      if (!payload.assetTag || !payload.name) { alert('Inventāra Nr un nosaukums ir obligāti'); return; }
      await api('/api/assets', { method: 'POST', body: payload });
    }
    closeModal(); loadAssets();
  } catch (e) { alert(e.message); }
}

const LIFECYCLE_EVENT_LABELS_LV = {
  purchased: 'Reģistrēts', deployed: 'Piešķirts', returned: 'Atgriezts',
  repair_started: 'Nodots remontā', repair_finished: 'Remonts pabeigts',
  transferred: 'Pārvietots', status_changed: 'Statuss mainīts',
  retired: 'Izņemts', disposed: 'Utilizēts', note: 'Piezīme',
};

async function openAssetDetail(id) {
  const { asset, assignments, lifecycle, tickets } = await api('/api/assets/' + id);
  const { users } = await api('/api/users');
  openModal(`
    <h2>${esc(asset.name)}</h2>
    <p class="muted">${esc(asset.asset_tag)} · ${esc(asset.category_name) || 'Bez kategorijas'} · ${STATUS_LABELS_LV[asset.status]}</p>

    <div class="section-title">Piešķiršana</div>
    <p class="muted" style="margin:4px 0">Ja iekārta nav piešķirta nevienam darbiniekam, tā skaitās kā IT nodaļas rīcībā esoša iekārta.</p>
    <div class="map-row">
      <select id="assignUser"><option value="">— izvēlēties darbinieku —</option>${users.map((u) => `<option value="${u.id}">${esc(u.display_name)} (${esc(u.email)})</option>`).join('')}</select>
      <button class="btn btn-sm btn-green" onclick="assignAsset('${id}')">Piešķirt</button>
      <button class="btn btn-sm btn-outline" onclick="unassignAsset('${id}')">Atgriezt</button>
    </div>

    <div class="section-title">Piešķīrumu vēsture (turētājs)</div>
    ${assignments.length ? assignments.map((a) => `<div class="history-item">
        <b>${esc(a.user_name)}</b> — ${fmtDateTime(a.assigned_at)} ${a.unassigned_at ? '→ ' + fmtDateTime(a.unassigned_at) : '<b>(pašlaik)</b>'}
        ${a.assigned_by_name ? `<br><span class="muted">Piešķīra: ${esc(a.assigned_by_name)}</span>` : ''}
      </div>`).join('') : '<p class="muted">Nav ierakstu</p>'}

    <div class="section-title">Dzīves cikla un atrašanās vietas vēsture</div>
    ${lifecycle.length ? lifecycle.map((l) => `<div class="history-item">
        ${fmtDateTime(l.event_at)} — <b>${esc(LIFECYCLE_EVENT_LABELS_LV[l.event_type] || l.event_type)}</b>: ${esc(l.description)}
        ${l.performed_by_name ? `<br><span class="muted">Veica: ${esc(l.performed_by_name)}</span>` : ''}
      </div>`).join('') : '<p class="muted">Nav ierakstu</p>'}

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
      <input type="text" id="appSearch" placeholder="Meklēt programmu..." oninput="loadApplications()" />
      <div>
        <button class="btn btn-outline" onclick="openImportModal('applications')">⬆ Importēt no CSV</button>
        <button class="btn btn-green" onclick="openAppForm()">+ Pievienot programmu</button>
      </div>
    </div>
    <table id="appsTable"><thead><tr id="appsTableHead"></tr></thead><tbody></tbody></table>`;
  await loadApplications();
}

async function loadApplications() {
  const search = document.getElementById('appSearch').value;
  const [{ applications }, customFieldDefs] = await Promise.all([
    api('/api/applications' + (search ? '?search=' + encodeURIComponent(search) : '')),
    loadCustomFieldDefs('applications'),
  ]);
  appsCache = applications;

  document.getElementById('appsTableHead').innerHTML =
    `<th>Nosaukums</th><th>Ražotājs</th><th>Aktīvie lietotāji</th><th>Licences (vietas)</th>` +
    customFieldDefs.map((f) => `<th>${esc(f.label)}</th>`).join('') +
    `<th></th>`;

  const tbody = document.querySelector('#appsTable tbody');
  tbody.innerHTML = applications.length ? applications.map((a) => `
    <tr class="clickable" onclick="openAppDetail('${a.id}')">
      <td>${esc(a.name)}</td><td>${esc(a.vendor) || '—'}</td>
      <td>${a.active_assignments}</td><td>${a.seats_total}</td>
      ${customFieldDefs.map((f) => {
        const val = (a.custom_fields || {})[f.field_key];
        const display = f.field_type === 'boolean' ? (val ? '✓' : '—') : (val ?? '—');
        return `<td>${esc(display)}</td>`;
      }).join('')}
      <td><button class="btn btn-sm btn-outline" onclick="event.stopPropagation(); openAppForm('${a.id}')">Rediģēt</button></td>
    </tr>`).join('') : `<tr><td colspan="${5 + customFieldDefs.length}" class="empty">Nav rezultātu</td></tr>`;
}

async function openAppForm(id) {
  const app = id ? appsCache.find((a) => a.id === id) : null;
  await loadCustomFieldDefs('applications');
  openModal(`
    <h2>${app ? 'Rediģēt programmu' : 'Jauna programma'}</h2>
    <label>Nosaukums *</label><input id="f_appName" value="${app ? esc(app.name) : ''}" />
    <label>Ražotājs</label><input id="f_appVendor" value="${app ? esc(app.vendor) : ''}" />
    <p class="muted">Kategorija: Programma (Pamatkategorija) -- automātiski redzama arī Kategoriju sadaļā.</p>
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
  if (!confirm('Dzēst šo programmu?')) return;
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
    <table id="phonesTable"><thead><tr id="phonesTableHead"></tr></thead><tbody></tbody></table>`;
  await loadPhones();
}

async function loadPhones() {
  const [{ phoneNumbers }, customFieldDefs] = await Promise.all([
    api('/api/phone-numbers'),
    loadCustomFieldDefs('phone_numbers'),
  ]);
  phonesCache = phoneNumbers;

  // Galvene tiek veidota DINAMISKI -- katrs aktīvais pielāgotais lauks kļūst
  // par savu kolonnu sarakstā, ne tikai redzams pievienošanas formā.
  document.getElementById('phonesTableHead').innerHTML =
    `<th>Numurs</th><th>Operators</th><th>Plāns</th><th>Turētājs</th>` +
    customFieldDefs.map((f) => `<th>${esc(f.label)}</th>`).join('') +
    `<th></th>`;

  const tbody = document.querySelector('#phonesTable tbody');
  tbody.innerHTML = phoneNumbers.length ? phoneNumbers.map((p) => `
    <tr>
      <td>${esc(p.number)}</td><td>${esc(p.carrier) || '—'}</td><td>${esc(p.plan_name) || '—'}</td>
      <td>${esc(p.current_holder) || '—'}</td>
      ${customFieldDefs.map((f) => {
        const val = (p.custom_fields || {})[f.field_key];
        const display = f.field_type === 'boolean' ? (val ? '✓' : '—') : (val ?? '—');
        return `<td>${esc(display)}</td>`;
      }).join('')}
      <td>
        <button class="btn btn-sm btn-outline" onclick="openPhoneAssign('${p.id}')">Piešķirt</button>
        <button class="btn btn-sm btn-outline" onclick="openPhoneForm('${p.id}')">Rediģēt</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="${5 + customFieldDefs.length}" class="empty">Nav rezultātu</td></tr>`;
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

    <div class="section-title">Programmas</div>
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
// importState.target ('phone-numbers') -> custom_field_definitions.table_name ('phone_numbers')
const IMPORT_TARGET_TO_CF_TABLE = { assets: 'assets', applications: 'applications', 'phone-numbers': 'phone_numbers' };

let importState = { target: null, csvRows: [], csvHeaders: [], customFieldDefs: [] };

async function openImportModal(target) {
  importState = { target, csvRows: [], csvHeaders: [], customFieldDefs: [] };
  importState.customFieldDefs = await loadCustomFieldDefs(IMPORT_TARGET_TO_CF_TABLE[target]);
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
  const customFields = importState.customFieldDefs; // pielāgotie lauki -- arī tos var sasaistīt ar CSV kolonnu
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
    ${customFields.length ? `<p class="muted" style="margin-top:10px">Pielāgotie lauki:</p>` : ''}
    ${customFields.map((f) => `
      <div class="map-row">
        <label>${esc(f.label)}${f.field_type === 'boolean' ? ' (1/0, jā/nē)' : ''}</label>
        <select id="map_cf__${f.field_key}">
          <option value="">— neizmantot —</option>
          ${headers.map((h) => `<option value="${esc(h)}" ${h.toLowerCase() === f.field_key.toLowerCase() || h.toLowerCase() === f.label.toLowerCase() ? 'selected' : ''}>${esc(h)}</option>`).join('')}
        </select>
      </div>`).join('')}
    <div class="import-preview"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${importState.csvRows.slice(0, 5).map((r) => `<tr>${headers.map((h) => `<td>${esc(r[h])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <button class="btn btn-primary" onclick="runImport()">Importēt ${importState.csvRows.length} rindas</button>
    <div id="importResult"></div>`;
}

// CSV vērtības kā "1", "0", "true", "false", "jā", "nē", "yes", "no" -- visas
// jāpārvērš par īstu true/false, lai jā/nē (boolean) tipa lauki strādātu pareizi.
function parseBooleanCsvValue(raw) {
  if (raw === undefined || raw === null) return false;
  const v = String(raw).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'ja', 'jā', 'x'].includes(v);
}

async function runImport() {
  const fields = IMPORT_FIELD_SETS[importState.target];
  const customFields = importState.customFieldDefs;
  const mapping = {};
  fields.forEach(([key]) => { mapping[key] = document.getElementById('map_' + key).value; });
  const cfMapping = {};
  customFields.forEach((f) => { cfMapping[f.field_key] = document.getElementById('map_cf__' + f.field_key).value; });

  const rows = importState.csvRows.map((row) => {
    const mapped = {};
    fields.forEach(([key]) => { if (mapping[key]) mapped[key] = row[mapping[key]]; });
    const customValues = {};
    customFields.forEach((f) => {
      if (!cfMapping[f.field_key]) return;
      const raw = row[cfMapping[f.field_key]];
      customValues[f.field_key] = f.field_type === 'boolean' ? parseBooleanCsvValue(raw) : raw;
    });
    if (Object.keys(customValues).length > 0) mapped.customFields = customValues;
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
