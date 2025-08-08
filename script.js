// URL of your Cloudflare Worker
const WORKER_URL = 'https://still-glade-4d20.curtisgenereux01.workers.dev';
const MODEL = 'gpt-5';
const STORAGE_KEY = 'chats_v1';
// Pending attachments: array of { kind: 'image'|'textfile'|'file', name, mime, size, dataUrl?, contentText? }
let pendingAttachments = [];
let syncTimer = null; // periodic server sync timer
let inflightController = null; // abort controller for model request
// Auth token helpers
const AUTH_TOKEN_KEY = 'auth_token';
const AUTH_USER_KEY  = 'auth_user';
function token()         { return localStorage.getItem(AUTH_TOKEN_KEY); }
function authedUser()    { return localStorage.getItem(AUTH_USER_KEY); }
function setAuth(t, u)   { localStorage.setItem(AUTH_TOKEN_KEY, t); localStorage.setItem(AUTH_USER_KEY, u); }
function clearAuth()     { localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem(AUTH_USER_KEY); }

function startAutoSyncTimer() {
  if (syncTimer || !token() || document.visibilityState !== 'visible') return;
  syncTimer = setInterval(() => { serverSyncMerge(); }, 30000); // every 30s
}
function stopAutoSyncTimer() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

// ---- state helpers ----
function newId() { return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8); }
function defaultTitle() { return 'New chat'; }

function loadState() {
  let s;
  try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) {}
  if (!s || !Array.isArray(s.items)) s = { activeId: null, items: [] };
  if (!s.items.length) {
    const nc = { id: newId(), title: defaultTitle(), createdAt: Date.now(), messages: [] };
    s.items.push(nc); s.activeId = nc.id; saveState(s);
  }
  if (!s.activeId || !s.items.find(c => c.id === s.activeId)) s.activeId = s.items[0].id;
  return s;
}
function saveState(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
function getActive(s) { return s.items.find(c => c.id === s.activeId); }

// ---- rendering ----
function renderSidebar() {
  const s = loadState();
  const list = document.getElementById('convList');
  list.innerHTML = '';
  s.items
    .slice()
    .sort((a,b) => b.createdAt - a.createdAt)
    .forEach(conv => {
      const li = document.createElement('li');
      li.textContent = conv.title || defaultTitle();
      li.dataset.id = conv.id;
      if (conv.id === s.activeId) li.classList.add('active');
      li.onclick = () => { const st = loadState(); st.activeId = conv.id; saveState(st); renderAll(); };
      const del = document.createElement('button');
      del.textContent = '🗑'; del.className = 'delbtn'; del.title = 'Delete this chat';
      del.onclick = (e) => { e.stopPropagation(); const st = loadState(); st.activeId = conv.id; saveState(st); deleteConversation(); };
      li.appendChild(del);
      list.appendChild(li);
    });
}

function renderChat() {
  const s = loadState();
  const conv = getActive(s);
  const box = document.getElementById('chat');
  box.innerHTML = '';
  (conv?.messages || []).forEach(m => {
    const wrap = document.createElement('div');
    wrap.className = 'message ' + m.role;
    if (Array.isArray(m.content)) {
      const who = document.createElement('div');
      who.textContent = (m.role === 'user' ? 'You:' : 'AI:');
      who.style.fontWeight = 'bold';
      wrap.appendChild(who);
      m.content.forEach(part => {
        if (part.type === 'text' && part.text?.trim()) {
          const p = document.createElement('div');
          p.textContent = part.text;
          wrap.appendChild(p);
        } else if (part.type === 'image_url' && part.image_url?.url) {
          const img = document.createElement('img');
          img.src = part.image_url.url;
          img.style.maxWidth = '200px';
          img.style.maxHeight = '200px';
          img.style.margin = '0.25rem 0.4rem 0.25rem 0';
          img.style.border = '1px solid #ddd';
          img.style.borderRadius = '6px';
          wrap.appendChild(img);
        }
      });
    } else {
      wrap.textContent = (m.role === 'user' ? 'You: ' : 'AI: ') + m.content;
    }
    box.appendChild(wrap);
  });
  box.scrollTop = box.scrollHeight;
}

function humanSize(bytes){
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}

function renderAttachments() {
  const cont = document.getElementById('attachments');
  if (!cont) return;
  cont.innerHTML = '';
  pendingAttachments.forEach((att, idx) => {
    if (att.kind === 'image') {
      const t = document.createElement('div');
      t.className = 'thumb';
      const img = document.createElement('img');
      img.src = att.dataUrl; t.appendChild(img);
      const b = document.createElement('button');
      b.textContent = '×'; b.title = 'Remove';
      b.onclick = () => { pendingAttachments.splice(idx,1); renderAttachments(); };
      t.appendChild(b);
      cont.appendChild(t);
    } else {
      const chip = document.createElement('div');
      chip.className = 'filechip';
      const label = document.createElement('span');
      label.textContent = `${att.name || '(file)'} · ${humanSize(att.size||0)}`;
      chip.appendChild(label);
      const b = document.createElement('button');
      b.textContent = '×'; b.className='remove'; b.title = 'Remove';
      b.onclick = () => { pendingAttachments.splice(idx,1); renderAttachments(); };
      chip.appendChild(b);
      cont.appendChild(chip);
    }
  });
}

function renderAll() { renderSidebar(); renderChat(); renderAttachments(); }

// ---- actions ----
function newConversation() {
  const s = loadState();
  const c = { id: newId(), title: defaultTitle(), createdAt: Date.now(), messages: [] };
  s.items.push(c); s.activeId = c.id; saveState(s); renderAll();
  persistToServer(c).catch(() => {});
}

function deleteConversation() {
  const s = loadState();
  if (!s.activeId) return;
  const conv = getActive(s);
  if (!conv) return;
  const ok = confirm(`Delete chat: "${conv.title || defaultTitle()}"?`);
  if (!ok) return;
  deleteOnServer(conv).catch(() => {});
  s.items = s.items.filter(c => c.id !== s.activeId);
  if (!s.items.length) {
    const nc = { id: newId(), title: defaultTitle(), createdAt: Date.now(), messages: [] };
    s.items.push(nc); s.activeId = nc.id;
  } else {
    s.activeId = s.items[0].id;
  }
  saveState(s); renderAll();
}

// (Removed Clear Conversation feature per request)

async function sendMessage() {
  if (inflightController) return; // already generating
  const input = document.getElementById('userInput');
  const text  = input.value.trim();
  if (!text && pendingAttachments.length === 0) return;

  const s = loadState();
  const conv = getActive(s);
  if (!conv) return;

  // Build user content as text or multimodal array
  let userContent;
  if (pendingAttachments.length > 0) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    const MAX_FILE_TEXT = 200_000; // characters
    for (const att of pendingAttachments) {
      if (att.kind === 'image' && att.dataUrl) {
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      } else if (att.kind === 'textfile') {
        let body = att.contentText || '';
        let pre = '';
        const lang = guessLangFromName(att.name||'');
        if (lang) pre = `\n\n\u0060\u0060\u0060${lang}\n`;
        const post = lang ? `\n\u0060\u0060\u0060` : '';
        if (body.length > MAX_FILE_TEXT) {
          body = body.slice(0, MAX_FILE_TEXT) + `\n...[truncated ${body.length - MAX_FILE_TEXT} chars]`;
        }
        const header = `[file: ${att.name || '(text file)'}]`;
        parts.push({ type: 'text', text: `${header}${pre}${body}${post}` });
      } else if (att.kind === 'file') {
        // Non-text files (e.g., PDFs). Include a note so the assistant knows what's attached.
        parts.push({ type: 'text', text: `[file attached: ${att.name || '(file)'} · ${att.mime || 'application/octet-stream'} · ${humanSize(att.size||0)}]` });
      }
    }
    userContent = parts;
  } else {
    userContent = text;
  }
  conv.messages.push({ role: 'user', content: userContent, ts: Date.now() });
  if (!conv.title || conv.title === defaultTitle()) {
    const titleBase = text || 'New chat';
    conv.title = titleBase.slice(0, 42) + (titleBase.length > 42 ? '…' : '');
  }
  saveState(s);
  renderAll();
  input.value = '';
  pendingAttachments = []; renderAttachments();
  persistToServer(conv).catch(() => {});

  try {
    inflightController = new AbortController();
    setGeneratingUI(true);
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: conv.messages.map(({role, content}) => ({ role, content })) }),
      signal: inflightController.signal
    });
    const textBody = await res.text();
    if (!res.ok) throw new Error(textBody || `HTTP ${res.status}`);
    let data;
    try { data = JSON.parse(textBody); } catch (_) { throw new Error('Invalid JSON from server'); }
    const replyContent = data.choices?.[0]?.message?.content;
    const reply = typeof replyContent === 'string' ? (replyContent.trim?.() || replyContent) : '[non-text response]';
    conv.messages.push({ role: 'assistant', content: reply, ts: Date.now() });
    saveState(s);
    renderAll();
    persistToServer(conv).catch(() => {});
    // Auto-sync after receiving assistant reply
    serverSyncMerge().catch(()=>{});
  } catch (err) {
    if (!(err && (err.name === 'AbortError' || /abort/i.test(String(err.name||''))))) {
      alert(err.message || String(err));
    }
  } finally {
    inflightController = null;
    setGeneratingUI(false);
  }
}

// ---- buttons ----
document.getElementById('send').addEventListener('click', sendMessage);
document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
// Clear button removed from UI
document.getElementById('download').addEventListener('click', () => {
  const s = loadState();
  const conv = getActive(s);
  const title = (conv?.title || 'conversation').trim();
  const lines = [];
  if (title) lines.push(`# ${title}`);
  if (conv?.messages?.length) {
    for (const m of conv.messages) {
      const who = m.role === 'user' ? 'You' : 'AI';
      let text = '';
      if (Array.isArray(m.content)) {
        const parts = [];
        for (const p of m.content) {
          if (p?.type === 'text' && p.text) parts.push(String(p.text));
          else if (p?.type === 'image_url') parts.push('[image]');
        }
        text = parts.join(' ');
      } else {
        text = String(m.content ?? '');
      }
      lines.push(`${who}: ${text}`);
    }
  }
  const blob = new Blob([lines.join('\n\n') + '\n'], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const filename = `${title.replace(/\s+/g, '_')}.txt`;
  Object.assign(document.createElement('a'), { href: url, download: filename }).click();
  URL.revokeObjectURL(url);
});
document.getElementById('newConv').addEventListener('click', newConversation);
document.getElementById('deleteConv').addEventListener('click', deleteConversation);
document.getElementById('attachMore').addEventListener('click', () => document.getElementById('fileInput').click());

document.getElementById('imageInput')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  await handleFiles(files);
  e.target.value = '';
  renderAttachments();
});
document.getElementById('stop').addEventListener('click', () => { if (inflightController) inflightController.abort(); });
document.getElementById('fileInput')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  await handleFiles(files);
  e.target.value = '';
  renderAttachments();
});

// Allow pasting images/files into the page
document.addEventListener('paste', async (e) => {
  const dt = e.clipboardData;
  if (!dt) return;
  const files = Array.from(dt.files || []);
  if (files.length) {
    await handleFiles(files);
    renderAttachments();
  }
});
// Server persistence helpers (Cloudflare Worker KV via new endpoints)
async function persistToServer(conv){
  const t = token();
  if (!t) return; // only persist when signed in
  try{
    await fetch(`${WORKER_URL}/conversations/${encodeURIComponent(conv.id)}` ,{
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ ...conv, model: MODEL })
    });
  }catch(_){/* ignore */}
}

function setGeneratingUI(on){
  const stopBtn = document.getElementById('stop');
  const sendBtn = document.getElementById('send');
  if (stopBtn) stopBtn.disabled = !on;
  if (sendBtn) sendBtn.disabled = on;
}
async function deleteOnServer(conv){
  const t = token();
  if (!t) return; // only delete when signed in
  try{
    await fetch(`${WORKER_URL}/conversations/${encodeURIComponent(conv.id)}` ,{
      method:'DELETE',
      headers:{ Authorization: `Bearer ${t}` }
    });
  }catch(_){/* ignore */}
}

// Pull remote conversations and merge with local
async function serverSyncMerge(){
  const t = token();
  if (!t) return;
  try{
    const listRes = await fetch(`${WORKER_URL}/conversations`, { headers:{ Authorization: `Bearer ${t}` } });
    if (!listRes.ok) return;
    const j = await listRes.json();
    const s = loadState();
    const byId = new Map(s.items.map(c => [c.id, c]));
    for (const it of (j.items || [])){
      try{
        const rr = await fetch(`${WORKER_URL}/conversations/${encodeURIComponent(it.id)}`, { headers:{ Authorization: `Bearer ${t}` } });
        if (!rr.ok) continue;
        const remote = await rr.json();
        if (!remote || !remote.id) continue;
        const local = byId.get(remote.id);
        const remoteUpdated = remote.updatedAt || remote.createdAt || 0;
        if (!local){
          s.items.push({ id: remote.id, title: remote.title, createdAt: remote.createdAt || Date.now(), messages: remote.messages || [] });
        } else {
          const localUpdated = (local.messages && local.messages.length ? local.messages[local.messages.length-1].ts : local.createdAt) || 0;
          if (remoteUpdated > localUpdated){
            local.title = remote.title || local.title;
            local.messages = Array.isArray(remote.messages) ? remote.messages : local.messages;
            local.createdAt = remote.createdAt || local.createdAt;
          } else if (localUpdated > remoteUpdated){
            // push newer local copy upstream
            persistToServer(local).catch(()=>{});
          }
        }
      }catch(_){/* ignore */}
    }
    if (!s.activeId && s.items.length) s.activeId = s.items[0].id;
    saveState(s); renderAll();
  }catch(_){/* ignore */}
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsText(file);
  });
}

function guessLangFromName(name){
  const n = (name || '').toLowerCase();
  const map = {
    js:'javascript', ts:'typescript', tsx:'tsx', jsx:'jsx', json:'json', md:'markdown',
    py:'python', rb:'ruby', go:'go', rs:'rust', java:'java', kt:'kotlin', swift:'swift',
    c:'c', h:'c', cpp:'cpp', cxx:'cpp', cc:'cpp', hpp:'cpp', cs:'csharp', php:'php',
    html:'html', css:'css', scss:'scss', sql:'sql', sh:'bash', yml:'yaml', yaml:'yaml'
  };
  const m = n.match(/\.([a-z0-9]+)$/);
  return m ? (map[m[1]] || '') : '';
}

async function handleFiles(files){
  for (const f of files) {
    try {
      const mime = f.type || 'application/octet-stream';
      if (mime.startsWith('image/')) {
        const dataUrl = await fileToDataURL(f);
        pendingAttachments.push({ kind:'image', name: f.name || 'image', mime, size: f.size, dataUrl });
      } else if (mime.startsWith('text/') || isLikelyCodeFile(f.name)) {
        const text = await fileToText(f);
        pendingAttachments.push({ kind:'textfile', name: f.name || 'text.txt', mime, size: f.size, contentText: text });
      } else if (mime === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        // Keep reference; not embedding full PDF into message to avoid huge payloads
        pendingAttachments.push({ kind:'file', name: f.name || 'document.pdf', mime, size: f.size });
      } else {
        pendingAttachments.push({ kind:'file', name: f.name || 'file', mime, size: f.size });
      }
    } catch (_) {
      // ignore
    }
  }
}

function isLikelyCodeFile(name){
  return /\.(js|ts|tsx|jsx|json|md|py|rb|go|rs|java|kt|swift|c|cpp|cxx|cc|h|hpp|cs|php|html|css|scss|sql|sh|yml|yaml)$/i.test(name || '');
}

// ---- init ----
renderAll();
// Auth/UI bootstrap
(async function bootstrap(){
  const authBox = document.getElementById('auth');
  const appBox  = document.getElementById('app');
  const whoEl   = document.getElementById('whoami');
  const msgEl   = document.getElementById('authMsg');

  async function checkAuth(){
    const t = token();
    if (!t) return false;
    try {
      const r = await fetch(`${WORKER_URL}/auth/me`, { headers: { Authorization: `Bearer ${t}` } });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j.username) return false;
      whoEl.textContent = `Signed in as ${j.username}`;
      return true;
    } catch { return false; }
  }

  function showAuth(){ authBox.style.display=''; appBox.style.display='none'; }
  function showApp(){ authBox.style.display='none'; appBox.style.display=''; }

  document.getElementById('loginBtn').addEventListener('click', async () => {
    msgEl.textContent = '';
    const username = document.getElementById('username').value.trim().toLowerCase();
    const password = document.getElementById('password').value;
    try {
      const r = await fetch(`${WORKER_URL}/auth/login`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username, password }) });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = null; }
      if (!r.ok) {
        const errMsg = (j && (typeof j.error === 'string' ? j.error : JSON.stringify(j.error || j))) || (t || `HTTP ${r.status}`);
        throw new Error(errMsg);
      }
      if (!j || !j.token) throw new Error('Invalid login response');
      setAuth(j.token, j.username);
      whoEl.textContent = `Signed in as ${j.username}`;
      showApp();
      startAutoSyncTimer();
      // Immediately pull down any existing conversations for this account
      try { await serverSyncMerge(); } catch {}
    } catch (e) { msgEl.textContent = e?.message || String(e); console.error('login error', e); }
  });

  document.getElementById('registerBtn').addEventListener('click', async () => {
    msgEl.textContent = '';
    const username = document.getElementById('username').value.trim().toLowerCase();
    const password = document.getElementById('password').value;
    try {
      const r = await fetch(`${WORKER_URL}/auth/register`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username, password }) });
      const t = await r.text();
      let j; try { j = JSON.parse(t); } catch { j = null; }
      if (!r.ok) {
        if (r.status === 409) {
          throw new Error('Account already exists. Please log in.');
        }
        const errMsg = (j && (typeof j.error === 'string' ? j.error : JSON.stringify(j.error || j))) || (t || `HTTP ${r.status}`);
        throw new Error(errMsg);
      }
      if (!j || !j.token) throw new Error('Invalid register response');
      setAuth(j.token, j.username);
      whoEl.textContent = `Signed in as ${j.username}`;
      showApp();
      startAutoSyncTimer();
      // After first sign-up, also pull any existing data (if any)
      try { await serverSyncMerge(); } catch {}
    } catch (e) { msgEl.textContent = e?.message || String(e); console.error('register error', e); }
  });

  document.getElementById('logout').addEventListener('click', async () => {
    try { await fetch(`${WORKER_URL}/auth/logout`, { method:'POST', headers:{ Authorization: `Bearer ${token()}` } }); } catch {}
    clearAuth();
    showAuth();
    stopAutoSyncTimer();
  });

  const authed = await checkAuth();
  if (authed) {
    showApp();
    startAutoSyncTimer();
    // Auto-sync on open so old chats appear immediately
    try { await serverSyncMerge(); } catch {}
  } else {
    showAuth();
  }
})();
// Manual sync button
document.getElementById('syncBtn')?.addEventListener('click', () => { serverSyncMerge(); });

// Also sync when the tab becomes visible or window gains focus
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { serverSyncMerge(); startAutoSyncTimer(); }
  else { stopAutoSyncTimer(); }
});
window.addEventListener('focus', () => { serverSyncMerge(); });
