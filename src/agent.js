/* 小枝 Agent —— 工具注册表 + 工具调用循环（function calling）。
 * 与 ai.js 的分工：ai.js 只管「一次对话请求」（含 tools 参数与 tool_calls 流解析）；
 * 这里负责循环编排：模型请求工具 → 本地执行 → 结果以 role:'tool' 消息回传 → 再问，直到给出最终回答。
 *
 * 设计要点：
 *  - 工具分两级：只读（readOnly，自动执行）；写入类（状态行提示、自动执行）；危险/远程（danger 或 MCP 非只读，
 *    必须经 opts.onConfirm 确认卡）。删除/清空类内置工具刻意不做。
 *  - MCP（mcp.js）的工具以 mcp_ 前缀动态并入 schemas()，与内置工具走同一条循环。
 *  - 循环上限 MAX_ROUND 轮，防失控；每轮检查 signal.aborted，确认卡等待中中断也会立即拒绝。
 *  - 工具结果截断到 RESULT_MAX 字符，防止爆上下文。
 */
(function () {
  'use strict';

  var MAX_ROUND = 8;
  var RESULT_MAX = 4000;

  function _clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…（已截断）' : s; }

  // ===== 笔记查找辅助 =====
  function _notes() { var all = window.storage && window.storage.getAll(); return (all && all.notes) || {}; }
  function _noteList() { var m = _notes(), out = []; for (var id in m) out.push(m[id]); return out; }
  /** 按 id 精确 / 标题包含模糊找笔记；返回 {note, candidates} */
  function _findNote(args) {
    var notes = _notes();
    if (args.id) return { note: notes[args.id] || null, candidates: [] };
    var t = String(args.title || '').trim().toLowerCase();
    if (!t) return { note: null, candidates: [] };
    var hits = [];
    _noteList().forEach(function (n) {
      var title = String(n.title || '').toLowerCase();
      if (title.indexOf(t) !== -1) hits.push(n);
    });
    return { note: hits[0] || null, candidates: hits.slice(1, 6).map(function (n) { return n.title; }) };
  }
  function _mdOf(n) {
    if (!n) return '';
    if (n.doc && window.editor && window.editor.serializeDocToMd) return window.editor.serializeDocToMd(n.doc) || '';
    return n.content || '';
  }

  // ===== 内置工具（第一批 6 个）=====
  var TOOLS = [
    {
      name: 'search_notes', desc: '全文搜索用户的所有笔记。返回命中的笔记 id、标题和摘要片段。', readOnly: true,
      params: { type: 'object', properties: { q: { type: 'string', description: '搜索关键词' } }, required: ['q'] },
      run: function (args) {
        var hits = (window.storage && window.storage.searchAll(String(args.q || ''))) || [];
        return Promise.resolve({ ok: true, count: hits.length,
          results: hits.slice(0, 8).map(function (h) { return { id: h.id, title: h.title, snippet: h.snippet }; }) });
      },
    },
    {
      name: 'read_note', desc: '读取一篇笔记的完整内容（Markdown）。用 id 最准；也可以给标题（模糊包含匹配，命中多篇时返回候选）。', readOnly: true,
      params: { type: 'object', properties: { id: { type: 'string', description: '笔记 id（来自 search_notes/list_tree）' }, title: { type: 'string', description: '标题关键词（没有 id 时用）' } }, required: [] },
      run: function (args) {
        var f = _findNote(args);
        if (!f.note) return Promise.resolve({ ok: false, error: '找不到笔记', candidates: f.candidates });
        var md = (window.aiChat && window.aiChat.getNoteContext) ? window.aiChat.getNoteContext(f.note.id) : _mdOf(f.note);
        return Promise.resolve({ ok: true, id: f.note.id, title: f.note.title, content: _clip(md.replace(/^【[^】]*】\n?/, ''), 6000) });
      },
    },
    {
      name: 'list_tree', desc: '列出当前工作区的全部笔记树（id、父 id、标题），用于了解笔记结构或找笔记 id。', readOnly: true,
      params: { type: 'object', properties: {}, required: [] },
      run: function () {
        var lines = _noteList().map(function (n) { return n.id + '\t' + (n.parentId || '-') + '\t' + (n.title || '无标题'); });
        var total = lines.length;
        return Promise.resolve({ ok: true, count: total, notes: _clip(lines.slice(0, 200).join('\n'), RESULT_MAX) });
      },
    },
    {
      name: 'create_note', desc: '新建一篇笔记（Markdown 正文）。返回新笔记的 id。', readOnly: false,
      params: { type: 'object', properties: { title: { type: 'string', description: '笔记标题' }, content: { type: 'string', description: 'Markdown 正文' }, parentId: { type: 'string', description: '可选：父笔记 id（建为子笔记）' } }, required: ['title', 'content'] },
      run: function (args) {
        var st = window.storage; if (!st) return Promise.resolve({ ok: false, error: '存储不可用' });
        var content = String(args.content || '');
        var note = st.create({ parentId: args.parentId || null, title: String(args.title || '无标题'), content: content,
          doc: (window.editor && window.editor.parseMdToDoc) ? window.editor.parseMdToDoc(content) : null });
        return Promise.resolve({ ok: true, id: note.id, title: note.title });
      },
    },
    {
      name: 'update_note', desc: '修改一篇笔记的正文（replace=整体替换；append=在末尾追加）。不能改当前正在编辑器里打开的笔记。', readOnly: false,
      params: { type: 'object', properties: { id: { type: 'string', description: '笔记 id' }, content: { type: 'string', description: '新的 Markdown 正文（replace）或要追加的段落（append）' }, mode: { type: 'string', enum: ['replace', 'append'], description: '默认 append' } }, required: ['id', 'content'] },
      run: function (args) {
        var st = window.storage, ed = window.editor;
        var n = st && st.get && st.get(args.id);
        if (!n) return Promise.resolve({ ok: false, error: '找不到笔记：' + args.id });
        if (ed && ed.currentId && ed.currentId() === args.id) return Promise.resolve({ ok: false, error: '这篇笔记正打开在编辑器里，为避免冲突请直接在编辑器中修改，或换一篇' });
        var mode = args.mode === 'replace' ? 'replace' : 'append';
        var oldMd = _mdOf(n);
        var newMd = mode === 'replace' ? String(args.content || '') : (oldMd ? oldMd + '\n\n' + args.content : String(args.content || ''));
        if (!ed || !ed.parseMdToDoc || !st.updateDoc) return Promise.resolve({ ok: false, error: '编辑器未就绪' });
        st.updateDoc(args.id, ed.parseMdToDoc(newMd));
        return Promise.resolve({ ok: true, id: args.id, mode: mode });
      },
    },
    {
      name: 'insert_at_cursor', desc: '把一段 Markdown 文本插入当前打开笔记的光标处（不影响其他笔记）。', readOnly: false,
      params: { type: 'object', properties: { text: { type: 'string', description: '要插入的 Markdown 文本' } }, required: ['text'] },
      run: function (args) {
        var ok = window.aiChat && window.aiChat.insertToEditor(String(args.text || ''));
        return Promise.resolve(ok ? { ok: true } : { ok: false, error: '没有打开的笔记或插入失败' });
      },
    },
  ];

  function find(name) {
    for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].name === name) return TOOLS[i];
    // MCP 工具（mcp_ 前缀）由 mcp.js 动态提供，同一条循环执行
    try { if (window.aiMcp && window.aiMcp._findTool) { var t = window.aiMcp._findTool(name); if (t) return t; } } catch (_) {}
    return null;
  }

  /** 全部工具的 OpenAI schema（内置 + MCP 动态并入） */
  function schemas() {
    var out = TOOLS.map(function (t) {
      return { type: 'function', function: { name: t.name, description: t.desc, parameters: t.params } };
    });
    try { if (window.aiMcp && window.aiMcp.schemas) out = out.concat(window.aiMcp.schemas() || []); } catch (_) {}
    return out;
  }
  /** 工具总数（设置 UI 显示用） */
  function toolCount() { return schemas().length; }

  function _abortErr() { var e = new Error('已中断'); e.name = 'AbortError'; return e; }

  /** 工具调用循环。opts: { messages, noteContext, signal,
   *  onDelta/onThink（透传流式文本）, onToolStart(name,args), onToolEnd(name,ok),
   *  onConfirm(toolCall)→Promise<bool>（危险/远程工具确认，缺省视为拒绝）,
   *  onDone(finalText), onError(err), onAbort() } */
  function run(opts) {
    return new Promise(function (resolve, reject) {
      var A = window.aiChat;
      if (!A || !A.isConfigured()) { reject(new Error('还没配置模型，请到设置 → 小枝 填好服务商和 key')); return; }
      var msgs = (opts.messages || []).slice();
      var aborted = false;
      var confirmRej = null; // 等待确认卡时的拒绝器：中断时立即拒掉

      function onAbr() { aborted = true; if (confirmRej) { try { confirmRej(_abortErr()); } catch (_) {} confirmRej = null; } }
      if (opts.signal) {
        if (opts.signal.aborted) onAbr();
        else try { opts.signal.addEventListener('abort', onAbr); } catch (_) {}
      }

      function done(text) { resolve(String(text || '')); }
      function fail(err) { reject(err && err.name === 'AbortError' ? err : (err instanceof Error ? err : new Error(String(err || '未知错误')))); }

      /** 一次模型请求：普通回答 → {text}；请求工具 → {toolCalls: assistantMsg} */
      function chatOnce(stream) {
        return new Promise(function (res, rej) {
          var settled = false;
          A.chat({
            messages: msgs.slice(),
            noteContext: opts.noteContext,
            tools: schemas(),
            stream: stream ? undefined : false,
            signal: opts.signal,
            onDelta: function (p, all) { opts.onDelta && opts.onDelta(p, all); },
            onThink: function (p, all) { opts.onThink && opts.onThink(p, all); },
            onToolCalls: function (m) { if (!settled) { settled = true; res({ toolCalls: m }); } },
            onDone: function (full) { if (!settled) { settled = true; res({ text: full }); } },
            onError: function (err) { if (!settled) { settled = true; rej(err); } },
            onAbort: function () { if (!settled) { settled = true; rej(_abortErr()); } },
          });
        });
      }

      /** 执行一批工具调用（结果依次追加进 msgs），全部完成后才继续下一轮 */
      function handleCalls(m) {
        msgs.push(m);
        var calls = (m.tool_calls || []).slice();
        var i = 0;
        function next() {
          if (aborted) { fail(_abortErr()); return Promise.resolve(); }
          if (i >= calls.length) return Promise.resolve();
          var tc = calls[i++];
          var name = (tc.function && tc.function.name) || '';
          var raw = (tc.function && tc.function.arguments) || '{}';
          var args = null;
          try { args = JSON.parse(raw || '{}'); } catch (_) {}
          return execOne(name, args, raw).then(function (out) {
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: _clip(JSON.stringify(out), RESULT_MAX) });
            opts.onToolEnd && opts.onToolEnd(name, !!out.ok, out);
          }, function () {
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: '工具执行出错' }) });
            opts.onToolEnd && opts.onToolEnd(name, false, null);
          }).then(next);
        }
        return next();
      }

      /** 单个工具：查表 →（危险/远程）确认 → 执行 */
      function execOne(name, args, raw) {
        var tool = find(name);
        if (!tool) return Promise.resolve({ ok: false, error: '未知工具：' + name });
        if (!args || typeof args !== 'object') return Promise.resolve({ ok: false, error: '工具参数不是合法 JSON：' + _clip(raw, 200) });
        var isMcp = name.indexOf('mcp_') === 0;
        var needConfirm = !!tool.danger || (isMcp && !tool.readOnly);
        var go = function () {
          opts.onToolStart && opts.onToolStart(name, args);
          return Promise.resolve().then(function () { return tool.run(args); });
        };
        if (needConfirm) {
          if (!opts.onConfirm) return Promise.resolve({ ok: false, error: '用户拒绝了这次操作' });
          return new Promise(function (res, rej) {
            confirmRej = rej;
            Promise.resolve().then(function () { return opts.onConfirm({ name: name, args: args, raw: raw }); })
              .then(function (ok) { confirmRej = null; res(ok); }, function (e) { confirmRej = null; rej(e); });
          }).then(function (ok) {
            if (!ok) return { ok: false, error: '用户拒绝了这次操作' };
            return go();
          }); // 确认卡被中断 → 这里的拒绝沿 handleCalls 走「工具出错」，下一轮开头再统一终止
        }
        return go();
      }

      var triedNonStream = false, round = 0;
      function step() {
        if (aborted) { fail(_abortErr()); return; }
        if (round >= MAX_ROUND) { done('（连续调用了 ' + MAX_ROUND + ' 轮工具，先到这里。可继续追问让我接着做。）'); return; }
        round++;
        chatOnce(!triedNonStream).then(function (r) {
          if (r.toolCalls) { handleCalls(r.toolCalls).then(step, fail); return; }
          done(r.text);
        }, function (err) {
          // 部分服务商不支持流式 tool_calls（400/参数类报错）：整轮回退非流式重试一次
          if (!triedNonStream && /（400）|（422）|invalid|tool/i.test(String((err && err.message) || ''))) {
            triedNonStream = true;
            step();
            return;
          }
          fail(err);
        });
      }
      step();
    });
  }

  window.aiAgent = {
    run: run,
    schemas: schemas,
    find: find,
    toolCount: toolCount,
  };
})();
