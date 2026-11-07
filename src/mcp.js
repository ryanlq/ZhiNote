/* 小枝 MCP 客户端 —— 仅远程形态（Streamable HTTP），把远程 MCP 服务器的工具并入 agent 的工具注册表。
 * 协议：JSON-RPC 2.0 over HTTP POST。方法：initialize / notifications/initialized / tools/list / tools/call。
 * 不引 SDK（零依赖约定），只手写这三个方法需要的最小子集。
 *
 * 跨域：浏览器直连多数 MCP 服务器会被 CORS 挡。mode='proxy' 时复用 AI/WebDAV 的跨域代理约定
 * （代理地址 + '/' + 完整目标 URL，与 ai.js requestUrl 相同）；mode='direct' 真直连（服务器自己放行跨域时用）。
 *
 * 安全约定：
 *  - 服务器清单（aiMcpServers）随设置云同步；Bearer token（_aiMcpTokens）与会话 ID（_aiMcpSess）带 _
 *    前缀只存本机，绝不上云。
 *  - 远程工具一律视为非只读：执行前必须经 agent 循环的确认卡（readOnlyHint 为 true 的才自动执行）。
 *  - 官方中转 worker 未升级前，会话型服务器（需要 Mcp-Session-Id 头）在代理模式下会失败——
 *    设置 UI 的测试按钮会把这类错误如实显示，提示改用直连。
 */
(function () {
  'use strict';

  var PROTOCOL_VERSION = '2025-03-26';
  var SERVERS_KEY = 'aiMcpServers';   // 随云同步
  var TOKENS_KEY = '_aiMcpTokens';    // 本机：{ serverId: bearerToken }
  var SESS_KEY = '_aiMcpSess';        // 本机：{ serverId: mcp-session-id }

  function gs(k, d) { try { var v = window.storage && window.storage.getSetting(k); return (v == null || v === '') ? d : v; } catch (_) { return d; } }
  function ss(k, v) { try { window.storage && window.storage.setSetting(k, v); } catch (_) {} }
  function _json(k, d) { try { var o = JSON.parse(gs(k, d) || d); return o || JSON.parse(d); } catch (_) { return JSON.parse(d); } }
  function _saveJson(k, o) { ss(k, JSON.stringify(o)); }

  // ===== 服务器清单管理 =====
  function servers() { return _json(SERVERS_KEY, '[]'); }
  function saveServers(list) { _saveJson(SERVERS_KEY, (list || []).slice(0, 20)); }
  function addServer(name, url, mode) {
    var list = servers();
    var s = { id: 'mcp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: String(name || 'MCP 服务器').slice(0, 30), url: String(url || '').trim(), mode: mode === 'direct' ? 'direct' : 'proxy' };
    list.push(s); saveServers(list); return s;
  }
  function updateServer(id, patch) {
    var list = servers();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) {
      if (patch.name != null) list[i].name = String(patch.name).slice(0, 30);
      if (patch.url != null) list[i].url = String(patch.url).trim();
      if (patch.mode != null) list[i].mode = patch.mode === 'direct' ? 'direct' : 'proxy';
      break;
    }
    saveServers(list);
  }
  function removeServer(id) {
    saveServers(servers().filter(function (s) { return s.id !== id; }));
    var t = _json(TOKENS_KEY, '{}'); if (t[id]) { delete t[id]; _saveJson(TOKENS_KEY, t); }
    var se = _json(SESS_KEY, '{}'); if (se[id]) { delete se[id]; _saveJson(SESS_KEY, se); }
    delete _tools[id]; delete _inited[id];
  }
  function tokenOf(id) { return String(_json(TOKENS_KEY, '{}')[id] || ''); }
  function setToken(id, tok) { var t = _json(TOKENS_KEY, '{}'); if (tok) t[id] = String(tok); else delete t[id]; _saveJson(TOKENS_KEY, t); }

  // ===== 传输：JSON-RPC over HTTP =====
  function _urlOf(s) {
    var A = window.aiChat;
    if (s.mode === 'direct') return s.url;
    var px = (A && A.proxyPrefix) ? A.proxyPrefix() : '';
    return px ? px + '/' + s.url : s.url;
  }
  function _headers(s, withSess) {
    var h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION };
    var tok = tokenOf(s.id); if (tok) h['Authorization'] = 'Bearer ' + tok;
    if (withSess) { var sid = _json(SESS_KEY, '{}')[s.id]; if (sid) h['Mcp-Session-Id'] = sid; }
    return h;
  }
  /** 响应解析：application/json 直接解析；text/event-stream 按行取 data: 帧找匹配 id 的 JSON-RPC 消息 */
  function _parseRpcBody(contentType, text, rpcId) {
    var ct = String(contentType || '').toLowerCase();
    if (ct.indexOf('text/event-stream') !== -1) {
      var lines = String(text || '').split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          var j = JSON.parse(payload);
          if (j && (j.id === rpcId || (j.method && j.id == null))) return j;
        } catch (_) {}
      }
      return null;
    }
    try { return JSON.parse(text); } catch (_) { return null; }
  }
  function _rpcErr(j) {
    var e = (j && j.error) || {};
    return new Error(e.message ? ('MCP 错误：' + e.message) : 'MCP 错误：' + JSON.stringify(e || '空响应'));
  }
  /** 一次 JSON-RPC 调用（含 SSE 兼容与 404/会话失效重握手） */
  function callRpc(server, method, params, isNotification) {
    var s = server;
    var attempt = function (withSess) {
      var rpcId = isNotification ? null : Date.now() + Math.floor(Math.random() * 100000);
      var body = { jsonrpc: '2.0', method: method };
      if (rpcId != null) { body.id = rpcId; body.params = params || {}; }
      else if (params) body.params = params;
      return fetch(_urlOf(s), { method: 'POST', headers: _headers(s, withSess), body: JSON.stringify(body) })
        .then(function (resp) {
          if (!resp.ok) {
            var err = new Error('HTTP ' + resp.status);
            err.status = resp.status;
            throw err;
          }
          return resp.text().then(function (text) {
            var j = _parseRpcBody(resp.headers.get('Content-Type'), text, rpcId);
            if (!j) return null; // 通知类或无匹配帧
            if (j.error) { var e = _rpcErr(j); e.code = j.error.code; throw e; }
            return j.result;
          });
        });
    };
    return attempt(true).catch(function (e) {
      // 会话失效（404/400 或 -32001 类）：清掉本机会话、重新握手一次再试
      if (e && (e.status === 404 || e.status === 400 || e.code === -32001)) {
        var se = _json(SESS_KEY, '{}'); delete se[s.id]; _saveJson(SESS_KEY, se);
        delete _inited[s.id];
        return ensureInit(s).then(function () { return attempt(true); });
      }
      throw e;
    });
  }

  // ===== 握手与工具发现 =====
  var _inited = {};   // { serverId: true } 本次页面会话内已握手
  var _tools = {};    // { serverId: [注册表条目] } 供 schemas() 同步读取

  function _setSess(s, resp) {
    var sid = resp && resp.headers ? resp.headers.get('mcp-session-id') : null;
    if (sid) { var se = _json(SESS_KEY, '{}'); se[s.id] = sid; _saveJson(SESS_KEY, se); }
  }
  /** initialize → notifications/initialized。幂等：已握手直接返回。 */
  function ensureInit(s) {
    if (_inited[s.id]) return Promise.resolve();
    var selfUrl = _urlOf(s);
    return fetch(selfUrl, {
      method: 'POST',
      headers: _headers(s, false),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ZhiNote', version: '1.0' } } }),
    }).then(function (resp) {
      if (!resp.ok) { var e = new Error('HTTP ' + resp.status); e.status = resp.status; throw e; }
      _setSess(s, resp);
      return resp.text();
    }).then(function (text) {
      var j = _parseRpcBody('application/json', text, 1);
      if (j && j.error) throw _rpcErr(j);
      return callRpc(s, 'notifications/initialized', {}, true);
    }).then(function () { _inited[s.id] = true; });
  }

  /** 拉取某服务器的工具清单并映射成本地注册表条目 */
  function _fetchTools(s) {
    return ensureInit(s).then(function () {
      return callRpc(s, 'tools/list', {});
    }).then(function (result) {
      var tools = (result && result.tools) || [];
      _tools[s.id] = tools.map(function (t) {
        var readOnlyHint = !!(t.annotations && t.annotations.readOnlyHint);
        return {
          name: 'mcp_' + s.id + '_' + t.name,
          mcpName: t.name,
          serverId: s.id,
          desc: '[' + (s.name || 'MCP') + '] ' + (t.description || t.name),
          params: t.inputSchema || { type: 'object', properties: {} },
          readOnly: readOnlyHint,
          danger: !readOnlyHint,
          run: function (args) { return callTool(s, t.name, args); },
        };
      });
      return _tools[s.id];
    });
  }
  function callTool(s, name, args) {
    return callRpc(s, 'tools/call', { name: name, arguments: args || {} }).then(function (result) {
      var texts = [];
      var content = (result && result.content) || [];
      for (var i = 0; i < content.length; i++) {
        if (content[i] && typeof content[i].text === 'string') texts.push(content[i].text);
      }
      if (result && result.isError) { var e = new Error(texts.join('\n') || '工具返回错误'); e.isToolError = true; throw e; }
      return { ok: true, text: texts.join('\n') };
    });
  }

  /** 拉取所有已配置服务器的工具（静默失败：单台挂了不影响其它）。启动时与设置里手动刷新时调用。 */
  function refreshAll() {
    var list = servers().filter(function (s) { return s.url; });
    return Promise.all(list.map(function (s) {
      return _fetchTools(s).then(function (ts) { return { server: s, ok: true, count: ts.length }; },
        function (e) { return { server: s, ok: false, error: e }; });
    }));
  }
  /** agent 注册表用的 schema（同步读缓存；未拉到前该服务器工具暂不可见） */
  function schemas() {
    var out = [];
    for (var sid in _tools) {
      (_tools[sid] || []).forEach(function (t) {
        out.push({ type: 'function', function: { name: t.name, description: t.desc, parameters: t.params } });
      });
    }
    return out;
  }
  /** 测试某服务器：握手 + tools/list，返回 { ok, count } 或抛错 */
  function testServer(id) {
    var s = null;
    servers().forEach(function (x) { if (x.id === id) s = x; });
    if (!s || !s.url) return Promise.reject(new Error('请先填接口地址'));
    return _fetchTools(s).then(function (ts) { return { ok: true, count: ts.length }; });
  }

  // 启动后延迟预取一次（静默，不阻塞界面）：让 schemas() 尽早有缓存
  setTimeout(function () { try { refreshAll(); } catch (_) {} }, 2500);

  window.aiMcp = {
    servers: servers, addServer: addServer, updateServer: updateServer, removeServer: removeServer,
    tokenOf: tokenOf, setToken: setToken,
    refreshAll: refreshAll, testServer: testServer, schemas: schemas,
    _findTool: function (regName) {
      for (var sid in _tools) {
        var arr = _tools[sid] || [];
        for (var i = 0; i < arr.length; i++) if (arr[i].name === regName) return arr[i];
      }
      return null;
    },
  };
})();
