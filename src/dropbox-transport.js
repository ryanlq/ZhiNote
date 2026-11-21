/* dropbox-transport.js — 把 Dropbox 变成 webdav-sync 的传输层。
 * ─────────────────────────────────────────────────────────────────
 * 定位：与 WebDAV/Git 并列的第三种云端（syncMethod === 'dropbox'）。
 * 做法：webdav-sync 的 HTTP 唯一收口点 _fetchWithTimeout 在 dropbox 模式下改走
 *   本模块的 webdavBridge(url, options)——把 WebDAV 动词翻译成 Dropbox API 调用，
 *   同步内核（manifest CAS / struct-ledger / 冲突仲裁 / 加密）零改动。
 *
 * 语义映射：
 *   GET   → files/download            （ETag 响应头 = rev，供 CAS 比对）
 *   PUT   → files/upload（overwrite；带 If-Match 时 update:rev，409 冲突 → 412 响应）
 *   DELETE→ files/delete_v2           （不存在 → 404，无害）
 *   MKCOL → 201（Dropbox 上传自动建父目录，无需实现）
 *   PROPFIND → files/list_folder（Depth 0/1）→ 生成 multistatus XML，
 *              webdav-sync 自带解析器读 href/getcontentlength/getlastmodified
 *
 * 体验增强：files/list_folder/longpoll_delta 后台长轮询——远端一变（秒级）就触发
 *   webdav-sync 拉取，替代 WebDAV 的 10~30s 轮询。
 *
 * 授权：OAuth2 PKCE（无需 client_secret）+ refresh_token 常驻；token 刷新与 API
 *   调用都可经「跨域代理」转发（大陆网络直连 Dropbox API 不可达时用）；授权弹窗页
 *   需要能访问 www.dropbox.com（仅授权那一刻）。
 *
 * 隐私：与 WebDAV 相同——笔记本体 AES 加密后才落 Dropbox，服务器只见密文；
 *   建议创建应用时选择 App folder 权限（Dropbox 自动隔离出独立应用目录）。
 */
(function () {
  'use strict';

  var API = 'https://api.dropboxapi.com/2';
  var CONTENT = 'https://content.dropboxapi.com/2';
  var AUTHZ = 'https://www.dropbox.com/oauth2/authorize';
  var TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
  var CALLBACK_PATH = '/dropbox-oauth';                  // 需在 Dropbox App 后台登记的重定向地址（CF 会剥掉 .html，故用无扩展名形式）
  var FALLBACK_ORIGIN = 'https://zhinote.shumu.de5.net'; // file:// 等无源宿主时用官方回调

  var LS_KEY = 'zhinote-dropbox-auth';
  var _cfg = { appKey: '', proxy: '', onChange: null };  // onChange(有远端变更) 由 webdav-sync 注入
  var _auth = null;                                      // { access_token, refresh_token, expires_at }
  var _refreshing = null;                                // 刷新单飞
  var _revCache = new Map();                             // path_lower → rev（GET 的 ETag / If-Match 用）
  var _cursor = null;
  var _pollStop = false;
  var _verifier = null;                                  // PKCE 进行中的 verifier

  // ── 基础 ──
  function _lsLoad() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) { const o = JSON.parse(raw); if (o && o.refresh_token) _auth = o; }
    } catch (_) {}
  }
  function _lsSave() { try { localStorage.setItem(LS_KEY, JSON.stringify(_auth)); } catch (_) {} }
  function _lsClear() { _auth = null; try { localStorage.removeItem(LS_KEY); } catch (_) {} }
  _lsLoad();

  function _proxied(url) {
    return _cfg.proxy ? String(_cfg.proxy).replace(/\/+$/, '') + '/' + url : url;
  }
  function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function _readSetting(key, dft) {
    try { const v = window.storage && window.storage.getSetting(key); return (v == null ? dft : v); } catch (_) { return dft; }
  }

  // ── token：单飞刷新，401 自动续一次 ──
  function _rawToken(body) {
    // token 端点也走代理（api.dropboxapi.com 大陆直连不可达）
    return fetch(_proxied(TOKEN_URL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }).then(async function (r) {
      const j = await r.json().catch(function () { return {}; });
      if (!r.ok) { const e = new Error(j.error_description || j.error || ('token ' + r.status)); e.authFail = true; throw e; }
      return j;
    });
  }
  function _persist(j) {
    _auth = {
      access_token: j.access_token,
      refresh_token: j.refresh_token || (_auth && _auth.refresh_token) || '',
      expires_at: Date.now() + ((j.expires_in || 14400) - 300) * 1000,
      account_id: j.account_id || '',
    };
    _lsSave();
    try { window.dispatchEvent(new CustomEvent('dropbox-auth-ok')); } catch (_) {}
  }
  function ensureToken() {
    if (_auth && _auth.access_token && Date.now() < (_auth.expires_at || 0)) return Promise.resolve(_auth.access_token);
    if (!_auth || !_auth.refresh_token) {
      const e = new Error('Dropbox 未授权'); e.status = 401; e.authFail = true; return Promise.reject(e);
    }
    if (_refreshing) return _refreshing;
    _refreshing = _rawToken({
      grant_type: 'refresh_token', refresh_token: _auth.refresh_token, client_id: _cfg.appKey,
    }).then(function (j) { _persist(j); _refreshing = null; return _auth.access_token; })
      .catch(function (e) { _refreshing = null; _lsClear(); e.status = 401; throw e; });
    return _refreshing;
  }
  function _authedFetch(url, options, retry) {
    return ensureToken().then(function (t) {
      const o = Object.assign({}, options);
      o.headers = Object.assign({}, o.headers || {}, { 'Authorization': 'Bearer ' + t });
      return fetch(_proxied(url), o).then(function (resp) {
        if (resp.status === 401 && !retry) {
          // access_token 过期（比如换机恢复）→ 强刷一次再试
          _auth.expires_at = 0;
          return ensureToken().then(function () { return _authedFetch(url, options, true); });
        }
        return resp;
      });
    });
  }

  // ── Dropbox API 封装 ──
  function _rpc(endpoint, params) {
    return _authedFetch(API + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
    }).then(async function (r) {
      const j = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        const err = new Error(j.error_summary || ('dropbox ' + r.status));
        err.status = r.status; err.tag = (j.error && j.error['.tag']) || (j.error && j.error.path && j.error.path['.tag']) || '';
        throw err;
      }
      return j;
    });
  }
  function _contentDownload(dbxPath) {
    return _authedFetch(CONTENT + '/files/download', {
      method: 'POST',
      headers: { 'Dropbox-API-Arg': JSON.stringify({ path: dbxPath }) },
    });
  }
  function _contentUpload(dbxPath, body, rev) {
    const mode = rev ? { '.tag': 'update', update: rev } : { '.tag': 'overwrite' };
    return _authedFetch(CONTENT + '/files/upload', {
      method: 'POST',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path: dbxPath, mode: mode, autorename: false, mute: true }),
        'Content-Type': 'application/octet-stream',
      },
      body: body,
    });
  }

  // ── 路径工具 ──
  function _pathFromUrl(url) {
    try { return decodeURIComponent(new URL(url).pathname) || '/'; } catch (_) { return '/'; }
  }
  function _norm(p) { return String(p || '').toLowerCase(); }

  // ── 响应工厂 ──
  function _resp(status, body, headers) {
    const h = Object.assign({}, headers || {});
    return new Response(body == null ? null : body, { status: status, headers: h });
  }
  function _xmlHeaders() { return { 'Content-Type': 'application/xml; charset=utf-8' }; }
  function _propfindXml(dbxDir, selfEntry, entries) {
    let out = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">';
    const one = function (href, size, mtime, isDir) {
      // 目录 href 以 / 结尾（真实 WebDAV 惯例）：webdav-sync 的消费者据此跳过目录，只认文件
      const h = href.replace(/&/g, '&amp;') + (isDir ? '/' : '');
      out += '<d:response><d:href>' + h + '</d:href><d:propstat><d:prop>'
        + '<d:getcontentlength>' + (size || 0) + '</d:getcontentlength>'
        + '<d:getlastmodified>' + (mtime || '') + '</d:getlastmodified>'
        + '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
    };
    if (selfEntry) one(dbxDir, selfEntry.size || 0, selfEntry.server_modified || '', true);
    else one(dbxDir, 0, '', true);
    (entries || []).forEach(function (e) {
      const isDir = e['.tag'] === 'folder';
      one(e.path_lower || '', isDir ? 0 : (e.size || 0), e.server_modified || '', isDir);
    });
    return out + '</d:multistatus>';
  }
  async function _meta(dbxPath) {
    try {
      return await _rpc('/files/get_metadata', { path: dbxPath, include_deleted: false });
    } catch (e) {
      if (e.status === 409) return null;   // path/not_found
      throw e;
    }
  }

  // ── 各动词处理 ──
  async function _hGet(p) {
    const r = await _contentDownload(p);
    if (!r.ok) {
      // 409 path/not_found → 404；401/429 保留原状态给 webdav-sync 的分支处理
      return _resp(r.status === 409 ? 404 : r.status, await r.text().catch(function () { return ''; }));
    }
    const buf = await r.arrayBuffer();
    const rev = _revCache.get(_norm(p));
    return _resp(200, buf, rev ? { 'ETag': '"' + rev + '"' } : {});
  }
  async function _hPut(p, options) {
    const ifMatch = (options.headers && options.headers['If-Match']) || '';
    const rev = String(ifMatch).replace(/"/g, '') || '';
    const r = await _contentUpload(p, options.body, rev);
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      // update:rev 未命中 = 别的设备抢先写过 → 412（webdav-sync 据此重合并重试）
      if (r.status === 409 && rev) return _resp(412, j.error_summary || 'conflict');
      if (r.status === 409) return _resp(409, j.error_summary || 'conflict');
      return _resp(r.status, j.error_summary || '');
    }
    if (j.rev) _revCache.set(_norm(p), j.rev);
    return _resp(200, JSON.stringify(j), { 'ETag': '"' + (j.rev || '') + '"' });
  }
  async function _hDelete(p) {
    try {
      await _rpc('/files/delete_v2', { path: p });
      return _resp(204, null);
    } catch (e) {
      if (e.status === 409) return _resp(204, null);   // 本来就不存在 = 已达目的
      return _resp(e.status || 500, e.message || '');
    }
  }
  async function _hPropfind(p, options) {
    const depth = String((options.headers && options.headers.Depth) || '1');
    if (depth === '0') {
      const m = await _meta(p);
      if (!m) return _resp(404, 'not found');
      return _resp(207, _propfindXml(p, m, []), _xmlHeaders());
    }
    try {
      const l = await _rpc('/files/list_folder', { path: p, recursive: false, include_deleted: false, limit: 500 });
      let entries = l.entries || [];
      let cursor = l.cursor, more = !!l.has_more;
      while (more) {
        const pg = await _rpc('/files/list_folder/continue', { cursor: cursor });
        entries = entries.concat(pg.entries || []);
        cursor = pg.cursor; more = !!pg.has_more;
      }
      entries.forEach(function (e) { if (e['.tag'] === 'file' && e.rev) _revCache.set(_norm(e.path_lower), e.rev); });
      return _resp(207, _propfindXml(p, null, entries), _xmlHeaders());
    } catch (e) {
      if (e.status === 409) return _resp(404, 'not found');   // 目录不存在
      return _resp(e.status || 500, e.message || '');
    }
  }

  /** webdav-sync 的传输入口：WebDAV 请求 → Dropbox API。 */
  async function webdavBridge(url, options) {
    const method = String((options && options.method) || 'GET').toUpperCase();
    const p = _pathFromUrl(url);
    try {
      if (!navigator.onLine) {
        const e = new Error('offline'); e.transient = true; throw e;
      }
      if (method === 'GET') return await _hGet(p);
      if (method === 'PUT') return await _hPut(p, options);
      if (method === 'DELETE') return await _hDelete(p);
      if (method === 'MKCOL') return _resp(201, null);   // 上传自动建父目录
      if (method === 'PROPFIND') return await _hPropfind(p, options);
      return _resp(405, 'method not supported');
    } catch (e) {
      if (e && e.transient) throw e;                      // 网络层失败：交 webdav-sync 瞬时重试
      const st = (e && e.status) || 502;
      return _resp(st === 429 ? 429 : st, String((e && e.message) || 'dropbox error'));
    }
  }

  // ── OAuth2 PKCE ──
  function _b64url(bytes) {
    let s = '';
    new Uint8Array(bytes).forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function _redirectUri() {
    // 统一用官方回调页（已登记、支持无扩展名直出，postMessage 跨源回传）：
    // 授权弹窗本来就需能访问 www.dropbox.com，回调页同域无额外负担；
    // 自建 App 的用户在 App 后台登记同一条 URI 即可。
    return FALLBACK_ORIGIN + CALLBACK_PATH;
  }
  function authorize() {
    if (!_cfg.appKey) { const e = new Error('请先填写 Dropbox App Key'); e.authFail = true; throw e; }
    // 格式预检：App Key 是 App Console「Settings」页顶部的短字符串（约 15 位字母数字）；
    // sl.u. 开头的长串是「Generated access token」（临时令牌），不是 App Key——填了会被 Dropbox 拒绝 Invalid client_id
    if (_cfg.appKey.length > 32 || /[.:@/]/.test(_cfg.appKey) || /^sl\./i.test(_cfg.appKey)) {
      const e = new Error('这看起来不是 App Key（像是 access token）：请回 Dropbox App Console → Settings 页顶部，复制那个约 15 位的 App Key');
      e.authFail = true; throw e;
    }
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    _verifier = _b64url(raw);
    try { sessionStorage.setItem('zhinote-dbx-verifier', _verifier); } catch (_) {}
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(_verifier)).then(function (h) {
      const url = AUTHZ + '?client_id=' + encodeURIComponent(_cfg.appKey)
        + '&response_type=code&token_access_type=offline'
        + '&code_challenge=' + _b64url(h) + '&code_challenge_method=S256'
        + '&redirect_uri=' + encodeURIComponent(_redirectUri());
      window.open(url, 'zhinote-dropbox-auth', 'width=560,height=680');
    });
  }
  /** 收到 code（弹窗 postMessage 或手动粘贴）→ 换 token。 */
  function exchangeCode(code) {
    const v = _verifier || (function () { try { return sessionStorage.getItem('zhinote-dbx-verifier'); } catch (_) { return null; } })();
    if (!v) { const e = new Error('授权会话过期，请重新连接'); e.authFail = true; return Promise.reject(e); }
    return _rawToken({
      grant_type: 'authorization_code', code: code, redirect_uri: _redirectUri(),
      client_id: _cfg.appKey, code_verifier: v,
    }).then(function (j) {
      _persist(j);
      try { sessionStorage.removeItem('zhinote-dbx-verifier'); } catch (_) {}
      return _auth;
    });
  }
  function disconnect() {
    _lsClear(); _revCache.clear(); _cursor = null; stopDeltaLoop();
  }
  function isConnected() { return !!(_auth && _auth.refresh_token); }
  function authAccountId() { return (_auth && _auth.account_id) || ''; }

  // 跨窗消息：官方回调页 dropbox-oauth.html 读取 ?code= 后 postMessage 回来
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.type !== 'dropbox-code' || !ev.data.code) return;
    exchangeCode(ev.data.code).then(function () {
      try { ev.source && ev.source.close(); } catch (_) {}
      try { window.dispatchEvent(new CustomEvent('dropbox-auth-ok')); } catch (_) {}
    }).catch(function (e) {
      try { window.dispatchEvent(new CustomEvent('dropbox-auth-fail', { detail: String(e && e.message || e) })); } catch (_) {}
    });
  });

  // ── longpoll 增量循环：远端一变就触发 onChange（替代 10~30s 轮询）──
  function startDeltaLoop() {
    stopDeltaLoop();
    _pollStop = false;
    let lastPollAt = 0;
    (async function () {
      try {
        const l = await _rpc('/files/list_folder', { path: '', recursive: true, include_deleted: false, limit: 500 });
        (l.entries || []).forEach(function (e) { if (e['.tag'] === 'file' && e.rev) _revCache.set(_norm(e.path_lower), e.rev); });
        const lc = await _rpc('/files/list_folder/get_latest_cursor', { path: '' });
        _cursor = lc.cursor;
      } catch (e) { _pollStop = true; return; }
      while (!_pollStop) {
        // longpoll 服务端最多挂 30s，但偶发会立即返回（无变更/限流降级）：
        // 强制最小间隔，绝不紧循环打 API
        const gap = 2000 - (Date.now() - lastPollAt);
        if (gap > 0) await _sleep(gap);
        if (_pollStop) break;
        lastPollAt = Date.now();
        try {
          const lp = await _rpc('/files/list_folder/longpoll_delta', { cursor: _cursor, timeout: 30 });
          if (!_pollStop) _cursor = lp.cursor;
          if (!lp.changes) continue;
          let changed = false;
          let more = true;
          while (more && !_pollStop) {
            const pg = await _rpc('/files/list_folder/continue', { cursor: _cursor });
            _cursor = pg.cursor; more = !!pg.has_more;
            (pg.entries || []).forEach(function (en) {
              if (en['.tag'] === 'file' && en.rev) _revCache.set(_norm(en.path_lower), en.rev);
              changed = true;   // 删除/新增也算变化，一律触发拉取（webdav-sync 自会跳过空转）
            });
          }
          if (changed && !_pollStop && typeof _cfg.onChange === 'function') {
            try { _cfg.onChange(); } catch (_) {}
          }
        } catch (e) {
          // cursor 失效（目录被重建等）→ 重新建 cursor；其余瞬态错误退避后重试
          try {
            const lc = await _rpc('/files/list_folder/get_latest_cursor', { path: '' });
            _cursor = lc.cursor;
          } catch (_) {}
          await _sleep(15000);
        }
      }
    })();
  }
  function stopDeltaLoop() { _pollStop = true; }

  function configure(opts) {
    opts = opts || {};
    if ('appKey' in opts) _cfg.appKey = String(opts.appKey || '').trim();
    if ('proxy' in opts) _cfg.proxy = String(opts.proxy || '').trim();
    if ('onChange' in opts) _cfg.onChange = opts.onChange || null;
  }

  window.dropboxTransport = {
    configure: configure,
    webdavBridge: webdavBridge,
    authorize: authorize,
    exchangeCode: exchangeCode,
    disconnect: disconnect,
    isConnected: isConnected,
    authAccountId: authAccountId,
    ensureToken: ensureToken,
    startDeltaLoop: startDeltaLoop,
    stopDeltaLoop: stopDeltaLoop,
  };
})();
