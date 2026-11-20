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
 *  - 无 struct-ledger/epoch 机器：结构 = 文件 + frontmatter。合并策略：
 *    单方变取该方；双方变先自动融合（正文行级 diff3 + frontmatter 字段级三路、
 *    workspaces/tombstones/settings 结构化并集），真撞车才本地为准 + 远端留底 conflicts/。
 *    留底带内容哈希去重，绝不重复堆积；决议后必须补双亲 merge commit
 *    （parent:[ours,theirs]）推进 HEAD，否则 push 永久非快进失败、留底每轮翻倍（v2.2.x 老坑）。
 *  - 删除保护：本地已删（回收站/墓碑）的笔记，远端"改了"不复活，远端版照旧留底可找回。
 *  - isogit 的 merge（快进/干净合并）只前进 ref、不落工作区 → 合并后必须 force checkout，
 *    否则 _applyRemote 读工作区拿到旧内容，"下载"静默失效（v2.2.x 隐藏 bug）。
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
  // 只写工作区、不登记 _exported：用于 conflicts/ 留底这类「本地未跟踪文件」。
  // 不进导出表 → 不会被 _exportAll 当消失的文件清掉，也不会被 _commitAll 提交进仓库。
  async function wfWriteLocal(path, content) {
    const full = DIR + '/' + path;
    await _mkdirp(full.slice(0, full.lastIndexOf('/')));
    await pfs().writeFile(full, content);
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
  /** 应用合并结果。baseOid→resultOid 决定「哪些文件内容要套用」；
   *  actionsBaseOid→resultOid（纯远端动作：快进=合并前HEAD，否则=上次 fetch 点）单独决定「远端删了什么」，
   *  避免把我们自己的删除误判成远端删除（误清回收站/误下线笔记）。返回应用的笔记 id 集合。 */
  async function _applyRemote(baseOid, resultOid, actionsBaseOid) {
    const d = await _diffTrees(baseOid, resultOid);
    const dAct = actionsBaseOid && actionsBaseOid !== resultOid ? await _diffTrees(actionsBaseOid, resultOid) : null;
    const changed = d.changed, newMap = d.newMap;
    const removedAct = (dAct || d).removed;
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
                       Object.keys(removedAct).some(p => p.indexOf('templates/') === 0);
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
    for (const p of Object.keys(removedAct)) {
      if (p.indexOf('trash/') !== 0 || !/\.md$/.test(p)) continue;
      const id = p.slice(6, -3);
      if (!_notes()[id] && _trash()[id] && !newMap['notes/' + id + '.md'] && !_tomb().note[id]) {
        S().purgeFromTrash(id); applied.add(id);
      }
    }

    // 5) 笔记文件（最后应用：先解析成功才还原——文件不存在=决议保留删除，绝不复活）
    for (const p of Object.keys(changed)) {
      if (p.indexOf('notes/') !== 0 || !/\.md$/.test(p)) continue;
      const id = p.slice(6, -3);
      const raw = await wfRead(p);
      const parsed = raw != null ? _fmParse(raw) : null;
      if (!parsed) { log('跳过无法解析/不存在的远端笔记 ' + p); continue; }
      if (_trash()[id]) S().restoreFromTrash(id);          // 远端把回收站笔记还原了
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
    for (const p of Object.keys(removedAct)) {
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

    // 写入有变化的；删除已消失的（本地 purge 后文件不再存在）。
    // 哈希不同但工作区已是同内容（合并检出后远端/决议版本已应用进存储）→ 只登记不重写，避免空提交。
    let changed = 0;
    for (const w of writes) {
      const h = hashStr(w.content);
      if (_exported[w.path] === h) continue;
      let cur = null;
      try { cur = await pfs().readFile(DIR + '/' + w.path, 'utf8'); } catch (_) {}
      if (cur === w.content) { _exported[w.path] = h; continue; }
      await wfWrite(w.path, w.content);
      changed++;
    }
    for (const path in _exported) {
      if (!present[path]) { await wfRm(path); changed++; }
    }
    return { changed: changed, images: imgCount };
  }

  // ---- 暂存 / 提交 / 推送 ----
  let _pendingRm = [];   // 待从 git 索引移除的路径（wfRm 登记，提交时统一 remove）
  /** parents 非空时创建双亲提交（手动 merge commit），否则普通单亲提交。 */
  async function _commitAll(message, parents) {
    for (const path of Object.keys(_exported)) {
      try { await git.add({ fs: _fs, dir: DIR, filepath: path }); }
      catch (_) { try { await git.remove({ fs: _fs, dir: DIR, filepath: path }); } catch (_) {} }
    }
    for (const path of _pendingRm) {
      try { await git.remove({ fs: _fs, dir: DIR, filepath: path }); } catch (_) {}
    }
    _pendingRm = [];
    const opts = { fs: _fs, dir: DIR, message: message, author: author() };
    if (parents && parents.length) opts.parent = parents;
    return await git.commit(opts);
  }
  async function _push() {
    const c = cfg();
    const pr = await git.push({ fs: _fs, http: window.gitHttp, dir: DIR, url: c.url, branch: c.branch, onAuth: onAuth });
    if (!pr.ok) throw new Error('push 失败：' + (pr.error && pr.error.message || JSON.stringify(pr.error || '')));
  }

  // ---- 行级 diff3 自动合并（笔记正文撞车的第一道工序，合不动才留底）----
  /** a→b 的编辑区段 [{a0,a1,b0,b1}]：a[a0:a1] 被 b[b0:b1] 替换（行号左闭右开）。 */
  function _alignHunks(a, b) {
    const n = a.length, m = b.length, W = m + 1;
    const dp = new Int32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + (j + 1)] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
      }
    }
    const hunks = [];
    let i = 0, j = 0;
    for (;;) {
      while (i < n && j < m && a[i] === b[j]) { i++; j++; }
      if (i >= n || j >= m) {
        if (i < n || j < m) hunks.push({ a0: i, a1: n, b0: j, b1: m });
        break;
      }
      const a0 = i, b0 = j;
      while (i < n && j < m && a[i] !== b[j]) {
        if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) i++; else j++;
      }
      hunks.push({ a0: a0, a1: i, b0: b0, b1: j });
    }
    return hunks;
  }
  /** 经典 diff3：无重叠冲突 → 返回合并后的行数组；重叠且两边改得不一样 → null（交给留底）。 */
  function _diff3Lines(base, ours, theirs) {
    if (base.length * (ours.length + theirs.length) > 4000000) return null; // 超长放弃自动合并
    const ho = _alignHunks(base, ours), ht = _alignHunks(base, theirs);
    const out = [];
    let pos = 0, io = 0, it = 0;
    while (io < ho.length || it < ht.length) {
      const hO = ho[io], hT = ht[it];
      const onlyO = hT === undefined || (hO !== undefined && hO.a1 < hT.a0);
      const onlyT = hO === undefined || (hT !== undefined && hT.a1 < hO.a0);
      if (hO && onlyO) {
        if (hO.a0 > pos) out.push(...base.slice(pos, hO.a0));
        out.push(...ours.slice(hO.b0, hO.b1));
        pos = hO.a1; io++;
      } else if (hT && onlyT) {
        if (hT.a0 > pos) out.push(...base.slice(pos, hT.a0));
        out.push(...theirs.slice(hT.b0, hT.b1));
        pos = hT.a1; it++;
      } else {
        // 重叠/相触 → 扩成一个冲突群（吞并所有牵连的 hunk）
        let lo = Math.min(hO.a0, hT.a0), hi = Math.max(hO.a1, hT.a1);
        let eO = io + 1, eT = it + 1, grew = true;
        while (grew) {
          grew = false;
          while (eO < ho.length && ho[eO].a0 <= hi) { if (ho[eO].a1 > hi) { hi = ho[eO].a1; grew = true; } eO++; }
          while (eT < ht.length && ht[eT].a0 <= hi) { if (ht[eT].a1 > hi) { hi = ht[eT].a1; grew = true; } eT++; }
        }
        if (lo > pos) out.push(...base.slice(pos, lo));
        const go = ho.slice(io, eO), gt = ht.slice(it, eT);
        const goL = go[go.length - 1], gtL = gt[gt.length - 1];
        const oSeg = ours.slice(Math.max(0, go[0].b0 - Math.max(0, go[0].a0 - lo)), Math.min(ours.length, goL.b1 + Math.max(0, hi - goL.a1)));
        const tSeg = theirs.slice(Math.max(0, gt[0].b0 - Math.max(0, gt[0].a0 - lo)), Math.min(theirs.length, gtL.b1 + Math.max(0, hi - gtL.a1)));
        const same = oSeg.length === tSeg.length && oSeg.every((l, k) => l === tSeg[k]);
        if (!same) return null;                    // 真撞车
        out.push(...oSeg);                         // 两边改得一样 → 收一份
        pos = hi; io = eO; it = eT;
      }
    }
    if (pos < base.length) out.push(...base.slice(pos));
    return out;
  }
  /** frontmatter 字段级三路：单方变取该方，双方变本地为准；updated 取较新。 */
  function _fmMergeThree(fmO, fmT, fmB) {
    const out = Object.assign({}, fmO);
    const keys = {};
    for (const k in fmT) keys[k] = 1;
    for (const k in fmB) keys[k] = 1;
    for (const k in fmO) keys[k] = 1;
    for (const k of Object.keys(keys)) {
      const ov = fmO[k], tv = fmT[k], bv = fmB ? fmB[k] : undefined;
      if (k === 'updated') { const mx = [ov, tv].sort().pop(); if (mx != null) out[k] = mx; continue; }
      if (JSON.stringify(ov) === JSON.stringify(bv) && JSON.stringify(tv) !== JSON.stringify(bv)) out[k] = tv; // 仅远端变
    }
    return out;
  }
  /** 双方都变的笔记文件：正文 diff3 + frontmatter 字段级合并。成功返回合并后全文，失败 null。 */
  function _autoMergeNoteText(oText, tText, bText) {
    const po = _fmParse(oText), pt = _fmParse(tText), pb = bText != null ? _fmParse(bText) : null;
    if (!po || !pt || !pb) return null;
    const merged = _diff3Lines(pb.body.split('\n'), po.body.split('\n'), pt.body.split('\n'));
    if (merged == null) return null;
    return _fmStringify(_fmMergeThree(po.fm, pt.fm, pb.fm), merged.join('\n'));
  }
  function _tsMapUnion(a, b) {
    const out = Object.assign({}, a || {});
    for (const k in (b || {})) { if (!(k in out) || String(b[k]) > String(out[k])) out[k] = b[k]; }
    return out;
  }
  /** 全局 JSON 双方变：结构化合并（墓碑并集 / 笔记本并集 / 设置按键三路），合不动返回 null。 */
  function _mergeGlobalJsonText(p, oText, tText, bText) {
    let mo, mt, mb = null;
    try { mo = JSON.parse(oText); mt = JSON.parse(tText); if (bText != null) mb = JSON.parse(bText); } catch (_) { return null; }
    if (!mo || !mt || typeof mo !== 'object' || typeof mt !== 'object') return null;
    try {
      if (p === 'tombstones.json') {
        return JSON.stringify({ v: 1, note: _tsMapUnion(mo.note, mt.note), ws: _tsMapUnion(mo.ws, mt.ws), tpl: _tsMapUnion(mo.tpl, mt.tpl) });
      }
      if (p === 'workspaces.json' && Array.isArray(mo.workspaces) && Array.isArray(mt.workspaces)) {
        const del = _tsMapUnion(mo.wsDeleted, mt.wsDeleted);
        const byId = {};
        for (const w of mt.workspaces) if (w && w.id) byId[w.id] = w;
        for (const w of mo.workspaces) if (w && w.id) byId[w.id] = w;   // 同 id 极罕见，本地优先
        const workspaces = Object.keys(byId).filter(id => !del[id]).map(id => byId[id]);
        return JSON.stringify({ v: 1, workspaces: workspaces, wsDeleted: del });
      }
      if (p === 'settings.json') {
        const merged = Object.assign({}, mo);
        for (const k of Object.keys(mt)) {
          const hasO = Object.prototype.hasOwnProperty.call(mo, k);
          const hasB = !!mb && Object.prototype.hasOwnProperty.call(mb, k);
          if (!hasO) { merged[k] = mt[k]; continue; }                    // 远端新增
          const ov = JSON.stringify(mo[k]), tv = JSON.stringify(mt[k]);
          const bv = hasB ? JSON.stringify(mb[k]) : null;
          const oChg = !hasB || bv !== ov, tChg = !hasB || bv !== tv;
          if (tChg && !oChg) merged[k] = mt[k];                          // 仅远端变
          else if (tChg && oChg && ov === tv) merged[k] = mt[k];         // 两边变得一样
          // 其余（本地变过且与远端不同 / 都没变）→ 保持本地
        }
        return JSON.stringify(merged);
      }
    } catch (_) { return null; }
    return null;
  }

  // ---- 合并冲突按文件决议：单方变取该方；双方变先自动融合，真撞车才本地为准 + 远端留底 conflicts/ ----
  // 留底是「纯本地未跟踪文件」：不进 _exported、不进仓库，_exportAll 不会清它、_commitAll 不会提交它。
  const CONFLICT_DIR = 'conflicts/';
  let _conflictIndex = null;   // 本轮决议的留底索引：orig → Set(hash)，用于去重（防每轮同步堆积）
  function _conflictHash(text) { return hashStr(String(text == null ? '' : text)).slice(-8); }
  async function _loadConflictIndex() {
    const idx = {};
    let names = [];
    try { names = await pfs().readdir(DIR + '/' + CONFLICT_DIR); } catch (_) { return idx; }
    for (const name of names) {
      if (!/\.md$/.test(name) || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0) continue;
      let raw = null;
      try { raw = await wfRead(CONFLICT_DIR + name); } catch (_) { continue; }
      if (!raw) continue;
      const m = /^<!-- zhinote-conflict\s*\n([\s\S]*?)-->/.exec(raw);
      if (!m) continue;
      const pm = /^path:\s*(.+)$/m.exec(m[1]);
      const hm = /^hash:\s*(\S+)/m.exec(m[1]);
      if (!pm || !hm) continue;
      const k = pm[1].trim();
      (idx[k] = idx[k] || new Set()).add(hm[1].trim());
    }
    return idx;
  }
  /** 该路径对应的笔记在本端是否已被删除（回收站或墓碑）→ 决议时不得被远端复活。 */
  function _localDeleted(p) {
    let id = null;
    if (p.indexOf('notes/') === 0 && /\.md$/.test(p)) id = p.slice(6, -3);
    else if (p.indexOf('trash/') === 0 && /\.md$/.test(p)) id = p.slice(6, -3);
    if (!id) return false;
    const tb = _tomb();
    return !!(_trash()[id] || (tb.note || {})[id]);
  }
  /** 存留底（带 orig+hash 去重）。返回是否真的新存了一份。 */
  async function _saveConflict(p, remoteText, ts) {
    const hash = _conflictHash(remoteText);
    const idx = _conflictIndex || {};
    if (idx[p] && idx[p].has(hash)) return false;
    const conflictPath = CONFLICT_DIR + p.replace(/\//g, '-') + '-' + ts + '-' + hash + '.md';
    // 头部注释记录原始路径/时间/内容指纹（供面板展示与去重）；正文是远端那版完整内容
    const header = '<!-- zhinote-conflict\npath: ' + p + '\nsaved: ' + ts + '\nhash: ' + hash + '\n-->\n';
    await wfWriteLocal(conflictPath, header + remoteText);
    (idx[p] = idx[p] || new Set()).add(hash);
    return true;
  }
  async function _resolvePerFileKeepBoth(oursHead, theirsHead, baseHead, silent) {
    const ours = await _treeFiles(oursHead);
    const theirs = await _treeFiles(theirsHead);
    const base = baseHead ? await _treeFiles(baseHead) : {};
    const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    let saved = 0, autoMerged = 0;
    _conflictIndex = await _loadConflictIndex();
    const paths = {};
    for (const p of Object.keys(theirs)) paths[p] = 1;
    for (const p of Object.keys(ours)) paths[p] = 1;
    for (const p of Object.keys(paths)) {
      if (p.indexOf('notes/') !== 0 && p.indexOf('trash/') !== 0 && p.indexOf('images/') !== 0 &&
          p.indexOf('templates/') !== 0 && p !== 'workspaces.json' && p !== 'settings.json' && p !== 'tombstones.json') continue;
      const o = ours[p] != null ? await _readBlobText(oursHead, p) : null;
      const t = theirs[p] != null ? await _readBlobText(theirsHead, p) : null;
      const b = baseHead && base[p] != null ? await _readBlobText(baseHead, p) : null;
      if (o === t) continue;                                   // 两边一致
      if (t === b) continue;                                   // 只有本地变 → 保留本地
      if (o === b || o == null) {
        // 本地不存在且基准里有 = 本地删过 → 不复活，远端版照旧留底可找回
        if (o == null && b != null && _localDeleted(p)) {
          if (await _saveConflict(p, t, ts)) saved++;
          continue;
        }
        await wfWrite(p, t); continue;                         // 只有远端变 / 远端还原 → 取远端
      }
      // 双方都变：笔记文件先试 diff3 自动融合（frontmatter 字段级三路）
      if (o != null && t != null && (p.indexOf('notes/') === 0 || p.indexOf('trash/') === 0)) {
        const mergedText = _autoMergeNoteText(o, t, b);
        if (mergedText != null) { await wfWrite(p, mergedText); autoMerged++; continue; }
      }
      // 全局 JSON 走结构化合并（墓碑/笔记本并集、设置按键三路），不再整文件 keep-both
      if (o != null && t != null && (p === 'tombstones.json' || p === 'workspaces.json' || p === 'settings.json')) {
        const mergedText = _mergeGlobalJsonText(p, o, t, b);
        if (mergedText != null) { await wfWrite(p, mergedText); autoMerged++; continue; }
      }
      // 真撞车：本地为准，远端留底（orig+hash 去重，绝不堆积）
      if (await _saveConflict(p, t, ts)) saved++;
    }
    _conflictIndex = null;
    if (autoMerged) log('合并自动融合 ' + autoMerged + ' 个文件（diff3 / 结构化并集）');
    if (saved) {
      log('合并撞车 ' + saved + ' 个远端版本留底 conflicts/（可在 Git 面板查看）');
      if (!silent) {
        try { window.toast ? window.toast('Git 合并：' + (autoMerged ? autoMerged + ' 处已自动合并，' : '') + saved + ' 处两端都改过，已按本地为准，远端版本留底在 Git 面板「冲突留底」', 'warn', { duration: 10000 }) : null; } catch (_) {}
      }
    }
    return { saved: saved, autoMerged: autoMerged };
  }

  // ---- 同步周期 ----
  // 单轮完整同步：导出→commit→fetch→merge→应用→push。失败直接抛，由 syncCycle 统一处理/重试。
  async function _syncOnceRaw(kind, opts, skipPush, skipMerge) {
    let pushed = false, applied = new Set(), exported = 0;
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

    // ---- push 模式：不合并、不应用远端；推送前先判分叉，绝不 force ----
    if (skipMerge) {
      // push 不带 force（_push 默认），isomorphic-git 遇非快进本就会拒绝；这里只做「提前友好提示」。
      if (remoteNew && localHead && remoteNew !== localHead) {
        try {
          const bases = await git.findMergeBase({ fs: _fs, dir: DIR, oids: [localHead, remoteNew] });
          const base = bases && bases[0];
          // 远端 HEAD 不是本地 HEAD 的祖先 → 远端另有提交 → 提前拒绝，给出可操作的提示
          if (base && base !== remoteNew) {
            throw new Error('远端有本地没有的提交，请先「拉取」合并后再推送（不会强制覆盖远端）');
          }
        } catch (e) {
          if (e && /请先/.test(e.message)) throw e;   // 上面主动抛的中文提示，原样透出
          /* 其余（API 不可用等）交给 _push 的非快进拒绝兜底，catch 里翻译成中文 */
        }
      }
    } else if (remoteNew && remoteNew !== localHead) {
      // 3) 远端有新内容 → 快进 / 干净合并 / 冲突按文件决议（自动融合优先，撞车留底）
      const theirs = 'refs/remotes/origin/' + c.branch;
      const preMergeHead = localHead;   // 合并前的本地 HEAD：应用合并结果的 diff 基准
      let mergeOk = false;
      let actionsBase = remoteOld || preMergeHead;   // 纯远端动作基准：防止把本端自己的增删误判成远端动作
      try {
        await git.merge({ fs: _fs, http: window.gitHttp, dir: DIR, theirs: theirs, fastForwardOnly: true });
        mergeOk = true;
        actionsBase = preMergeHead;    // 快进：合并前 HEAD → 远端 HEAD 全是远端动作
      } catch (e1) {
        let clean = false;
        if (remoteOld && localHead !== remoteOld) {
          // 真分叉：先试干净合并（不同文件互不干扰时 isogit 能合出来）
          try {
            await git.merge({ fs: _fs, http: window.gitHttp, dir: DIR, theirs: theirs, message: 'zhinote: 合并远端变更', author: author() });
            clean = true;
          } catch (e2) { /* 冲突 / 本地含新增文件时 isogit 直接 MergeNotSupportedError → 走文件级决议 */ }
        }
        if (!clean) {
          // 文件级三路决议。基准优先用真 merge base（比"上次 fetch 的远端 ref"更准）
          let baseOid = remoteOld;
          try { const mb = await git.findMergeBase({ fs: _fs, dir: DIR, oids: [localHead, remoteNew] }); if (mb && mb[0]) baseOid = mb[0]; } catch (_) {}
          await _resolvePerFileKeepBoth(localHead, remoteNew, baseOid, opts.silent);
          // 关键：决议后补双亲 merge commit 推进 HEAD。不补的话 push 永久非快进失败、
          // 每轮同步重跑决议 → conflicts/ 成倍堆积（v2.2.x「一冲突就卡死」的根因）。
          await _commitAll('zhinote: 合并远端变更（冲突已按文件决议，撞车处以本地为准，远端留底 conflicts/）', [localHead, remoteNew]);
          localHead = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' });
        }
        mergeOk = true;
      }
      if (mergeOk) {
        // isogit 的 merge（快进/干净合并）只前进 ref、不落工作区 → 必须强制检出，
        // 否则 _applyRemote 读工作区拿到旧内容，"下载"静默失效（v2.2.x 隐藏 bug）。untracked 的 conflicts/ 不受检出影响。
        try { await git.checkout({ fs: _fs, dir: DIR, ref: c.branch, force: true }); } catch (e) { log('合并后检出失败：' + (e && e.message)); }
      }
      pushed = true;
      // 4) 应用合并结果（内容跟随合并后的 HEAD；「远端删了什么」用纯远端动作基准单独判定）。
      //    合并发生过就必须应用——哪怕本轮没有新 fetch（上次周期 fetch 后中断，remoteOld===remoteNew），否则下载静默丢失。
      const resultOid = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' }).catch(function () { return null; }) || remoteNew;
      applied = await _applyRemote(preMergeHead, resultOid, actionsBase);
    }

    // 5) 推送（完整同步 / push 模式）；pull 模式跳过
    let doPush = false;
    if (!skipPush) doPush = pushed || (skipMerge && !!localHead);
    if (doPush) await _push();
    _saveExported();

    const detail = skipMerge ? 'push' : (skipPush ? 'pull' : (kind === 'put' ? 'put' : 'get'));
    emitOk(detail, { uploaded: exported, downloadedNoteIds: applied }, opts.silent);
    try { if (_bc && kind !== 'wake') _bc.postMessage('synced'); } catch (_) {}
    _hasRemoteNotes = true;
    return {
      ok: true, mode: skipMerge ? 'push' : (skipPush ? 'pull' : 'sync'),
      pushed: doPush, uploaded: exported, downloaded: applied.size,
      nothingToPush: !!(skipMerge && !pushed && remoteNew === localHead),
    };
  }

  const NON_FF_RE = /reject|non-fast-forward|fetch first|not a fast|not a simple fast|fetch.*first|failed to push|cannot push/i;
  const NON_FF_MSG = '远端刚有了新提交，和本地撞车了：点一下「拉取」合并后再推就好（不会强制覆盖远端，也不丢任何一边的笔记）';

  async function syncCycle(kind, opts) {
    opts = opts || {};
    const skipPush = !!opts.skipPush;   // pull：只拉不推
    const skipMerge = !!opts.skipMerge; // push：只推不拉
    if (_syncing) { schedulePut('busy-reschedule'); return { ok: false, skipped: true }; }
    if (!_lock()) { log('他标签正在同步，跳过本轮'); return { ok: false, skipped: true }; }
    _syncing = true; _uiBusy++;
    emitStart(kind, opts.silent);
    // 竞态自愈：完整同步（既拉又推）撞「非快进」时，说明 fetch 后、push 前另一台设备抢先推了一笔。
    // 静默重跑一轮 fetch+merge+push 即可自愈；只重试一次，且推送/拉取单按钮不参与，避免死循环。
    const canRetry = !skipMerge && !skipPush;
    try {
      let lastErr = null;
      for (let attempt = 0, max = canRetry ? 2 : 1; attempt < max; attempt++) {
        try {
          return await _syncOnceRaw(kind, opts, skipPush, skipMerge);
        } catch (e) {
          lastErr = e;
          const m = String((e && (e.message || e.code)) || e);
          if (canRetry && attempt === 0 && NON_FF_RE.test(m)) {
            log('推送撞非快进（竞态），自动重跑一轮 fetch+merge+push');
            continue;
          }
          throw e;
        }
      }
      throw lastErr;
    } catch (e) {
      log('同步失败：' + (e && (e.stack || e.message || e.code) || e));
      // 非快进统一翻成中文（自动同步 / 立即同步 / 推送所有路径都覆盖），明说「点一下拉取就好」
      const m = String((e && (e.message || e.code)) || e);
      const err = NON_FF_RE.test(m) ? new Error(NON_FF_MSG) : e;
      emitFail(err, opts.silent);
      return { ok: false, error: String((err && err.message) || err) };
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
  async function manualSync() { return await syncCycle('manual'); }
  function isSyncing() { return _syncing; }
  function isUiSyncing() { return _uiBusy > 0 || _syncing; }
  async function testConnection(over) {
    const c = Object.assign(cfg(), over || {});
    if (!c.url) throw new Error('还没填仓库地址');
    // 密码框不回填（只存本机），表单留空时回退用已保存的密码，否则测试连接会拿空密码去撞 401
    if (!c.pass) c.pass = String(gs(K.pass, ''));
    const fs2 = _fs || (window.LightningFS ? new window.LightningFS(FS_NAME) : null);
    const auth = (c.user || c.pass) ? { username: c.user || 'anonymous', password: c.pass } : undefined;
    // 单独给「测试连接」设超时：后端卡死时不能让按钮永远转圈（信号由 isogit-http 透传给 fetch）
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 15000) : null;
    const http = ctrl ? { request: function (o) { return window.gitHttp.request(Object.assign({}, o, { signal: ctrl.signal })); } } : window.gitHttp;
    try {
      const info = await git.getRemoteInfo({ fs: fs2, http: http, dir: DIR, url: c.url, onAuth: () => auth });
      const heads = (info.refs && info.refs.heads) || {};
      return { ok: true, branches: Object.keys(heads), hasBranch: !!heads[c.branch] };
    } catch (e) {
      if (ctrl && ctrl.signal.aborted) throw new Error('服务器 15 秒内无响应，Git 服务可能卡住，请稍后重试');
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  // ---- 阶段3：Git 侧面板（独立 pull / push + 状态 + 提交记录）----
  // 面板读取一律走「本地已有仓库」，绝不主动 clone / 联网；只有 pull / push 才触网。
  async function _localReady() {
    if (!_fs) { try { _fs = new window.LightningFS(FS_NAME); } catch (_) { return false; } }
    try { return !!(await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' })); } catch (_) { return false; }
  }
  async function _countSince(ref, stopOid) {
    if (!ref || ref === stopOid) return 0;
    let arr = [];
    try { arr = await git.log({ fs: _fs, dir: DIR, ref: ref, depth: 200 }); } catch (_) { return 0; }
    let n = 0;
    for (const x of arr) { if (x.oid === stopOid) return n; n++; }
    return n;  // 触到 depth 上限，返回已知下界
  }

  /** 只拉：把远端改动取回并合并进本地（pull 前先 commit 本地改动保住，不推送）。 */
  async function pull(opts) {
    return await syncCycle('manual', Object.assign({ skipPush: true, silent: true }, opts || {}));
  }
  /** 只推：把本地改动 commit 后推送（先 fetch 判分叉，分叉则拒绝，绝不 force；不合并、不改本地笔记）。 */
  async function push(opts) {
    return await syncCycle('manual', Object.assign({ skipMerge: true, silent: true }, opts || {}));
  }

  /** 面板状态：分支 / HEAD / 领先落后 / 上次同步 / 待同步改动。不联网。 */
  async function getStatus() {
    const c = cfg();
    const out = {
      configured: !!c.url, url: c.url, branch: c.branch,
      author: c.an + ' <' + c.ae + '>',
      state: _state, error: _lastError, syncing: _syncing,
      lastSync: _lastSyncTime, repoReady: false,
      head: null, remote: null, ahead: 0, behind: 0, dirtyNotes: 0,
    };
    try { out.dirtyNotes = (S().getDirtyNoteIds && S().getDirtyNoteIds() || []).length; } catch (_) {}
    if (!c.url || !(await _localReady())) return out;
    out.repoReady = true;
    try { out.head = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'HEAD' }); } catch (_) {}
    try { out.remote = await git.resolveRef({ fs: _fs, dir: DIR, ref: 'refs/remotes/origin/' + c.branch }); } catch (_) {}
    if (out.head && out.remote) {
      if (out.head !== out.remote) {
        try {
          const bases = await git.findMergeBase({ fs: _fs, dir: DIR, oids: [out.head, out.remote] });
          const base = bases && bases[0];
          if (base) { out.ahead = await _countSince(out.head, base); out.behind = await _countSince(out.remote, base); }
        } catch (_) {}
      }
    } else if (out.head) {
      // 从没 fetch 过：本地提交都算待推送
      try { out.ahead = (await git.log({ fs: _fs, dir: DIR, depth: 200 })).length; } catch (_) {}
    }
    return out;
  }

  /** 整仓提交时间线（不带 filepath = 全部提交，不只是单篇笔记）。 */
  async function listCommits(opts) {
    opts = opts || {};
    if (!(await _localReady())) return [];
    const depth = Math.max(1, Math.min(200, opts.depth || 40));
    let arr = [];
    try { arr = await git.log({ fs: _fs, dir: DIR, depth: depth }); } catch (_) { return []; }
    return arr.map(function (x) {
      return {
        oid: x.oid,
        date: x.commit.author.timestamp * 1000,
        message: (x.commit.message || '').trim(),
        author: (x.commit.author && x.commit.author.name) || '',
        parent: (x.commit.parent && x.commit.parent[0]) || null,
      };
    });
  }

  /** 某次提交改了哪些文件（相对父提交）；用于面板点开一条记录看详情。 */
  async function commitDetail(oid) {
    if (!(await _localReady())) return { changed: [], removed: [] };
    try {
      const commit = await git.readCommit({ fs: _fs, dir: DIR, oid: oid });
      const parent = (commit.commit.parent && commit.commit.parent[0]) || null;
      const d = await _diffTrees(parent, oid);
      return { changed: Object.keys(d.changed).sort(), removed: Object.keys(d.removed).sort() };
    } catch (_) { return { changed: [], removed: [] }; }
  }

  // ---- 阶段4：冲突留底（列出 / 预览 / 用远端版覆盖本地 / 忽略）----
  // 留底是「纯本地未跟踪文件」：不进 _exported、不进仓库，_exportAll 不会清它、_commitAll 不会提交它。
  // （CONFLICT_DIR 常量与去重索引在上方合并决议段声明）
  function _conflictSafePath(p) {
    return typeof p === 'string' && /^conflicts\/[^/]+\.md$/.test(p);
  }
  function _parseConflict(raw) {
    let body = raw, orig = '', saved = '';
    const m = /^<!-- zhinote-conflict\s*\n([\s\S]*?)-->\n/.exec(raw);
    if (m) {
      const kv = m[1];
      const p = /^path:\s*(.+)$/m.exec(kv); if (p) orig = p[1].trim();
      const s = /^saved:\s*(.+)$/m.exec(kv); if (s) saved = s[1].trim();
      body = raw.slice(m[0].length);
    }
    const parsed = _fmParse(body);
    return {
      orig: orig, saved: saved, raw: body,
      fm: parsed ? parsed.fm : {},
      body: parsed ? parsed.body : body,
      title: parsed ? String(parsed.fm.title || '') : '',
      id: parsed ? String(parsed.fm.id || '') : '',
      parseable: !!parsed,
    };
  }
  /** 列出全部冲突留底（本地读取，不联网）。 */
  async function listConflicts() {
    if (!(await _localReady())) return [];
    let names = [];
    try { names = await pfs().readdir(DIR + '/' + CONFLICT_DIR); } catch (_) { return []; }
    const out = [];
    for (const name of names) {
      if (name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || name.indexOf('..') >= 0 || !/\.md$/.test(name)) continue;
      let raw;
      try { raw = await wfRead(CONFLICT_DIR + name); } catch (_) { continue; }
      if (raw == null) continue;
      const c = _parseConflict(raw);
      let orig = c.orig;
      if (!orig) { // 兼容无头部注释的旧留底：从文件名粗还原
        const mm = /^(.+)-\d{4}-\d{2}-\d{2}T?[\d-]*\.md$/.exec(name);
        orig = mm ? mm[1].replace(/-/g, '/') : name;
      }
      out.push({
        path: CONFLICT_DIR + name, name: name, orig: orig,
        saved: c.saved || name, title: c.title || c.id || orig,
        id: c.id, parseable: c.parseable,
        preview: c.body.slice(0, 240), size: c.raw.length,
        canApply: /^notes\//.test(orig) && c.parseable,
      });
    }
    out.sort((a, b) => String(b.saved).localeCompare(String(a.saved)));
    return out;
  }
  /** 读单条留底详情（供预览）。 */
  async function readConflict(path) {
    if (!_conflictSafePath(path)) throw new Error('非法的留底路径');
    if (!(await _localReady())) throw new Error('本地仓库还没就绪');
    const raw = await wfRead(path);
    if (raw == null) throw new Error('留底文件不存在或已被处理');
    const c = _parseConflict(raw);
    return {
      path: path, orig: c.orig, saved: c.saved, title: c.title,
      id: c.id, fm: c.fm, body: c.body, raw: c.raw, parseable: c.parseable,
    };
  }
  async function _dropConflict(path) {
    try { await pfs().unlink(DIR + '/' + path); } catch (_) {}
  }
  /** 用远端留底这版恢复笔记。opts.mode='replace'（默认）整篇覆盖；
   *  'body' 仅取标题+正文，位置/置顶/颜色等结构字段保留本地。标脏，下轮同步把结果推上去。 */
  async function applyConflict(path, opts) {
    const mode = (opts && opts.mode) || 'replace';
    const v = await readConflict(path);
    if (!/^notes\//.test(v.orig) || !v.parseable) {
      throw new Error('这份留底不是可覆盖的笔记内容，请在预览里手动复制正文');
    }
    const id = v.id || v.orig.slice(6, -3);
    const fm = v.fm;
    const doc = (window.editor && window.editor.parseMdToDoc) ? window.editor.parseMdToDoc(v.body) : null;
    const noteData = {
      id: id, title: String(fm.title || '无标题'),
      parentId: fm.parent || null, workspaceId: fm.workspace || undefined,
      frac: fm.order || undefined, order: 0,
      pinnedAt: fm.pinned || null, color: fm.color || null, icon: fm.icon || null,
      expanded: fm.expanded === '1', createdAt: fm.created || undefined,
      updatedAt: fm.updated || undefined, doc: doc, content: v.body,
    };
    if (mode === 'body') {
      const local = _notes()[id] || _trash()[id];
      if (local) {
        noteData.parentId = local.parentId || null;
        noteData.workspaceId = local.workspaceId || undefined;
        noteData.frac = local.frac || undefined;
        noteData.pinnedAt = local.pinnedAt || null;
        noteData.color = local.color || null;
        noteData.icon = local.icon || null;
        noteData.expanded = !!local.expanded;
        noteData.createdAt = local.createdAt || noteData.createdAt;
      }
    }
    const Sx = S();
    if (_trash()[id] && Sx.restoreFromTrash) Sx.restoreFromTrash(id);
    Sx._webdavApplyNote(id, noteData, { keepLedger: false });
    Sx._gitApplyGlobal({});  // 收尾：结构自愈 + 存盘 + 全树刷新
    if (Sx.markNotesDirtyByIds) Sx.markNotesDirtyByIds([id]);
    else if (Sx.markDirty) Sx.markDirty('git-conflict-apply');
    await _dropConflict(path);
    schedulePut('conflict-apply');
    return { id: id, title: noteData.title };
  }
  /** 忽略：删掉这条留底。 */
  async function ignoreConflict(path) {
    if (!_conflictSafePath(path)) throw new Error('非法的留底路径');
    if (!(await _localReady())) throw new Error('本地仓库还没就绪');
    await _dropConflict(path);
    return { ok: true };
  }

  window.gitSync = {
    loadConfig: loadConfig, startAutoSync: startAutoSync, stop: stop,
    schedulePut: schedulePut, flushPutOnHide: flushPutOnHide,
    manualSync: manualSync, testConnection: testConnection,
    isSyncing: isSyncing, isUiSyncing: isUiSyncing,
    getState: function () { return { state: _state, lastSync: _lastSyncTime, error: _lastError }; },
    listNoteHistory: listNoteHistory, readNoteVersion: readNoteVersion, restoreNoteVersion: restoreNoteVersion,
    pull: pull, push: push, getStatus: getStatus,
    listCommits: listCommits, commitDetail: commitDetail,
    listConflicts: listConflicts, readConflict: readConflict,
    applyConflict: applyConflict, ignoreConflict: ignoreConflict,
    alignHunks: _alignHunks,   // 行级 LCS 区段，供预览双栏差异高亮复用
  };
})();
