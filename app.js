// DS File — SPA that mirrors the Android DS File app on top of
// Synology's File Station API. Runs as an MV3 extension page so it
// can reach the NAS over HTTP/HTTPS without hitting CORS or
// mixed-content restrictions.

'use strict';

/* =============================================================== *
 *  1.  Synology File Station API wrapper                           *
 * =============================================================== */

const WEBAPI = { AUTH: 'auth.cgi', ENTRY: 'entry.cgi' };

const AUTH_ERRORS = {
  400: 'Incorrect account or password',
  401: 'Account disabled',
  402: 'Permission denied',
  403: 'Two-factor code required',
  404: 'Invalid two-factor code',
  406: 'Two-factor authentication is required',
  407: 'This IP is blocked by auto-block',
  408: 'The password has expired',
  409: 'The password has expired',
  410: 'The password must be changed',
  411: 'Account temporarily disabled',
};

const FS_ERRORS = {
  100: 'Unknown error',
  101: 'Invalid parameter',
  102: 'The requested API does not exist',
  103: 'The requested method does not exist',
  104: 'The requested API version is not supported',
  105: 'The logged-in session does not have permission',
  106: 'Session timeout',
  107: 'Session interrupted by duplicated login',
  119: 'SID not found',
  400: 'Invalid parameter of file operation',
  401: 'Unknown error of file operation',
  402: 'System is too busy',
  403: 'Invalid user does this file operation',
  404: 'Invalid group does this file operation',
  405: 'Invalid user and group does this file operation',
  406: 'Can’t get user/group information',
  407: 'Operation not permitted',
  408: 'No such file or directory',
  409: 'Non-supported file system',
  410: 'Failed to connect internet-based file system',
  411: 'Read-only file system',
  412: 'Filename is too long for the non-encrypted file system',
  413: 'Filename is too long for the encrypted file system',
  414: 'File already exists',
  415: 'Disk quota exceeded',
  416: 'No space left on device',
  417: 'Input/output error',
  418: 'Illegal name or path',
  419: 'Illegal file name',
  420: 'Illegal file name on FAT',
  421: 'Device or resource busy',
  599: 'No such task of the file operation',
  900: 'Failed to delete the file(s) or folder(s)',
  1000: 'Failed to copy or move the file(s)',
  1001: 'Failed to copy or move the file(s), destination doesn’t exist',
  1002: 'Failed to copy or move the file(s), destination is read-only',
  1003: 'Cannot overwrite or skip the existing file',
  1100: 'Failed to create a folder — the name already exists',
  1101: 'The name is reserved or invalid',
  1200: 'Failed to copy or move the file(s)',
  1300: 'Failed to delete the file(s)',
  1400: 'Failed to rename it — name invalid or already exists',
  1800: 'There is no Content-Length header',
  1801: 'Upload timed out',
  1802: 'Not enough disk space on the destination',
  1803: 'Destination folder does not exist',
  1804: 'Not enough permission to upload',
  1805: 'The file already exists in the destination',
  1806: 'Transfer quota exceeded',
};

class ApiError extends Error {
  constructor(code, section) {
    const map = section === 'auth' ? AUTH_ERRORS : FS_ERRORS;
    super(map[code] || `API error ${code}`);
    this.code = code;
    this.section = section;
  }
}

class SynoAPI {
  constructor() { this.base = null; this.sid = null; this.account = null; }

  configure({ host, port, https }) {
    const proto = https ? 'https' : 'http';
    const defPort = https ? 5001 : 5000;
    const p = port ? `:${port}` : (host.includes(':') ? '' : `:${defPort}`);
    const bareHost = host.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.base = `${proto}://${bareHost}${bareHost.includes(':') ? '' : p}`;
  }

  url(cgi, params) {
    const u = new URL(`${this.base}/webapi/${cgi}`);
    if (params) for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, v);
    }
    if (this.sid && !u.searchParams.has('_sid')) u.searchParams.set('_sid', this.sid);
    return u.toString();
  }

  async request(cgi, params, { method = 'GET', body = null, signal = null } = {}) {
    const url = this.url(cgi, params);
    const res = await fetch(url, { method, body, signal, credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.success) {
      const code = json.error?.code ?? 0;
      throw new ApiError(code, cgi === WEBAPI.AUTH ? 'auth' : 'fs');
    }
    return json.data;
  }

  entry(api, method, version, extra = {}, opts) {
    return this.request(WEBAPI.ENTRY, { api, method, version, ...extra }, opts);
  }

  // ---------- Auth ----------
  async login({ host, port, https, account, passwd, otp }) {
    this.configure({ host, port, https });
    const data = await this.request(WEBAPI.AUTH, {
      api: 'SYNO.API.Auth', version: 6, method: 'login',
      account, passwd,
      session: 'FileStation', format: 'sid',
      otp_code: otp || undefined,
      enable_syno_token: 'no',
    });
    this.sid = data.sid;
    this.account = account;
    return data;
  }

  async logout() {
    if (!this.sid) return;
    try {
      await this.request(WEBAPI.AUTH, {
        api: 'SYNO.API.Auth', version: 6, method: 'logout', session: 'FileStation',
      });
    } catch (_) { /* ignore */ }
    this.sid = null;
  }

  // ---------- Listing ----------
  listShares() {
    return this.entry('SYNO.FileStation.List', 'list_share', 2, {
      offset: 0, limit: 1000, sort_by: 'name', sort_direction: 'asc',
      additional: '["real_path","owner","time","perm","mount_point_type","volume_status"]',
    });
  }

  list(folder_path, { sortBy = 'name', dir = 'asc', filetype = 'all' } = {}) {
    return this.entry('SYNO.FileStation.List', 'list', 2, {
      folder_path, sort_by: sortBy, sort_direction: dir, filetype,
      offset: 0, limit: 10000,
      additional: '["real_path","size","owner","time","perm","type","mount_point_type"]',
    });
  }

  getInfo(paths) {
    return this.entry('SYNO.FileStation.List', 'getinfo', 2, {
      path: JSON.stringify(paths),
      additional: '["real_path","size","owner","time","perm","type"]',
    });
  }

  createFolder(folder_path, name) {
    return this.entry('SYNO.FileStation.CreateFolder', 'create', 2, {
      folder_path: JSON.stringify([folder_path]),
      name: JSON.stringify([name]),
      force_parent: 'false',
    });
  }

  rename(path, name) {
    return this.entry('SYNO.FileStation.Rename', 'rename', 2, {
      path: JSON.stringify([path]),
      name: JSON.stringify([name]),
    });
  }

  async deleteStart(paths, recursive = true) {
    const data = await this.entry('SYNO.FileStation.Delete', 'start', 2, {
      path: JSON.stringify(paths),
      recursive: recursive ? 'true' : 'false',
    });
    return data.taskid;
  }
  deleteStatus(taskid)  { return this.entry('SYNO.FileStation.Delete', 'status', 2, { taskid }); }
  deleteStop(taskid)    { return this.entry('SYNO.FileStation.Delete', 'stop',   2, { taskid }); }

  async copyMoveStart(paths, destFolder, { overwrite = 'false', removeSrc = false } = {}) {
    const data = await this.entry('SYNO.FileStation.CopyMove', 'start', 3, {
      path: JSON.stringify(paths),
      dest_folder_path: destFolder,
      overwrite, remove_src: removeSrc ? 'true' : 'false',
    });
    return data.taskid;
  }
  copyMoveStatus(taskid) { return this.entry('SYNO.FileStation.CopyMove', 'status', 3, { taskid }); }
  copyMoveStop(taskid)   { return this.entry('SYNO.FileStation.CopyMove', 'stop',   3, { taskid }); }

  async searchStart(folder_path, pattern) {
    const data = await this.entry('SYNO.FileStation.Search', 'start', 2, {
      folder_path, pattern: JSON.stringify([pattern]), recursive: 'true',
    });
    return data.taskid;
  }
  searchList(taskid) {
    return this.entry('SYNO.FileStation.Search', 'list', 2, {
      taskid, offset: 0, limit: 1000,
      additional: '["size","owner","time","type","perm"]',
    });
  }
  searchStop(taskid) { return this.entry('SYNO.FileStation.Search', 'stop', 2, { taskid }); }

  listFavorites() {
    return this.entry('SYNO.FileStation.Favorite', 'list', 2, {
      offset: 0, limit: 1000, status_filter: 'all',
      additional: '["real_path","owner","time","perm","type"]',
    });
  }
  addFavorite(path, name) {
    return this.entry('SYNO.FileStation.Favorite', 'add', 2, {
      path, name: name || path.split('/').pop(),
    });
  }
  removeFavorite(path) {
    return this.entry('SYNO.FileStation.Favorite', 'delete', 2, { path });
  }

  createShareLink(paths) {
    return this.entry('SYNO.FileStation.Sharing', 'create', 3, {
      path: JSON.stringify(paths),
    });
  }

  thumbUrl(path, size = 'small') {
    return this.url(WEBAPI.ENTRY, {
      api: 'SYNO.FileStation.Thumb', version: 2, method: 'get',
      path, size, rotate: 0,
    });
  }

  downloadUrl(paths, mode = 'download') {
    return this.url(WEBAPI.ENTRY, {
      api: 'SYNO.FileStation.Download', version: 2, method: 'download',
      path: JSON.stringify(paths), mode,
    });
  }

  uploadFile({ dest, file, overwrite = 'skip', onProgress, signal }) {
    const form = new FormData();
    form.append('api', 'SYNO.FileStation.Upload');
    form.append('version', '2');
    form.append('method', 'upload');
    form.append('path', dest);
    form.append('create_parents', 'true');
    form.append('overwrite', overwrite);
    form.append('file', file, file.name);          // must be last field
    const url = this.url(WEBAPI.ENTRY, {});
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.responseType = 'json';
      xhr.upload.onprogress = e => { if (onProgress && e.lengthComputable) onProgress(e.loaded, e.total); };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.onload = () => {
        const r = xhr.response;
        if (xhr.status >= 200 && xhr.status < 300 && r?.success) resolve(r.data);
        else reject(new ApiError(r?.error?.code ?? 0, 'fs'));
      };
      if (signal) signal.addEventListener('abort', () => xhr.abort());
      xhr.send(form);
    });
  }
}

/* =============================================================== *
 *  2.  App state                                                   *
 * =============================================================== */

const S = {
  api: new SynoAPI(),
  conn: null,            // { host, port, https, user }
  view: 'files',         // files | favorites | recent | shared | search
  cwd: '',               // current folder (empty = shares root)
  entries: [],           // current list
  sortBy: 'name',
  sortDir: 'asc',
  layout: 'list',        // list | grid
  selection: new Set(),  // paths
  selectMode: false,
  search: null,          // { pattern, folder, taskid, result }
  recent: [],
  favoritesCache: null,
  uploads: new Map(),    // id -> { file, loaded, total, status }
  uploadSeq: 0,
};

const $  = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

/* =============================================================== *
 *  3.  Small UI helpers                                            *
 * =============================================================== */

function toast(msg, ms = 2800) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

function fmtSize(n) {
  if (n == null) return '';
  const u = ['B','KB','MB','GB','TB','PB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function fmtTime(epoch) {
  if (!epoch) return '';
  const d = new Date(epoch * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const opts = sameYear
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

function errorToast(e) {
  console.error(e);
  if (e instanceof ApiError && (e.code === 106 || e.code === 119 || e.code === 403 || e.code === 407)) {
    toast('Session expired — signing in again');
    setTimeout(signOut, 800);
    return;
  }
  toast(e.message || String(e));
}

function iconSvg(type, name) {
  // Returns inline <svg> markup picked by file "type" and extension.
  if (type === 'dir') return `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor"/></svg>`;
  const ext = (name.split('.').pop() || '').toLowerCase();
  const img = new Set(['png','jpg','jpeg','gif','webp','bmp','heic','heif','tif','tiff','svg']);
  const vid = new Set(['mp4','mkv','mov','avi','webm','wmv','flv','m4v','3gp']);
  const aud = new Set(['mp3','wav','flac','ogg','m4a','aac','wma','opus']);
  const doc = new Set(['pdf','doc','docx','odt','rtf','txt','md']);
  const sht = new Set(['xls','xlsx','csv','ods','numbers']);
  const slide = new Set(['ppt','pptx','odp','key']);
  const arc = new Set(['zip','rar','7z','tar','gz','bz2','xz']);
  const code = new Set(['js','ts','py','java','c','cc','cpp','h','hpp','rs','go','rb','php','css','html','xml','yml','yaml','json','sh','ini','conf','sql']);
  if (img.has(ext)) return `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="#6366f1"/><circle cx="9" cy="11" r="2" fill="#fff"/><path d="M3 17l5-5 4 4 3-3 6 6H3z" fill="#fff" opacity=".9"/></svg>`;
  if (vid.has(ext)) return `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="#ef4444"/><path d="M10 9l5 3-5 3z" fill="#fff"/></svg>`;
  if (aud.has(ext)) return `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" fill="#10b981"/><path d="M10 9v6a2 2 0 1 1-2-2V9zm0 0h5" stroke="#fff" stroke-width="1.6" fill="none"/></svg>`;
  if (doc.has(ext)) return `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="#3b82f6"/><path d="M14 3v4h4" fill="#1d4ed8"/></svg>`;
  if (sht.has(ext)) return `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="#059669"/><path d="M14 3v4h4" fill="#065f46"/></svg>`;
  if (slide.has(ext)) return `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="#ea580c"/><path d="M14 3v4h4" fill="#9a3412"/></svg>`;
  if (arc.has(ext)) return `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="#a855f7"/><path d="M14 3v4h4" fill="#7e22ce"/><path d="M10 7v2m0 2v2m0 2v2" stroke="#fff" stroke-width="1.4"/></svg>`;
  if (code.has(ext)) return `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="#0ea5e9"/><path d="M14 3v4h4" fill="#0369a1"/><path d="M9 13l-2 2 2 2m6-4l2 2-2 2" stroke="#fff" stroke-width="1.5" fill="none"/></svg>`;
  return `<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" fill="#9ca3af"/><path d="M14 3v4h4" fill="#6b7280"/></svg>`;
}

function isImage(name) {
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif|tif|tiff|svg)$/i.test(name);
}

/* ---- Menu / dialog primitives ---- */

function openMenu(menuId, anchor, items) {
  const m = $('#' + menuId);
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const btn = document.createElement('button');
    if (it.danger) btn.className = 'danger';
    btn.innerHTML = `${it.icon || ''}<span>${it.label}</span>`;
    btn.onclick = () => { closeAllMenus(); it.onClick?.(); };
    m.appendChild(btn);
  }
  m.hidden = false;
  const r = anchor.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight;
  // position below+left-aligned to anchor's right edge
  const rect = m.getBoundingClientRect();
  let left = r.right - rect.width;
  let top  = r.bottom + 4;
  if (left < 8) left = 8;
  if (left + rect.width > vw - 8) left = vw - rect.width - 8;
  if (top + rect.height > vh - 8) top = r.top - rect.height - 4;
  if (top < 8) top = 8;
  m.style.left = left + 'px';
  m.style.top  = top + 'px';
}

function closeAllMenus() {
  for (const id of ['menu-more','menu-fab','menu-item','menu-sel-more']) {
    const m = document.getElementById(id); if (m) m.hidden = true;
  }
}

document.addEventListener('click', e => {
  if (!e.target.closest('.menu') && !e.target.closest('[data-menu-anchor]')) closeAllMenus();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeAllMenus(); closeDialog(); if ($('#preview')?.hidden === false) closePreview(); }
});

/* Dialogs */

function openDialog({ title, body, actions }) {
  $('#dialog-title').textContent = title || '';
  const b = $('#dialog-body'); b.innerHTML = '';
  if (typeof body === 'string') b.innerHTML = body; else if (body) b.appendChild(body);
  const a = $('#dialog-actions'); a.innerHTML = '';
  for (const act of actions || []) {
    const btn = document.createElement('button');
    btn.className = 'btn ' + (act.className || 'btn-ghost');
    btn.textContent = act.label;
    btn.onclick = () => act.onClick?.();
    a.appendChild(btn);
  }
  $('#dialog').hidden = false;
}

function closeDialog() { $('#dialog').hidden = true; }

function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK' }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="dialog-body-row">${label || ''}</div>`;
    const input = document.createElement('input');
    input.value = value; input.placeholder = placeholder;
    wrap.appendChild(input);
    openDialog({
      title,
      body: wrap,
      actions: [
        { label: 'Cancel', onClick: () => { closeDialog(); resolve(null); } },
        { label: okLabel, className: 'btn-primary', onClick: () => { closeDialog(); resolve(input.value); } },
      ],
    });
    setTimeout(() => { input.focus(); input.select(); }, 20);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { closeDialog(); resolve(input.value); }
    });
  });
}

function confirmDialog({ title, body, okLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    openDialog({
      title, body,
      actions: [
        { label: 'Cancel', onClick: () => { closeDialog(); resolve(false); } },
        { label: okLabel, className: danger ? 'btn-danger' : 'btn-primary', onClick: () => { closeDialog(); resolve(true); } },
      ],
    });
  });
}

/* =============================================================== *
 *  4.  Storage                                                     *
 * =============================================================== */

const Store = {
  async get(keys) { return (await chrome.storage.local.get(keys)) || {}; },
  async set(obj)  { await chrome.storage.local.set(obj); },
  async remove(k) { await chrome.storage.local.remove(k); },
};

async function saveSession() {
  if (!S.conn) return;
  await Store.set({ last_conn: S.conn });
  sessionStorage.setItem('ds_sid',   S.api.sid || '');
  sessionStorage.setItem('ds_base',  S.api.base || '');
  sessionStorage.setItem('ds_user',  S.api.account || '');
}

async function restoreSession() {
  const sid  = sessionStorage.getItem('ds_sid');
  const base = sessionStorage.getItem('ds_base');
  const user = sessionStorage.getItem('ds_user');
  if (!sid || !base) return false;
  S.api.base = base; S.api.sid = sid; S.api.account = user;
  // probe
  try { await S.api.entry('SYNO.FileStation.Info', 'get', 2, {}); }
  catch { sessionStorage.clear(); return false; }
  const { last_conn } = await Store.get('last_conn');
  S.conn = last_conn || { host: new URL(base).hostname, user };
  return true;
}

/* =============================================================== *
 *  5.  Login flow                                                  *
 * =============================================================== */

async function initLoginForm() {
  const { last_conn } = await Store.get('last_conn');
  if (last_conn) {
    $('#host').value  = last_conn.host  || '';
    $('#port').value  = last_conn.port  || '';
    $('#https').checked = last_conn.https !== false;
    $('#user').value  = last_conn.user  || '';
  }
  $('#login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const host = $('#host').value.trim();
    const port = $('#port').value.trim();
    const https = $('#https').checked;
    const user = $('#user').value.trim();
    const pass = $('#pass').value;
    const otp  = $('#otp').value.trim();
    const remember = $('#remember').checked;
    const btn = $('#login-btn');
    btn.disabled = true; btn.textContent = 'Signing in…';
    $('#login-error').textContent = '';
    try {
      await S.api.login({ host, port, https, account: user, passwd: pass, otp });
      S.conn = { host, port, https, user };
      if (remember) await Store.set({ last_conn: S.conn });
      else await Store.remove('last_conn');
      await saveSession();
      showApp();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 403 || e.code === 406)) {
        $('#otp-row').hidden = false;
        $('#otp').focus();
        $('#login-error').textContent = 'Enter the verification code from your authenticator app.';
      } else {
        $('#login-error').textContent = e.message || 'Sign-in failed';
        if ((e.message || '').includes('Failed to fetch')) {
          $('#login-error').textContent += ' — if your NAS uses a self-signed HTTPS cert, open it once in Chrome and accept the warning first.';
        }
      }
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
}

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
}

function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  renderDrawerHeader();
  navigate('files');
}

async function signOut() {
  try { await S.api.logout(); } catch {}
  sessionStorage.clear();
  S.conn = null; S.cwd = ''; S.entries = []; S.selection.clear(); S.selectMode = false;
  showLogin();
}

/* =============================================================== *
 *  6.  Navigation / rendering                                      *
 * =============================================================== */

function setBusy(on) { $('#busy').hidden = !on; }

async function navigate(view, arg) {
  S.view = view;
  S.selectMode = false; S.selection.clear(); document.body.classList.remove('select-mode');
  $('#appbar-select').hidden = true;
  $('#searchbar').hidden = true;
  $('#appbar-main').hidden = false;
  $$('#drawer .drawer-nav button').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  closeDrawer();

  if (view === 'files') {
    const path = typeof arg === 'string' ? arg : '';
    await openFolder(path);
  } else if (view === 'favorites') {
    await openFavorites();
  } else if (view === 'recent') {
    openRecent();
  } else if (view === 'shared') {
    await openFolder('');       // same as top-level shares
    $('#appbar-title').textContent = 'Shared folders';
  } else if (view === 'settings') {
    openSettings();
  } else if (view === 'logout') {
    signOut();
  }
}

async function openFolder(path) {
  S.view = 'files';
  S.cwd = path;
  $('#appbar-title').textContent = path ? path.split('/').pop() : 'My files';
  $('#btn-up').hidden = !path;
  setBusy(true); renderBreadcrumb();
  try {
    const data = path
      ? await S.api.list(path, { sortBy: S.sortBy, dir: S.sortDir })
      : await S.api.listShares();
    S.entries = data.files || data.shares || [];
    sortEntries();
    renderFiles();
  } catch (e) { errorToast(e); S.entries = []; renderFiles(); }
  finally { setBusy(false); }
}

async function refresh() {
  if (S.view === 'files')     return openFolder(S.cwd);
  if (S.view === 'favorites') return openFavorites();
  if (S.view === 'recent')    return openRecent();
  if (S.view === 'search')    return runSearch(S.search?.pattern || '');
}

function sortEntries() {
  const dir = S.sortDir === 'asc' ? 1 : -1;
  const key = S.sortBy;
  S.entries.sort((a, b) => {
    if (a.isdir !== b.isdir) return a.isdir ? -1 : 1;
    let va, vb;
    if (key === 'size') { va = a.additional?.size || 0; vb = b.additional?.size || 0; }
    else if (key === 'time') { va = a.additional?.time?.mtime || 0; vb = b.additional?.time?.mtime || 0; }
    else if (key === 'user') { va = a.additional?.owner?.user || ''; vb = b.additional?.owner?.user || ''; }
    else { va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); }
    return va < vb ? -dir : va > vb ? dir : 0;
  });
}

function renderBreadcrumb() {
  const bc = $('#breadcrumb'); bc.innerHTML = '';
  if (S.view !== 'files') { bc.hidden = true; return; }
  bc.hidden = false;
  const root = document.createElement('button');
  root.textContent = 'My files';
  root.onclick = () => openFolder('');
  bc.appendChild(root);
  if (!S.cwd) { root.classList.add('current'); return; }
  const parts = S.cwd.split('/').filter(Boolean);
  let acc = '';
  parts.forEach((p, i) => {
    acc += '/' + p;
    const sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '/';
    bc.appendChild(sep);
    const b = document.createElement('button');
    b.textContent = p;
    const target = acc;
    b.onclick = () => openFolder(target);
    if (i === parts.length - 1) b.classList.add('current');
    bc.appendChild(b);
  });
}

function renderFiles() {
  const list = $('#file-list');
  list.className = 'file-list' + (S.layout === 'grid' ? ' grid' : '');
  list.innerHTML = '';
  if (!S.entries.length) { $('#empty-state').hidden = false; return; }
  $('#empty-state').hidden = true;

  for (const ent of S.entries) {
    const li = document.createElement('li');
    li.dataset.path = ent.path;
    li.setAttribute('role', 'option');
    const selected = S.selection.has(ent.path);
    if (selected) li.classList.add('selected');

    const icon = document.createElement('div');
    icon.className = 'file-icon' + (ent.isdir ? ' folder' : '');
    if (!ent.isdir && isImage(ent.name)) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = S.api.thumbUrl(ent.path, 'small');
      img.alt = '';
      img.onerror = () => { icon.innerHTML = iconSvg('reg', ent.name); };
      icon.appendChild(img);
    } else {
      icon.innerHTML = iconSvg(ent.isdir ? 'dir' : 'reg', ent.name);
    }

    const meta = document.createElement('div');
    meta.className = 'file-meta';
    const name = document.createElement('div');
    name.className = 'file-name';
    name.textContent = ent.name;
    const sub = document.createElement('div');
    sub.className = 'file-sub';
    const size = ent.isdir ? '' : fmtSize(ent.additional?.size);
    const time = fmtTime(ent.additional?.time?.mtime);
    sub.textContent = [size, time].filter(Boolean).join(' · ');
    meta.appendChild(name); meta.appendChild(sub);

    const check = document.createElement('div'); check.className = 'file-check';

    const over = document.createElement('button');
    over.className = 'file-overflow'; over.setAttribute('aria-label', 'More');
    over.dataset.menuAnchor = '1';
    over.innerHTML = `<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>`;
    over.onclick = e => { e.stopPropagation(); itemMenu(ent, over); };

    li.appendChild(check);
    li.appendChild(icon);
    li.appendChild(meta);
    li.appendChild(over);

    let holdTimer = null;
    li.addEventListener('pointerdown', () => {
      holdTimer = setTimeout(() => {
        enterSelectMode();
        toggleSelect(ent.path);
      }, 480);
    });
    const cancelHold = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
    li.addEventListener('pointerup', cancelHold);
    li.addEventListener('pointerleave', cancelHold);
    li.addEventListener('pointermove', cancelHold);

    li.addEventListener('click', e => {
      if (S.selectMode) { toggleSelect(ent.path); return; }
      if (ent.isdir) openFolder(ent.path);
      else openPreview(ent);
    });

    list.appendChild(li);
  }
}

/* ---- Selection ---- */

function enterSelectMode() {
  if (S.selectMode) return;
  S.selectMode = true;
  document.body.classList.add('select-mode');
  $('#appbar-main').hidden = true;
  $('#appbar-select').hidden = false;
  updateSelCount();
}

function exitSelectMode() {
  S.selectMode = false;
  S.selection.clear();
  document.body.classList.remove('select-mode');
  $('#appbar-select').hidden = true;
  $('#appbar-main').hidden = false;
  renderFiles();
}

function toggleSelect(path) {
  if (S.selection.has(path)) S.selection.delete(path);
  else S.selection.add(path);
  if (!S.selection.size) exitSelectMode();
  else {
    updateSelCount();
    const li = document.querySelector(`li[data-path="${CSS.escape(path)}"]`);
    if (li) li.classList.toggle('selected', S.selection.has(path));
  }
}

function updateSelCount() {
  $('#sel-count').textContent = `${S.selection.size} selected`;
}

function selectedEntries() {
  return S.entries.filter(e => S.selection.has(e.path));
}

/* =============================================================== *
 *  7.  File operations                                             *
 * =============================================================== */

async function doCreateFolder() {
  if (!S.cwd) { toast('Pick a shared folder first'); return; }
  const name = await promptDialog({ title: 'New folder', label: 'Folder name', placeholder: 'Untitled' });
  if (name == null) return;
  if (!name.trim()) return;
  try { await S.api.createFolder(S.cwd, name.trim()); toast('Folder created'); refresh(); }
  catch (e) { errorToast(e); }
}

async function doRename(ent) {
  const name = await promptDialog({ title: 'Rename', label: 'New name', value: ent.name });
  if (name == null || !name.trim() || name === ent.name) return;
  try { await S.api.rename(ent.path, name.trim()); toast('Renamed'); refresh(); }
  catch (e) { errorToast(e); }
}

async function doDelete(entries) {
  const paths = entries.map(e => e.path);
  const ok = await confirmDialog({
    title: paths.length > 1 ? `Delete ${paths.length} items?` : 'Delete item?',
    body: paths.length === 1
      ? `“${entries[0].name}” will be moved to the Recycle Bin (if enabled on this share) or deleted permanently.`
      : `These items will be moved to the Recycle Bin (if enabled on this share) or deleted permanently.`,
    okLabel: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    const tid = await S.api.deleteStart(paths, true);
    await pollTask(tid, () => S.api.deleteStatus(tid));
    toast(paths.length > 1 ? `${paths.length} items deleted` : 'Deleted');
    exitSelectMode(); refresh();
  } catch (e) { errorToast(e); }
}

async function pollTask(tid, statusFn, { every = 500, max = 300 } = {}) {
  for (let i = 0; i < max; i++) {
    const st = await statusFn();
    if (st.finished) {
      if (st.processing_path && st.processed_num === 0) return st;
      return st;
    }
    await new Promise(r => setTimeout(r, every));
  }
  return null;
}

async function doDownload(entries) {
  if (!entries.length) return;
  const paths = entries.map(e => e.path);
  const url = S.api.downloadUrl(paths, paths.length > 1 ? 'open' : 'download');
  if (paths.length === 1) {
    try {
      await chrome.downloads.download({ url, filename: entries[0].name, saveAs: false });
    } catch (_) { window.open(url, '_blank'); }
  } else {
    // Multiple: Synology bundles into a zip when mode=open and >1 path
    const zipName = (S.cwd ? S.cwd.split('/').pop() : 'DSFile') + '.zip';
    try { await chrome.downloads.download({ url, filename: zipName, saveAs: true }); }
    catch (_) { window.open(url, '_blank'); }
  }
}

async function doShare(entries) {
  try {
    const data = await S.api.createShareLink(entries.map(e => e.path));
    const link = data.links?.[0]?.url;
    if (!link) throw new Error('No link returned');
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="dialog-body-row">Anyone with this link can access the file:</div>`;
    const inp = document.createElement('input'); inp.readOnly = true; inp.value = link;
    wrap.appendChild(inp);
    openDialog({
      title: 'Share link',
      body: wrap,
      actions: [
        { label: 'Copy', className: 'btn-primary', onClick: () => {
            navigator.clipboard.writeText(link).then(() => toast('Link copied')).catch(() => {});
            closeDialog();
        } },
        { label: 'Close', onClick: () => closeDialog() },
      ],
    });
    setTimeout(() => { inp.focus(); inp.select(); }, 20);
  } catch (e) { errorToast(e); }
}

async function doFavorite(ent) {
  try {
    await S.api.addFavorite(ent.path, ent.name);
    toast('Added to Favorites');
    S.favoritesCache = null;
  } catch (e) { errorToast(e); }
}

async function doUnfavorite(ent) {
  try {
    await S.api.removeFavorite(ent.path);
    toast('Removed from Favorites');
    S.favoritesCache = null;
    if (S.view === 'favorites') refresh();
  } catch (e) { errorToast(e); }
}

async function doCopyMove(entries, mode) {
  const dest = await destinationPicker({
    title: mode === 'move' ? 'Move to…' : 'Copy to…',
    excludePaths: entries.map(e => e.path),
  });
  if (!dest) return;
  try {
    const tid = await S.api.copyMoveStart(
      entries.map(e => e.path),
      dest,
      { overwrite: 'false', removeSrc: mode === 'move' },
    );
    toast(mode === 'move' ? 'Moving…' : 'Copying…');
    await pollTask(tid, () => S.api.copyMoveStatus(tid), { every: 600 });
    toast(mode === 'move' ? 'Moved' : 'Copied');
    exitSelectMode(); refresh();
  } catch (e) { errorToast(e); }
}

/* Destination picker: a cascading tree starting from shares. */
async function destinationPicker({ title, excludePaths = [] }) {
  return new Promise(async resolve => {
    let selected = null;
    const wrap = document.createElement('div');
    const hint = document.createElement('div');
    hint.className = 'dialog-body-row';
    hint.textContent = 'Pick a destination folder.';
    const tree = document.createElement('div'); tree.className = 'tree';
    wrap.appendChild(hint); wrap.appendChild(tree);

    const chosenLabel = document.createElement('div');
    chosenLabel.className = 'dialog-body-row'; chosenLabel.style.marginTop = '8px';
    chosenLabel.textContent = 'Selected: (none)';
    wrap.appendChild(chosenLabel);

    async function makeNode(path, label, container) {
      const row = document.createElement('div');
      row.className = 'tree-item';
      row.dataset.path = path;
      const caret = document.createElement('span'); caret.className = 'caret';
      caret.innerHTML = `<svg viewBox="0 0 10 10"><path d="M3 2l4 3-4 3z" fill="currentColor"/></svg>`;
      const iconSpan = document.createElement('span');
      iconSpan.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#f1b84a"/></svg>`;
      const text = document.createElement('span'); text.textContent = label;
      row.appendChild(caret); row.appendChild(iconSpan); row.appendChild(text);
      const kids = document.createElement('div'); kids.className = 'tree-children'; kids.hidden = true;
      container.appendChild(row); container.appendChild(kids);

      let loaded = false;
      row.addEventListener('click', async () => {
        tree.querySelectorAll('.tree-item.active').forEach(n => n.classList.remove('active'));
        row.classList.add('active');
        selected = path;
        chosenLabel.textContent = 'Selected: ' + path;
        if (!loaded) {
          loaded = true;
          try {
            const data = await S.api.list(path);
            const kidsFiles = (data.files || []).filter(f => f.isdir && !excludePaths.includes(f.path));
            for (const k of kidsFiles) await makeNode(k.path, k.name, kids);
            if (!kidsFiles.length) { kids.innerHTML = `<div class="tree-item" style="color:var(--text-muted);cursor:default">(empty)</div>`; }
            kids.hidden = false;
          } catch (e) { kids.innerHTML = `<div class="tree-item" style="color:var(--danger);cursor:default">${e.message}</div>`; kids.hidden = false; }
        } else {
          kids.hidden = !kids.hidden;
        }
      });
    }

    try {
      const sh = await S.api.listShares();
      for (const share of (sh.shares || [])) {
        if (excludePaths.includes(share.path)) continue;
        await makeNode(share.path, share.name, tree);
      }
    } catch (e) { tree.textContent = e.message; }

    openDialog({
      title,
      body: wrap,
      actions: [
        { label: 'Cancel', onClick: () => { closeDialog(); resolve(null); } },
        { label: 'OK', className: 'btn-primary', onClick: () => {
          if (!selected) { toast('Pick a folder first'); return; }
          closeDialog(); resolve(selected);
        } },
      ],
    });
  });
}

/* =============================================================== *
 *  8.  Uploads                                                     *
 * =============================================================== */

function pickFiles() {
  if (!S.cwd) { toast('Open a shared folder first'); return; }
  const inp = document.createElement('input');
  inp.type = 'file'; inp.multiple = true;
  inp.onchange = () => { for (const f of inp.files) startUpload(f); };
  inp.click();
}

function startUpload(file) {
  const id = ++S.uploadSeq;
  const item = { id, file, loaded: 0, total: file.size, status: 'uploading', dest: S.cwd };
  S.uploads.set(id, item);
  renderUploads();
  const li = $(`#upload-list li[data-id="${id}"]`);
  S.api.uploadFile({
    dest: S.cwd, file, overwrite: 'skip',
    onProgress: (loaded, total) => {
      item.loaded = loaded; item.total = total;
      if (li) {
        const pct = Math.round(100 * loaded / total);
        li.querySelector('.uprog > span').style.width = pct + '%';
        li.querySelector('.ustatus').textContent = pct + '%';
      }
    },
  }).then(() => {
    item.status = 'done';
    if (li) { li.classList.add('done'); li.querySelector('.ustatus').textContent = 'Done'; }
    if (S.cwd === item.dest) refresh();
  }).catch(e => {
    item.status = 'err'; item.err = e.message;
    if (li) { li.classList.add('err'); li.querySelector('.ustatus').textContent = 'Error'; li.title = e.message; }
  });
}

function renderUploads() {
  const ul = $('#upload-list');
  ul.innerHTML = '';
  for (const [id, u] of S.uploads) {
    const li = document.createElement('li');
    li.dataset.id = id;
    const pct = Math.round(100 * u.loaded / Math.max(1, u.total));
    li.innerHTML = `
      <span class="uname" title="${u.file.name}">${u.file.name}</span>
      <span class="uprog"><span style="width:${pct}%"></span></span>
      <span class="ustatus">${u.status === 'done' ? 'Done' : u.status === 'err' ? 'Error' : pct + '%'}</span>`;
    if (u.status === 'done') li.classList.add('done');
    if (u.status === 'err')  { li.classList.add('err'); li.title = u.err || ''; }
    ul.appendChild(li);
  }
  $('#upload-tray').hidden = S.uploads.size === 0;
}

/* =============================================================== *
 *  9.  Preview                                                     *
 * =============================================================== */

async function openPreview(ent) {
  const name = ent.name;
  $('#preview-title').textContent = name;
  const body = $('#preview-body'); body.innerHTML = '';
  $('#preview').hidden = false;
  pushRecent(ent);

  const url = S.api.downloadUrl([ent.path], 'open');
  const ext = (name.split('.').pop() || '').toLowerCase();
  const img = ['png','jpg','jpeg','gif','webp','bmp','svg'];
  const vid = ['mp4','webm','mov','m4v'];
  const aud = ['mp3','wav','ogg','m4a','flac'];
  const txt = ['txt','md','log','json','yml','yaml','xml','ini','conf','csv','js','ts','py','c','cc','cpp','h','hpp','rs','go','rb','php','css','html','sh','sql'];
  const pdf = ['pdf'];

  $('#preview-download').onclick = () => doDownload([ent]);

  if (img.includes(ext)) {
    const i = document.createElement('img'); i.src = url; i.alt = name; body.appendChild(i);
  } else if (vid.includes(ext)) {
    const v = document.createElement('video'); v.src = url; v.controls = true; v.autoplay = true; body.appendChild(v);
  } else if (aud.includes(ext)) {
    const a = document.createElement('audio'); a.src = url; a.controls = true; a.autoplay = true; body.appendChild(a);
  } else if (pdf.includes(ext)) {
    const f = document.createElement('iframe'); f.src = url; f.style.cssText = 'width:100%;height:100%;border:0;background:#fff'; body.appendChild(f);
  } else if (txt.includes(ext) && (ent.additional?.size ?? 0) < 1024 * 1024) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      const pre = document.createElement('pre'); pre.textContent = text; body.appendChild(pre);
    } catch (e) { body.innerHTML = `<div class="preview-unsupported">Failed to load preview.<br>${e.message}</div>`; }
  } else {
    const d = document.createElement('div');
    d.className = 'preview-unsupported';
    d.innerHTML = `No in-app preview for <b>${name}</b>.<br/>`;
    const btn = document.createElement('button');
    btn.className = 'btn'; btn.textContent = 'Download';
    btn.onclick = () => doDownload([ent]);
    d.appendChild(btn);
    body.appendChild(d);
  }
}

function closePreview() { $('#preview').hidden = true; $('#preview-body').innerHTML = ''; }

/* =============================================================== *
 *  10. Recent (local)                                              *
 * =============================================================== */

async function loadRecent() {
  const host = S.conn?.host || 'default';
  const { recent } = await Store.get('recent');
  S.recent = (recent && recent[host]) || [];
}

async function pushRecent(ent) {
  if (!ent || ent.isdir) return;
  const host = S.conn?.host || 'default';
  const { recent } = await Store.get('recent');
  const map = recent || {};
  const list = map[host] || [];
  const trimmed = [{ path: ent.path, name: ent.name, size: ent.additional?.size, time: Date.now() / 1000 },
                   ...list.filter(x => x.path !== ent.path)].slice(0, 60);
  map[host] = trimmed;
  await Store.set({ recent: map });
  S.recent = trimmed;
}

function openRecent() {
  $('#appbar-title').textContent = 'Recent files';
  $('#btn-up').hidden = true;
  $('#breadcrumb').hidden = true;
  S.entries = S.recent.map(r => ({
    name: r.name, path: r.path, isdir: false,
    additional: { size: r.size, time: { mtime: r.time } },
  }));
  renderFiles();
}

/* =============================================================== *
 *  11. Favorites                                                   *
 * =============================================================== */

async function openFavorites() {
  $('#appbar-title').textContent = 'Favorites';
  $('#btn-up').hidden = true;
  $('#breadcrumb').hidden = true;
  setBusy(true);
  try {
    const data = await S.api.listFavorites();
    S.entries = (data.favorites || []).map(f => ({
      name: f.name, path: f.path,
      isdir: f.isdir ?? (f.status === 'valid' && !/\.\w+$/.test(f.name)),
      additional: f.additional,
    }));
    renderFiles();
  } catch (e) { errorToast(e); S.entries = []; renderFiles(); }
  finally { setBusy(false); }
}

/* =============================================================== *
 *  12. Search                                                      *
 * =============================================================== */

async function runSearch(pattern) {
  if (!pattern) return;
  if (!S.cwd) { toast('Open a folder to search in'); return; }
  S.view = 'search'; S.search = { pattern, folder: S.cwd };
  $('#appbar-title').textContent = `Search: ${pattern}`;
  $('#breadcrumb').hidden = true;
  setBusy(true);
  try {
    const tid = await S.api.searchStart(S.cwd, pattern);
    S.search.taskid = tid;
    // poll a few times until initial results arrive
    let data;
    for (let i = 0; i < 6; i++) {
      data = await S.api.searchList(tid);
      if (data.finished || (data.files && data.files.length)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    S.entries = data.files || [];
    sortEntries();
    renderFiles();
    try { await S.api.searchStop(tid); } catch {}
  } catch (e) { errorToast(e); }
  finally { setBusy(false); }
}

/* =============================================================== *
 *  13. Settings                                                    *
 * =============================================================== */

function openSettings() {
  $('#appbar-title').textContent = 'Settings';
  $('#btn-up').hidden = true;
  $('#breadcrumb').hidden = true;
  const list = $('#file-list');
  list.className = 'file-list';
  list.innerHTML = '';
  const u = S.conn || {};
  const html = `
    <li style="display:block;cursor:default">
      <div class="file-name">Signed in as</div>
      <div class="file-sub">${u.user || ''} @ ${u.host || ''}${u.port ? ':' + u.port : ''} (${u.https ? 'HTTPS' : 'HTTP'})</div>
    </li>
    <li id="set-layout" style="justify-content:space-between">
      <div class="file-meta"><div class="file-name">View</div><div class="file-sub">List or grid</div></div>
      <span class="file-sub">${S.layout}</span>
    </li>
    <li id="set-sort" style="justify-content:space-between">
      <div class="file-meta"><div class="file-name">Default sort</div><div class="file-sub">How files are ordered</div></div>
      <span class="file-sub">${S.sortBy} · ${S.sortDir}</span>
    </li>
    <li id="set-theme" style="justify-content:space-between">
      <div class="file-meta"><div class="file-name">Theme</div><div class="file-sub">Follow system / light / dark</div></div>
      <span class="file-sub">${document.documentElement.dataset.theme || 'system'}</span>
    </li>
    <li id="set-signout" style="color:var(--danger)">
      <div class="file-meta"><div class="file-name">Sign out</div><div class="file-sub">End this session on the NAS</div></div>
    </li>`;
  list.innerHTML = html;
  $('#set-layout').onclick = () => { S.layout = S.layout === 'grid' ? 'list' : 'grid'; openSettings(); };
  $('#set-sort').onclick   = () => sortMenu($('#set-sort'));
  $('#set-theme').onclick  = () => {
    const t = document.documentElement.dataset.theme;
    const next = t === 'dark' ? 'light' : t === 'light' ? '' : 'dark';
    if (next) document.documentElement.dataset.theme = next;
    else document.documentElement.removeAttribute('data-theme');
    Store.set({ theme: next });
    openSettings();
  };
  $('#set-signout').onclick = () => signOut();
}

/* =============================================================== *
 *  14. Menus                                                       *
 * =============================================================== */

const SVG = {
  download: `<svg viewBox="0 0 24 24"><path d="M12 4v12m0 0l-4-4m4 4l4-4M5 20h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  rename:   `<svg viewBox="0 0 24 24"><path d="M4 20h4L20 8l-4-4L4 16z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>`,
  trash:    `<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  copy:     `<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 4H6a2 2 0 0 0-2 2v10" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  move:     `<svg viewBox="0 0 24 24"><path d="M4 7h8l2 2h6v9H4z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>`,
  share:    `<svg viewBox="0 0 24 24"><circle cx="6" cy="12" r="2" fill="currentColor"/><circle cx="18" cy="6" r="2" fill="currentColor"/><circle cx="18" cy="18" r="2" fill="currentColor"/><path d="M7.5 11l9-4M7.5 13l9 4" stroke="currentColor" stroke-width="1.5"/></svg>`,
  star:     `<svg viewBox="0 0 24 24"><path d="M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18l-5.9 3 1.2-6.5L2.5 9.9 9.1 9z" fill="currentColor"/></svg>`,
  unstar:   `<svg viewBox="0 0 24 24"><path d="M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18l-5.9 3 1.2-6.5L2.5 9.9 9.1 9z" fill="none" stroke="currentColor" stroke-width="2"/></svg>`,
  info:     `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 10v6M12 7v.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
  upload:   `<svg viewBox="0 0 24 24"><path d="M12 20V8m0 0l-4 4m4-4l4 4M5 4h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  folder:   `<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor"/></svg>`,
  sort:     `<svg viewBox="0 0 24 24"><path d="M4 7h10M4 12h7M4 17h4M17 5v14m0 0l-3-3m3 3l3-3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  view:     `<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
  select:   `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 12l3 3 5-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  refresh:  `<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5l2-2v6h-6l2-2a6 6 0 1 0 2 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  check:    `<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function moreMenu(anchor) {
  const items = [
    { label: 'Sort', icon: SVG.sort,  onClick: () => sortMenu(anchor) },
    { label: `${S.layout === 'grid' ? 'List' : 'Grid'} view`, icon: SVG.view, onClick: () => { S.layout = S.layout === 'grid' ? 'list' : 'grid'; renderFiles(); } },
    { label: 'Select', icon: SVG.select, onClick: enterSelectMode },
    '-',
    { label: 'Refresh', icon: SVG.refresh, onClick: refresh },
  ];
  openMenu('menu-more', anchor, items);
}

function sortMenu(anchor) {
  const opts = [
    { k: 'name', label: 'Name' },
    { k: 'time', label: 'Modified' },
    { k: 'size', label: 'Size' },
    { k: 'user', label: 'Owner' },
  ];
  const items = opts.map(o => ({
    label: `${o.label}${S.sortBy === o.k ? '  ·  ' + (S.sortDir === 'asc' ? 'A→Z' : 'Z→A') : ''}`,
    icon: S.sortBy === o.k ? SVG.check : '',
    onClick: () => {
      if (S.sortBy === o.k) S.sortDir = S.sortDir === 'asc' ? 'desc' : 'asc';
      else { S.sortBy = o.k; S.sortDir = 'asc'; }
      sortEntries(); renderFiles();
    },
  }));
  openMenu('menu-more', anchor, items);
}

function fabMenu() {
  const items = [
    { label: 'Upload files', icon: SVG.upload, onClick: pickFiles },
    { label: 'New folder',   icon: SVG.folder, onClick: doCreateFolder },
  ];
  openMenu('menu-fab', $('#fab'), items);
}

function itemMenu(ent, anchor) {
  const items = [];
  items.push({ label: ent.isdir ? 'Open' : 'Preview', icon: ent.isdir ? SVG.folder : SVG.info,
               onClick: () => ent.isdir ? openFolder(ent.path) : openPreview(ent) });
  if (!ent.isdir) items.push({ label: 'Download', icon: SVG.download, onClick: () => doDownload([ent]) });
  items.push({ label: 'Rename', icon: SVG.rename, onClick: () => doRename(ent) });
  items.push({ label: 'Copy to…', icon: SVG.copy, onClick: () => doCopyMove([ent], 'copy') });
  items.push({ label: 'Move to…', icon: SVG.move, onClick: () => doCopyMove([ent], 'move') });
  items.push({ label: 'Share link', icon: SVG.share, onClick: () => doShare([ent]) });
  const favored = S.view === 'favorites';
  items.push({ label: favored ? 'Remove from favorites' : 'Add to favorites',
               icon: favored ? SVG.unstar : SVG.star,
               onClick: () => favored ? doUnfavorite(ent) : doFavorite(ent) });
  items.push('-');
  items.push({ label: 'Properties', icon: SVG.info, onClick: () => showProperties(ent) });
  items.push({ label: 'Delete', icon: SVG.trash, danger: true, onClick: () => doDelete([ent]) });
  openMenu('menu-item', anchor, items);
}

function selMoreMenu(anchor) {
  const entries = selectedEntries();
  openMenu('menu-sel-more', anchor, [
    { label: 'Share link', icon: SVG.share, onClick: () => doShare(entries) },
    { label: 'Add to favorites', icon: SVG.star,  onClick: async () => { for (const e of entries) await S.api.addFavorite(e.path, e.name); toast('Added to favorites'); exitSelectMode(); } },
  ]);
}

function showProperties(ent) {
  const d = document.createElement('div');
  d.className = 'dialog-body-row';
  const rows = [
    ['Name', ent.name],
    ['Path', ent.path],
    ['Type', ent.isdir ? 'Folder' : (ent.name.split('.').pop() || 'File')],
    ['Size', ent.isdir ? '—' : fmtSize(ent.additional?.size)],
    ['Modified', fmtTime(ent.additional?.time?.mtime)],
    ['Owner', ent.additional?.owner?.user || '—'],
  ];
  d.innerHTML = rows.map(([k, v]) => `<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid var(--divider)"><b style="min-width:90px">${k}</b><span>${v || ''}</span></div>`).join('');
  openDialog({
    title: 'Properties', body: d,
    actions: [{ label: 'Close', onClick: closeDialog }],
  });
}

/* =============================================================== *
 *  15. Drawer                                                      *
 * =============================================================== */

function openDrawer()  { $('#drawer').hidden = false; $('#drawer').classList.add('open'); $('#scrim').hidden = false; }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').hidden = true; setTimeout(() => { $('#drawer').hidden = true; }, 220); }

function renderDrawerHeader() {
  const u = S.conn || {};
  const first = (u.user || '?').slice(0, 1).toUpperCase();
  $('#drawer-avatar').textContent = first;
  $('#drawer-user').textContent = u.user || '';
  $('#drawer-host').textContent = `${u.host || ''}${u.port ? ':' + u.port : ''}`;
}

/* =============================================================== *
 *  16. Wiring                                                      *
 * =============================================================== */

function wireEvents() {
  $('#btn-menu').onclick = openDrawer;
  $('#scrim').onclick    = closeDrawer;
  $('#btn-up').onclick   = () => {
    if (!S.cwd) return;
    const parent = S.cwd.split('/').slice(0, -1).join('/');
    openFolder(parent || '');
  };
  $('#btn-search').onclick = () => {
    $('#appbar-main').hidden = true;
    $('#searchbar').hidden = false;
    $('#search-input').focus();
  };
  $('#btn-search-close').onclick = () => {
    $('#searchbar').hidden = true;
    $('#appbar-main').hidden = false;
    $('#search-input').value = '';
    if (S.view === 'search') openFolder(S.search?.folder || '');
  };
  $('#btn-search-clear').onclick = () => { $('#search-input').value = ''; };
  $('#search-input').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(e.target.value.trim()); });

  $('#btn-view').onclick = () => { S.layout = S.layout === 'grid' ? 'list' : 'grid'; renderFiles(); };
  $('#btn-more').onclick = e => { e.stopPropagation(); moreMenu($('#btn-more')); };
  $('#fab').onclick      = e => { e.stopPropagation(); fabMenu(); };
  $('#btn-more').dataset.menuAnchor = '1';
  $('#fab').dataset.menuAnchor = '1';

  // Selection toolbar
  $('#btn-sel-cancel').onclick = exitSelectMode;
  $('#btn-sel-download').onclick = () => doDownload(selectedEntries());
  $('#btn-sel-copy').onclick   = () => doCopyMove(selectedEntries(), 'copy');
  $('#btn-sel-move').onclick   = () => doCopyMove(selectedEntries(), 'move');
  $('#btn-sel-delete').onclick = () => doDelete(selectedEntries());
  $('#btn-sel-more').onclick   = e => { e.stopPropagation(); selMoreMenu($('#btn-sel-more')); };
  $('#btn-sel-more').dataset.menuAnchor = '1';

  // Drawer navigation
  $$('#drawer .drawer-nav button').forEach(b => {
    b.onclick = async () => {
      const nav = b.dataset.nav;
      if (nav === 'logout') {
        if (!(await confirmDialog({ title: 'Sign out?', body: 'You will be signed out of this NAS.', okLabel: 'Sign out', danger: true }))) return;
        signOut();
      } else {
        navigate(nav);
      }
    };
  });

  // Upload tray close
  $('#upload-close').onclick = () => { S.uploads.clear(); renderUploads(); };

  // Preview
  $('#preview-close').onclick = closePreview;

  // Drag-and-drop into current folder
  const area = $('#file-area');
  area.addEventListener('dragover', e => { if (S.view === 'files' && S.cwd) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  area.addEventListener('drop', e => {
    if (S.view !== 'files' || !S.cwd) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) startUpload(f);
  });
}

/* =============================================================== *
 *  17. Boot                                                        *
 * =============================================================== */

async function boot() {
  const { theme } = await Store.get('theme');
  if (theme) document.documentElement.dataset.theme = theme;
  wireEvents();
  await initLoginForm();
  const ok = await restoreSession();
  if (ok) {
    await loadRecent();
    showApp();
  } else {
    showLogin();
  }
}

window.addEventListener('DOMContentLoaded', boot);
