// URL of your Cloudflare Worker
const WORKER_URL = 'https://still-glade-4d20.curtisgenereux01.workers.dev';
const MODEL = 'gpt-5';
const STORAGE_KEY = 'chats_v1';
let pendingAttachments = []; // data URLs for images awaiting send
// Auth token helpers
const AUTH_TOKEN_KEY = 'auth_token';
const AUTH_USER_KEY  = 'auth_user';
function token()         { return localStorage.getItem(AUTH_TOKEN_KEY); }
function authedUser()    { return localStorage.getItem(AUTH_USER_KEY); }
function setAuth(t, u)   { localStorage.setItem(AUTH_TOKEN_KEY, t); localStorage.setItem(AUTH_USER_KEY, u); }
function clearAuth()     { localStorage.removeItem(AUTH_TOKEN_KEY); localStorage.removeItem(AUTH_USER_KEY); }

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

function renderAttachments() {
  const cont = document.getElementById('attachments');
  if (!cont) return;
  cont.innerHTML = '';
  pendingAttachments.forEach((url, idx) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    const img = document.createElement('img');
    img.src = url; t.appendChild(img);
    const b = document.createElement('button');
    b.textContent = '×'; b.title = 'Remove';
    b.onclick = () => { pendingAttachments.splice(idx,1); renderAttachments(); };
    t.appendChild(b);
    cont.appendChild(t);
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

function clearConversation() {
  const s = loadState();
  const conv = getActive(s);
  if (!conv) return;
  const ok = confirm('Clear messages in this chat?');
  if (!ok) return;
  conv.messages = [];
  saveState(s); renderAll();
  persistToServer(conv).catch(() => {});
}

async function sendMessage() {
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
    for (const url of pendingAttachments) parts.push({ type: 'image_url', image_url: { url } });
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
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: conv.messages.map(({role, content}) => ({ role, content })) })
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
  } catch (err) {
    alert(err.message || String(err));
  }
}

// ---- buttons ----
document.getElementById('send').addEventListener('click', sendMessage);
document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('clear').addEventListener('click', clearConversation);
document.getElementById('download').addEventListener('click', () => {
  const s = loadState();
  const conv = getActive(s);
  const blob = new Blob([JSON.stringify(conv || {}, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: `${(conv?.title||'conversation').replace(/\s+/g,'_')}.json` }).click();
  URL.revokeObjectURL(url);
});
document.getElementById('newConv').addEventListener('click', newConversation);
document.getElementById('deleteConv').addEventListener('click', deleteConversation);
document.getElementById('attach').addEventListener('click', () => document.getElementById('imageInput').click());
document.getElementById('imageInput')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const dataUrl = await fileToDataURL(f);
    pendingAttachments.push(dataUrl);
  }
  e.target.value = '';
  renderAttachments();
});
// Server persistence helpers (Cloudflare Worker KV via new endpoints)
async function persistToServer(conv){
  try{
    await fetch(`${WORKER_URL}/conversations/${encodeURIComponent(conv.id)}` ,{
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${token()}` },
      body: JSON.stringify({ ...conv, model: MODEL })
    });
  }catch(_){/* ignore */}
}
async function deleteOnServer(conv){
  try{
    await fetch(`${WORKER_URL}/conversations/${encodeURIComponent(conv.id)}` ,{
      method:'DELETE',
      headers:{ Authorization: `Bearer ${token()}` }
    });
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
        const errMsg = (j && (typeof j.error === 'string' ? j.error : JSON.stringify(j.error || j))) || (t || `HTTP ${r.status}`);
        throw new Error(errMsg);
      }
      if (!j || !j.token) throw new Error('Invalid register response');
      setAuth(j.token, j.username);
      whoEl.textContent = `Signed in as ${j.username}`;
      showApp();
    } catch (e) { msgEl.textContent = e?.message || String(e); console.error('register error', e); }
  });

  document.getElementById('logout').addEventListener('click', async () => {
    try { await fetch(`${WORKER_URL}/auth/logout`, { method:'POST', headers:{ Authorization: `Bearer ${token()}` } }); } catch {}
    clearAuth();
    showAuth();
  });

  if (await checkAuth()) showApp(); else showAuth();
})();

// Try initial sync after auth: fetch server list and merge if local is empty
(async function initialSync(){
  try{
    const s = loadState();
    if (s.items.length > 1) return; // already have local history
    const r = await fetch(`${WORKER_URL}/conversations`, { headers: { Authorization: `Bearer ${token()}` } });
    if(!r.ok) return;
    const j = await r.json();
    if(Array.isArray(j.items) && j.items.length){
      // pull each conv and merge minimal
      for (const it of j.items){
        const rr = await fetch(`${WORKER_URL}/conversations/${encodeURIComponent(it.id)}`, { headers:{ Authorization: `Bearer ${token()}` } });
        if (!rr.ok) continue;
        const conv = await rr.json();
        if (conv && conv.id){
          s.items.push({ id: conv.id, title: conv.title, createdAt: conv.createdAt || Date.now(), messages: conv.messages || [] });
        }
      }
      if (s.items.length) s.activeId = s.items[0].id;
      saveState(s); renderAll();
    }
  }catch(_){/* ignore */}
})();
