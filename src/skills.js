/* 小枝技能 —— 注入系统提示词的持久行为预设。
 * 与「常用语」的区别：常用语是点一下发一条指令（一次性）；技能是开关式的行为模式
 * （如「写作教练」「学术腔」），开启后每一轮对话都会作为系统提示并入。
 *
 * 存储：'aiSkills' 随设置云同步（{v:1, groups:[…]}）；UI 折叠状态留在 mascot.js，不上云。
 * 结构与 aiQuickCmds 同型：groups[n].items[i] = { id, e:图标, n:名称, p:提示词正文, on:'1'|'' }。
 */
(function () {
  'use strict';

  var SK_KEY = 'aiSkills';
  var GMAX = 20, IMAX = 50, PMAX = 2000;

  function gs(k, d) { try { var v = window.storage && window.storage.getSetting(k); return (v == null || v === '') ? d : v; } catch (_) { return d; } }
  function ss(k, v) { try { window.storage && window.storage.setSetting(k, v); } catch (_) {} }

  function _id() { return 'sk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // 首次使用给一个示例（默认关，避免悄悄改变所有回答的口吻；用户开了才生效）
  function _defaults() {
    return [{ n: '写作', items: [
      { id: _id(), e: '✍️', n: '写作教练', on: '',
        p: '你是写作教练：回答时先给出可直接使用的成稿，再用两三点简短说明写法要点（为什么这样组织、哪里可以再改）。语气务实，不空谈理论。' },
    ] }];
  }

  function _clean(it) {
    return { id: it.id || _id(), e: String(it.e || '🧭').slice(0, 8), n: String(it.n || '').replace(/\s+/g, ' ').trim().slice(0, 20),
      p: String(it.p || '').trim().slice(0, PMAX), on: it.on ? '1' : '' };
  }

  /** 全部分组（首次自动写入示例） */
  function groups() {
    var raw = gs(SK_KEY, '');
    if (!raw) { var d = _defaults(); _save(d); return d; }
    try {
      var o = JSON.parse(raw);
      if (o && o.v === 1 && Array.isArray(o.groups)) return o.groups;
    } catch (_) {}
    return _defaults();
  }
  function _save(g) {
    g = (g || []).slice(0, GMAX);
    var total = 0;
    g.forEach(function (grp) { grp.items = (grp.items || []).filter(function (it) { total++; return total <= IMAX; }); });
    ss(SK_KEY, JSON.stringify({ v: 1, groups: g }));
  }

  /** 所有已开启技能的提示词正文（去重）——ai.js 注入系统提示用 */
  function activePrompts() {
    var out = [], seen = {};
    groups().forEach(function (grp) {
      (grp.items || []).forEach(function (it) {
        if (it.on === '1' && it.p && !seen[it.p]) { seen[it.p] = 1; out.push(it.p); }
      });
    });
    return out;
  }

  function addItem(gi, it) {
    var g = groups(); if (!g[gi]) return;
    it = _clean(it); if (!it.p) return;
    (g[gi].items = g[gi].items || []).push(it);
    _save(g);
  }
  function updateItem(gi, ii, patch) {
    var g = groups(); var grp = g[gi]; if (!grp || !grp.items || !grp.items[ii]) return;
    var cur = grp.items[ii];
    var merged = _clean({ id: cur.id, e: patch.e != null ? patch.e : cur.e, n: patch.n != null ? patch.n : cur.n,
      p: patch.p != null ? patch.p : cur.p, on: patch.on != null ? patch.on : cur.on });
    grp.items[ii] = merged;
    _save(g);
  }
  function removeItem(gi, ii) { var g = groups(); if (g[gi] && g[gi].items) { g[gi].items.splice(ii, 1); _save(g); } }
  function toggle(gi, ii, on) { updateItem(gi, ii, { on: on ? '1' : '' }); }

  function addGroup(name) {
    name = String(name || '').trim().slice(0, 12) || '新分组';
    var g = groups(); if (g.length >= GMAX) return -1;
    g.push({ n: name, items: [] }); _save(g); return g.length - 1;
  }
  function renameGroup(gi, name) { var g = groups(); if (!g[gi]) return; g[gi].n = String(name || '').trim().slice(0, 12) || g[gi].n; _save(g); }
  function removeGroup(gi) { var g = groups(); if (g[gi]) { g.splice(gi, 1); _save(g); } }

  window.aiSkills = {
    groups: groups, activePrompts: activePrompts,
    addItem: addItem, updateItem: updateItem, removeItem: removeItem, toggle: toggle,
    addGroup: addGroup, renameGroup: renameGroup, removeGroup: removeGroup,
  };
})();
