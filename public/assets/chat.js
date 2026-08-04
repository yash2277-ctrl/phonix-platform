/* ═══════════════════════════════════════
   PHØNIX AI — Workspace client
   Agent streaming · artifacts · knowledge
   projects · prompts · memory · tools
   ═══════════════════════════════════════ */

const API = window.location.origin;
let token = localStorage.getItem('phonix_token');
let currentUser = JSON.parse(localStorage.getItem('phonix_user') || 'null');
let isGuest = localStorage.getItem('phonix_guest') === '1';

let conversations = [], currentConversation = null, messages = [];
let projects = [], artifacts = [], knowledge = [], prompts = [], models = [];
let currentModel = localStorage.getItem('phonix_model') || 'blaze';
let currentProject = null, activeArtifact = null;
let isStreaming = false, abortCtl = null, attachedFiles = [];
let features = { thinking: true, tools: true, knowledge: true };
let activeTab = 'chats';

if (!currentUser) location.href = '/login';

/* ─── API ─── */
async function api(endpoint, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token && !isGuest) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + endpoint, { ...opts, headers, credentials: 'include' });

  if (res.status === 401 && !isGuest) {
    const r = await fetch(API + '/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (r.ok) {
      token = (await r.json()).data.accessToken;
      localStorage.setItem('phonix_token', token);
      headers.Authorization = `Bearer ${token}`;
      return fetch(API + endpoint, { ...opts, headers, credentials: 'include' }).then(x => x.json());
    }
    logout(); return null;
  }
  try { return await res.json(); } catch { return null; }
}

function toast(msg, ms = 2600) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
const ico = (n, cls='ic') => `<svg class="${cls}"><use href="#i-${n}"/></svg>`;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ─── INIT ─── */
document.addEventListener('DOMContentLoaded', async () => {
  initUser(); loadTheme(); loadFeatureToggles();
  const input = document.getElementById('messageInput');
  input.addEventListener('input', () => {
    document.getElementById('sendBtn').disabled = !input.value.trim() && !attachedFiles.length;
  });
  await Promise.all([loadModels(), loadConversations(), refreshUsage()]);
  loadProjects(); loadArtifacts(); loadKnowledge(); loadPrompts();
});

function initUser() {
  if (!currentUser) return;
  const initials = (currentUser.display_name || currentUser.username || 'U').slice(0, 2).toUpperCase();
  document.getElementById('userAvatar').textContent = initials;
  document.getElementById('userName').textContent = currentUser.display_name || currentUser.username || 'User';
  document.getElementById('userPlan').textContent = isGuest ? 'Guest' : (currentUser.plan || 'FREE');
}

async function refreshUsage() {
  if (isGuest) {
    const m = document.querySelector('.meter');
    if (m) m.style.display = 'none';
    return;
  }
  const r = await api('/api/v1/users/me');
  if (!r?.success) return;
  currentUser = r.data.user;
  localStorage.setItem('phonix_user', JSON.stringify(currentUser));
  initUser();
  const u = r.data.usage;
  const pct = Math.min(100, (u.today / u.limit) * 100);
  const fill = document.getElementById('usageFill');
  fill.style.width = pct + '%';
  fill.className = 'meter-fill' + (pct >= 100 ? ' full' : pct > 80 ? ' warn' : '');
  document.getElementById('usageText').textContent = `${u.today} / ${u.limit} MSGS`;
  document.getElementById('usagePct').textContent = Math.round(pct) + '%';
}

/* ─── MODELS ─── */
async function loadModels() {
  const r = await api('/api/v1/chat/models');
  models = r?.data?.models || [{ id: 'blaze', name: 'Blaze', description: '', available: true }];
  const menu = document.getElementById('modelMenu');
  menu.innerHTML = models.map(m => `
    <div class="mopt ${m.id === currentModel ? 'on' : ''}" onclick="selectModel('${m.id}')">
      <div class="mopt-ic">${ico(m.id === 'nova' ? 'sparkle' : m.id === 'ember' ? 'bolt' : 'tool')}</div>
      <div><div class="mopt-t">${esc(m.name.replace('PHØNIX ',''))}${m.available ? '' : '<span class="lock">PRO</span>'}</div>
      <div class="mopt-d">${esc(m.description)}</div></div>
    </div>`).join('');
  const sel = document.getElementById('settingsModel');
  if (sel) sel.innerHTML = models.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  updateModelLabel();
}
function updateModelLabel() {
  const m = models.find(x => x.id === currentModel);
  document.getElementById('currentModel').textContent = (m?.name || 'Blaze').replace('PHØNIX ', '');
}
function selectModel(id) {
  const m = models.find(x => x.id === id);
  if (m && !m.available) return toast('That model needs an upgraded plan');
  currentModel = id; localStorage.setItem('phonix_model', id);
  updateModelLabel(); loadModels();
  document.getElementById('modelMenu').classList.remove('show');
}
const toggleModelMenu = () => document.getElementById('modelMenu').classList.toggle('show');

/* ─── FEATURE TOGGLES ─── */
function loadFeatureToggles() {
  features = { ...features, ...JSON.parse(localStorage.getItem('phonix_features') || '{}') };
  for (const [k, el] of [['thinking', 'tglThink'], ['tools', 'tglTools'], ['knowledge', 'tglKnow']])
    document.getElementById(el)?.classList.toggle('on', !!features[k]);
}
function toggleFeature(name) {
  features[name] = !features[name];
  localStorage.setItem('phonix_features', JSON.stringify(features));
  loadFeatureToggles();
  toast(`${name} ${features[name] ? 'enabled' : 'disabled'}`);
}

/* ─── TABS ─── */
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.side-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
  ({ projects: loadProjects, artifacts: loadArtifacts, knowledge: loadKnowledge, prompts: loadPrompts }[tab] || (() => {}))();
}

/* ═══ CONVERSATIONS ═══ */
async function loadConversations() {
  if (isGuest) { conversations = JSON.parse(localStorage.getItem('phonix_guest_convs') || '[]'); return renderConversations(); }
  const r = await api('/api/v1/conversations');
  if (r?.success) { conversations = r.data.conversations; renderConversations(); }
}

function renderConversations() {
  const list = document.getElementById('convList');
  if (!conversations.length) return list.innerHTML = `<div class="empty">${ico('chat')}<p>No conversations yet.<br>Start one above.</p></div>`;
  const groups = { Pinned: [], Today: [], Yesterday: [], 'This week': [], Older: [] };
  const now = new Date(), today = now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  conversations.forEach(c => {
    if (c.is_pinned) return groups.Pinned.push(c);
    const d = new Date(c.last_message_at || c.updated_at || c.created_at);
    if (d.toDateString() === today) groups.Today.push(c);
    else if (d.toDateString() === yest.toDateString()) groups.Yesterday.push(c);
    else if (now - d < 6048e5) groups['This week'].push(c);
    else groups.Older.push(c);
  });
  list.innerHTML = Object.entries(groups).filter(([, v]) => v.length).map(([label, items]) => `
    <div class="grp">${label}</div>` + items.map(c => `
    <div class="row ${currentConversation?.id === c.id ? 'active' : ''}" onclick="openConversation('${c.id}')">
      ${ico(c.is_pinned ? 'pin' : 'chat')}
      <div class="row-main"><div class="row-t">${esc(c.title)}</div></div>
      <div class="row-acts">
        <button onclick="event.stopPropagation();pinConversation('${c.id}',${c.is_pinned ? 0 : 1})" title="Pin">${ico('pin')}</button>
        <button onclick="event.stopPropagation();renameConversation('${c.id}')" title="Rename">${ico('edit')}</button>
        <button onclick="event.stopPropagation();deleteConversation('${c.id}')" title="Delete">${ico('trash')}</button>
      </div>
    </div>`).join('')).join('');
  updateCounts();
}

async function newConversation() {
  autoCloseDrawer();
  if (isGuest) {
    const c = { id: 'c' + Date.now(), title: 'New conversation', model: currentModel, messages: [], created_at: new Date().toISOString() };
    conversations.unshift(c); saveGuest(); return openConversation(c.id);
  }
  const r = await api('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ model: currentModel, projectId: currentProject || undefined }) });
  if (r?.success) { conversations.unshift(r.data.conversation); renderConversations(); openConversation(r.data.conversation.id); }
}

async function openConversation(id) {
  currentConversation = conversations.find(c => c.id === id);
  if (!currentConversation) return;
  document.getElementById('welcomeScreen').style.display = 'none';
  document.getElementById('messagesArea').style.display = 'block';
  document.getElementById('chatTitle').textContent = currentConversation.title;
  document.getElementById('suggestionChips').innerHTML = '';
  autoCloseDrawer();
  renderConversations();
  if (isGuest) { messages = currentConversation.messages || []; return renderMessages(); }
  const r = await api(`/api/v1/messages/${id}`);
  if (r?.success) { messages = r.data.messages; renderMessages(); }
}

async function deleteConversation(id) {
  if (!confirm('Move this conversation to trash?')) return;
  if (isGuest) { conversations = conversations.filter(c => c.id !== id); saveGuest(); }
  else { await api(`/api/v1/conversations/${id}`, { method: 'DELETE' }); conversations = conversations.filter(c => c.id !== id); }
  if (currentConversation?.id === id) resetToWelcome();
  renderConversations(); toast('Moved to trash');
}
async function pinConversation(id, pin) {
  if (!isGuest) await api(`/api/v1/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ is_pinned: !!pin }) });
  const c = conversations.find(x => x.id === id); if (c) c.is_pinned = pin;
  if (isGuest) saveGuest();
  renderConversations();
}
async function renameConversation(id) {
  const t = prompt('New title:'); if (!t) return;
  if (!isGuest) await api(`/api/v1/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title: t }) });
  const c = conversations.find(x => x.id === id); if (c) c.title = t;
  if (currentConversation?.id === id) document.getElementById('chatTitle').textContent = t;
  if (isGuest) saveGuest();
  renderConversations();
}
function resetToWelcome() {
  currentConversation = null; messages = [];
  document.getElementById('welcomeScreen').style.display = 'flex';
  document.getElementById('messagesArea').style.display = 'none';
  document.getElementById('chatTitle').textContent = 'New conversation';
}
const saveGuest = () => localStorage.setItem('phonix_guest_convs', JSON.stringify(conversations));

/* ═══ MESSAGES ═══ */
function renderMessages() {
  const area = document.getElementById('messagesArea');
  area.innerHTML = '';
  messages.forEach(m => area.appendChild(createMessageEl(m)));
  area.scrollTop = area.scrollHeight;
  hydrateCode();
}

function createMessageEl(msg) {
  const div = document.createElement('div');
  const isUser = msg.role === 'user';
  div.className = `turn ${isUser ? 'me' : 'ai'}`;
  div.dataset.id = msg.id || '';
  const initials = isUser ? (currentUser?.display_name || 'U').slice(0, 1).toUpperCase() : ico('sparkle');
  const name = isUser ? (currentUser?.display_name || 'You') : 'Phønix';
  const time = msg.created_at ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  div.innerHTML = `
    <div class="turn-head">
      <div class="turn-av ${isUser ? 'me' : 'ai'}">${initials}</div>
      <span class="turn-who">${esc(name)}</span><span class="turn-time">${time}</span>
    </div>
    <div class="turn-body">
      <div class="prose">${isUser ? esc(msg.content).replace(/\n/g, '<br>') : renderMarkdown(msg.content)}</div>
    </div>
    <div class="turn-acts">
      <button onclick="copyMessage(this)">${ico('copy')}Copy</button>
      ${!isUser ? `<button onclick="regenerate()">${ico('refresh')}Retry</button>` : ''}
      ${!isUser ? `<button onclick="rateMessage('${msg.id}','up',this)" title="Good">${ico('up')}</button>
                   <button onclick="rateMessage('${msg.id}','down',this)" title="Bad">${ico('down')}</button>
                   <button onclick="speakMsg(this)" title="Read aloud">${ico('volume')}</button>` : ''}
    </div>`;
  return div;
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    marked.setOptions({ breaks: true, gfm: true });
    const html = marked.parse(text);
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(html) : esc(text);
  } catch { return esc(text).replace(/\n/g, '<br>'); }
}

function hydrateCode() {
  document.querySelectorAll('.prose pre code').forEach(el => {
    if (el.dataset.hl) return;
    try { hljs.highlightElement(el); } catch {}
    el.dataset.hl = '1';
    const pre = el.closest('pre');
    if (pre && !pre.querySelector('.code-header')) {
      const lang = (el.className.match(/language-(\w+)/) || [, 'text'])[1];
      const h = document.createElement('div');
      h.className = 'code-bar';
      h.innerHTML = `<span>${lang}</span><button onclick="copyCode(this)">Copy</button>`;
      pre.insertBefore(h, pre.firstChild);
    }
  });
}

/* ═══ SENDING — the agent pipeline ═══ */
async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if ((!text && !attachedFiles.length) || isStreaming) return;

  if (!currentConversation) {
    if (isGuest) {
      currentConversation = { id: 'c' + Date.now(), title: text.slice(0, 50), model: currentModel, messages: [] };
      conversations.unshift(currentConversation); saveGuest();
    } else {
      const r = await api('/api/v1/conversations', { method: 'POST', body: JSON.stringify({ model: currentModel, title: text.slice(0, 50), projectId: currentProject || undefined }) });
      if (r?.success) { currentConversation = r.data.conversation; conversations.unshift(currentConversation); }
    }
    document.getElementById('welcomeScreen').style.display = 'none';
    document.getElementById('messagesArea').style.display = 'block';
    renderConversations();
  }

  let content = text;
  const attachIds = attachedFiles.map(f => f.id).filter(Boolean);
  if (attachedFiles.length) {
    const names = attachedFiles.map(f => f.name).join(', ');
    content = text + `\n\n_[attached: ${names}]_`;
    clearFiles();
  }

  const userMsg = { id: 'm' + Date.now(), role: 'user', content, created_at: new Date().toISOString() };
  messages.push(userMsg);
  const area = document.getElementById('messagesArea');
  area.appendChild(createMessageEl(userMsg));
  area.scrollTop = area.scrollHeight;

  input.value = ''; input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  document.getElementById('suggestionChips').innerHTML = '';

  await streamAgent(content, attachIds);
  refreshUsage();
  if (!isGuest) loadConversations();
}

async function streamAgent(userMessage, attachmentIds = []) {
  isStreaming = true;
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('stopBtn').style.display = 'grid';
  const area = document.getElementById('messagesArea');

  // shell for the assistant turn
  const wrap = document.createElement('div');
  wrap.className = 'turn ai';
  wrap.innerHTML = `
    <div class="turn-head">
      <div class="turn-av ai">${ico('sparkle')}</div><span class="turn-who">Phønix</span>
      <span class="turn-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>
    <div class="turn-body">
      <div class="reason" id="thBlock" style="display:none" onclick="this.classList.toggle('open')">
        <div class="reason-h">${ico('brain')}<span id="thLabel">Thinking</span>${ico('chevron','ic chev')}</div>
        <div class="reason-b" id="thBody"></div>
      </div>
      <div class="tools" id="toolStrip"></div>
      <div class="prose" id="liveContent"></div>
      <div id="artifactSlot"></div>
      <div id="citeSlot"></div>
    </div>
    <div class="turn-acts">
      <button onclick="copyMessage(this)">${ico('copy')}Copy</button>
      <button onclick="regenerate()">${ico('refresh')}Retry</button>
    </div>`;
  area.appendChild(wrap);

  const thinkEl = wrap.querySelector('#thBlock'), thBody = wrap.querySelector('#thBody'), thLabel = wrap.querySelector('#thLabel');
  const strip = wrap.querySelector('#toolStrip'), live = wrap.querySelector('#liveContent');
  const artSlot = wrap.querySelector('#artifactSlot'), citeSlot = wrap.querySelector('#citeSlot');

  const thinking = document.createElement('div');
  thinking.className = 'dots';
  thinking.innerHTML = '<i></i><i></i><i></i><span>Working…</span>';
  live.appendChild(thinking);
  area.scrollTop = area.scrollHeight;

  abortCtl = new AbortController();
  let full = '';

  const useAgent = !isGuest && token;
  const endpoint = useAgent ? '/api/v1/chat/agent' : '/api/v1/chat/stream';
  const payload = useAgent
    ? { message: userMessage, conversationId: currentConversation?.id, model: currentModel,
        thinking: features.thinking, useTools: features.tools, useKnowledge: features.knowledge,
        artifacts: true, suggestions: true, attachmentIds }
    : { message: userMessage, model: currentModel, persist: false,
        history: messages.slice(-20).map(m => ({ role: m.role, content: m.content })) };

  try {
    const res = await fetch(API + endpoint, {
      method: 'POST', signal: abortCtl.signal, credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(token && !isGuest ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload)
    });

    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n'); buf = frames.pop() || '';

      for (const frame of frames) {
        let evt = 'message', data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) evt = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let p; try { p = JSON.parse(data); } catch { continue; }

        if (evt === 'sources' && p.sources?.length) {
          thLabel.textContent = `Reading ${p.sources.length} source${p.sources.length > 1 ? 's' : ''} from your knowledge base`;
          thinkEl.style.display = 'block';
        }
        if (evt === 'thinking' && p.text) {
          thinkEl.style.display = 'block';
          thLabel.textContent = 'Reasoning';
          thBody.textContent = p.text;
        }
        if (evt === 'tool_use') {
          thinking.remove();
          const el = document.createElement('div');
          el.className = 'tool run';
          el.innerHTML = `<span class="d"></span>Using <code>${esc(p.tool)}</code><span class="ms">running</span>`;
          strip.appendChild(el); area.scrollTop = area.scrollHeight;
        }
        if (evt === 'tool_result') {
          const el = strip.lastElementChild;
          if (el) {
            el.className = 'tool ' + (p.ok ? 'ok' : 'fail');
            el.querySelector('.ms').textContent = (p.ok ? '' : 'failed · ') + (p.durationMs ?? 0) + 'ms';
          }
        }
        if (evt === 'delta' && p.text) {
          thinking.remove();
          full += p.text;
          live.innerHTML = renderMarkdown(full);
          area.scrollTop = area.scrollHeight;
        }
        if (evt === 'artifact') {
          artifacts.unshift(p);
          artSlot.insertAdjacentHTML('beforeend', `
            <button class="art-card" onclick="openArtifact('${p.id}')">
              <div class="art-ic">${ico(p.type === 'application/code' ? 'code' : p.type === 'text/html' ? 'globe' : 'file')}</div>
              <div><div class="art-t">${esc(p.title)}</div><div class="art-s">${esc(p.language || p.type.split('/')[1])} · v${p.version}</div></div>
              <span class="art-go">${ico('chevron')}</span>
            </button>`);
          loadArtifacts();
        }
        if (evt === 'citations' && p.citations?.length) {
          citeSlot.innerHTML = `<div class="cites"><div class="cites-h">Sources</div>` +
            p.citations.map(c => `<div class="cite" ${c.url ? `onclick="window.open('${esc(c.url)}','_blank')"` : ''}>
              <span class="cite-n">${c.n}</span><span class="cite-t">${esc(c.title || c.url || 'Source')}</span></div>`).join('') + `</div>`;
        }
        if (evt === 'suggestions' && p.suggestions?.length) {
          document.getElementById('suggestionChips').innerHTML =
            p.suggestions.map(s => `<div class="chip" onclick="useChip(this)">${esc(s)}</div>`).join('');
        }
        if (evt === 'error') console.warn('agent error:', p.message);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') { full = full || `I hit a problem: ${e.message}. Please try again.`; live.innerHTML = renderMarkdown(full); }
  } finally {
    thinking.remove();
    if (!full) { full = 'No response received.'; live.innerHTML = renderMarkdown(full); }
    messages.push({ id: 'm' + Date.now(), role: 'assistant', content: full, created_at: new Date().toISOString() });
    if (isGuest && currentConversation) { currentConversation.messages = messages; saveGuest(); }
    hydrateCode();
    isStreaming = false; abortCtl = null;
    document.getElementById('sendBtn').style.display = 'grid';
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('messageInput').focus();
  }
}

function stopGeneration() { abortCtl?.abort(); }
function useChip(el) {
  document.getElementById('messageInput').value = el.textContent;
  document.getElementById('sendBtn').disabled = false;
  sendMessage();
}
function useSuggestion(el) {
  document.getElementById('messageInput').value = el.querySelector('span:last-child').textContent;
  document.getElementById('sendBtn').disabled = false;
  sendMessage();
}
async function regenerate() {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  const idx = messages.map(m => m.role).lastIndexOf('assistant');
  if (idx >= 0) { messages.splice(idx, 1); renderMessages(); }
  await streamAgent(lastUser.content);
}
async function rateMessage(id, rating, btn) {
  if (isGuest || !id?.startsWith?.('m')) { /* server ids only */ }
  const r = await api(`/api/v1/messages/${id}/feedback`, { method: 'POST', body: JSON.stringify({ rating }) });
  btn.classList.add('on'); toast(r?.success ? 'Thanks for the feedback' : 'Feedback saved locally');
}

function updateCounts() {
  const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n || ''; };
  set('cChats', conversations.length); set('cProjects', projects.length);
  set('cArtifacts', artifacts.length); set('cKnowledge', knowledge.length); set('cPrompts', prompts.length);
}

/* ═══ PROJECTS ═══ */
async function loadProjects() {
  if (isGuest) return;
  const r = await api('/api/v1/projects');
  projects = r?.data?.projects || [];
  document.getElementById('projectList').innerHTML =
    `<button class="row add" onclick="showProjectModal()">${ico('plus')}<div class="row-main"><div class="row-t">New project</div></div></button>` +
    (projects.length ? projects.map(p => `
    <div class="row ${currentProject === p.id ? 'active' : ''}" onclick="selectProject('${p.id}')">
      ${ico('folder')}
      <div class="row-main"><div class="row-t">${esc(p.name)}</div>
      <div class="row-s">${p.conversationCount} chat${p.conversationCount === 1 ? '' : 's'}</div></div>
      <div class="row-acts"><button onclick="event.stopPropagation();deleteProject('${p.id}')" title="Delete">${ico('trash')}</button></div>
    </div>`).join('')
    : `<div class="empty">${ico('folder')}<p>No projects yet.<br>Group chats with shared instructions.</p></div>`);
  updateCounts();
}
function selectProject(id) {
  currentProject = currentProject === id ? null : id;
  loadProjects();
  toast(currentProject ? 'New chats will join this project' : 'Project filter cleared');
}
function showProjectModal() {
  openModal('New project', `
    <div class="fld"><label>Name</label><input class="in" id="pName" placeholder="e.g. Vara5 launch"></div>
    <div class="fld"><label>Description</label><input class="in" id="pDesc" placeholder="Optional"></div>
    <div class="fld"><label>Project instructions <span class="hint">— applied to every chat in this project</span></label>
      <textarea class="in" id="pPrompt" rows="3" placeholder="e.g. Answer as a senior engineer. Prefer TypeScript."></textarea></div>
    <button class="btn primary" onclick="createProject()">Create project</button>`);
}
async function createProject() {
  const name = document.getElementById('pName').value.trim();
  if (!name) return toast('Give it a name');
  const r = await api('/api/v1/projects', { method: 'POST', body: JSON.stringify({
    name, description: document.getElementById('pDesc').value || undefined,
    system_prompt: document.getElementById('pPrompt').value || undefined }) });
  if (r?.success) { closeModal('genericModal'); loadProjects(); toast('Project created'); }
  else toast(r?.error?.message || 'Could not create project');
}
async function deleteProject(id) {
  if (!confirm('Delete this project? Its chats are kept.')) return;
  await api(`/api/v1/projects/${id}`, { method: 'DELETE' });
  if (currentProject === id) currentProject = null;
  loadProjects(); toast('Project deleted');
}

/* ═══ ARTIFACTS ═══ */
async function loadArtifacts() {
  if (isGuest) return;
  const r = await api('/api/v1/artifacts');
  artifacts = r?.data?.artifacts || [];
  document.getElementById('artifactList').innerHTML = artifacts.length ? artifacts.map(a => `
    <div class="row" onclick="openArtifact('${a.id}')">
      ${ico(a.type === 'application/code' ? 'code' : a.type === 'text/html' ? 'globe' : 'file')}
      <div class="row-main"><div class="row-t">${esc(a.title)}</div>
      <div class="row-s">v${a.version} · ${esc(a.language || a.type.split('/')[1])}${a.is_published ? ' · public' : ''}</div></div>
      <div class="row-acts"><button onclick="event.stopPropagation();deleteArtifact('${a.id}')" title="Delete">${ico('trash')}</button></div>
    </div>`).join('') : `<div class="empty">${ico('file')}<p>No artifacts yet.<br>Ask for a document or some code.</p></div>`;
  updateCounts();
}

async function openArtifact(id) {
  const r = await api(`/api/v1/artifacts/${id}`);
  if (!r?.success) return toast('Could not open artifact');
  activeArtifact = r.data.artifact;
  activeArtifact._versions = r.data.versions;
  document.getElementById('apTitle').textContent = activeArtifact.title;
  document.getElementById('apMeta').textContent =
    `v${activeArtifact.version} · ${activeArtifact.language || activeArtifact.type}${activeArtifact.is_published ? ' · published' : ''}`;
  const body = document.getElementById('apBody');
  body.innerHTML = activeArtifact.type === 'text/markdown'
    ? `<div class="prose">${renderMarkdown(activeArtifact.content)}</div>`
    : `<pre><code class="language-${esc(activeArtifact.language || 'text')}">${esc(activeArtifact.content)}</code></pre>`;
  body.querySelectorAll('pre code').forEach(el => { try { hljs.highlightElement(el); } catch {} });
  document.getElementById('apVersions').classList.remove('show');
  document.getElementById('artifactPanel').classList.add('open');
  autoCloseDrawer();
}
const closeArtifact = () => document.getElementById('artifactPanel').classList.remove('open');
function copyArtifact() { navigator.clipboard.writeText(activeArtifact?.content || ''); toast('Copied'); }
function downloadArtifact() { if (activeArtifact) location.href = `${API}/api/v1/artifacts/${activeArtifact.id}/download`; }
async function publishArtifact() {
  const r = await api(`/api/v1/artifacts/${activeArtifact.id}/publish`, { method: 'POST' });
  if (r?.success) {
    const url = location.origin + r.data.url;
    navigator.clipboard.writeText(url).catch(() => {});
    toast('Published — link copied'); openArtifact(activeArtifact.id); loadArtifacts();
  }
}
function showVersions() {
  const el = document.getElementById('apVersions');
  const vs = activeArtifact?._versions || [];
  el.innerHTML = vs.length
    ? vs.map(v => `<div class="ver">v${v.version} · ${new Date(v.created_at).toLocaleString()}${v.change_note ? ' · ' + esc(v.change_note) : ''}
        <button onclick="rollback(${v.version})">Restore</button></div>`).join('')
    : `<div class="empty">${ico('clock')}<p>No earlier versions.</p></div>`;
  el.classList.toggle('show');
}
async function rollback(version) {
  const r = await api(`/api/v1/artifacts/${activeArtifact.id}/rollback`, { method: 'POST', body: JSON.stringify({ version }) });
  if (r?.success) { toast(`Restored v${version}`); openArtifact(activeArtifact.id); }
}
async function deleteArtifact(id) {
  if (!confirm('Delete this artifact?')) return;
  await api(`/api/v1/artifacts/${id}`, { method: 'DELETE' });
  if (activeArtifact?.id === id) closeArtifact();
  loadArtifacts(); toast('Artifact deleted');
}

/* ═══ KNOWLEDGE ═══ */
async function loadKnowledge() {
  if (isGuest) return;
  const r = await api('/api/v1/knowledge');
  knowledge = r?.data?.documents || [];
  document.getElementById('knowledgeList').innerHTML =
    `<button class="row add" onclick="showKnowledgeModal()">${ico('plus')}<div class="row-main"><div class="row-t">Add document</div></div></button>` +
    (knowledge.length ? knowledge.map(d => `
    <div class="row" onclick="previewDoc('${d.id}')">
      ${ico('book')}
      <div class="row-main"><div class="row-t">${esc(d.title)}</div>
      <div class="row-s">${d.chunk_count} chunk${d.chunk_count === 1 ? '' : 's'} · ${(d.size / 1024).toFixed(1)} kb</div></div>
      <div class="row-acts"><button onclick="event.stopPropagation();deleteDoc('${d.id}')" title="Remove">${ico('trash')}</button></div>
    </div>`).join('')
    : `<div class="empty">${ico('book')}<p>No documents yet.<br>Add text, a file or a URL —<br>Phønix will cite them.</p></div>`);
  updateCounts();
}
function showKnowledgeModal() {
  openModal('Add to knowledge base', `
    <p class="lede">Phønix searches these documents when answering and cites what it uses.</p>
    <div class="fld"><label>Title</label><input class="in" id="kTitle" placeholder="e.g. Product handbook"></div>
    <div class="fld"><label>Paste text</label><textarea class="in" id="kBody" rows="6" placeholder="Paste any reference material…"></textarea></div>
    <button class="btn primary" onclick="addKnowledge()">Add document</button>
    <div class="sep">or</div>
    <div class="fld"><label>Import from URL</label>
      <div class="row"><input class="in" id="kUrl" placeholder="https://…"><button class="btn sm" onclick="addKnowledgeUrl()">Fetch</button></div></div>
    <div class="fld"><label>Import an uploaded file</label>
      <button class="btn" onclick="document.getElementById('kbFile').click()">Choose a file…</button>
      <input type="file" id="kbFile" style="display:none" onchange="addKnowledgeFile(event)"></div>`);
}
async function addKnowledge() {
  const title = document.getElementById('kTitle').value.trim();
  const content = document.getElementById('kBody').value.trim();
  if (!title || !content) return toast('Title and text are required');
  const r = await api('/api/v1/knowledge', { method: 'POST', body: JSON.stringify({ title, content }) });
  if (r?.success) { closeModal('genericModal'); loadKnowledge(); toast(`Indexed into ${r.data.document.chunks} chunks`); }
  else toast(r?.error?.message || 'Could not add');
}
async function addKnowledgeUrl() {
  const url = document.getElementById('kUrl').value.trim();
  if (!url) return;
  toast('Fetching…');
  const r = await api('/api/v1/knowledge/from-url', { method: 'POST', body: JSON.stringify({ url }) });
  if (r?.success) { closeModal('genericModal'); loadKnowledge(); toast('Page indexed'); }
  else toast(r?.error?.message || 'Could not fetch that URL');
}
async function addKnowledgeFile(e) {
  const file = e.target.files[0]; if (!file) return;
  toast('Uploading…');
  const up = await uploadFile(file);
  if (!up) return toast('Upload failed');
  const r = await api('/api/v1/knowledge/from-file', { method: 'POST', body: JSON.stringify({ attachmentId: up.id }) });
  if (r?.success) { closeModal('genericModal'); loadKnowledge(); toast('File indexed'); }
  else toast(r?.error?.message || 'No readable text in that file');
}
async function previewDoc(id) {
  const r = await api(`/api/v1/knowledge/${id}`);
  if (!r?.success) return;
  openModal(r.data.document.title, `
    <p class="lede">${r.data.chunks.length} chunks · ${esc(r.data.document.source || 'manual')}</p>
    ${r.data.chunks.map(c => `<div class="mono" style="color:var(--tx2)">${esc(c.content.slice(0, 400))}${c.content.length > 400 ? '…' : ''}</div>`).join('')}`);
}
async function deleteDoc(id) {
  if (!confirm('Remove this document from the knowledge base?')) return;
  await api(`/api/v1/knowledge/${id}`, { method: 'DELETE' });
  loadKnowledge(); toast('Document removed');
}

/* ═══ PROMPTS ═══ */
async function loadPrompts() {
  if (isGuest) return;
  const r = await api('/api/v1/prompts');
  prompts = r?.data?.prompts || [];
  document.getElementById('promptList').innerHTML =
    `<button class="row add" onclick="showPromptModal()">${ico('plus')}<div class="row-main"><div class="row-t">New prompt</div></div></button>` +
    (prompts.length ? prompts.map(p => `
    <div class="row" onclick="usePrompt('${p.id}')">
      ${ico('bolt')}
      <div class="row-main"><div class="row-t">${esc(p.title)}</div>
      <div class="row-s">${esc(p.category)} · used ${p.use_count}×</div></div>
      <div class="row-acts"><button onclick="event.stopPropagation();deletePrompt('${p.id}')" title="Delete">${ico('trash')}</button></div>
    </div>`).join('')
    : `<div class="empty">${ico('bolt')}<p>No saved prompts.</p><button onclick="seedPrompts()">Add starter pack</button></div>`);
  updateCounts();
}
async function seedPrompts() { const r = await api('/api/v1/prompts/seed', { method: 'POST' }); loadPrompts(); toast(`Added ${r?.data?.added || 0} prompts`); }
async function usePrompt(id) {
  const r = await api(`/api/v1/prompts/${id}/use`, { method: 'POST' });
  if (r?.success) {
    const input = document.getElementById('messageInput');
    input.value = r.data.body; input.focus(); autoResize(input);
    autoCloseDrawer();
    document.getElementById('sendBtn').disabled = false;
    loadPrompts();
  }
}
const openPromptPicker = () => { switchTab('prompts'); document.getElementById('sidebar').classList.add('open'); };
function showPromptModal() {
  openModal('New prompt', `
    <div class="fld"><label>Title</label><input class="in" id="prTitle" placeholder="e.g. Code review"></div>
    <div class="fld"><label>Category</label><input class="in" id="prCat" placeholder="general" value="general"></div>
    <div class="fld"><label>Prompt text</label><textarea class="in" id="prBody" rows="5" placeholder="Review this code for bugs and clarity:"></textarea></div>
    <button class="btn primary" onclick="createPrompt()">Save prompt</button>`);
}
async function createPrompt() {
  const title = document.getElementById('prTitle').value.trim(), body = document.getElementById('prBody').value.trim();
  if (!title || !body) return toast('Title and text are required');
  const r = await api('/api/v1/prompts', { method: 'POST', body: JSON.stringify({ title, body, category: document.getElementById('prCat').value || 'general' }) });
  if (r?.success) { closeModal('genericModal'); loadPrompts(); toast('Prompt saved'); }
}
async function deletePrompt(id) { await api(`/api/v1/prompts/${id}`, { method: 'DELETE' }); loadPrompts(); toast('Prompt deleted'); }

/* ═══ FILES ═══ */
const triggerFileUpload = () => document.getElementById('fileInput').click();
function handleFile(e) { Array.from(e.target.files).forEach(uploadAndAttach); e.target.value = ''; }
function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result.split(',').pop()); r.onerror = rej; r.readAsDataURL(file); });
}
async function uploadFile(file) {
  const data = await fileToBase64(file);
  const r = await api('/api/v1/files', { method: 'POST', body: JSON.stringify({
    filename: file.name, mimeType: file.type || 'application/octet-stream', data,
    conversationId: currentConversation?.id }) });
  return r?.success ? r.data.attachment : null;
}
async function uploadAndAttach(file) {
  if (isGuest) return toast('Sign in to attach files');
  toast(`Uploading ${file.name}…`);
  const a = await uploadFile(file);
  if (!a) return toast('Upload failed');
  attachedFiles.push({ id: a.id, name: a.filename });
  renderFilePreview();
  document.getElementById('sendBtn').disabled = false;
  toast(a.hasText ? 'Attached — text extracted' : 'Attached');
}
function renderFilePreview() {
  document.getElementById('filePreview').innerHTML = attachedFiles.map((f, i) =>
    `<div class="att">${ico('file')}<span>${esc(f.name)}</span><button onclick="removeFile(${i})">${ico('x')}</button></div>`).join('');
}
function removeFile(i) { attachedFiles.splice(i, 1); renderFilePreview(); }
function clearFiles() { attachedFiles = []; renderFilePreview(); }

/* ═══ COMMAND PALETTE ═══ */
let paletteSel = 0, paletteItems = [];
function openPalette() {
  document.getElementById('palette').classList.add('show');
  const i = document.getElementById('paletteInput'); i.value = ''; i.focus();
  paletteSearch();
}
const closePalette = () => document.getElementById('palette').classList.remove('show');
async function paletteSearch() {
  const q = document.getElementById('paletteInput').value.trim();
  const box = document.getElementById('paletteResults');
  if (!q) {
    paletteItems = [
      { icon: 'plus', t: 'New chat', s: 'Start a fresh conversation', kind: 'action', run: newConversation },
      { icon: 'folder', t: 'New project', s: 'Group chats with shared instructions', kind: 'action', run: showProjectModal },
      { icon: 'book', t: 'Add knowledge', s: 'Index a document for citation', kind: 'action', run: showKnowledgeModal },
      { icon: 'brain', t: 'Memory', s: 'What Phønix remembers', kind: 'action', run: showMemories },
      { icon: 'chart', t: 'Usage', s: 'Your activity and limits', kind: 'action', run: showUsage },
      { icon: 'settings', t: 'Settings', s: 'Profile and instructions', kind: 'action', run: showSettings }
    ];
    return renderPalette();
  }
  const r = await api(`/api/v1/search?q=${encodeURIComponent(q)}`);
  const R = r?.data?.results || {};
  paletteItems = [
    ...(R.conversations || []).map(c => ({ icon: 'chat', t: c.title, s: `${c.message_count} messages`, kind: 'chat', run: () => openConversation(c.id) })),
    ...(R.messages || []).map(m => ({ icon: 'search', t: m.snippet, s: m.conversationTitle, kind: 'message', run: () => openConversation(m.conversationId) })),
    ...(R.projects || []).map(p => ({ icon: 'folder', t: p.name, s: p.description || 'Project', kind: 'project', run: () => { switchTab('projects'); selectProject(p.id); } })),
    ...(R.prompts || []).map(p => ({ icon: 'bolt', t: p.title, s: p.category, kind: 'prompt', run: () => usePrompt(p.id) }))
  ];
  renderPalette();
}
function renderPalette() {
  paletteSel = 0;
  const box = document.getElementById('paletteResults');
  box.innerHTML = paletteItems.length ? paletteItems.map((it, i) => `
    <div class="pit ${i === 0 ? 'sel' : ''}" onclick="runPalette(${i})">
      <div class="pit-ic">${ico(it.icon)}</div>
      <div class="pit-m"><div class="pit-t">${esc(it.t)}</div><div class="pit-s">${esc(it.s)}</div></div>
      <span class="pit-k">${it.kind}</span>
    </div>`).join('') : `<div class="empty">${ico('search')}<p>No matches</p></div>`;
}
function runPalette(i) { const it = paletteItems[i]; if (!it) return; closePalette(); it.run(); }
function paletteKey(e) {
  if (e.key === 'Escape') return closePalette();
  if (e.key === 'Enter') { e.preventDefault(); return runPalette(paletteSel); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    paletteSel = Math.max(0, Math.min(paletteItems.length - 1, paletteSel + (e.key === 'ArrowDown' ? 1 : -1)));
    document.querySelectorAll('.pit').forEach((el, i) => el.classList.toggle('sel', i === paletteSel));
  }
}
let searchTimer;
function onSearchInput() {
  clearTimeout(searchTimer);
  const q = document.getElementById('searchInput').value.toLowerCase();
  searchTimer = setTimeout(() => {
    document.querySelectorAll('#panel-' + activeTab + ' .row:not(.add)').forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  }, 120);
}

/* ═══ MODALS ═══ */
function openModal(title, html) {
  document.getElementById('gmTitle').textContent = title;
  document.getElementById('gmBody').innerHTML = html;
  document.getElementById('genericModal').classList.add('show');
}
const closeModal = id => document.getElementById(id).classList.remove('show');

function showSettings() {
  document.getElementById('userMenu')?.classList.remove('show');
  document.getElementById('settingsName').value = currentUser?.display_name || '';
  document.getElementById('settingsInstructions').value = currentUser?.custom_instructions || '';
  document.getElementById('settingsTheme').value = localStorage.getItem('phonix_theme') || 'dark';
  document.getElementById('settingsModel').value = currentModel;
  document.getElementById('settingsModal').classList.add('show');
}
async function saveSettings() {
  currentModel = document.getElementById('settingsModel').value;
  localStorage.setItem('phonix_model', currentModel); updateModelLabel();
  if (!isGuest) {
    const r = await api('/api/v1/users/me', { method: 'PATCH', body: JSON.stringify({
      displayName: document.getElementById('settingsName').value,
      customInstructions: document.getElementById('settingsInstructions').value }) });
    if (r?.success) { currentUser = r.data.user; localStorage.setItem('phonix_user', JSON.stringify(currentUser)); initUser(); }
  }
  closeModal('settingsModal'); toast('Settings saved');
}

async function showMemories() {
  document.getElementById('userMenu')?.classList.remove('show');
  document.getElementById('memoriesModal').classList.add('show');
  loadMemories();
}
async function loadMemories() {
  const list = document.getElementById('memoriesList');
  const r = await api('/api/v1/memories');
  const mem = r?.data?.memories || [];
  list.innerHTML = mem.length ? mem.map(m => `
    <div class="mem">
      <div class="mem-m"><div class="mem-k">${esc(m.key)}<span class="pill ${m.source === 'auto' ? 'auto' : ''}">${m.source === 'auto' ? 'learned' : esc(m.type)}</span></div>
      <div class="mem-v">${esc(m.value)}</div></div>
      <button class="ib" onclick="deleteMemory('${m.id}')" title="Forget">${ico('x')}</button>
    </div>`).join('') : `<div class="empty">${ico('brain')}<p>Nothing remembered yet.<br>Phønix learns as you chat.</p></div>`;
}
async function addMemory() {
  const key = document.getElementById('memoryKey').value.trim(), value = document.getElementById('memoryValue').value.trim();
  if (!key || !value) return;
  await api('/api/v1/memories', { method: 'POST', body: JSON.stringify({ key, value, type: document.getElementById('memoryType').value }) });
  document.getElementById('memoryKey').value = ''; document.getElementById('memoryValue').value = '';
  loadMemories(); toast('Saved to memory');
}
async function deleteMemory(id) { await api(`/api/v1/memories/${id}`, { method: 'DELETE' }); loadMemories(); }

async function showUsage() {
  document.getElementById('userMenu')?.classList.remove('show');
  const [u, s] = await Promise.all([api('/api/v1/users/me/usage'), api('/api/v1/users/me/stats')]);
  const t = u?.data?.today || {}, st = s?.data || {};
  openModal('Usage', `
    <div class="stats">
      <div class="stat"><div class="stat-n">${t.used ?? 0}<em>/${t.limit ?? '—'}</em></div><div class="stat-l">Today</div></div>
      <div class="stat"><div class="stat-n">${st.conversations ?? 0}</div><div class="stat-l">Conversations</div></div>
      <div class="stat"><div class="stat-n">${st.messages ?? 0}</div><div class="stat-l">Total messages</div></div>
      <div class="stat"><div class="stat-n">${st.memories ?? 0}</div><div class="stat-l">Memories</div></div>
      <div class="stat"><div class="stat-n">${st.projects ?? 0}</div><div class="stat-l">Projects</div></div>
      <div class="stat"><div class="stat-n">${st.attachments ?? 0}</div><div class="stat-l">Files</div></div>
    </div>
    ${(u?.data?.byModel || []).map(m => `<div class="kv"><span>${esc(m.model)}</span><b>${m.count} calls · ${m.tokens} tokens</b></div>`).join('')}`);
}

async function showKeys() {
  document.getElementById('userMenu')?.classList.remove('show');
  const r = await api('/api/v1/keys');
  const keys = r?.data?.keys || [];
  openModal('API keys', `
    <p class="lede">Use these to call the Phønix API from your own code. Send them as an <code>x-api-key</code> header.</p>
    ${keys.map(k => `<div class="kv"><div class="kv-m"><div class="kv-t">${esc(k.name)}</div>
      <div class="kv-s">${esc(k.key)} · ${k.request_count} calls</div></div>
      <div class="kv-a">${k.revoked ? '<span class="pill">revoked</span>' : `<button class="btn danger sm" onclick="revokeKey('${k.id}')">Revoke</button>`}</div></div>`).join('')
      || `<div class="empty">${ico('key')}<p>No API keys yet.</p></div>`}
    <div class="fld" style="margin-top:16px"><label>Create a key</label>
      <div class="row"><input class="in" id="keyName" placeholder="e.g. My script"><button class="btn sm" onclick="createKey()">Create</button></div></div>`);
}
async function createKey() {
  const name = document.getElementById('keyName').value.trim() || 'API key';
  const r = await api('/api/v1/keys', { method: 'POST', body: JSON.stringify({ name }) });
  if (!r?.success) return toast(r?.error?.message || 'Could not create key');
  openModal('Key created', `<p class="lede">Copy this now — it won't be shown again.</p>
    <div class="mono">${esc(r.data.secret)}</div>
    <button class="btn primary" onclick="navigator.clipboard.writeText('${esc(r.data.secret)}');toast('Copied')">Copy key</button>`);
}
async function revokeKey(id) { await api(`/api/v1/keys/${id}`, { method: 'DELETE' }); showKeys(); toast('Key revoked'); }

async function showShares() {
  document.getElementById('userMenu')?.classList.remove('show');
  const r = await api('/api/v1/shares');
  const shares = r?.data?.shares || [];
  openModal('Shared links', shares.length ? shares.map(s => `
    <div class="kv"><div class="kv-m"><div class="kv-t">${esc(s.title)}</div><div class="kv-s">${s.views} views</div></div>
    <div class="kv-a"><button class="btn sm" onclick="navigator.clipboard.writeText('${location.origin}${s.url}');toast('Link copied')">Copy</button>
    <button class="btn danger sm" onclick="revokeShare('${s.id}')">Revoke</button></div></div>`).join('')
    : `<div class="empty">${ico('link')}<p>No shared conversations.</p></div>`);
}
async function revokeShare(id) { await api(`/api/v1/shares/${id}`, { method: 'DELETE' }); showShares(); toast('Link revoked'); }

async function showTrash() {
  document.getElementById('userMenu')?.classList.remove('show');
  const r = await api('/api/v1/conversations?trashed=true');
  const items = r?.data?.conversations || [];
  openModal('Trash', items.length ? items.map(c => `
    <div class="kv"><div class="kv-m"><div class="kv-t">${esc(c.title)}</div></div>
    <div class="kv-a"><button class="btn sm" onclick="restoreConv('${c.id}')">Restore</button></div></div>`).join('') +
    `<div class="zone"><button class="btn danger" onclick="emptyTrash()">Empty trash</button></div>`
    : `<div class="empty">${ico('trash')}<p>Trash is empty.</p></div>`);
}
async function restoreConv(id) { await api(`/api/v1/conversations/${id}/restore`, { method: 'POST' }); loadConversations(); showTrash(); toast('Restored'); }
async function emptyTrash() {
  if (!confirm('Permanently delete everything in trash?')) return;
  await api('/api/v1/conversations/trash/empty', { method: 'POST' }); showTrash(); toast('Trash emptied');
}

async function shareConversation() {
  if (!currentConversation || isGuest) return toast('Open a conversation first');
  const r = await api('/api/v1/shares', { method: 'POST', body: JSON.stringify({ conversationId: currentConversation.id }) });
  if (r?.success) {
    const url = location.origin + (r.data.share.url || `/s/${r.data.share.slug}`);
    navigator.clipboard.writeText(url).catch(() => {});
    toast('Share link copied');
  }
}
function exportData() {
  document.getElementById('userMenu')?.classList.remove('show');
  location.href = `${API}/api/v1/users/me/export`;
}
function confirmDeleteAccount() {
  openModal('Delete account', `<p class="lede">This permanently deletes your account and all data. This cannot be undone.</p>
    <div class="fld"><label>Password</label><input type="password" class="in" id="delPw"></div>
    <div class="fld"><label>Type DELETE to confirm</label><input class="in" id="delConfirm"></div>
    <button class="btn danger" onclick="deleteAccount()">Permanently delete</button>`);
}
async function deleteAccount() {
  const r = await api('/api/v1/users/me', { method: 'DELETE', body: JSON.stringify({
    password: document.getElementById('delPw').value, confirm: document.getElementById('delConfirm').value }) });
  if (r?.success) { localStorage.clear(); location.href = '/login'; }
  else toast(r?.error?.message || 'Could not delete account');
}

/* ═══ MISC ═══ */
function copyMessage(btn) {
  navigator.clipboard.writeText(btn.closest('.turn').querySelector('.prose').innerText);
  toast('Copied');
}
function copyCode(btn) {
  navigator.clipboard.writeText(btn.closest('pre').querySelector('code').innerText);
  btn.textContent = 'Copied'; setTimeout(() => btn.textContent = 'Copy', 1800);
}
function speakMsg(btn) {
  const text = btn.closest('.turn').querySelector('.prose').innerText;
  if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}
let recognition = null;
function toggleVoice() {
  const btn = document.getElementById('voiceBtn');
  if (recognition) { recognition.stop(); recognition = null; btn.classList.remove('on'); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return toast('Voice input not supported here');
  recognition = new SR(); recognition.interimResults = true; recognition.continuous = true;
  btn.classList.add('on');
  recognition.onresult = e => {
    let t = ''; for (let i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript;
    const input = document.getElementById('messageInput');
    input.value = t; autoResize(input);
    document.getElementById('sendBtn').disabled = !t.trim();
  };
  recognition.onend = () => { recognition = null; btn.classList.remove('on'); };
  recognition.start();
}
function handleKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px'; }
const isMobile = () => window.matchMedia('(max-width:900px)').matches;
function toggleSidebar() {
  const open = document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('scrim')?.classList.toggle('show', open);
  document.body.style.overflow = open && isMobile() ? 'hidden' : '';
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('scrim')?.classList.remove('show');
  document.body.style.overflow = '';
}
// On phones the drawer should get out of the way once you've chosen something.
const autoCloseDrawer = () => { if (isMobile()) closeSidebar(); };
const toggleUserMenu = () => document.getElementById('userMenu').classList.toggle('show');
/* Theme is owned by assets/theme.js (loaded in <head> to avoid a flash).
   These wrappers keep the existing markup + settings dropdown working. */
function toggleTheme() { window.PhonixTheme?.toggle(); }
function setTheme(t)   { window.PhonixTheme?.set(t); }
function loadTheme()   { /* applied pre-paint by theme.js */ }
function applyTheme(t, persist = true) {
  persist ? window.PhonixTheme?.set(t) : null;
}

function logout() {
  if (!isGuest) api('/api/v1/auth/logout', { method: 'POST' });
  localStorage.removeItem('phonix_token'); localStorage.removeItem('phonix_user'); localStorage.removeItem('phonix_guest');
  location.href = '/login';
}

/* shortcuts + outside clicks */
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (e.key === 'Escape') { closePalette(); closeArtifact(); closeSidebar(); document.querySelectorAll('.modal-overlay.show').forEach(m => m.classList.remove('show')); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.model-selector, .model-menu')) document.getElementById('modelMenu')?.classList.remove('show');
  if (!e.target.closest('.user-card, .user-menu')) document.getElementById('userMenu')?.classList.remove('show');
});
document.querySelectorAll('.modal-overlay').forEach(m =>
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); }));
