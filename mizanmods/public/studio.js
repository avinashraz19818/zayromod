const $ = s => document.querySelector(s);
let token = '', jobs = [], activeDetail = null, refreshing = false;
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').hidden = true, 5000); }
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network request failed' }));
    if (response.status === 401) { token = ''; $('#auth-label').textContent = 'Workspace locked'; }
    throw Error(error.error || 'Request failed');
  }
  return response;
}
function navigate(view) {
  if (!['studio', 'history', 'settings'].includes(view)) view = 'studio';
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== view);
  document.querySelectorAll('nav button').forEach(el => el.classList.toggle('selected', el.dataset.view === view));
  $('#breadcrumb').textContent = { studio: 'Build studio', history: 'Build history', settings: 'Environment' }[view];
  history.replaceState(null, '', `#${view}`);
  if (view === 'settings' && token) loadSettings();
}
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.view)));
window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
$('#lock').addEventListener('click', () => {
  if (token) { token = ''; jobs = []; render(); $('#auth-label').textContent = 'Workspace locked'; $('#checks').textContent = 'Unlock your workspace to check the build environment.'; $('#retention').textContent = ''; $('#build-detail').close(); toast('Workspace locked'); }
  else $('#auth').showModal();
});
$('#auth-close').addEventListener('click', () => $('#auth').close());
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault(); token = $('#token').value; $('#auth-error').textContent = '';
  const button = event.submitter; button.disabled = true;
  try { await refresh(true); $('#token').value = ''; $('#auth').close(); $('#auth-label').textContent = 'Connected · click to lock'; toast('Your workspace is connected'); if (!$('#settings').hidden) await loadSettings(); }
  catch (e) { token = ''; $('#auth-error').textContent = e.message; }
  finally { button.disabled = false; }
});
const empty = '<div class="empty"><span>◷</span><h3>No builds just yet.</h3><p>Create a build to see its progress and download your release here.</p></div>';
function render() {
  $('#total').textContent = token ? jobs.length : '—'; $('#ready').textContent = token ? jobs.filter(j => j.status === 'ready').length : '—'; $('#pending').textContent = token ? jobs.filter(j => ['queued','building'].includes(j.status)).length : '—';
  const row = j => `<article class="build-row"><span class="avatar">M</span><div class="build-info"><strong>${escape(j.config.appName)}</strong><small>${escape(j.config.packageName)} · v${escape(j.config.versionName)}</small></div><span class="badge ${escape(j.status)}">${escape(j.status)}${j.status === 'building' ? ` ${j.progress}%` : ''}</span><button class="secondary" data-detail="${j.id}">Details ↗</button>${j.status === 'ready' ? `<button class="secondary" data-download="${j.id}">↓ APK</button>` : ''}</article>`;
  $('#recent').innerHTML = jobs.slice(0, 3).map(row).join('') || empty;
  $('#history-list').innerHTML = jobs.map(row).join('') || empty;
  if (activeDetail && $('#build-detail').open) renderDetail();
}
async function refresh(throwError = false) {
  if (!token || refreshing) return;
  refreshing = true;
  try { jobs = await (await api('/api/builds')).json(); render(); }
  catch (e) { if (throwError) throw e; toast(e.message); }
  finally { refreshing = false; }
}
$('#build-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!token) { $('#auth').showModal(); return; }
  const data = Object.fromEntries(new FormData(event.target)); data.versionCode = Number(data.versionCode);
  $('#submit').disabled = true; $('#submit').textContent = 'Adding to your pipeline…';
  try { const job = await (await api('/api/builds', { method: 'POST', body: JSON.stringify(data) })).json(); await refresh(); activeDetail = job.id; renderDetail(); $('#build-detail').showModal(); toast('Build added to the queue'); }
  catch (e) { toast(e.message); }
  finally { $('#submit').disabled = false; $('#submit').innerHTML = 'Create Android build <span>↗</span>'; }
});
function renderDetail() {
  const j = jobs.find(j => j.id === activeDetail); if (!j) return;
  $('#detail-content').innerHTML = `<p>${escape(j.config.appName)} · ${escape(j.id)}</p><span class="badge ${j.status}">${j.status}</span><p>${escape(new Date(j.created).toLocaleString())}</p><progress value="${j.progress}" max="100" aria-label="Build progress"></progress><pre>${escape(j.log || 'Waiting for the build worker…')}</pre>${j.sha256 ? `<p>SHA-256</p><pre>${escape(j.sha256)}</pre><p>${(j.bytes / 1048576).toFixed(2)} MB · Signature verified</p>` : ''}${j.status === 'ready' ? `<button class="primary" data-download="${j.id}">Download verified APK ↓</button>` : ''}${['failed','expired'].includes(j.status) ? `<button class="primary" data-retry="${j.id}">Use configuration for a new build ↗</button>` : ''}`;
}
$('#detail-close').addEventListener('click', () => $('#build-detail').close());
document.addEventListener('click', async event => {
  const el = event.target.closest('button'); if (!el) return;
  if (el.dataset.detail) { activeDetail = el.dataset.detail; renderDetail(); $('#build-detail').showModal(); }
  if (el.dataset.retry) {
    const j = jobs.find(j => j.id === el.dataset.retry);
    Object.entries(j.config).forEach(([k,v]) => { $('#build-form').elements[k].value = v; });
    updatePreview(); $('#build-detail').close(); navigate('studio'); toast('Configuration restored. Review and create a new build.');
  }
  if (el.dataset.download) {
    el.disabled = true;
    try {
      const response = await api(`/api/builds/${el.dataset.download}/download`), blob = await response.blob();
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'MizanMods.apk'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast(e.message); } finally { el.disabled = false; }
  }
});
async function loadSettings() {
  $('#refresh-settings').disabled = true;
  try {
    const s = await (await api('/api/settings')).json();
    $('#checks').innerHTML = s.checks.map(c => `<div class="check"><span>${escape(c.name)}</span><span class="badge ${c.ok ? 'ready' : 'failed'}">${c.ok ? 'Ready' : 'Setup required'}</span></div>`).join('');
    $('#retention').textContent = `${s.storage} · ${s.retentionDays}-day artifact retention · ${s.concurrency} concurrent build`;
  } catch(e) { toast(e.message); } finally { $('#refresh-settings').disabled = false; }
}
$('#refresh-settings').addEventListener('click', () => token ? loadSettings() : $('#auth').showModal());
let previewTemplate = '';
function updatePreview() {
  $('#hex').textContent = $('#accent').value.toUpperCase();
  if (!previewTemplate) return;
  const html = previewTemplate.replaceAll('__APP_NAME__', escape($('#appName').value || 'Your app')).replaceAll('__WELCOME__', escape($('#welcome-message').value));
  $('#app-preview').srcdoc = html;
}
$('#build-form').addEventListener('input', updatePreview);
// The preview uses the bundled HTML/CSS/JS; its document gets the selected accent after load.
$('#app-preview').addEventListener('load', () => {
  const doc = $('#app-preview').contentDocument;
  if (doc) doc.documentElement.style.setProperty('--accent', $('#accent').value);
});
fetch('/popup.html').then(r => { if (!r.ok) throw Error(); return r.text(); }).then(html => { previewTemplate = html; updatePreview(); }).catch(() => toast('App preview could not load. Refresh to try again.'));
navigate(location.hash.slice(1)); render(); setInterval(() => { if (!document.hidden && !$('#auth').open) refresh(); }, 3000);
