// ── State ────────────────────────────────────────────────────────────────────
let currentFile     = null;   // path of currently loaded file
let originalContent = null;   // content at time of open (for in-memory revert)
let editorDirty     = false;  // unsaved changes in textarea
let fileIsEditable  = false;  // server says this file type is editable
let editingEnabled  = false;  // user has unlocked editing (read-only toggle)
let hasBackup       = false;  // .panelbak exists on disk for currentFile
let pm2Processes    = [];
let hideSampleFiles = true;

// ── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtBytes(b) { if (b<1024) return b+'B'; if (b<1048576) return (b/1024).toFixed(1)+'KB'; return (b/1048576).toFixed(1)+'MB'; }
function fmtUptime(ts) { const s=Math.floor((Date.now()-ts)/1000); if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m'; if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d'; }
function fileIcon(ext) { return {'.md':'◎','.sh':'⚡','.conf':'⚙','.json':'{}','.yaml':'⚙','.yml':'⚙','.js':'⬡','.ts':'⬡','.env':'⚿','.txt':'◎','.log':'≡'}[ext]||'◦'; }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type; el.textContent = msg;
  document.body.appendChild(el); setTimeout(() => el.remove(), 3000);
}

// ── Navigation ───────────────────────────────────────────────────────────────
function navigate(panel, el) {
  // Guard: warn if navigating away with unsaved changes
  if (editorDirty) {
    if (!confirm('You have unsaved changes. Leave the file browser anyway?\n\nYour edits will be lost.')) return;
    editorDirty = false;
  }
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + panel).classList.add('active');
  el.classList.add('active');
  if (panel === 'health') loadHealth();
  if (panel === 'resources') loadSystem();
  if (panel === 'pm2') loadPM2();
  if (panel === 'docker') loadDocker();
  if (panel === 'logs') initLogs();
  if (panel === 'files') loadFileRoots();
  if (panel === 'backrest') loadBackrest();
  if (panel === 'diagnostics') loadDiagnostics();
}

// ── Clock ────────────────────────────────────────────────────────────────────
function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
}
setInterval(updateClock, 1000); updateClock();

// ── Health ───────────────────────────────────────────────────────────────────
async function loadHealth(force = false) {
  try {
    const res = force ? await fetch('/api/health/refresh', { method: 'POST' }) : await fetch('/api/health');
    renderHealth(await res.json());
  } catch (e) { document.getElementById('service-grid').innerHTML = `<div class="error-msg">${e.message}</div>`; }
}

function renderHealth(data) {
  const services = data.services || [];
  const upCount = services.filter(s => s.status === 'up').length;
  const downCount = services.filter(s => s.status === 'down').length;
  const badge = document.getElementById('badge-health');
  badge.textContent = `${upCount}/${services.length}`;
  badge.className = 'badge ' + (downCount > 0 ? 'warn' : 'up');
  document.getElementById('service-grid').innerHTML = services.map(svc => {
    const dots = (svc.history || []).map(h =>
      `<span class="hist-dot ${h.status}" title="${new Date(h.ts).toLocaleTimeString()}: ${h.status}${h.latency != null ? ' · ' + h.latency + 'ms' : ''}"></span>`
    ).join('');
    return `
    <div class="service-card ${svc.status}">
      <div class="service-name">${escHtml(svc.label)}</div>
      <div class="service-meta">
        <div class="status-dot ${svc.status}"></div><span>${svc.status}</span>
        ${svc.latency != null ? `<span style="margin-left:auto;font-size:10px">${svc.latency}ms</span>` : ''}
      </div>
      ${dots ? `<div class="hist-dots">${dots}</div>` : ''}
      ${svc.link ? `<a class="service-link" href="${escHtml(svc.link)}" target="_blank">\u2197 open</a>` : ''}
    </div>`;
  }).join('');
  if (data.lastCheck)
    document.getElementById('health-updated').textContent = 'last checked ' + new Date(data.lastCheck).toLocaleTimeString();
}

// ── PM2 ──────────────────────────────────────────────────────────────────────
async function loadPM2() {
  document.getElementById('pm2-content').innerHTML = '<div class="loading">loading\u2026</div>';
  try {
    pm2Processes = await (await fetch('/api/pm2/list')).json();
    const onlineCount = pm2Processes.filter(p => p.status === 'online').length;
    const badge = document.getElementById('badge-pm2');
    badge.textContent = `${onlineCount}/${pm2Processes.length}`;
    badge.className = 'badge ' + (onlineCount === pm2Processes.length ? 'up' : 'warn');

    const always    = pm2Processes.filter(p => !p.cron);
    const scheduled = pm2Processes.filter(p => p.cron);

    const alwaysRows = always.map(p => `
      <tr>
        <td class="pm2-name">${escHtml(p.name)}</td>
        <td><span class="pm2-status ${p.status}">${escHtml(p.status)}</span></td>
        <td class="pm2-mono">${p.pid || '\u2014'}</td>
        <td class="pm2-mono">${p.restarts ?? '\u2014'}</td>
        <td class="pm2-mono">${p.cpu != null ? p.cpu + '%' : '\u2014'}</td>
        <td class="pm2-mono">${p.memory != null ? fmtBytes(p.memory) : '\u2014'}</td>
        <td class="pm2-mono">${p.uptime ? fmtUptime(p.uptime) : '\u2014'}</td>
        <td><div class="pm2-actions">
          <button class="btn sm" data-pm2-action="restart" data-pm2-name="${escHtml(p.name)}">restart</button>
          <button class="btn sm" data-pm2-action="${p.status==='online'?'stop':'restart'}" data-pm2-name="${escHtml(p.name)}">
            ${p.status === 'online' ? 'stop' : 'start'}
          </button>
        </div></td>
      </tr>`).join('');

    const scheduledRows = scheduled.map(p => `
      <tr>
        <td class="pm2-name">${escHtml(p.name)}</td>
        <td><span class="pm2-status ${p.status}">${escHtml(p.status)}</span></td>
        <td class="pm2-mono">${p.restarts ?? '\u2014'}</td>
        <td class="pm2-mono">${p.cpu != null ? p.cpu + '%' : '\u2014'}</td>
        <td class="pm2-mono">${p.memory != null ? fmtBytes(p.memory) : '\u2014'}</td>
        <td class="pm2-mono">${p.uptime ? fmtUptime(p.uptime) : '\u2014'}</td>
        <td class="pm2-mono" style="font-size:10px;color:var(--dim)">${escHtml(p.cron)}</td>
        <td><div class="pm2-actions">
          <button class="btn sm" data-pm2-action="restart" data-pm2-name="${escHtml(p.name)}">run now</button>
        </div></td>
      </tr>`).join('');

    let html = '';
    if (always.length) html += `
      <div class="pm2-section">
        <div class="pm2-section-label">always on (${always.length})</div>
        <table class="pm2-table">
          <thead><tr><th>name</th><th>status</th><th>pid</th><th>restarts</th><th>cpu</th><th>mem</th><th>uptime</th><th>actions</th></tr></thead>
          <tbody>${alwaysRows}</tbody>
        </table>
      </div>`;
    if (scheduled.length) html += `
      <div class="pm2-section">
        <div class="pm2-section-label">scheduled (${scheduled.length})</div>
        <table class="pm2-table">
          <thead><tr><th>name</th><th>status</th><th>runs</th><th>cpu</th><th>mem</th><th>last run</th><th>schedule</th><th>actions</th></tr></thead>
          <tbody>${scheduledRows}</tbody>
        </table>
      </div>`;

    document.getElementById('pm2-content').innerHTML = html;
    populateLogSelect(pm2Processes);
  } catch (e) { document.getElementById('pm2-content').innerHTML = `<div class="error-msg">${e.message}</div>`; }
}

async function pm2Action(action, name) {
  try {
    const data = await (await fetch('/api/pm2/action', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({action,name}) })).json();
    if (data.error) throw new Error(data.error);
    toast(`${action} \u2192 ${name}`, 'success'); setTimeout(loadPM2, 1200);
  } catch (e) { toast(`failed: ${e.message}`, 'error'); }
}

// ── Logs ─────────────────────────────────────────────────────────────────────
let rawLogText = '';

function initLogs() {
  if (pm2Processes.length === 0) fetch('/api/pm2/list').then(r=>r.json()).then(p => { pm2Processes = p; populateLogSelect(p); });
}
function populateLogSelect(procs) {
  const sel = document.getElementById('log-process-select'), cur = sel.value;
  sel.innerHTML = '<option value="">select process\u2026</option>' + procs.map(p => `<option value="${escHtml(p.name)}" ${p.name===cur?'selected':''}>${escHtml(p.name)}</option>`).join('');
}
async function loadLog() {
  const name = document.getElementById('log-process-select').value;
  const stream = document.getElementById('log-stream-select').value;
  const lines = document.getElementById('log-lines-select').value;
  const out = document.getElementById('log-output');
  if (!name) return; out.textContent = 'loading\u2026';
  try {
    const data = await (await fetch(`/api/pm2/logs?name=${encodeURIComponent(name)}&lines=${lines}`)).json();
    rawLogText = (stream === 'stderr' ? data.stderr : data.stdout) || '(empty)';
    applyLogFilter();
    out.scrollTop = out.scrollHeight;
  } catch (e) { out.textContent = 'error: ' + e.message; }
}
function applyLogFilter() {
  const filter = document.getElementById('log-search').value;
  const out = document.getElementById('log-output');
  const clearBtn = document.getElementById('log-search-clear');
  clearBtn.style.display = filter ? 'inline-block' : 'none';
  if (!filter || !rawLogText) { out.textContent = rawLogText; return; }
  const lower = filter.toLowerCase();
  const matched = rawLogText.split('\n').filter(l => l.toLowerCase().includes(lower));
  out.textContent = matched.length ? matched.join('\n') : '(no lines match)';
}
function clearLogSearch() {
  document.getElementById('log-search').value = '';
  applyLogFilter();
}

// ── File Tree ─────────────────────────────────────────────────────────────────
function applySampleToggle() {
  const tree = document.getElementById('file-tree-content');
  const btn  = document.getElementById('btn-toggle-samples');
  tree.classList.toggle('hide-samples', hideSampleFiles);
  btn.style.opacity = hideSampleFiles ? '0.4' : '1';
  btn.title = hideSampleFiles ? 'Show .sample files' : 'Hide .sample files';
}

function toggleSampleFiles() {
  hideSampleFiles = !hideSampleFiles;
  applySampleToggle();
}

async function loadFileRoots() {
  const tree = document.getElementById('file-tree-content');
  tree.innerHTML = '<div class="loading">loading\u2026</div>';
  try {
    const roots = await (await fetch('/api/files/roots')).json();
    tree.innerHTML = roots.map(r => `
      <div class="tree-root" data-root-path="${escHtml(r.path)}" data-root-type="${r.type}"><span>\u25B8</span> ${r.label}</div>
      <div class="tree-children" data-root="${escHtml(r.path)}"></div>`).join('');
    applySampleToggle();
  } catch (e) { tree.innerHTML = `<div class="error-msg">${e.message}</div>`; }
}

async function toggleRoot(el, rootPath, type) {
  if (!guardDirty()) return;
  const isOpen = el.classList.contains('open'), children = el.nextElementSibling;
  if (isOpen) { el.classList.remove('open'); el.querySelector('span').textContent = '\u25B8'; children.classList.remove('open'); return; }
  el.classList.add('open'); el.querySelector('span').textContent = '\u25BE'; children.classList.add('open');
  if (type === 'file') { openFile(rootPath, el); return; }
  if (children.dataset.loaded) return;
  children.dataset.loaded = '1'; await browseDir(rootPath, children, 1);
}

async function browseDir(dirPath, container, depth) {
  container.innerHTML = '<div class="loading" style="padding-left:28px">loading\u2026</div>';
  try {
    const data = await (await fetch('/api/files/browse?path=' + encodeURIComponent(dirPath))).json();
    if (data.error) throw new Error(data.error);
    container.innerHTML = data.entries.map(e => {
      const isSample = e.type === 'file' && e.name.endsWith('.sample');
      const sampleAttr = isSample ? ' data-sample="1"' : '';
      const icon = e.type === 'dir' ? '\u25B8' : fileIcon(e.ext);
      const child = e.type === 'dir' ? '<div class="tree-children" style="display:none"></div>' : '';
      const dataAttrs = e.type === 'dir'
        ? ` data-browse-dir="${escHtml(e.path)}" data-browse-depth="${depth}"`
        : ` data-open-file="${escHtml(e.path)}"`;
      return `<div class="tree-entry" style="padding-left:${14+depth*14}px"${sampleAttr}${dataAttrs}>` +
        `<span class="icon">${icon}</span>` +
        `<span style="overflow:hidden;text-overflow:ellipsis">${e.name}</span>` +
        `</div>${child}`;
    }).join('');
  } catch(err) { container.innerHTML = `<div style="padding-left:28px;color:var(--danger);font-size:10px">${err.message}</div>`; }
}
function browseSubdir(el, dirPath, depth) {
  if (!guardDirty()) return;
  const sibling = el.nextElementSibling, isOpen = el.dataset.open === '1';
  if (isOpen) { el.dataset.open='0'; el.querySelector('.icon').textContent='\u25B8'; if(sibling) sibling.style.display='none'; return; }
  el.dataset.open='1'; el.querySelector('.icon').textContent='\u25BE';
  if (sibling) { sibling.style.display='block'; if(!sibling.dataset.loaded) { sibling.dataset.loaded='1'; browseDir(dirPath, sibling, depth+1); } }
}

// Returns false and shows a confirm if there are unsaved changes; caller should abort if false.
function guardDirty() {
  if (!editorDirty) return true;
  return confirm('You have unsaved changes. Discard them?');
}

// ── Editor UI helpers ─────────────────────────────────────────────────────────
function syncEditorUI() {
  const textarea      = document.getElementById('editor-textarea');
  const strip         = document.getElementById('edit-mode-strip');
  const btnUnlock     = document.getElementById('btn-unlock');
  const btnSave       = document.getElementById('btn-save');
  const btnRevert     = document.getElementById('btn-revert');
  const btnBackup     = document.getElementById('btn-discard-backup');
  const modeLabel     = document.getElementById('editor-mode-label');
  const dirtyLabel    = document.getElementById('editor-dirty');

  const canEdit = fileIsEditable && currentFile;

  if (!currentFile) {
    // Nothing loaded — hide everything
    btnUnlock.style.display = btnSave.style.display = btnRevert.style.display = btnBackup.style.display = 'none';
    textarea.readOnly = true;
    textarea.className = 'readonly-mode';
    strip.className = '';
    modeLabel.textContent = '\u2014';
    return;
  }

  if (editingEnabled) {
    // EDIT MODE
    btnUnlock.style.display = 'none';
    btnSave.style.display = 'inline-block';
    btnSave.disabled = !editorDirty;
    btnRevert.style.display = editorDirty ? 'inline-block' : 'none';
    btnBackup.style.display = hasBackup ? 'inline-block' : 'none';
    textarea.readOnly = false;
    textarea.className = '';
    strip.className = 'editing';
    modeLabel.textContent = '\u270E editing';
    modeLabel.style.color = 'var(--warn)';
  } else {
    // READ-ONLY MODE
    btnUnlock.style.display = canEdit ? 'inline-block' : 'none';
    btnSave.style.display = 'none';
    btnRevert.style.display = 'none';
    btnBackup.style.display = hasBackup ? 'inline-block' : 'none';
    textarea.readOnly = true;
    textarea.className = 'readonly-mode';
    strip.className = '';
    modeLabel.textContent = 'read-only';
    modeLabel.style.color = 'var(--dim)';
  }

  dirtyLabel.style.display = editorDirty ? 'inline' : 'none';
}

// ── Open file ─────────────────────────────────────────────────────────────────
async function openFile(filePath, el) {
  if (!guardDirty()) return;

  // Reset editing state
  editingEnabled = false;
  editorDirty = false;
  currentFile = null;
  originalContent = null;
  hasBackup = false;

  document.querySelectorAll('.tree-entry.selected,.tree-root.selected').forEach(e => e.classList.remove('selected'));
  if (el) el.classList.add('selected');

  const textarea = document.getElementById('editor-textarea');
  const pathEl   = document.getElementById('editor-path');
  pathEl.textContent = filePath;
  textarea.value = 'loading\u2026';
  syncEditorUI();

  try {
    const data = await (await fetch('/api/files/read?path=' + encodeURIComponent(filePath))).json();
    if (data.error) throw new Error(data.error);

    currentFile    = filePath;
    fileIsEditable = data.editable;
    originalContent = data.content;
    hasBackup      = data.hasBackup || false;
    editorDirty    = false;

    textarea.value = data.content;
    document.getElementById('editor-info').textContent =
      `${data.content.split('\n').length} lines \u00B7 ${fmtBytes(data.size)} \u00B7 ${data.ext||'text'}` +
      (data.editable ? '' : ' \u00B7 not editable') +
      (hasBackup ? ' \u00B7 backup exists' : '');

    syncEditorUI();

    textarea.oninput = () => {
      if (!editingEnabled) return;
      editorDirty = true;
      syncEditorUI();
    };
  } catch(e) {
    textarea.value = 'Error: ' + e.message;
    currentFile = null;
    syncEditorUI();
  }
}

// ── Edit mode toggle ──────────────────────────────────────────────────────────
function enableEditing() {
  if (!fileIsEditable || !currentFile) return;
  editingEnabled = true;
  syncEditorUI();
  document.getElementById('editor-textarea').focus();
}

// ── Revert (in-memory, pre-save) ──────────────────────────────────────────────
function revertChanges() {
  if (!currentFile || originalContent === null) return;
  if (!confirm('Discard all unsaved changes and revert to the version loaded from disk?')) return;
  document.getElementById('editor-textarea').value = originalContent;
  editorDirty = false;
  syncEditorUI();
  toast('reverted to loaded version', '');
}

// ── Save flow (with confirmation modal) ───────────────────────────────────────
function requestSave() {
  if (!currentFile || !editorDirty) return;
  document.getElementById('confirm-path-display').textContent = currentFile;
  const current = document.getElementById('editor-textarea').value;
  document.getElementById('diff-view').innerHTML = renderDiff(computeDiff(originalContent || '', current));
  document.getElementById('confirm-overlay').classList.add('visible');
}

document.getElementById('confirm-cancel-btn').onclick = () => {
  document.getElementById('confirm-overlay').classList.remove('visible');
};

document.getElementById('confirm-save-btn').onclick = async () => {
  document.getElementById('confirm-overlay').classList.remove('visible');
  await doSave();
};

async function doSave() {
  if (!currentFile) return;
  try {
    const content = document.getElementById('editor-textarea').value;
    const data = await (await fetch('/api/files/write', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ filePath: currentFile, content })
    })).json();
    if (data.error) throw new Error(data.error);

    // After save: re-lock to read-only, update originalContent, mark backup present
    editorDirty    = false;
    editingEnabled = false;
    originalContent = content;
    hasBackup = true; // server created a backup on first write

    syncEditorUI();
    // Update info line
    const lines = content.split('\n').length;
    document.getElementById('editor-info').textContent =
      `${lines} lines \u00B7 ${fmtBytes(new Blob([content]).size)} \u00B7 ${currentFile.split('.').pop()} \u00B7 backup exists`;
    toast('saved', 'success');
  } catch(e) { toast('save failed: ' + e.message, 'error'); }
}

// ── Discard backup ────────────────────────────────────────────────────────────
async function discardBackup() {
  if (!currentFile || !hasBackup) return;
  if (!confirm(`Permanently discard the backup for:\n${currentFile}\n\nThis cannot be undone.`)) return;
  try {
    const data = await (await fetch('/api/files/backup', {
      method: 'DELETE',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ filePath: currentFile })
    })).json();
    if (data.error) throw new Error(data.error);
    hasBackup = false;
    syncEditorUI();
    const infoEl = document.getElementById('editor-info');
    infoEl.textContent = infoEl.textContent.replace(' \u00B7 backup exists', '');
    toast('backup discarded', '');
  } catch(e) { toast('failed: ' + e.message, 'error'); }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    if (editingEnabled && editorDirty) requestSave();
  }
  // Escape closes the confirm modal
  if (e.key === 'Escape') {
    document.getElementById('confirm-overlay').classList.remove('visible');
  }
});

// ── System Resources ─────────────────────────────────────────────────────────
async function loadSystem() {
  const content = document.getElementById('resources-content');
  if (!content.dataset.loaded) content.innerHTML = '<div class="loading">loading\u2026</div>';
  try {
    const data = await (await fetch('/api/system')).json();
    renderSystem(data);
    content.dataset.loaded = '1';
  } catch (e) {
    content.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

function renderSystem(d) {
  const { cpu, memory, disks, uptime } = d;
  function pct(used, total) { return total ? Math.round(used / total * 100) : 0; }
  function barCls(p) { return p > 85 ? 'danger' : p > 65 ? 'warn' : ''; }
  const uptimeDays = Math.floor(uptime / 86400);
  const uptimeHours = Math.floor((uptime % 86400) / 3600);
  const uptimeMins = Math.floor((uptime % 3600) / 60);
  const uptimeStr = uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours}h` : `${uptimeHours}h ${uptimeMins}m`;
  const cpuPct1 = Math.min(100, Math.round(cpu.load1 / cpu.cores * 100));
  const cpuPct5 = Math.min(100, Math.round(cpu.load5 / cpu.cores * 100));
  const cpuPct15 = Math.min(100, Math.round(cpu.load15 / cpu.cores * 100));
  const memPct = pct(memory.used, memory.total);
  const diskCards = disks.map(disk => {
    const p = pct(disk.used, disk.total);
    return `<div class="res-row">
      <div class="res-label"><span>${escHtml(disk.mount)}</span><span>${fmtBytes(disk.free)} free \u00B7 ${p}%</span></div>
      <div class="res-bar-wrap"><div class="res-bar ${barCls(p)}" style="width:${p}%"></div></div>
    </div>`;
  }).join('');
  document.getElementById('resources-content').innerHTML = `
    <div class="res-grid">
      <div class="res-card">
        <div class="res-card-title">CPU \u00B7 ${cpu.cores} cores \u00B7 uptime ${uptimeStr}</div>
        <div class="res-row">
          <div class="res-label"><span>load 1m</span><span>${cpu.load1.toFixed(2)} (${cpuPct1}%)</span></div>
          <div class="res-bar-wrap"><div class="res-bar ${barCls(cpuPct1)}" style="width:${cpuPct1}%"></div></div>
        </div>
        <div class="res-row">
          <div class="res-label"><span>load 5m</span><span>${cpu.load5.toFixed(2)} (${cpuPct5}%)</span></div>
          <div class="res-bar-wrap"><div class="res-bar ${barCls(cpuPct5)}" style="width:${cpuPct5}%"></div></div>
        </div>
        <div class="res-row">
          <div class="res-label"><span>load 15m</span><span>${cpu.load15.toFixed(2)} (${cpuPct15}%)</span></div>
          <div class="res-bar-wrap"><div class="res-bar ${barCls(cpuPct15)}" style="width:${cpuPct15}%"></div></div>
        </div>
      </div>
      <div class="res-card">
        <div class="res-card-title">Memory</div>
        <div class="res-row">
          <div class="res-label"><span>used</span><span>${fmtBytes(memory.used)} / ${fmtBytes(memory.total)} \u00B7 ${memPct}%</span></div>
          <div class="res-bar-wrap"><div class="res-bar ${barCls(memPct)}" style="width:${memPct}%"></div></div>
        </div>
        <div style="font-family:var(--mono);font-size:10px;color:var(--dim)">${fmtBytes(memory.free)} free</div>
      </div>
      ${disks.length ? `<div class="res-card"><div class="res-card-title">Disk</div>${diskCards}</div>` : ''}
    </div>`;
}

// ── Docker Containers ─────────────────────────────────────────────────────────
async function loadDocker() {
  document.getElementById('docker-content').innerHTML = '<div class="loading">loading\u2026</div>';
  try {
    const containers = await (await fetch('/api/docker/containers')).json();
    if (containers.error) throw new Error(containers.error);
    const running = containers.filter(c => c.state === 'running').length;
    const badge = document.getElementById('badge-docker');
    badge.textContent = `${running}/${containers.length}`;
    badge.className = 'badge ' + (running === containers.length ? 'up' : 'warn');
    document.getElementById('docker-content').innerHTML = `
      <table class="pm2-table">
        <thead><tr><th>name</th><th>image</th><th>state</th><th>status</th></tr></thead>
        <tbody>${containers.map(c => `
          <tr>
            <td class="pm2-name">${escHtml(c.name)}</td>
            <td class="pm2-mono" style="font-size:10px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(c.image)}</td>
            <td><span class="pm2-status ${c.state === 'running' ? 'online' : c.state === 'exited' ? 'stopped' : 'errored'}">${escHtml(c.state)}</span></td>
            <td class="pm2-mono">${escHtml(c.status)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    document.getElementById('docker-content').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

// ── Diff ──────────────────────────────────────────────────────────────────────
function computeDiff(oldText, newText) {
  const a = oldText.split('\n'), b = newText.split('\n');
  if (a.length + b.length > 3000) return null;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const hunks = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) { hunks.push({ t: '=', l: a[i] }); i++; j++; }
    else if (j < n && (i >= m || dp[i][j+1] >= dp[i+1][j])) { hunks.push({ t: '+', l: b[j] }); j++; }
    else { hunks.push({ t: '-', l: a[i] }); i++; }
  }
  return hunks;
}

function renderDiff(hunks) {
  if (!hunks) return '<div class="diff-line skip">(file too large to diff)</div>';
  const CONTEXT = 3;
  const changed = new Set();
  hunks.forEach((h, i) => { if (h.t !== '=') changed.add(i); });
  if (changed.size === 0) return '<div class="diff-line ctx" style="color:var(--accent);padding:6px 10px">no changes</div>';
  const visible = new Set();
  changed.forEach(i => {
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(hunks.length - 1, i + CONTEXT); k++) visible.add(k);
  });
  const adds = hunks.filter(h => h.t === '+').length;
  const dels = hunks.filter(h => h.t === '-').length;
  const sorted = [...visible].sort((a, b) => a - b);
  let html = `<div style="padding:4px 10px;font-size:10px;color:var(--dim);border-bottom:1px solid var(--border);font-family:var(--mono)">+${adds} \u2212${dels}</div>`;
  let last = -1;
  for (const idx of sorted) {
    if (last !== -1 && idx > last + 1) html += `<div class="diff-line skip">\u00B7\u00B7\u00B7</div>`;
    const h = hunks[idx];
    const cls = h.t === '+' ? 'add' : h.t === '-' ? 'del' : 'ctx';
    const prefix = h.t === '+' ? '+' : h.t === '-' ? '-' : ' ';
    html += `<div class="diff-line ${cls}">${prefix} ${escHtml(h.l)}</div>`;
    last = idx;
  }
  return html;
}

// ── Scale ─────────────────────────────────────────────────────────────────────
function setScale(pct) {
  document.documentElement.style.zoom = pct + '%';
  localStorage.setItem('panelScale', pct);
  document.querySelectorAll('.scale-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.scale) === pct);
  });
}
(function() { setScale(parseInt(localStorage.getItem('panelScale')) || 100); })();

// ── Backrest ──────────────────────────────────────────────────────────────────
async function loadBackrest() {
  document.getElementById('backrest-content').innerHTML = '<div class="loading">loading\u2026</div>';
  try {
    const limit = document.getElementById('backrest-limit-select').value;
    const data = await (await fetch(`/api/backrest/operations?limit=${limit}`)).json();
    if (data.error) throw new Error(data.error);
    const ops = data.operations || [];
    if (!ops.length) {
      document.getElementById('backrest-content').innerHTML = '<div class="loading">no operations found</div>';
      return;
    }
    document.getElementById('backrest-content').innerHTML = `
      <table class="pm2-table">
        <thead><tr><th>status</th><th>plan</th><th>repo</th><th>started</th><th>duration</th><th>details</th></tr></thead>
        <tbody>${ops.map(op => {
          const startMs = op.unixTimeStartMs ? Number(op.unixTimeStartMs) : null;
          const endMs   = op.unixTimeEndMs   ? Number(op.unixTimeEndMs)   : null;
          const startStr = startMs ? new Date(startMs).toLocaleString() : '\u2014';
          const durSec   = (startMs && endMs) ? Math.round((endMs - startMs) / 1000) : null;
          const durStr   = durSec != null ? (durSec >= 60 ? Math.floor(durSec/60)+'m '+durSec%60+'s' : durSec+'s') : '\u2014';
          const status   = (op.status ?? 'unknown').replace('STATUS_', '').toLowerCase();
          const cls      = status === 'success' ? 'online' : status === 'error' ? 'errored' : status === 'inprogress' ? 'warn' : 'stopped';
          return `
            <tr>
              <td><span class="pm2-status ${cls}">${escHtml(status)}</span></td>
              <td class="pm2-mono">${escHtml(op.planId || '\u2014')}</td>
              <td class="pm2-mono">${escHtml(op.repoId || '\u2014')}</td>
              <td class="pm2-mono" style="font-size:10px">${escHtml(startStr)}</td>
              <td class="pm2-mono">${escHtml(durStr)}</td>
              <td class="pm2-mono" style="font-size:10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(op.displayMessage || '\u2014')}</td>
            </tr>`;
        }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    document.getElementById('backrest-content').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────────────
async function loadDiagnostics() {
  const content = document.getElementById('diagnostics-content');
  try {
    const data = await (await fetch('/api/diagnostics')).json();
    renderDiagnostics(data);
  } catch (e) {
    content.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

async function runDiagnostics(mode) {
  const content = document.getElementById('diagnostics-content');
  content.innerHTML = `<div class="loading">running ${mode} checks\u2026</div>`;
  try {
    const url = mode === 'thorough' ? '/api/diagnostics/run' : '/api/diagnostics/run-lightweight';
    const data = await (await fetch(url, { method: 'POST' })).json();
    renderDiagnostics(data);
    toast('diagnostics complete', 'success');
  } catch (e) {
    content.innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

function renderDiagnostics(data) {
  const content = document.getElementById('diagnostics-content');
  const badge = document.getElementById('badge-diag');

  if (!data.lastRun) {
    badge.textContent = '--';
    badge.className = 'badge';
    content.innerHTML = '<div class="loading">no results yet \u2014 run a check</div>';
    return;
  }

  const { summary, categories, lastRun, mode } = data;
  const issues = summary.fail + summary.warn;
  badge.textContent = issues === 0 ? '\u2713' : issues;
  badge.className = 'badge ' + (summary.fail > 0 ? 'warn' : issues > 0 ? 'warn' : 'up');

  const timeStr = new Date(lastRun).toLocaleTimeString();
  let html = `<div class="diag-summary">last run: ${timeStr} (${escHtml(mode)}) \u2014 ${summary.pass} pass \u00B7 ${summary.warn} warn \u00B7 ${summary.fail} fail</div>`;
  html += '<div class="diag-grid">';

  const catOrder = ['services', 'network', 'storage', 'security', 'config'];
  for (const cat of catOrder) {
    const c = categories[cat];
    if (!c) continue;
    const dotCls = c.status === 'fail' ? 'fail' : c.status === 'warn' ? 'warn' : 'pass';
    html += `<div class="diag-category">`;
    html += `<div class="diag-cat-header"><div class="status-dot ${dotCls}"></div><div class="diag-cat-title">${escHtml(cat)}</div></div>`;
    for (const check of c.checks) {
      const cDot = check.status === 'fail' ? 'fail' : check.status === 'warn' ? 'warn' : 'pass';
      html += `<div class="diag-check">`;
      html += `<div class="status-dot ${cDot}"></div>`;
      html += `<span class="diag-label">${escHtml(check.label)}</span>`;
      html += `<span class="diag-msg">${escHtml(check.message)}</span>`;
      html += `<span class="diag-time">${check.duration}ms</span>`;
      html += `</div>`;
      if (check.detail) {
        html += `<div class="diag-detail">${escHtml(check.detail)}</div>`;
      }
    }
    html += `</div>`;
  }
  html += '</div>';
  content.innerHTML = html;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadHealth();
setInterval(() => {
  if (document.querySelector('.panel.active')?.id === 'panel-health') loadHealth();
}, 30000);

// ── Event Delegation & Listeners (CSP-safe replacements for inline handlers) ──

// Scale buttons
document.querySelectorAll('.scale-btn[data-scale]').forEach(btn => {
  btn.addEventListener('click', () => setScale(parseInt(btn.dataset.scale)));
});

// Nav items
document.querySelectorAll('.nav-item[data-panel]').forEach(item => {
  item.addEventListener('click', () => navigate(item.dataset.panel, item));
});

// Panel refresh buttons
document.getElementById('btn-refresh-health').addEventListener('click', () => loadHealth(true));
document.getElementById('btn-refresh-resources').addEventListener('click', () => loadSystem());
document.getElementById('btn-refresh-docker').addEventListener('click', () => loadDocker());
document.getElementById('btn-refresh-pm2').addEventListener('click', () => loadPM2());
document.getElementById('btn-refresh-logs').addEventListener('click', () => loadLog());
document.getElementById('btn-refresh-backrest').addEventListener('click', () => loadBackrest());

// Diagnostics buttons
document.getElementById('btn-diag-cached').addEventListener('click', () => loadDiagnostics());
document.getElementById('btn-diag-lightweight').addEventListener('click', () => runDiagnostics('lightweight'));
document.getElementById('btn-diag-thorough').addEventListener('click', () => runDiagnostics('thorough'));

// Log controls
document.getElementById('log-process-select').addEventListener('change', () => loadLog());
document.getElementById('log-stream-select').addEventListener('change', () => loadLog());
document.getElementById('log-lines-select').addEventListener('change', () => loadLog());
document.getElementById('log-search').addEventListener('input', () => applyLogFilter());
document.getElementById('log-search-clear').addEventListener('click', () => clearLogSearch());

// Backrest limit select
document.getElementById('backrest-limit-select').addEventListener('change', () => loadBackrest());

// File browser buttons
document.getElementById('btn-toggle-samples').addEventListener('click', () => toggleSampleFiles());
document.getElementById('btn-unlock').addEventListener('click', () => enableEditing());
document.getElementById('btn-save').addEventListener('click', () => requestSave());
document.getElementById('btn-revert').addEventListener('click', () => revertChanges());
document.getElementById('btn-discard-backup').addEventListener('click', () => discardBackup());

// ── Event delegation for dynamically generated elements ──

// PM2 action buttons (restart, stop, start, run now)
document.getElementById('pm2-content').addEventListener('click', e => {
  const btn = e.target.closest('[data-pm2-action]');
  if (btn) pm2Action(btn.dataset.pm2Action, btn.dataset.pm2Name);
});

// File tree: roots and entries (toggleRoot, browseSubdir, openFile)
document.getElementById('file-tree-content').addEventListener('click', e => {
  // Tree root click
  const root = e.target.closest('.tree-root[data-root-path]');
  if (root) {
    toggleRoot(root, root.dataset.rootPath, root.dataset.rootType);
    return;
  }

  // Tree entry — directory
  const dirEntry = e.target.closest('.tree-entry[data-browse-dir]');
  if (dirEntry) {
    browseSubdir(dirEntry, dirEntry.dataset.browseDir, parseInt(dirEntry.dataset.browseDepth));
    return;
  }

  // Tree entry — file
  const fileEntry = e.target.closest('.tree-entry[data-open-file]');
  if (fileEntry) {
    openFile(fileEntry.dataset.openFile, fileEntry);
    return;
  }
});
