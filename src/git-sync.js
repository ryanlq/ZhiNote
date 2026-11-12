/* git-sync.js — 枝记 Git 同步后端（isomorphic-git，浏览器端）。
 * ─────────────────────────────────────────────────────────────────
 * 定位：与 webdav-sync 并列的第二同步后端（syncMethod === 'git'）。
 * 数据映射（明文，无 E2EE）：
 *   notes/<id>.md        YAML frontmatter（元数据）+ Markdown 正文（serializeDocToMd）
 *   trash/<id>.md        回收站笔记（frontmatter.deleted = 删除时间）
 *   images/<hash>.<ext>  图片二进制（内容寻址，正文 zhinote://img/<hash> 引用）
 *   workspaces.json      {v, workspaces:[{id,name,icon}], wsDeleted:{id:ts}}
 *   templates/<id>.json  {name, content}
 *   tombstones.json      {v, note:{id:ts}, ws:{id:ts}, tpl:{id:ts}} —— purge 语义
 *   settings.json        共享设置（与 WebDAV _extractSharedSettings 同规则）
 * 设计取舍：
 *  - 无 struct-ledger/epoch 机器：结构 = 文件 + frontmatter；合并冲突走"单方变取该方，
 *    双方变本地为准 + 远端版本留底 conflicts/"。
 *  - ydoc 防复活：远端内容真变时 noteData 不带 ydoc 且 keepLedger:false → 笔记无账本，
 *    editor._bindNoteCrdt 对无账本笔记用 clientID=0 确定性创世，天然重置。
 *  - LightningFS(IndexedDB) 长驻不重克隆；多标签 localStorage 互斥锁 + BroadcastChannel。
 *  - 每周期全量哈希扫描导出（个人库体量足够快），应用复用 storage._webdavApply* 事件链。
 * 周期流程（add-commit-pull-merge-push）：
 *   ensureRepo → (首次：采纳远端 / 异仓清理) → 导出本地变更 → commit → fetch →
 *   远端有新 → 快进/merge commit（冲突按文件 keep-both）→ 应用远端增量 → push
 */
(function () {
  'use strict';

  const K = { url: 'gitUrl', user: 'gitUser', pass: 'gitPass', branch: 'gitBranch', an: 'gitAuthorName', ae: 'gitAuthorEmail' };
  const FS_NAME = 'zhinote-git';
  const DIR = '/zhinote';
  const LOCK_KEY = 'zhinote-git-lock';
  const LOCK_STALE_MS = 30000;

  // ---- 运行态 ----
  let _fs = null;
  let _cloned = false;          // 本地仓库就绪（init 或 clone 完成）
  let _justCloned = false;      // 本轮待处理首同步（采纳远端 / 异仓清理）
  let _hasRemoteNotes = true;   // 远端是否含可解析笔记（false = 异仓，需以本机为准接管）
  let _syncing = false;
  let _uiBusy = 0;
  let _state = 'local';
  let _lastError = '';
  let _lastSyncTime = 0;
  let _putTimer = null;
  let _putAt = 0;
  let _exported = {};           // path → 内容 hash（上次导出状态，用于增量与删除检测）
  let _imgWritten = {};         // hash → 已写入仓库的图片
  let _imgExtCache = {};
  let _bc = null;
  const _putDebounceMs = 2500;
  const _minIntervalMs = 12000;

  // ---- 基础 ----
  function S() { return window.storage; }
  function gs(k, d) { try { const v = S().getSetting(k); return (v == null || v === '') ? d : v; } catch (_) { return d; } }
  function emit(type, payload) { try { S()._emitCloudSync(Object.assign({ type: type }, payload || {})); } catch (_) {} }
  function log(msg) { try { console.log('[git-sync] ' + msg); } catch (_) {} }
  function cfg() {
    return {
      url: String(gs(K.url, '')).trim().replace(/\/+$/, ''),
      user: String(gs(K.user, '')).trim(),
      pass: String(gs(K.pass, '')),
      branch: String(gs(K.branch, 'main')).trim() || 'main',
      an: String(gs(K.an, 'ZhiNote')).trim() || 'ZhiNote',
      ae: String(gs(K.ae, 'zhinote@local')).trim() || 'zhinote@local',
    };
  }
  function onAuth() {
    const c = cfg();
    return (c.user || c.pass) ? { username: c.user || 'anonymous', password: c.pass } : undefined;
  }
  function author() { const c = cfg(); return { name: c.an, email: c.ae }; }
  function hashStr(s) {
    let h = 5381;
    s = String(s == null ? '' : s);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }

  // ---- 事件（git- 前缀，app.js 归一为 webdav- 家族复用同一套 UI）----
  function emitStart(detail, silent) { emit('git-sync-start', { detail: detail, silent: !!silent }); }
  function emitOk(detail, extra, silent) { _state = 'ok'; _lastSyncTime = Date.now(); emit('git-sync-ok', Object.assign({ detail: detail, silent: !!silent }, extra || {})); }
  function emitFail(err, silent) { _state = 'error'; _lastError = String((err && err.message) || err); emit('git-sync-fail', { error: new Error(_lastError), silent: !!silent }); }

  // ---- frontmatter：值一律 JSON 字符串编码，规避 YAML 冒号/换行坑 ----
  function _fmStringify(fm, body) {
    const keys = ['id', 'title', 'parent', 'workspace', 'order', 'pinned', 'color', 'icon', 'expanded', 'created', 'updated', 'deleted'];
    let out = '---\n';
    for (const k of keys) {
      if (fm[k] === undefined || fm[k] === null || fm[k] === '') continue;
      out += k + ': ' + JSON.stringify(String(fm[k])) + '\n';
    }
    return out + '---\n' + String(body == null ? '' : body);
  }
  function _fmParse(text) {
    const s = String(text == null ? '' : text);
    if (s.slice(0, 4) !== '---\n') return null;          // 无 frontmatter → 异仓内容
    const end = s.indexOf('\n---\n', 4);
    if (end < 0) return null;
    const fm = {};
    for (const line of s.slice(4, end).split('\n')) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const k = line.slice(0, i).trim();
      let v = line.slice(i + 1).trim();
      try { v = JSON.parse(v); } catch (_) { /* 保留原串 */ }
      fm[k] = v;
    }
    return { fm: fm, body: s.slice(end + 5) };
  }

  // ---- 仓库工作区文件读写 ----
  function pfs() { return _fs.promises; }
  /** LightningFS 的 mkdir 不支持 recursive 且目录已存在会抛 EEXIST → 逐级创建并忽略 EEXIST */
  async function _mkdirp(full) {
    const parts = full.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      try { await pfs().mkdir(cur); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    }
  }
  async function wfWrite(path, content) {
    const full = DIR + '/' + path;
    await _mkdirp(full.slice(0, full.lastIndexOf('/')));
    await pfs().writeFile(full, content);
    _exported[path] = hashStr(content);
  }
  async function wfWriteBin(path, bytes) {
    const full = DIR + '/' + path;
    await _mkdirp(full.slice(0, full.lastIndexOf('/')));
    await pfs().writeFile(full, bytes);
  }

  // _exported 跨会话持久化：页面刷新后哈希还在 → 无变化就不产生空提交
  const EXPORTED_KEY = 'zhinote-git-exported';
  function _loadExported() {
    try { const o = JSON.parse(localStorage.getItem(EXPORTED_KEY) || '{}'); if (o && typeof o === 'object') _exported = o; } catch (_) {}
  }
  function _saveExported() {
    try { localStorage.setItem(EXPORTED_KEY, JSON.stringify(_exported)); } catch (_) {}
  }
  async function wfRead(path) {
    try { return await pfs().readFile(DIR + '/' + path, 'utf8'); } catch (_) { return null; }
  }
  async function wfRm(path) {
    try { await pfs().unlink(DIR + '/' + path); } catch (_) {}
    delete _exported[path];
    if (_pendingRm.indexOf(path) === -1) _pendingRm.push(path);  // 从 git 索引移除（含外来文件）
  }
  async function _readBlobText(oid, path) {
    try {
      const b = await git.readBlob({ fs: _fs, dir: DIR, oid: oid, filepath: path });
      return new TextDecoder().decode(b.blob);
    } catch (_) { return null; }
  }

  // ---- 互斥锁（多标签：localStorage + 心跳；BroadcastChannel 通知他标签补拉）----
  function _tabId() {
    let id = null;
    try { id = localStorage.getItem('zhinote-git-tab'); } catch (_) {}
    if (!id) { id = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); try { localStorage.setItem('zhinote-git-tab', id); } catch (_) {} }
    return id;
  }
  function _lock() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      if (raw) {
        const l = JSON.parse(raw);
        if (l.tab !== _tabId() && Date.now() - l.ts < LOCK_STALE_MS) return false;
      }
      localStorage.setItem(LOCK_KEY, JSON.stringify({ tab: _tabId(), ts: Date.now() }));
      return true;
    } catch (_) { return true; }
  }
  function _unlock() {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      if (raw && JSON.parse(raw).tab === _tabId()) localStorage.removeItem(LOCK_KEY);
    } catch (_) {}
  }
  function _bcInit() {
    if (_bc || typeof BroadcastChannel === 'undefined') return;
    try {
      _bc = new BroadcastChannel('zhinote-git');
      _bc.onmessage = function (ev) { if (ev && ev.data === 'synced') schedulePut('peer-synced'); };
    } catch (_) {}
  }

  // ---- 数据读取 ----
  function _data() { return S().getAll() || {}; }
  function _notes() { return _data().notes || {}; }
  function _trash() { return _data().trash || {}; }
  function _tomb() { const d = _data(); return { note: d.noteTombstones || {}, ws: d.wsTombstones || {}, tpl: d.tplTombstones || {} }; }

  /** 笔记 → {path, content}；deletedAt 表示回收站。 */
  function _noteFile(id, n, deletedAt) {
    const body = (n.doc && window.editor && window.editor.serializeDocToMd)
      ? String(window.editor.serializeDocToMd(n.doc) || '') : String(n.content || '');
    const fm = {
      id: id, title: n.title || '', parent: n.parentId || '', workspace: n.workspaceId || '',
      order: n.frac || '', pinned: n.pinnedAt || '', color: n.color || '', icon: n.icon || '',
      expanded: n.expanded ? '1' : '', created: n.createdAt || '', updated: n.updatedAt || '', deleted: deletedAt || '',
    };
    return { path: (deletedAt ? 'trash/' : 'notes/') + id + '.md', content: _fmStringify(fm, body) };
  }
  /** 笔记正文引用的图片 hash 集合。 */
  function _noteImages(doc) {
    const out = new Set();
    try { if (doc && window.editor && window.editor.walkDocImages) window.editor.walkDocImages(doc, (src) => { if (src) out.add(String(src).replace(/^zhinote:\/\/img\//, '')); }); } catch (_) {}
    return out;
  }
  function _sharedSettings() {
    const st = _data().settings || {};
    const LOCAL_ONLY = ['theme', 'fontSize', 'fontFamily', 'noteTransition', 'sidebarCollapsed', 'outlineCollapsed', 'showTrashBadge', 'syncMethod',
      'editorPadding', 'sidebarWidth', 'outlineOpen', 'activeWorkspace', 'lastOpenedId', 'startupNoteId', 'recent', 'recentEmojis', 'imagesDir',
      'webdavUrl', 'webdavUser', 'webdavPass', 'webdavProvider', 'webdavEncryptNotes', 'webdavProxy', 'webdavRealtime', 'webdavCryptoPass', 'pinned',
      'urlOpenInBrowser', 'urlOpenBrowser', 'unsyncedParkedIds'];
    const LOCAL_PREFIX = ['webdav_', 'git_', '_'];
    const shared = {};
    for (const k in st) { if (LOCAL_ONLY.includes(k)) continue; if (LOCAL_PREFIX.some(p => k.startsWith(p))) continue; shared[k] = st[k]; }
    return shared;
  }
  function _imgExtOf(dataUrl) {
    const m = /^data:image\/([a-z0-9.+-]+);/i.exec(String(dataUrl || ''));
    if (!m) return 'png';
    const e = m[1].toLowerCase();
    return e === 'jpeg' ? 'jpg' : e;
  }
  function _dataUrlToBytes(dataUrl) {
    const bin = atob(String(dataUrl).replace(/^data:[^,]*,/, ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function _bytesToDataUrl(bytes, ext) {
    const mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/' + ext;
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:' + mime + ';base64,' + btoa(bin);
  }

  // ---- 仓库就绪（init / clone / 异仓判定）----
  async function _ensureRepo() {
    const c = cfg();
    if (!c.url) throw new Error('还没配置 Git 仓库地址');
    if (!_fs) _fs = new window.LightningFS(FS_NAME);
    if (_cloned) return;
    try { await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' }); _cloned = true; return; } catch (_) {}
    const info = await git.getRemoteInfo({ fs: _fs, http: window.gitHttp, dir: DIR, url: c.url, onAuth: onAuth });
    const heads = (info.refs && info.refs.heads) || {};
    if (!heads[c.branch]) {
      await git.init({ fs: _fs, dir: DIR, defaultBranch: c.branch });
      try { await git.addRemote({ fs: _fs, dir: DIR, remote: 'origin', url: c.url, force: true }); } catch (_) {}
      _cloned = true; _hasRemoteNotes = false; _justCloned = false;
      _loadExported();
      log('远端为空仓：首次导出将全量首推');
      return;
    }
    // 目录可能残留上次中断的半截 clone（git.clone 遇已存在目录会抛 EEXIST）→ 先探测
    let hasDir = false;
    try { await pfs().stat(DIR); hasDir = true; } catch (_) {}
    if (!hasDir) {
      await git.clone({ fs: _fs, http: window.gitHttp, dir: DIR, url: c.url, branch: c.branch, singleBranch: true, onAuth: onAuth });
    } else {
      // 修复路径：init + fetch + 把本地分支指到远端并强制检出（中断的半截仓库自愈）
      log('检测到残留仓库目录：走 init+fetch+checkout 修复');
      try { await git.init({ fs: _fs, dir: DIR, defaultBranch: c.branch }); } catch (_) {}
      try { await git.addRemote({ fs: _fs, dir: DIR, remote: 'origin', url: c.url, force: true }); } catch (_) {}
      await git.fetch({ fs: _fs, http: window.gitHttp, dir: DIR, url: c.url, branch: c.branch, force: true, onAuth: onAuth });
      const oid = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'refs/remotes/origin/' + c.branch });
      let branched = false;
      try { await git.branch({ fs: _fs, dir: DIR, ref: oid, name: c.branch, force: true, checkout: true }); branched = true; } catch (_) {}
      if (!branched) {
        try { await git.checkout({ fs: _fs, dir: DIR, ref: oid, force: true }); } catch (_) {}
        try { await git.branch({ fs: _fs, dir: DIR, ref: oid, name: c.branch, force: true }); } catch (_) {}
        try { await git.checkout({ fs: _fs, dir: DIR, ref: c.branch, force: true }); } catch (_) {}
      }
    }
    _cloned = true; _justCloned = true;
    _loadExported();
    // 异仓判定：notes/ 下存在不可解析文件（密文/异构数据）→ 以本机为准接管
    _hasRemoteNotes = true;
    try {
      const files = await pfs().readdir(DIR + '/notes');
      for (const f of files) {
        if (!/\.md$/.test(f)) continue;
        const text = await wfRead('notes/' + f);
        if (text != null && _fmParse(text) == null) { _hasRemoteNotes = false; break; }
      }
    } catch (_) { _hasRemoteNotes = false; }
    log('clone 完成（hasRemoteNotes=' + _hasRemoteNotes + '）');
  }
  /** 异仓接管：远端所有非图片文件清掉（布局未知/密文），随后以本机导出覆盖。图片按内容寻址保留。 */
  async function _wipeForeignFiles() {
    let remote = {};
    try { remote = await _treeFiles('HEAD'); } catch (_) { return; }
    for (const p of Object.keys(remote)) {
      if (p.indexOf('images/') === 0) continue;   // 内容寻址，保留复用
      await wfRm(p);
    }
    _imgWritten = {}; _imgExtCache = {};
    log('异仓文件已清理，将以本机导出接管');
  }
  async function _treeFiles(oid) {
    const map = {};
    if (!oid) return map;
    const walk = async (treePath, treeOid) => {
      const tree = await git.readTree({ fs: _fs, dir: DIR, oid: treeOid });
      const entries = (tree && (tree.entries || tree.tree)) || [];
      if (!Array.isArray(entries)) { log('readTree 异常: oid=' + treeOid + ' → ' + JSON.stringify(tree).slice(0, 120)); return; }
      for (const e of entries) {
        const p = treePath ? treePath + '/' + e.path : e.path;
        if (e.mode === '040000') await walk(p, e.oid);
        else if (e.mode === '100644' || e.mode === '100755') map[p] = e.oid;
      }
    };
    const commit = await git.readCommit({ fs: _fs, dir: DIR, oid: oid });
    await walk('', commit.commit.tree);
    return map;
  }
  async function _diffTrees(fromOid, toOid) {
    const a = await _treeFiles(fromOid), b = await _treeFiles(toOid);
    const changed = {}, removed = {};
    for (const p in b) if (a[p] !== b[p]) changed[p] = true;
    for (const p in a) if (!(p in b)) removed[p] = true;
    return { changed: changed, removed: removed, newMap: b };
  }

  // ---- 远端 → 本地应用 ----
  /** 应用远端变更。remoteOld 为 null = 全量采纳。返回应用的笔记 id 集合。 */
  async function _applyRemote(remoteOld, remoteNew) {
    const d = await _diffTrees(remoteOld, remoteNew);
    const changed = d.changed, removed = d.removed, newMap = d.newMap;
    const applied = new Set();

    // 1) 墓碑（purge 语义）：远端已永久删除 → 本端下线
    if (changed['tombstones.json']) {
      const t = JSON.parse((await wfRead('tombstones.json')) || '{}') || {};
      for (const id in (t.note || {})) {
        if (S().isNoteDeleted(id)) continue;
        if (_notes()[id]) S()._webdavRemoveNote(id);
        if (_trash()[id]) S().purgeFromTrash(id);
        applied.add(id);
      }
      S()._gitApplyGlobal({ wsDeleted: t.ws || {}, tplDeleted: t.tpl || {} });
    }

    // 2) 全局：笔记本 / 模板 / 共享设置（远端文件权威；本地偏好由 storage 侧回贴）
    const global = {};
    if (changed['workspaces.json']) {
      const w = JSON.parse((await wfRead('workspaces.json')) || '{}') || {};
      global.workspaces = w.workspaces || [];
      global.wsDeleted = w.wsDeleted || {};
    }
    if (changed['settings.json']) global.settings = JSON.parse((await wfRead('settings.json')) || '{}') || {};
    const tplTouched = Object.keys(changed).some(p => p.indexOf('templates/') === 0) ||
                       Object.keys(removed).some(p => p.indexOf('templates/') === 0);
    if (tplTouched) {
      const tplTomb = _tomb().tpl || {};
      const templates = [];
      for (const p of Object.keys(newMap)) {
        if (p.indexOf('templates/') !== 0 || !/\.json$/.test(p)) continue;
        try {
          const t = JSON.parse((await wfRead(p)) || 'null');
          const id = p.slice(10, -5);
          if (t && !tplTomb[id]) templates.push({ id: id, name: t.name || id, content: t.content || '' });
        } catch (_) {}
      }
      global.templates = templates;
    }
    if (Object.keys(global).length) S()._gitApplyGlobal(global);

    // 3) 图片：回填本地缓存（zhinote://img/<hash> 引用即可显示）
    for (const p of Object.keys(changed)) {
      if (p.indexOf('images/') !== 0) continue;
      const base = p.slice(7), dot = base.lastIndexOf('.');
      const hash = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot + 1) : 'png';
      try {
        const b = await git.readBlob({ fs: _fs, dir: DIR, oid: newMap[p], filepath: p });
        S()._webdavStoreImage(hash, _bytesToDataUrl(b.blob, ext));
      } catch (e) { log('图片应用失败 ' + p + ': ' + (e && e.message)); }
    }

    // 4) 回收站：远端新增 → 本地入回收站；远端还原 → 本地跟着还原
    for (const p of Object.keys(changed)) {
      if (p.indexOf('trash/') !== 0 || !/\.md$/.test(p)) continue;
      const id = p.slice(6, -3);
      if (_notes()[id]) { S()._webdavRemoveNote(id); applied.add(id); }
    }
    for (const p of Object.keys(removed)) {
      if (p.indexOf('trash/') !== 0 || !/\.md$/.test(p)) continue;
      const id = p.slice(6, -3);
      if (!_notes()[id] && _trash()[id] && !newMap['notes/' + id + '.md'] && !_tomb().note[id]) {
        S().purgeFromTrash(id); applied.add(id);
      }
    }

    // 5) 笔记文件（最后应用：还原场景先 restore 再套用内容）
    for (const p of Object.keys(changed)) {
      if (p.indexOf('notes/') !== 0 || !/\.md$/.test(p)) continue;
      const id = p.slice(6, -3);
      if (_trash()[id]) S().restoreFromTrash(id);          // 远端把回收站笔记还原了
      const parsed = _fmParse(await wfRead(p));
      if (!parsed) { log('跳过无法解析的远端笔记 ' + p); continue; }
      const fm = parsed.fm;
      const doc = (window.editor && window.editor.parseMdToDoc) ? window.editor.parseMdToDoc(parsed.body) : null;
      const noteData = {
        id: id,
        title: String(fm.title || '无标题'),
        parentId: fm.parent || null,
        workspaceId: fm.workspace || undefined,
        frac: fm.order || undefined,
        order: 0,
        pinnedAt: fm.pinned || null,
        color: fm.color || null,
        icon: fm.icon || null,
        expanded: fm.expanded === '1',
        createdAt: fm.created || undefined,
        updatedAt: fm.updated || undefined,
        doc: doc,
        content: parsed.body,
      };
      S()._webdavApplyNote(id, noteData, { keepLedger: false });  // frontmatter 权威 + 无账本（CRDT 重置）
      applied.add(id);
    }

    // 6) 远端删掉的笔记文件（非移入回收站、非 purge → 防御性移入回收站）
    for (const p of Object.keys(removed)) {
      if (p.indexOf('notes/') !== 0 || !/\.md$/.test(p)) continue;
      const id = p.slice(6, -3);
      if (newMap['trash/' + id + '.md'] || _tomb().note[id]) continue;
      if (_notes()[id]) S()._webdavRemoveNote(id);
      applied.add(id);
    }

    // 收尾：结构自愈 + 存盘 + 全树刷新（_gitApplyGlobal 兼容空参，仅做收尾）
    S()._gitApplyGlobal({});
    return applied;
  }

  // ---- 本地 → 仓库导出（全量哈希扫描，自愈漂移）----
  async function _exportAll() {
    const d = _data();
    const notes = d.notes || {}, trash = d.trash || {};
    const writes = [], present = {}, imgRefs = new Set();
    let imgCount = 0;

    const dump = (id, n, deletedAt) => {
      const f = _noteFile(id, n, deletedAt);
      present[f.path] = true;
      writes.push(f);
      for (const h of _noteImages(n.doc)) imgRefs.add(h);
    };
    for (const id in notes) { const n = notes[id]; if (n && (n.doc != null || n.content != null)) dump(id, n, ''); }
    for (const id in trash) { const n = trash[id]; if (n) dump(id, n, n.deletedAt || ''); }

    // 图片：现役引用确保落盘（已写过且内容未变的跳过；登记进 _exported 才会被 git.add）
    const imgMap = S().getImageMap ? S().getImageMap() : {};
    for (const h of imgRefs) {
      let dataUrl = imgMap[h] || null;
      if (!dataUrl && S().getLocalImage) { try { dataUrl = await S().getLocalImage(h); } catch (_) {} }
      if (!dataUrl) continue;
      const ext = _imgExtOf(dataUrl);
      const p2 = 'images/' + h + '.' + ext;
      const hkey = hashStr(dataUrl);
      present[p2] = true;
      _imgWritten[h] = true; _imgExtCache[h] = ext;
      if (_exported[p2] === hkey) continue;
      await wfWriteBin(p2, _dataUrlToBytes(dataUrl));
      _exported[p2] = hkey;
      imgCount++;
    }

    // 全局 JSON
    writes.push(
      { path: 'workspaces.json', content: JSON.stringify({ v: 1, workspaces: d.workspaces || [], wsDeleted: d.wsTombstones || {} }) },
      { path: 'settings.json', content: JSON.stringify(_sharedSettings()) },
    );
    const tb = _tomb();
    writes.push({ path: 'tombstones.json', content: JSON.stringify({ v: 1, note: tb.note, ws: tb.ws, tpl: tb.tpl }) });
    present['workspaces.json'] = present['settings.json'] = present['tombstones.json'] = true;
    const tplTomb = tb.tpl || {};
    for (const t of (d.templates || [])) {
      if (tplTomb[t.id]) continue;
      const p = 'templates/' + t.id + '.json';
      writes.push({ path: p, content: JSON.stringify({ name: t.name || t.id, content: t.content || '' }) });
      present[p] = true;
    }

    // 写入有变化的；删除已消失的（本地 purge 后文件不再存在）
    let changed = 0;
    for (const w of writes) {
      if (_exported[w.path] !== hashStr(w.content)) { await wfWrite(w.path, w.content); changed++; }
    }
    for (const path in _exported) {
      if (!present[path]) { await wfRm(path); changed++; }
    }
    return { changed: changed, images: imgCount };
  }

  // ---- 暂存 / 提交 / 推送 ----
  let _pendingRm = [];   // 待从 git 索引移除的路径（wfRm 登记，提交时统一 remove）
  async function _commitAll(message) {
    for (const path of Object.keys(_exported)) {
      try { await git.add({ fs: _fs, dir: DIR, filepath: path }); }
      catch (_) { try { await git.remove({ fs: _fs, dir: DIR, filepath: path }); } catch (_) {} }
    }
    for (const path of _pendingRm) {
      try { await git.remove({ fs: _fs, dir: DIR, filepath: path }); } catch (_) {}
    }
    _pendingRm = [];
    return await git.commit({ fs: _fs, dir: DIR, message: message, author: author() });
  }
  async function _push() {
    const c = cfg();
    const pr = await git.push({ fs: _fs, http: window.gitHttp, dir: DIR, url: c.url, branch: c.branch, onAuth: onAuth });
    if (!pr.ok) throw new Error('push 失败：' + (pr.error && pr.error.message || JSON.stringify(pr.error || '')));
  }

  // ---- 合并冲突按文件处理：单方变取该方；双方变本地为准 + 远端留底 conflicts/ ----
  async function _resolvePerFileKeepBoth(oursHead, theirsHead, baseHead) {
    const ours = await _treeFiles(oursHead);
    const theirs = await _treeFiles(theirsHead);
    const base = baseHead ? await _treeFiles(baseHead) : {};
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    let saved = 0;
    const paths = {};
    for (const p of Object.keys(theirs)) paths[p] = 1;
    for (const p of Object.keys(ours)) paths[p] = 1;
    for (const p of Object.keys(paths)) {
      if (p.indexOf('notes/') !== 0 && p.indexOf('trash/') !== 0 && p.indexOf('images/') !== 0 &&
          p.indexOf('templates/') !== 0 && p !== 'workspaces.json' && p !== 'settings.json' && p !== 'tombstones.json') continue;
      const o = ours[p] != null ? await _readBlobText(oursHead, p) : null;
      const t = theirs[p] != null ? await _readBlobText(theirsHead, p) : null;
      const b = base[p] != null ? await _readBlobText(baseHead, p) : null;
      if (o === t) continue;                                   // 两边一致
      if (t === b) continue;                                   // 只有本地变 → 保留本地
      if (o === b || o == null) { await wfWrite(p, t); continue; } // 只有远端变 / 本地新增缺失 → 取远端
      // 双方都变：本地为准，远端留底
      const conflictPath = 'conflicts/' + p.replace(/\//g, '-') + '-' + ts + '.md';
      await wfWrite(conflictPath, t);
      saved++;
    }
    if (saved) {
      log('合并冲突：' + saved + ' 个远端版本留底 conflicts/');
      try { window.toast ? window.toast('Git 合并有冲突：' + saved + ' 个远端版本已留底 conflicts/ 目录', 'warn', { duration: 8000 }) : null; } catch (_) {}
    }
  }

  // ---- 同步周期 ----
  async function syncCycle(kind, opts) {
    opts = opts || {};
    if (_syncing) { schedulePut('busy-reschedule'); return; }
    if (!_lock()) { log('他标签正在同步，跳过本轮'); return; }
    _syncing = true; _uiBusy++;
    emitStart(kind, opts.silent);
    let pushed = false, applied = new Set(), exported = 0;
    try {
      await _ensureRepo();
      const c = cfg();

      // 首同步：采纳远端（可解析）或接管异仓（以本机为准）
      if (_justCloned) {
        _justCloned = false;
        if (_hasRemoteNotes) {
          const head = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' });
          applied = await _applyRemote(null, head);
        } else {
          await _wipeForeignFiles();
          _hasRemoteNotes = true;
        }
      }

      // 1) 导出本地变更 → 提交（本地先落库，pull/merge 时工作区干净）
      const ex = await _exportAll();
      _saveExported();
      exported = ex.changed;
      const localHead0 = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' }).catch(() => null);
      let localHead = localHead0;
      if (ex.changed > 0 || ex.images > 0 || localHead === null) {
        const sha = await _commitAll('zhinote: 同步（' + ex.changed + ' 项变更）');
        localHead = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' });
        pushed = true;
        log('committed ' + String(sha).slice(0, 8));
      }

      // 2) 拉远端
      const remoteOld = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'refs/remotes/origin/' + c.branch }).catch(() => null);
      await git.fetch({ fs: _fs, http: window.gitHttp, dir: DIR, url: c.url, branch: c.branch, onAuth: onAuth });
      const remoteNew = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'refs/remotes/origin/' + c.branch }).catch(() => null);

      // 3) 远端有新内容 → 快进 / merge commit / 冲突按文件 keep-both
      if (remoteNew && remoteNew !== localHead) {
        let merged = false;
        try {
          await git.merge({ fs: _fs, http: window.gitHttp, dir: DIR, theirs: 'refs/remotes/origin/' + c.branch, fastForwardOnly: true });
          merged = true;
        } catch (e1) {
          if (remoteOld && localHead !== remoteOld) {
            // 真分叉：本地与远端各有提交 → merge commit
            try {
              await git.merge({ fs: _fs, http: window.gitHttp, dir: DIR, theirs: 'refs/remotes/origin/' + c.branch, message: 'zhinote: 合并远端变更', author: author() });
              merged = true;
            } catch (e2) { await _resolvePerFileKeepBoth(localHead, remoteNew, remoteOld); merged = true; }
          } else {
            await _resolvePerFileKeepBoth(localHead, remoteNew, null);  // 冲突标记等异常情况
            merged = true;
          }
        }
        if (merged) pushed = true;
        // 4) 应用远端增量（remoteOld → remoteNew = 纯远端贡献）
        if (remoteOld !== remoteNew) applied = await _applyRemote(remoteOld, remoteNew);
      }

      // 5) 推送（本地提交 / merge commit）
      if (pushed) await _push();
      _saveExported();

      emitOk(kind === 'put' ? 'put' : 'get', { uploaded: exported, downloadedNoteIds: applied }, opts.silent);
      try { if (_bc && kind !== 'wake') _bc.postMessage('synced'); } catch (_) {}
      _hasRemoteNotes = true;
    } catch (e) {
      log('同步失败：' + (e && (e.stack || e.message || e.code) || e));
      emitFail(e, opts.silent);
    } finally {
      _syncing = false; _uiBusy = Math.max(0, _uiBusy - 1); _unlock();
      _putAt = Date.now();
    }
  }

  // ---- 调度 ----
  function schedulePut(reason) {
    if (gs(K.url, '') === '') return;
    if (_putTimer) clearTimeout(_putTimer);
    const wait = Math.max(_putDebounceMs, _minIntervalMs - (Date.now() - _putAt));
    _putTimer = setTimeout(function () { _putTimer = null; syncCycle('put'); }, wait);
  }
  function flushPutOnHide() {
    if (_putTimer) { clearTimeout(_putTimer); _putTimer = null; }
    if (gs(K.url, '') !== '' && !_syncing) syncCycle('put', { silent: true });
  }

  // ---- 对外接口 ----
  async function loadConfig() { /* git 配置即设即用，无需解密/预取 */ }
  function startAutoSync() {
    _bcInit();
    schedulePut('start');
    try {
      window.addEventListener('online', function () { schedulePut('online'); });
      document.addEventListener('visibilitychange', function () { if (!document.hidden) schedulePut('visible'); });
    } catch (_) {}
  }
  function stop() {
    if (_putTimer) { clearTimeout(_putTimer); _putTimer = null; }
  }
  async function manualSync() { await syncCycle('manual'); }
  function isSyncing() { return _syncing; }
  function isUiSyncing() { return _uiBusy > 0 || _syncing; }
  async function testConnection(over) {
    const c = Object.assign(cfg(), over || {});
    if (!c.url) throw new Error('还没填仓库地址');
    const fs2 = _fs || (window.LightningFS ? new window.LightningFS(FS_NAME) : null);
    const auth = (c.user || c.pass) ? { username: c.user || 'anonymous', password: c.pass } : undefined;
    const info = await git.getRemoteInfo({ fs: fs2, http: window.gitHttp, dir: DIR, url: c.url, onAuth: () => auth });
    const heads = (info.refs && info.refs.heads) || {};
    return { ok: true, branches: Object.keys(heads), hasBranch: !!heads[c.branch] };
  }

  // ---- 阶段2：版本历史 ----
  async function listNoteHistory(id) {
    const commits = await git.log({ fs: _fs, http: window.gitHttp, dir: DIR, filepath: 'notes/' + id + '.md', force: true, depth: 50 });
    return commits.map(x => ({ oid: x.oid, date: x.commit.author.timestamp * 1000, message: x.commit.message }));
  }
  async function readNoteVersion(id, oid) {
    const b = await git.readBlob({ fs: _fs, dir: DIR, oid: oid, filepath: 'notes/' + id + '.md' });
    const parsed = _fmParse(new TextDecoder().decode(b.blob));
    const body = parsed ? parsed.body : String(new TextDecoder().decode(b.blob));
    const doc = (window.editor && window.editor.parseMdToDoc) ? window.editor.parseMdToDoc(body) : null;
    const fm = parsed ? parsed.fm : {};
    return { body: body, doc: doc, fm: fm, title: String(fm.title || '') };
  }
  /** 还原此版本：写回当前笔记（doc + frontmatter 字段），标脏 → 下轮周期成为一次新提交。 */
  async function restoreNoteVersion(id, oid) {
    const v = await readNoteVersion(id, oid);
    if (!v.doc) throw new Error('该版本无法解析');
    const Sx = S();
    Sx.updateDoc(id, v.doc);
    // 直接改 note 元数据字段（title/parent 等非 doc 字段不在 updateDoc 管辖内）
    const d = _data();
    const n = (d.notes || {})[id];
    if (n) {
      const fm = v.fm || {};
      if ('title' in fm) n.title = String(fm.title || n.title);
      if ('pinned' in fm) n.pinnedAt = fm.pinned || null;
      if ('color' in fm) n.color = fm.color || null;
      if ('icon' in fm) n.icon = fm.icon || null;
      n.updatedAt = new Date().toISOString();
    }
    Sx.markNotesDirtyByIds ? Sx.markNotesDirtyByIds([id]) : Sx.markDirty('git-restore');
    schedulePut('restore');
    return v;
  }

  window.gitSync = {
    loadConfig: loadConfig, startAutoSync: startAutoSync, stop: stop,
    schedulePut: schedulePut, flushPutOnHide: flushPutOnHide,
    manualSync: manualSync, testConnection: testConnection,
    isSyncing: isSyncing, isUiSyncing: isUiSyncing,
    getState: function () { return { state: _state, lastSync: _lastSyncTime, error: _lastError }; },
    listNoteHistory: listNoteHistory, readNoteVersion: readNoteVersion, restoreNoteVersion: restoreNoteVersion,
  };
})();
