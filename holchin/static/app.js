/* Holchin Estimator — front end. Vanilla JS, no dependencies. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } [c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(16).slice(2, 12).padEnd(10, '0');
const ROOT = '__root__';

const S = {
  project: null,
  file: null,
  schema: null,
  settings: null,
  defaults: {},
  results: {},
  iterations: 0,
  idx: new Map(),
  visible: [],
  sel: new Set(),
  primary: ROOT,
  dirty: false,
  filter: '',
  metric: 'effort_pm',
  undo: [],
  redo: [],
  lastCoalesce: null,
  lastTime: 0,
  renaming: false,
  busy: false,
};

// ======================================================================= API
async function api(path, body, { text = false, raw = false } = {}) {
  const opt = body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': raw ? 'text/plain' : 'application/json' },
    body: raw ? body : JSON.stringify(body),
  };
  const res = await fetch(path, opt);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return text ? res.text() : res.json();
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), err ? 4500 : 2200);
}

// ======================================================================= formatting
const CUR = () => (S.settings && S.settings.currency) || '$';

function fmtN(x, d = 0) {
  if (x == null || !isFinite(x)) return '–';
  return Number(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtCompact(x, d = 1) {
  const a = Math.abs(x);
  if (a >= 1e9) return (x / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (x / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return (x / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (x / 1e3).toFixed(d) + 'k';
  return fmtN(x, a < 10 && x % 1 ? 1 : 0);
}
const METRICS = {
  effort_pm: { label: 'Effort', unit: 'PM', fmt: (x) => fmtN(x, x < 100 ? 1 : 0) + ' PM', tick: (x) => fmtCompact(
    x) },
  cost: { label: 'Cost', unit: '', fmt: (x) => CUR() + fmtCompact(x), tick: (x) => CUR() + fmtCompact(x) },
  schedule_months: { label: 'Schedule', unit: 'months', fmt: (x) => fmtN(x, 1) + ' mo', tick: (x) => fmtN(x, x < 10 ?
      1 : 0) },
  esloc: { label: 'Size', unit: 'ESLOC', fmt: (x) => fmtCompact(x) + ' ESLOC', tick: (x) => fmtCompact(x) },
  effort_hours: { label: 'Hours', unit: 'h', fmt: (x) => fmtN(x) + ' h', tick: (x) => fmtCompact(x) },
};

// ======================================================================= tree index
function rootNode() {
  return { id: ROOT, type: 'group', name: S.project.project?.name || 'Project', children: S.project.tree,
  expanded: true };
}

function buildIndex() {
  S.idx = new Map();
  const root = rootNode();
  S.idx.set(ROOT, { node: root, parent: null, depth: 0 });
  const walk = (list, parent, depth) => {
    for (const n of list) {
      S.idx.set(n.id, { node: n, parent, depth });
      if (n.type === 'group') { n.children = n.children || [];
        walk(n.children, n, depth + 1); }
    }
  };
  walk(root.children, root, 1);
  for (const id of [...S.sel])
    if (!S.idx.has(id)) S.sel.delete(id);
  if (!S.idx.has(S.primary)) S.primary = ROOT;
  if (!S.sel.size) S.sel.add(S.primary);
}
const getNode = (id) => S.idx.get(id)?.node;
const parentOf = (id) => S.idx.get(id)?.parent;

function isDescendantOrSelf(id, ancestorId) {
  let cur = id;
  while (cur) { if (cur === ancestorId) return true;
    cur = parentOf(cur)?.id; }
  return false;
}

function pathTo(id) {
  const out = [];
  let cur = getNode(id);
  while (cur) { out.unshift(cur);
    cur = parentOf(cur.id); }
  return out;
}

function allGroups() {
  const out = [];
  const walk = (n, d) => { if (n.type === 'group') { out.push({ node: n, depth: d });
      n.children.forEach((c) => walk(c, d + 1)); } };
  walk(rootNode(), 0);
  return out;
}

function forEachComponent(fn) {
  const walk = (list) => list.forEach((n) => (n.type === 'group' ? walk(n.children) : fn(n)));
  walk(S.project.tree);
}

function normalizeIds(ids) {
  // drop root and anything whose ancestor is also selected
  return ids.filter((id) => id !== ROOT && S.idx.has(id) &&
    !ids.some((o) => o !== id && isDescendantOrSelf(id, o)));
}

// ======================================================================= state mutation & undo
function mutate(fn, { coalesce = null, tree = true, main = false } = {}) {
  const now = Date.now();
  if (!(coalesce && S.lastCoalesce === coalesce && now - S.lastTime < 1500)) {
    S.undo.push(JSON.stringify(S.project));
    if (S.undo.length > 200) S.undo.shift();
    S.redo = [];
  }
  S.lastCoalesce = coalesce;
  S.lastTime = now;
  fn();
  S.dirty = true;
  buildIndex();
  if (tree) renderTree();
  if (main) renderMain();
  scheduleEstimate();
  renderStatus();
}

function undo() {
  if (!S.undo.length) return toast('Nothing to undo');
  S.redo.push(JSON.stringify(S.project));
  S.project = JSON.parse(S.undo.pop());
  S.lastCoalesce = null;
  afterChangeAll();
}

function redo() {
  if (!S.redo.length) return toast('Nothing to redo');
  S.undo.push(JSON.stringify(S.project));
  S.project = JSON.parse(S.redo.pop());
  S.lastCoalesce = null;
  afterChangeAll();
}
async function afterChangeAll() {
  S.dirty = true;
  buildIndex();
  await loadSchema();
  renderAll();
  scheduleEstimate(0);
}

// ======================================================================= schema & estimate
async function loadSchema() {
  const r = await api('/api/schema', { settings: S.project.settings || {} });
  S.schema = r.parameters;
  S.settings = r.settings;
  S.defaults = r.defaults;
}
let estTimer = null,
  estCtl = null,
  estSeq = 0;

function scheduleEstimate(delay = 220) {
  clearTimeout(estTimer);
  estTimer = setTimeout(runEstimate, delay);
}
async function runEstimate() {
  if (estCtl) estCtl.abort();
  estCtl = new AbortController();
  const seq = ++estSeq;
  S.busy = true;
  renderStatus();
  try {
    const res = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(S.project),
      signal: estCtl.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (seq !== estSeq) return;
    S.results = data.results;
    S.iterations = data.iterations;
    S.busy = false;
    if (!S.renaming) renderTree();
    renderResults();
    renderStatus();
  } catch (e) {
    if (e.name === 'AbortError') return;
    S.busy = false;
    renderStatus();
    toast('Estimate failed: ' + e.message, true);
  }
}

// ======================================================================= status bar
function renderStatus() {
  const f = S.file ? S.file.split(/[\\/]/).pop() : 'unsaved';
  $('#status').innerHTML =
    (S.busy ? '<span class="busy">● computing…</span>' : (S.iterations ?
      `<span>${fmtN(S.iterations)} Monte Carlo runs</span>` : '')) +
    `<span class="${S.dirty ? 'dirty' : ''}" title="${esc(S.file || 'Not saved to a file yet')}"><span class="dot"></span>${esc(f)}${S.dirty ? ' — unsaved changes' : ''}</span>`;
  $('[data-act=undo]').disabled = !S.undo.length;
  $('[data-act=redo]').disabled = !S.redo.length;
  document.title = (S.dirty ? '• ' : '') + (S.project.project?.name || 'Project') + ' — Holchin Estimator';
}

// ======================================================================= tree
const ICONS = {
  chevron: '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  group: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="var(--text-secondary)" stroke-width="1.3"/></svg>',
  component: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 1.8 13.6 5v6L8 14.2 2.4 11V5z M2.4 5 8 8.2 13.6 5 M8 8.2v6" fill="none" stroke="var(--series-1)" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  root: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2 14 5 8 8 2 5z M2 8l6 3 6-3 M2 11l6 3 6-3" fill="none" stroke="var(--text-primary)" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

function matchesFilter(n) {
  if (!S.filter) return true;
  if (n.name.toLowerCase().includes(S.filter)) return true;
  return n.type === 'group' && n.children.some(matchesFilter);
}

function highlight(name) {
  if (!S.filter) return esc(name);
  const i = name.toLowerCase().indexOf(S.filter);
  if (i < 0) return esc(name);
  return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + S.filter.length)) + '</mark>' + esc(name.slice(i + S
    .filter.length));
}

function renderTree() {
  const rows = [];
  S.visible = [];
  const rootMean = S.results[ROOT]?.mc?.effort_pm?.stats?.mean || 0;
  const rowHtml = (n, depth) => {
    if (n.id !== ROOT && !matchesFilter(n)) return;
    const isGroup = n.type === 'group';
    const open = isGroup && (n.expanded !== false || !!S.filter);
    const r = S.results[n.id];
    const st = r?.mc?.effort_pm?.stats;
    const warn = r?.warnings?.length ? `<span class="warn-ico" title="${esc(r.warnings.join('\n'))}">!</span>` : '';
    const share = st && rootMean ? Math.max(2, Math.min(100, (st.mean / rootMean) * 100)) : 0;
    const badge = st ?
      `<span class="badge" title="Effort P50 ${esc(METRICS.effort_pm.fmt(st.p50))} · ${share.toFixed(0)}% of total (mean)">${warn}${fmtN(st.p50, st.p50 < 100 ? 1 : 0)} PM<span class="minibar"><span style="left:0;width:${share}%"></span></span></span>` :
      '';
    const pad = 4 + (depth) * 16;
    const cls = ['row', n.id === ROOT ? 'root' : n.type, S.sel.has(n.id) ? 'selected' : '', S.primary === n.id ?
      'primary-sel' : ''
    ].join(' ');
    rows.push(`<div class="${cls}" data-id="${esc(n.id)}" role="treeitem" aria-level="${depth + 1}" aria-selected="${S.sel.has(n.id)}"${isGroup ? ` aria-expanded="${open}"` : ''} ${n.id !== ROOT ? 'draggable="true"' : ''} style="padding-left:${pad}px;--indent:${pad + 22}px">
      ${isGroup && n.id !== ROOT ? `<span class="twisty ${open ? 'open' : ''}" data-twisty>${ICONS.chevron}</span>` : '<span class="twisty"></span>'}
      <span class="node-icon">${n.id === ROOT ? ICONS.root : ICONS[n.type]}</span>
      <span class="node-name" title="${esc(n.name)}">${highlight(n.name)}</span>${badge}</div>`);
    S.visible.push(n.id);
    if (open) n.children.forEach((c) => rowHtml(c, depth + 1));
  };
  rowHtml(rootNode(), 0);
  if (S.filter && S.visible.length === 1) rows.push('<div class="empty" style="padding:20px">No matches</div>');
  $('#tree').innerHTML = rows.join('');
}

function select(id, { additive = false, range = false, focusMain = true } = {}) {
  if (range && S.primary) {
    const a = S.visible.indexOf(S.primary),
      b = S.visible.indexOf(id);
    if (a >= 0 && b >= 0) {
      S.sel = new Set(S.visible.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
  } else if (additive) {
    if (S.sel.has(id) && S.sel.size > 1) { S.sel.delete(id); if (S.primary === id) S.primary = [...S.sel][0];
      renderTree();
      renderMain(); return; }
    S.sel.add(id);
  } else {
    S.sel = new Set([id]);
  }
  S.primary = id;
  try { history.replaceState(null, '', id === ROOT ? location.pathname : '#' + encodeURIComponent(id)); } catch (
  _) { /* ignore */ }
  renderTree();
  if (focusMain) renderMain();
  const row = $(`.row[data-id="${CSS.escape(id)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function toggle(id, force) {
  const n = getNode(id);
  if (!n || n.type !== 'group' || id === ROOT) return;
  n.expanded = force ?? n.expanded === false;
  renderTree();
}

function setAllExpanded(v) {
  const walk = (list) => list.forEach((n) => { if (n.type === 'group') { n.expanded = v;
      walk(n.children); } });
  walk(S.project.tree);
  renderTree();
}

function startRename(id) {
  if (id === ROOT) { $('#projectName').focus();
    $('#projectName').select(); return; }
  const row = $(`.row[data-id="${CSS.escape(id)}"]`);
  if (!row) return;
  const n = getNode(id);
  const span = $('.node-name', row);
  S.renaming = true;
  span.innerHTML = `<input value="${esc(n.name)}" aria-label="Rename">`;
  const inp = $('input', span);
  inp.focus();
  inp.select();
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    S.renaming = false;
    const v = inp.value.trim();
    if (ok && v && v !== n.name) mutate(() => { n.name = v; }, { main: S.primary === id });
    else renderTree();
    $('#tree').focus();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('mousedown', (e) => e.stopPropagation());
  inp.addEventListener('click', (e) => e.stopPropagation());
}

// -- structural operations
function newComponent(name) {
  return { id: uid(), type: 'component', name: name || 'New component', attributes: clone(S.defaults) };
}

function newGroup(name) { return { id: uid(), type: 'group', name: name || 'New group', expanded: true,
children: [] }; }

function insertionPoint() {
  const n = getNode(S.primary) || rootNode();
  if (n.type === 'group') return { list: n.children, index: n.children.length, parent: n };
  const p = parentOf(n.id);
  return { list: p.children, index: p.children.indexOf(n) + 1, parent: p };
}

function addNode(kind) {
  const node = kind === 'group' ? newGroup() : newComponent();
  if (kind === 'component') {
    // inherit language & maturity from a sibling component for convenience
    const { list } = insertionPoint();
    const sib = list.find((x) => x.type === 'component');
    if (sib)
      for (const k of ['language', 'maturity']) node.attributes[k] = sib.attributes[k];
  }
  mutate(() => {
    const { list, index, parent } = insertionPoint();
    parent.expanded = true;
    list.splice(index, 0, node);
  });
  select(node.id);
  setTimeout(() => startRename(node.id), 0);
}

function withNewIds(n) {
  const c = clone(n);
  const walk = (x) => { x.id = uid();
    (x.children || []).forEach(walk); };
  walk(c);
  return c;
}

function duplicate(ids) {
  ids = normalizeIds(ids);
  if (!ids.length) return;
  const created = [];
  mutate(() => {
    for (const id of ids) {
      const n = getNode(id),
        p = parentOf(id);
      const c = withNewIds(n);
      c.name = n.name + ' (copy)';
      p.children.splice(p.children.indexOf(n) + 1, 0, c);
      created.push(c.id);
    }
  });
  S.sel = new Set(created);
  S.primary = created[0];
  renderTree();
  renderMain();
}

function removeNodes(ids) {
  ids = normalizeIds(ids);
  if (!ids.length) return;
  const count = ids.reduce((a, id) => a + countComponents(getNode(id)), 0);
  const names = ids.map((id) => getNode(id).name);
  const msg = ids.length === 1 ? `Delete “${names[0]}”` : `Delete ${ids.length} items`;
  if ((count > 1 || ids.some((id) => getNode(id).type === 'group' && getNode(id).children.length)) &&
    !confirm(`${msg} including ${count} component(s)? You can undo this.`)) return;
  const fallback = parentOf(ids[0])?.id || ROOT;
  mutate(() => {
    for (const id of ids) {
      const p = parentOf(id),
        n = getNode(id);
      p.children.splice(p.children.indexOf(n), 1);
    }
  });
  S.sel = new Set([S.idx.has(fallback) ? fallback : ROOT]);
  S.primary = [...S.sel][0];
  renderTree();
  renderMain();
  toast(`${msg} — Ctrl+Z to undo`);
}

function countComponents(n) { return n.type === 'component' ? 1 : n.children.reduce((a, c) => a + countComponents(c),
  0); }

function canDrop(ids, targetId, pos) {
  if (!ids.length) return false;
  if (targetId === ROOT && pos !== 'inside') return false;
  const t = getNode(targetId);
  if (!t) return false;
  if (pos === 'inside' && t.type !== 'group') return false;
  return !ids.some((id) => isDescendantOrSelf(targetId, id));
}

function moveNodes(ids, targetId, pos) {
  ids = normalizeIds(ids);
  if (!canDrop(ids, targetId, pos)) return false;
  // keep visual order of the moved items
  ids.sort((a, b) => S.visible.indexOf(a) - S.visible.indexOf(b));
  const target = getNode(targetId);
  const dest = pos === 'inside' ? target : parentOf(targetId);
  mutate(() => {
    const nodes = ids.map(getNode);
    for (const id of ids) { const p = parentOf(id);
      p.children.splice(p.children.indexOf(getNode(id)), 1); }
    let index;
    if (pos === 'inside') { index = dest.children.length;
      dest.expanded = true; } else {
      index = dest.children.indexOf(target) + (pos === 'after' ? 1 : 0);
    }
    dest.children.splice(index, 0, ...nodes);
  }, { main: true });
  toast(
    `Moved ${ids.length > 1 ? ids.length + ' items' : '“' + getNode(ids[0]).name + '”'} to ${dest.id === ROOT ? 'project root' : '“' + dest.name + '”'}`
    );
  return true;
}

function wrapInGroup(ids) {
  ids = normalizeIds(ids);
  if (!ids.length) return;
  ids.sort((a, b) => S.visible.indexOf(a) - S.visible.indexOf(b));
  const g = newGroup();
  mutate(() => {
    const first = getNode(ids[0]),
      p = parentOf(ids[0]);
    p.children.splice(p.children.indexOf(first), 0, g);
    for (const id of ids) { const pp = parentOf(id);
      pp.children.splice(pp.children.indexOf(getNode(id)), 1);
      g.children.push(getNode(id)); }
  });
  select(g.id);
  setTimeout(() => startRename(g.id), 0);
}

// -- tree events
function initTree() {
  const tree = $('#tree');
  tree.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('[data-twisty]')) { toggle(id); return; }
    select(id, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
    tree.focus({ preventScroll: true });
  });
  tree.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row || e.target.closest('[data-twisty]')) return;
    const n = getNode(row.dataset.id);
    if (e.target.closest('.node-name')) startRename(n.id);
    else if (n.type === 'group') toggle(n.id);
  });
  tree.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    const id = row.dataset.id;
    if (!S.sel.has(id)) select(id);
    showNodeMenu(e.clientX, e.clientY);
  });
  tree.addEventListener('keydown', (e) => {
    if (S.renaming) return;
    const i = S.visible.indexOf(S.primary);
    const n = getNode(S.primary);
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      const j = Math.max(0, Math.min(S.visible.length - 1, i + (k === 'ArrowDown' ? 1 : -1)));
      select(S.visible[j], { range: e.shiftKey });
    } else if (k === 'ArrowRight' && n?.type === 'group') {
      e.preventDefault();
      if (n.expanded === false) toggle(n.id, true);
      else if (n.children[0]) select(n.children[0].id);
    } else if (k === 'ArrowLeft') {
      e.preventDefault();
      if (n?.type === 'group' && n.expanded !== false && n.id !== ROOT) toggle(n.id, false);
      else if (parentOf(S.primary)) select(parentOf(S.primary).id);
    } else if (k === 'F2') { e.preventDefault();
      startRename(S.primary); } else if (k === 'Delete' || k === 'Backspace') { e.preventDefault();
      removeNodes([...S.sel]); } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd') { e.preventDefault();
      duplicate([...S.sel]); } else if (k === 'Enter') { e.preventDefault(); const t = $('.title-input'); if (t) t
        .focus(); }
  });

  // drag & drop
  let dragIds = [],
    hoverTimer = null,
    hoverId = null;
  const clearDrop = () => $$('.drop-before,.drop-after,.drop-inside', tree).forEach((r) => r.classList.remove(
    'drop-before', 'drop-after', 'drop-inside'));
  const dropPos = (row, e) => {
    const n = getNode(row.dataset.id);
    const rect = row.getBoundingClientRect();
    const y = (e.clientY - rect.top) / rect.height;
    if (n.id === ROOT) return 'inside';
    if (n.type === 'group') return y < 0.28 ? 'before' : y > 0.72 && (n.expanded === false || !n.children.length) ?
      'after' : 'inside';
    return y < 0.5 ? 'before' : 'after';
  };
  tree.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.row');
    if (!row || row.dataset.id === ROOT) { e.preventDefault(); return; }
    const id = row.dataset.id;
    if (!S.sel.has(id)) { S.sel = new Set([id]);
      S.primary = id;
      renderTree();
      renderMain(); }
    dragIds = normalizeIds([...S.sel]);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragIds.map((x) => getNode(x).name).join(', '));
    requestAnimationFrame(() => dragIds.forEach((x) => $(`.row[data-id="${CSS.escape(x)}"]`)?.classList.add(
      'dragging')));
  });
  tree.addEventListener('dragover', (e) => {
    const row = e.target.closest('.row');
    clearDrop();
    if (!row || !dragIds.length) return;
    const id = row.dataset.id,
      pos = dropPos(row, e);
    if (!canDrop(dragIds, id, pos)) { e.dataTransfer.dropEffect = 'none'; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drop-' + pos);
    // hover-to-expand collapsed groups
    const n = getNode(id);
    if (n.type === 'group' && n.expanded === false && pos === 'inside') {
      if (hoverId !== id) { clearTimeout(hoverTimer);
        hoverId = id;
        hoverTimer = setTimeout(() => { toggle(id, true); }, 650); }
    } else if (hoverId !== id) { clearTimeout(hoverTimer);
      hoverId = null; }
    // autoscroll
    const tr = tree.getBoundingClientRect();
    if (e.clientY < tr.top + 30) tree.scrollTop -= 8;
    else if (e.clientY > tr.bottom - 30) tree.scrollTop += 8;
  });
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) clearDrop(); });
  tree.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = e.target.closest('.row');
    clearDrop();
    clearTimeout(hoverTimer);
    hoverId = null;
    if (!row) return;
    moveNodes(dragIds, row.dataset.id, dropPos(row, e));
    dragIds = [];
  });
  tree.addEventListener('dragend', () => { clearDrop();
    dragIds = [];
    $$('.dragging', tree).forEach((r) => r.classList.remove('dragging')); });
}

// ======================================================================= menus
function showMenu(x, y, html, bind) {
  const m = $('#menu');
  m.innerHTML = html;
  m.classList.add('show');
  const w = m.offsetWidth,
    h = m.offsetHeight;
  m.style.left = Math.min(x, innerWidth - w - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - h - 8) + 'px';
  m.onclick = (e) => { const b = e.target.closest('button'); if (!b) return;
    hideMenu();
    bind(b.dataset.m, b.dataset); };
}

function hideMenu() { $('#menu').classList.remove('show'); }

function moveTargetsHtml(ids) {
  return allGroups().filter((g) => canDrop(ids, g.node.id, 'inside') && !ids.every((id) => parentOf(id)?.id === g.node
      .id))
    .map((g) =>
      `<button data-m="moveto" data-target="${esc(g.node.id)}" style="padding-left:${10 + g.depth * 14}px">${g.node.id === ROOT ? '⌂ Project root' : esc(g.node.name)}</button>`
      ).join('') ||
    '<div class="sub-title">No other groups</div>';
}

function showNodeMenu(x, y) {
  const ids = [...S.sel];
  const norm = normalizeIds(ids);
  const n = getNode(S.primary);
  const multi = norm.length > 1;
  const isRoot = S.primary === ROOT && !multi;
  let html = '';
  if (!multi) html += `<button data-m="rename">Rename<span class="k">F2</span></button>`;
  if (n.type === 'group' && !multi) html +=
    `<button data-m="add-component">Add component</button><button data-m="add-group">Add group</button>`;
  if (!isRoot) {
    html +=
      `<button data-m="dup">Duplicate${multi ? ` ${norm.length} items` : ''}<span class="k">Ctrl+D</span></button>`;
    html += `<button data-m="wrap">Put ${multi ? norm.length + ' items' : 'in'} in a new group</button>`;
    html +=
      `<hr><div class="sub-title">Move ${multi ? norm.length + ' items ' : ''}to…</div><div class="scroll">${moveTargetsHtml(norm)}</div><hr>`;
  }
  if (n.type === 'group') html +=
    `<button data-m="expand">Expand all below</button><button data-m="collapse">Collapse all below</button>`;
  if (!isRoot) html +=
    `<hr><button data-m="del" class="danger">Delete${multi ? ` ${norm.length} items` : ''}<span class="k">Del</span></button>`;
  showMenu(x, y, html, (m, d) => {
    if (m === 'rename') startRename(S.primary);
    else if (m === 'add-component') addNode('component');
    else if (m === 'add-group') addNode('group');
    else if (m === 'dup') duplicate(ids);
    else if (m === 'wrap') wrapInGroup(ids);
    else if (m === 'moveto') moveNodes(ids, d.target, 'inside');
    else if (m === 'del') removeNodes(ids);
    else if (m === 'expand' || m === 'collapse') {
      const walk = (g) => { if (g.type === 'group') { if (g.id !== ROOT) g.expanded = m === 'expand';
          g.children.forEach(walk); } };
      walk(n);
      if (n.id !== ROOT && m === 'collapse') n.expanded = true;
      renderTree();
    }
  });
}

// ======================================================================= main panel
function renderAll() { renderTree();
  renderMain();
  renderStatus();
  $('#projectName').value = S.project.project?.name || ''; }

function renderMain() {
  const n = getNode(S.primary) || rootNode();
  const main = $('#main');
  const scroll = main.scrollTop;
  const isRoot = n.id === ROOT,
    isComp = n.type === 'component';
  const crumbs = pathTo(n.id).slice(0, -1).map((p) =>
    `<a data-goto="${esc(p.id)}">${esc(p.id === ROOT ? (p.name || 'Project') : p.name)}</a>`).join(' / ');
  const moveOpts = !isRoot ? allGroups().map((g) => {
    const ok = canDrop([n.id], g.node.id, 'inside');
    return `<option value="${esc(g.node.id)}" ${parentOf(n.id)?.id === g.node.id ? 'selected' : ''} ${ok ? '' : 'disabled'}>${'  '.repeat(g.depth)}${esc(g.node.id === ROOT ? 'Project root' : g.node.name)}</option>`;
  }).join('') : '';
  const multi = normalizeIds([...S.sel]).length > 1 ?
    `<div class="warn" style="background:var(--select-bg);border-color:var(--accent)">${normalizeIds([...S.sel]).length} items selected — drag them in the tree, or right-click for Move to / Put in group / Delete.</div>` :
    '';
  main.innerHTML = `
    <div class="node-header">
      <div class="node-title">
        <div class="crumbs">${crumbs || '&nbsp;'}</div>
        <input class="title-input" value="${esc(isRoot ? S.project.project?.name || '' : n.name)}" aria-label="Name">
        <div class="kind-tag">${isRoot ? 'Project' : isComp ? 'Component' : 'Group'} · <span id="kindInfo"></span></div>
      </div>
      <div class="node-actions">
        ${!isRoot ? `<label class="kind-tag" for="moveSel">Parent</label><select id="moveSel" title="Move to another group">${moveOpts}</select>
        <button data-na="dup">Duplicate</button><button data-na="del" class="danger">Delete</button>` : ''}
        ${!isComp ? `<button data-na="add-component">＋ Component</button><button data-na="add-group">＋ Group</button>` : ''}
      </div>
    </div>
    ${multi}
    <div id="warnings"></div>
    <div class="kpis" id="kpis"></div>
    <div class="split ${isComp ? '' : 'group-view'}">
      ${isComp ? `<div class="editor" id="editor"></div>` : ''}
      <div class="charts" id="results"></div>
    </div>`;
  main.scrollTop = scroll;

  $('.title-input', main).addEventListener('input', (e) => {
    const v = e.target.value;
    mutate(() => { if (isRoot) { S.project.project.name = v;
        $('#projectName').value = v; } else n.name = v; }, { coalesce: 'name' + n.id });
  });
  $$('[data-goto]', main).forEach((a) => a.addEventListener('click', () => select(a.dataset.goto)));
  $('#moveSel', main)?.addEventListener('change', (e) => moveNodes([n.id], e.target.value, 'inside'));
  $$('[data-na]', main).forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.na;
    if (a === 'dup') duplicate([n.id]);
    else if (a === 'del') removeNodes([n.id]);
    else addNode(a === 'add-group' ? 'group' : 'component');
  }));
  if (isComp) renderEditor(n);
  renderResults();
  if (chartObserver) { chartObserver.disconnect();
    chartObserver.observe(main);
    chartObserver.observe($('#results')); }
}
let chartObserver = null;

// ----------------------------------------------------------------------- KPIs & charts
function renderResults() {
  const n = getNode(S.primary) || rootNode();
  const r = S.results[n.id];
  const box = $('#results');
  if (!box) return;
  const kinfo = $('#kindInfo');
  if (!r) { box.innerHTML = '<div class="card wide empty">Computing…</div>';
    $('#kpis').innerHTML = ''; return; }
  if (kinfo) kinfo.textContent = n.type === 'component' ?
    `${r.maturity || ''} · EM ×${(r.em ?? 1).toFixed(2)}` :
    `${r.components} component${r.components === 1 ? '' : 's'}`;
  $('#warnings').innerHTML = (r.warnings || []).map((w) => `<div class="warn">${esc(w)}</div>`).join('');

  const e = r.mc.effort_pm.stats,
    c = r.mc.cost.stats,
    s = r.mc.schedule_months.stats,
    z = r.mc.esloc.stats;
  const h = r.mc.effort_hours.stats;
  $('#kpis').innerHTML = [
    kpi('Effort P50', METRICS.effort_pm.fmt(e.p50), `P10 ${fmtN(e.p10, 1)} · P90 ${fmtN(e.p90, 1)} PM`),
    kpi('Effort P80', METRICS.effort_pm.fmt(e.p80), `${fmtN(h.p80)} hours`),
    kpi('Cost P80', METRICS.cost.fmt(c.p80), `P50 ${METRICS.cost.fmt(c.p50)}`),
    kpi('Schedule P50', METRICS.schedule_months.fmt(s.p50), `P80 ${METRICS.schedule_months.fmt(s.p80)}`),
    kpi('Size (likely)', fmtN(r.points.likely.esloc) + ' ESLOC',
      `MC P50 ${fmtCompact(z.p50)} · P90 ${fmtCompact(z.p90)}`),
  ].join('');

  const m = S.metric;
  const seg =
    `<span class="seg">${Object.entries(METRICS).filter(([k]) => k !== 'effort_hours').map(([k, v]) => `<button data-metric="${k}" class="${k === m ? 'on' : ''}">${v.label}</button>`).join('')}</span>`;
  const cards = [];
  if (n.type === 'group') {
    cards.push(card('Contribution by child',
      `${METRICS.effort_pm.label} P50 with P10–P90 range. Click a bar to open it.`, 'contrib', 'wide'));
  }
  cards.push(card(`Three-point estimate — ${METRICS[m].label}`,
    'Deterministic low / most likely / PERT / high against the Monte Carlo spread.', 'three', 'wide', seg));
  cards.push(card(`Distribution — ${METRICS[m].label}`, `${fmtN(S.iterations)} Monte Carlo runs.`, 'hist'));
  cards.push(card(`Confidence (S-curve) — ${METRICS[m].label}`, 'Probability that the outcome is at or below a value.',
    'scurve'));
  cards.push(card('Size composition (most likely)',
    'Equivalent SLOC from new code, adapted existing code, and Holchin growth.', 'comp'));
  if (n.type === 'component') {
    cards.push(card('Size cross-check by basis',
      'Likely ESLOC from each sizing basis before growth; the selected basis is solid.', 'bases'));
    cards.push(card('Effort multipliers', `Language and cost drivers. Combined ×${(r.em ?? 1).toFixed(3)}.`, 'mults'));
  }
  cards.push(
    `<div class="card wide"><h3>Estimate table</h3><p class="desc">Point estimates and Monte Carlo percentiles.</p><div class="table-scroll">${pointsTable(r)}</div></div>`
    );
  box.innerHTML = cards.join('');
  $$('[data-metric]', box).forEach((b) => b.addEventListener('click', () => { S.metric = b.dataset.metric;
    renderResults(); }));
  drawCharts();
}
const kpi = (l, v, s) =>
  `<div class="kpi"><div class="lbl">${esc(l)}</div><div class="val">${esc(v)}</div><div class="sub">${esc(s)}</div></div>`;
const card = (title, desc, chart, cls = '', extra = '') =>
  `<div class="card ${cls}"><h3>${esc(title)}<span class="spacer"></span>${extra}</h3><p class="desc">${esc(desc)}</p><div class="chart" data-chart="${chart}"></div></div>`;

function pointsTable(r) {
  const rows = [
    ['Size (ESLOC)', 'esloc', (x) => fmtN(x)],
    ['Effort (PM)', 'effort_pm', (x) => fmtN(x, 1)],
    ['Effort (hours)', 'effort_hours', (x) => fmtN(x)],
    ['Cost', 'cost', (x) => CUR() + fmtN(x)],
    ['Schedule (months)', 'schedule_months', (x) => fmtN(x, 1)]
  ];
  const hours = S.settings.hours_per_pm;
  const mc = (k, p) => k === 'effort_hours' ? r.mc.effort_pm.stats[p] * hours : r.mc[k].stats[p];
  return `<table class="pts"><thead><tr><th></th><th>Low</th><th>Likely</th><th>PERT</th><th>High</th><th>MC P10</th><th>MC P50</th><th>MC mean</th><th>MC P80</th><th>MC P90</th></tr></thead><tbody>` +
    rows.map(([l, k, f]) =>
      `<tr><td>${l}</td>${['low', 'likely', 'pert', 'high'].map((w) => `<td>${f(r.points[w][k])}</td>`).join('')}` + [
        'p10', 'p50', 'mean', 'p80', 'p90'
      ].map((p) => `<td class="${p === 'p80' ? 'em' : ''}">${f(mc(k, p))}</td>`).join('') + '</tr>').join('') +
    '</tbody></table>';
}

// ----------------------------------------------------------------------- chart primitives
function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const span = hi - lo,
    step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}
const scale = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / ((d1 - d0) || 1)) * (r1 - r0);

function topRoundedRect(x, y, w, h, r = 4) {
  if (h <= 0 || w <= 0) return '';
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function rightRoundedRect(x, y, w, h, r = 4) {
  if (w <= 0 || h <= 0) return '';
  r = Math.min(r, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}
const tipAttr = (html) => `data-tip="${esc(html)}"`;

function drawCharts() {
  const n = getNode(S.primary) || rootNode();
  const r = S.results[n.id];
  if (!r) return;
  for (const el of $$('.chart[data-chart]')) {
    const w = Math.max(260, el.clientWidth);
    const k = el.dataset.chart;
    try {
      if (k === 'hist') el.innerHTML = chartHist(r, S.metric, w);
      else if (k === 'scurve') { el.innerHTML = chartSCurve(r, S.metric, w);
        bindSCurve(el, r, S.metric); } else if (k === 'three') el.innerHTML = chartThree(r, S.metric, w);
      else if (k === 'comp') el.innerHTML = chartComposition(r, w);
      else if (k === 'contrib') { el.innerHTML = chartContrib(r, w);
        $$('[data-goto]', el).forEach((g) => g.addEventListener('click', () => select(g.dataset.goto))); } else if (
        k === 'bases') el.innerHTML = chartBases(r, getNode(S.primary), w);
      else if (k === 'mults') el.innerHTML = chartMults(r, w);
    } catch (err) { el.textContent = 'Chart error: ' + err.message;
      console.error(err); }
  }
}

function chartHist(r, m, W) {
  const d = r.mc[m],
    H = 230,
    M = { l: 44, r: 14, t: 26, b: 34 };
  const { edges, counts } = d.hist;
  const n = counts.reduce((a, b) => a + b, 0) || 1;
  const x0 = edges[0],
    x1 = edges[edges.length - 1];
  const ymax = Math.max(...counts) / n;
  const yt = niceTicks(0, ymax * 1.05, 4);
  const x = scale(x0, x1, M.l, W - M.r),
    y = scale(0, yt[yt.length - 1] || ymax, H - M.b, M.t);
  const fmt = METRICS[m];
  let g = '<g class="grid">' + yt.map((t) => `<line x1="${M.l}" x2="${W - M.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('') +
    '</g>';
  g += yt.map((t) =>
    `<text x="${M.l - 6}" y="${y(t) + 4}" text-anchor="end">${(t * 100).toFixed(t < 0.1 && t ? 1 : 0)}%</text>`).join(
    '');
  const xt = niceTicks(x0, x1, Math.max(3, Math.floor(W / 90)));
  g += `<g class="axis"><line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/></g>`;
  g += xt.filter((t) => t >= x0 && t <= x1).map((t) =>
    `<text x="${x(t)}" y="${H - M.b + 16}" text-anchor="middle">${fmt.tick(t)}</text>`).join('');
  g +=
    `<text x="${(M.l + W - M.r) / 2}" y="${H - 3}" text-anchor="middle" class="t-muted">${fmt.label}${fmt.unit ? ' (' + fmt.unit + ')' : ''}</text>`;
  counts.forEach((c, i) => {
    const bx = x(edges[i]) + 1,
      bw = Math.max(1, x(edges[i + 1]) - x(edges[i]) - 2);
    const by = y(c / n);
    g += `<g ${tipAttr(`<b>${fmt.fmt(edges[i])} – ${fmt.fmt(edges[i + 1])}</b><div class="tt-row"><span>Runs</span><span>${fmtN(c)} (${(c / n * 100).toFixed(1)}%)</span></div>`)}>
      <rect class="hit" x="${bx - 1}" y="${M.t}" width="${bw + 2}" height="${H - M.b - M.t}"/>
      <path class="bar" d="${topRoundedRect(bx, by, bw, H - M.b - by, 3)}"/></g>`;
  });
  const st = d.stats;
  const marks = [
    ['P50', st.p50],
    ['P80', st.p80]
  ];
  marks.forEach(([l, v], i) => {
    if (x1 <= x0) return;
    const px = x(v);
    g +=
      `<line x1="${px}" x2="${px}" y1="${M.t - 4}" y2="${H - M.b}" stroke="var(--text-secondary)" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    const anchor = px > W - 90 ? 'end' : 'start';
    g +=
      `<text x="${px + (anchor === 'end' ? -5 : 5)}" y="${M.t - 10 + i * 13}" text-anchor="${anchor}" class="t-primary">${l} ${fmt.fmt(v)}</text>`;
  });
  return `<svg width="${W}" height="${H}" role="img" aria-label="Histogram of ${fmt.label}">${g}</svg>`;
}

function chartSCurve(r, m, W) {
  const d = r.mc[m],
    H = 230,
    M = { l: 44, r: 16, t: 14, b: 34 };
  const pts = d.cdf;
  const x0 = pts[0][0],
    x1 = pts[pts.length - 1][0];
  const x = scale(x0, x1, M.l, W - M.r),
    y = scale(0, 1, H - M.b, M.t);
  const fmt = METRICS[m];
  let g = '<g class="grid">' + [0, .25, .5, .75, 1].map((t) =>
    `<line x1="${M.l}" x2="${W - M.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('') + '</g>';
  g += [0, .25, .5, .75, 1].map((t) => `<text x="${M.l - 6}" y="${y(t) + 4}" text-anchor="end">${t * 100}%</text>`)
    .join('');
  const xt = niceTicks(x0, x1, Math.max(3, Math.floor(W / 90)));
  g += `<g class="axis"><line x1="${M.l}" x2="${W - M.r}" y1="${H - M.b}" y2="${H - M.b}"/></g>`;
  g += xt.filter((t) => t >= x0 && t <= x1).map((t) =>
    `<text x="${x(t)}" y="${H - M.b + 16}" text-anchor="middle">${fmt.tick(t)}</text>`).join('');
  g +=
    `<text x="${(M.l + W - M.r) / 2}" y="${H - 3}" text-anchor="middle" class="t-muted">${fmt.label}${fmt.unit ? ' (' + fmt.unit + ')' : ''}</text>`;
  const line = pts.map(([v, p], i) => `${i ? 'L' : 'M'}${x(v).toFixed(1)},${y(p).toFixed(1)}`).join('');
  g += `<path d="${line}L${x(x1)},${y(0)}L${x(x0)},${y(0)}Z" fill="var(--series-1)" opacity=".10"/>`;
  g += `<path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>`;
  const st = d.stats;
  [
    ['P10', .1, st.p10],
    ['P50', .5, st.p50],
    ['P80', .8, st.p80],
    ['P90', .9, st.p90]
  ].forEach(([l, p, v]) => {
    const px = x(v),
      py = y(p);
    g += `<line x1="${M.l}" x2="${px}" y1="${py}" y2="${py}" stroke="var(--axis)" stroke-dasharray="2 3"/>`;
    g +=
    `<circle cx="${px}" cy="${py}" r="4.5" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="2"/>`;
    // P50 sits below-right of the rising curve, P80 above-left: both land in empty space
    if (l === 'P50') g +=
      `<text x="${px + 9}" y="${py + 14}" text-anchor="${px > W - 110 ? 'end' : 'start'}" class="t-primary">${l} ${fmt.fmt(v)}</text>`;
    if (l === 'P80') g +=
      `<text x="${px - 9}" y="${py - 6}" text-anchor="end" class="t-primary">${l} ${fmt.fmt(v)}</text>`;
  });
  g +=
    `<g class="xhair" style="display:none"><line y1="${M.t}" y2="${H - M.b}" stroke="var(--text-secondary)" stroke-width="1"/><circle r="4.5" fill="var(--surface-1)" stroke="var(--series-1)" stroke-width="2"/></g>`;
  g += `<rect class="hit" x="${M.l}" y="${M.t}" width="${W - M.l - M.r}" height="${H - M.t - M.b}"/>`;
  return `<svg width="${W}" height="${H}" data-x0="${x0}" data-x1="${x1}" data-l="${M.l}" data-r="${W - M.r}" data-t="${M.t}" data-b="${H - M.b}" role="img" aria-label="S-curve of ${fmt.label}">${g}</svg>`;
}

function bindSCurve(el, r, m) {
  const svg = $('svg', el),
    hit = $('.hit', svg),
    xh = $('.xhair', svg);
  const ds = svg.dataset,
    pts = r.mc[m].cdf,
    fmt = METRICS[m];
  const L = +ds.l,
    R = +ds.r,
    T = +ds.t,
    B = +ds.b,
    x0 = +ds.x0,
    x1 = +ds.x1;
  hit.addEventListener('mousemove', (e) => {
    const rect = svg.getBoundingClientRect();
    const px = Math.max(L, Math.min(R, e.clientX - rect.left));
    const v = x0 + (px - L) / (R - L || 1) * (x1 - x0);
    let p = 1;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][0] >= v) {
        const [va, pa] = pts[i - 1], [vb, pb] = pts[i];
        p = vb > va ? pa + (v - va) / (vb - va) * (pb - pa) : pb;
        break;
      }
    }
    if (v <= pts[0][0]) p = 0;
    const py = B - p * (B - T);
    xh.style.display = '';
    $('line', xh).setAttribute('x1', px);
    $('line', xh).setAttribute('x2', px);
    $('circle', xh).setAttribute('cx', px);
    $('circle', xh).setAttribute('cy', py);
    showTip(
      `<b>${(p * 100).toFixed(0)}% confidence</b><div class="tt-row"><span>${fmt.label} ≤</span><span>${fmt.fmt(v)}</span></div>`,
      e);
  });
  hit.addEventListener('mouseleave', () => { xh.style.display = 'none';
    hideTip(); });
}

function chartThree(r, m, W) {
  const P = r.points,
    st = r.mc[m].stats,
    fmt = METRICS[m];
  const H = 132,
    M = { l: 16, r: 16 },
    axisY = 78;
  const vals = [P.low[m], P.likely[m], P.pert[m], P.high[m], st.p5, st.p95];
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  if (hi - lo < 1e-9) { lo -= 1;
    hi += 1; }
  const pad = (hi - lo) * 0.06;
  const x = scale(lo - pad, hi + pad, M.l, W - M.r);
  let g = '';
  const xt = niceTicks(lo - pad, hi + pad, Math.max(3, Math.floor(W / 100)));
  g += `<g class="axis"><line x1="${M.l}" x2="${W - M.r}" y1="${axisY}" y2="${axisY}"/></g>`;
  g += xt.map((t) =>
    `<line x1="${x(t)}" x2="${x(t)}" y1="${axisY + 12}" y2="${axisY + 16}" stroke="var(--axis)"/><text x="${x(t)}" y="${axisY + 29}" text-anchor="middle">${fmt.tick(t)}</text>`
    ).join('');
  // MC bands
  const band = (a, b, h, fill, label) =>
    `<rect x="${x(a)}" y="${axisY - h / 2}" width="${Math.max(1, x(b) - x(a))}" height="${h}" rx="4" fill="${fill}" ${tipAttr(label)}/>`;
  g += band(st.p5, st.p95, 22, 'var(--series-1-soft)',
    `<b>Monte Carlo P5–P95</b><div class="tt-row"><span>${fmt.fmt(st.p5)}</span><span>${fmt.fmt(st.p95)}</span></div>`
    );
  g += band(st.p10, st.p90, 22, 'var(--series-1-mid)',
    `<b>Monte Carlo P10–P90</b><div class="tt-row"><span>${fmt.fmt(st.p10)}</span><span>${fmt.fmt(st.p90)}</span></div>`
    );
  g +=
    `<line x1="${x(st.p50)}" x2="${x(st.p50)}" y1="${axisY - 15}" y2="${axisY + 15}" stroke="var(--series-1)" stroke-width="3" stroke-linecap="round" ${tipAttr(`<b>MC P50</b> ${fmt.fmt(st.p50)}`)}/>`;
  // markers
  const marks = [
    ['Low', P.low[m], 'M-5,0L0,-5L5,0L0,5Z'],
    ['Likely', P.likely[m], 'circle'],
    ['PERT', P.pert[m], 'M-5.5,4L0,-5L5.5,4Z'],
    ['High', P.high[m], 'M-5,0L0,-5L5,0L0,5Z']
  ];
  // label placement: alternate above rows to avoid collisions
  const placed = [];
  marks.sort((a, b) => a[1] - b[1]).forEach(([l, v, shape]) => {
    const px = x(v);
    let row = 0;
    while (placed.some((p) => p.row === row && Math.abs(p.x - px) < 92)) row++;
    placed.push({ x: px, row });
    const ly = axisY - 26 - row * 15;
    g += `<line x1="${px}" x2="${px}" y1="${ly + 3}" y2="${axisY - 7}" stroke="var(--border-strong)"/>`;
    const sh = shape === 'circle' ?
      `<circle r="5.5" fill="var(--text-primary)" stroke="var(--surface-1)" stroke-width="2"/>` :
      `<path d="${shape}" fill="var(--text-primary)" stroke="var(--surface-1)" stroke-width="1.5"/>`;
    g +=
      `<g transform="translate(${px},${axisY})" ${tipAttr(`<b>${l}</b> ${fmt.fmt(v)}`)}><circle r="10" fill="transparent"/>${sh}</g>`;
    const anchor = px < 60 ? 'start' : px > W - 60 ? 'end' : 'middle';
    g +=
      `<text x="${px}" y="${ly}" text-anchor="${anchor}"><tspan class="t-primary">${l}</tspan> ${fmt.fmt(v)}</text>`;
  });
  return `<svg width="${W}" height="${H}" role="img" aria-label="Three-point estimate">${g}</svg>
    <div class="legend"><span><i style="background:var(--series-1-mid)"></i>MC P10–P90</span><span><i style="background:var(--series-1-soft)"></i>MC P5–P95</span><span><i style="background:var(--series-1);width:3px"></i>MC P50</span><span>◆ low / high · ● likely · ▲ PERT (L+4M+H)/6</span></div>`;
}

function chartComposition(r, W) {
  const b = r.breakdown || {};
  const parts = [
    ['New code', b.new_esloc || 0, 'var(--series-1)'],
    ['Adapted existing', b.adapted_esloc || 0, 'var(--series-2)'],
    ['Holchin growth', b.growth_esloc || 0, 'var(--series-3)']
  ];
  const tot = parts.reduce((a, p) => a + p[1], 0);
  if (!tot) return '<div class="empty" style="padding:30px">No size entered yet.</div>';
  const H = 44,
    bw = W;
  let x = 0,
    g = '';
  parts.forEach(([l, v, c], i) => {
    if (!v) return;
    const w = v / tot * bw;
    const gap = 2;
    const rx = 4;
    g +=
      `<rect x="${x + (x ? gap / 2 : 0)}" y="4" width="${Math.max(1, w - (x ? gap / 2 : 0) - (x + w < bw - 0.5 ? gap / 2 : 0))}" height="28" rx="${rx}" fill="${c}" ${tipAttr(`<b>${l}</b><div class="tt-row"><span>ESLOC</span><span>${fmtN(v)}</span></div><div class="tt-row"><span>Share</span><span>${(v / tot * 100).toFixed(1)}%</span></div>`)}/>`;
    if (w > 70) g +=
      `<text x="${x + 8}" y="22" fill="#fff" style="fill:#fff;font-weight:600">${(v / tot * 100).toFixed(0)}%</text>`;
    x += w;
  });
  return `<svg width="${W}" height="${H}" role="img" aria-label="Size composition">${g}</svg>
    <div class="legend">${parts.map(([l, v, c]) => `<span><i style="background:${c}"></i>${l}: <b>${fmtN(v)}</b></span>`).join('')}<span>Total: <b>${fmtN(tot)} ESLOC</b></span></div>`;
}

function chartContrib(r, W) {
  const kids = (r.children || []).slice().sort((a, b) => b.mean - a.mean);
  if (!kids.length)
  return '<div class="empty" style="padding:30px">This group is empty. Add components, or drag them here from the tree.</div>';
  const rowH = 28,
    M = { t: 6, b: 24 },
    labelW = Math.min(220, Math.max(110, W * 0.28)),
    valW = 120;
  const H = M.t + kids.length * rowH + M.b;
  const xmax = Math.max(...kids.map((k) => k.p90)) || 1;
  const x = scale(0, xmax * 1.04, labelW, W - valW);
  const xt = niceTicks(0, xmax * 1.04, Math.max(3, Math.floor((W - labelW - valW) / 90)));
  let g = '<g class="grid">' + xt.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${M.t}" y2="${H - M.b}"/>`).join('') +
    '</g>';
  g += xt.map((t) => `<text x="${x(t)}" y="${H - 8}" text-anchor="middle">${fmtCompact(t)}</text>`).join('');
  kids.forEach((k, i) => {
    const cy = M.t + i * rowH + rowH / 2;
    const name = k.name.length > 30 ? k.name.slice(0, 29) + '…' : k.name;
    const icon = k.type === 'group' ? '▸ ' : '';
    g += `<g class="clickable" data-goto="${esc(k.id)}" ${tipAttr(`<b>${esc(k.name)}</b><div class="tt-row"><span>P10</span><span>${fmtN(k.p10, 1)} PM</span></div><div class="tt-row"><span>P50</span><span>${fmtN(k.p50, 1)} PM</span></div><div class="tt-row"><span>P90</span><span>${fmtN(k.p90, 1)} PM</span></div><div class="tt-row"><span>Most likely</span><span>${fmtN(k.likely, 1)} PM</span></div><div class="tt-row"><span>Share of mean</span><span>${(k.mean / (r.mc.effort_pm.stats.mean || 1) * 100).toFixed(1)}%</span></div>`)}>
      <rect x="0" y="${cy - rowH / 2}" width="${W}" height="${rowH}" fill="transparent"/>
      <text x="${labelW - 10}" y="${cy + 4}" text-anchor="end" class="t-primary" style="font-weight:500">${icon}${esc(name)}</text>
      <path class="bar" d="${rightRoundedRect(x(0), cy - 7, Math.max(1, x(k.p50) - x(0)), 14, 4)}"/>
      <line x1="${x(k.p10)}" x2="${x(k.p90)}" y1="${cy}" y2="${cy}" stroke="var(--text-primary)" stroke-width="1.5"/>
      <line x1="${x(k.p10)}" x2="${x(k.p10)}" y1="${cy - 5}" y2="${cy + 5}" stroke="var(--text-primary)" stroke-width="1.5"/>
      <line x1="${x(k.p90)}" x2="${x(k.p90)}" y1="${cy - 5}" y2="${cy + 5}" stroke="var(--text-primary)" stroke-width="1.5"/>
      <text x="${W - valW + 10}" y="${cy + 4}">${fmtN(k.p50, 1)} PM</text></g>`;
  });
  return `<svg width="${W}" height="${H}" role="img" aria-label="Contribution by child">${g}</svg>
    <div class="legend"><span><i style="background:var(--series-1)"></i>Effort P50 (PM)</span><span>├─┤ P10–P90</span></div>`;
}

function chartBases(r, n, W) {
  const b = r.points.likely.bases || {};
  const basis = n.attributes.size_basis || 'sloc';
  const items = [
    ['sloc', 'SLOC'],
    ['requirements', 'Requirements'],
    ['use_cases', 'Use cases']
  ];
  const vmax = Math.max(1, ...items.map(([k]) => b[k] || 0));
  const rowH = 30,
    labelW = 100,
    valW = 90,
    H = items.length * rowH + 4;
  const x = scale(0, vmax, labelW, W - valW);
  let g = '';
  items.forEach(([k, l], i) => {
    const v = b[k] || 0,
      cy = i * rowH + rowH / 2;
    const on = basis === k || basis === 'max' || basis === 'average';
    g +=
      `<text x="${labelW - 10}" y="${cy + 4}" text-anchor="end" class="${basis === k ? 't-primary' : ''}">${l}</text>`;
    g +=
      `<rect x="${labelW}" y="${cy - 8}" width="${W - valW - labelW}" height="16" rx="4" fill="var(--surface-2)"/>`;
    if (v) g +=
      `<path d="${rightRoundedRect(labelW, cy - 8, x(v) - labelW, 16, 4)}" fill="${on ? 'var(--series-1)' : 'var(--series-1-mid)'}" ${tipAttr(`<b>${l}</b> ${fmtN(v)} ESLOC`)}/>`;
    g += `<text x="${W - valW + 10}" y="${cy + 4}">${v ? fmtN(v) : 'no data'}</text>`;
  });
  return `<svg width="${W}" height="${H}" role="img" aria-label="Size by basis">${g}</svg>`;
}

function chartMults(r, W) {
  const ents = Object.entries(r.multipliers || {});
  const rowH = 26,
    labelW = Math.min(190, W * 0.4),
    valW = 56,
    H = ents.length * rowH + 22;
  const lo = Math.min(0.6, ...ents.map((e) => e[1])),
    hi = Math.max(1.5, ...ents.map((e) => e[1]));
  const x = scale(lo, hi, labelW, W - valW);
  let g = `<line x1="${x(1)}" x2="${x(1)}" y1="0" y2="${H - 18}" stroke="var(--axis)"/>`;
  g +=
    `<text x="${x(1)}" y="${H - 4}" text-anchor="middle">×1.0</text><text x="${x(lo)}" y="${H - 4}" text-anchor="start" class="t-muted">less effort</text><text x="${x(hi)}" y="${H - 4}" text-anchor="end" class="t-muted">more effort</text>`;
  ents.forEach(([l, v], i) => {
    const cy = i * rowH + rowH / 2;
    const a = Math.min(x(1), x(v)),
      w = Math.abs(x(v) - x(1));
    g +=
    `<text x="${labelW - 10}" y="${cy + 4}" text-anchor="end">${esc(l === 'language' ? 'Language' : l)}</text>`;
    if (w > 0.5) g +=
      `<rect x="${a}" y="${cy - 7}" width="${w}" height="14" rx="3" fill="${v > 1 ? 'var(--div-pos)' : 'var(--div-neg)'}" ${tipAttr(`<b>${esc(l)}</b> ×${v.toFixed(3)}`)}/>`;
    else g += `<circle cx="${x(1)}" cy="${cy}" r="3" fill="var(--axis)"/>`;
    g += `<text x="${W - valW + 8}" y="${cy + 4}" class="${v !== 1 ? 't-primary' : ''}">×${v.toFixed(2)}</text>`;
  });
  return `<svg width="${W}" height="${H}" role="img" aria-label="Effort multipliers">${g}</svg>`;
}

// ----------------------------------------------------------------------- tooltip
function showTip(html, e) {
  const t = $('#tooltip');
  t.innerHTML = html;
  t.classList.add('show');
  const w = t.offsetWidth,
    h = t.offsetHeight;
  let x = e.clientX + 14,
    y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  t.style.left = x + 'px';
  t.style.top = y + 'px';
}

function hideTip() { $('#tooltip').classList.remove('show'); }
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el) showTip(el.dataset.tip, e);
  else if (!e.target.closest?.('.hit')) hideTip();
});

// ======================================================================= component editor
function renderEditor(n) {
  const ed = $('#editor');
  const attrs = n.attributes = n.attributes || {};
  const sections = new Map();
  for (const p of S.schema) {
    if (!sections.has(p.section)) sections.set(p.section, []);
    sections.get(p.section).push(p);
  }
  const known = new Set(S.schema.map((p) => p.key));
  const custom = Object.keys(attrs).filter((k) => !known.has(k));
  const openState = renderEditor.open || (renderEditor
.open = { 'General': true, 'Existing baseline': true, 'Modification of existing': true, 'New development': true });
  let html = '';
  for (const [sec, params] of sections) {
    html +=
      `<details class="section" data-sec="${esc(sec)}" ${openState[sec] ? 'open' : ''}><summary>${esc(sec)}<span class="count">${sectionSummary(sec, attrs)}</span></summary><div class="fields">` +
      params.map((p) => fieldHtml(p, attrs[p.key])).join('') + '</div></details>';
  }
  html += `<details class="section" data-sec="Custom attributes" ${openState['Custom attributes'] ? 'open' : ''}><summary>Custom attributes<span class="count">${custom.length || ''}</span></summary><div class="fields">
    <div class="help" style="margin-top:-4px">Free-form fields saved with the component in the YAML file.</div>
    ${custom.map((k) => `<div class="custom-row" data-ckey="${esc(k)}"><input value="${esc(k)}" data-cname aria-label="Field name"><input value="${esc(typeof attrs[k] === 'object' ? JSON.stringify(attrs[k]) : attrs[k] ?? '')}" data-cval aria-label="Field value"><button data-cdel title="Remove field" aria-label="Remove field">✕</button></div>`).join('')}
    <div class="custom-row"><input id="newCKey" placeholder="field name"><input id="newCVal" placeholder="value"><button id="addCustom" title="Add field" aria-label="Add field">＋</button></div>
  </div></details>`;
  ed.innerHTML = html;

  $$('details.section', ed).forEach((d) => d.addEventListener('toggle', () => { openState[d.dataset.sec] = d.open; }));
  const set = (key, val) => mutate(() => { attrs[key] = val; }, { coalesce: n.id + key, tree: false });
  for (const p of S.schema) {
    const f = $(`.field[data-key="${CSS.escape(p.key)}"]`, ed);
    if (!f) continue;
    if (p.type === 'tri' || p.type === 'tri_percent') {
      const inputs = $$('input[data-k]', f);
      const upd = () => {
        const v = {};
        inputs.forEach((i) => { v[i.dataset.k] = i.value === '' ? 0 : +i.value; });
        const bad = !(v.low <= v.likely && v.likely <= v.high);
        inputs.forEach((i) => i.classList.toggle('bad', bad));
        $('svg', f).outerHTML = triSvg(v);
        $('.pert-note', f).innerHTML = triNote(v, p);
        set(p.key, v);
        refreshSummary(ed, p.section, attrs);
      };
      inputs.forEach((i) => i.addEventListener('input', upd));
      $('[data-spread]', f)?.addEventListener('click', () => {
        const lk = +inputs[1].value || 0;
        const pct = p.type === 'tri_percent';
        inputs[0].value = round(Math.max(0, lk * 0.8));
        inputs[2].value = round(pct ? Math.min(100, lk * 1.5) : lk * 1.5);
        upd();
      });
    } else {
      const inp = $('input,select,textarea', f);
      inp.addEventListener(p.type === 'select' ? 'change' : 'input', () => {
        let v = inp.value;
        if (['number', 'int', 'percent'].includes(p.type)) v = v === '' ? (p.default === null ? null : 0) : (p
          .type === 'int' ? Math.round(+v) : +v);
        set(p.key, v);
        refreshSummary(ed, p.section, attrs);
      });
    }
  }
  // custom attributes
  $$('.custom-row[data-ckey]', ed).forEach((row) => {
    const k = row.dataset.ckey;
    const parse = (s) => (s !== '' && !isNaN(+s) ? +s : s);
    $('[data-cval]', row).addEventListener('input', (e) => set(k, parse(e.target.value)));
    $('[data-cname]', row).addEventListener('change', (e) => {
      const nk = e.target.value.trim();
      if (!nk || nk === k || nk in attrs) { e.target.value = k; return; }
      mutate(() => { const v = attrs[k];
        delete attrs[k];
        attrs[nk] = v; }, { tree: false, main: true });
    });
    $('[data-cdel]', row).addEventListener('click', () => mutate(() => { delete attrs[k]; }, { tree: false,
      main: true }));
  });
  $('#addCustom', ed).addEventListener('click', () => {
    const k = $('#newCKey', ed).value.trim(),
      v = $('#newCVal', ed).value;
    if (!k) return toast('Enter a field name', true);
    if (known.has(k) || k in attrs) return toast('That field already exists', true);
    renderEditor.open['Custom attributes'] = true;
    mutate(() => { attrs[k] = v !== '' && !isNaN(+v) ? +v : v; }, { tree: false, main: true });
  });
}
const round = (v) => Math.round(v * 100) / 100;

function fieldHtml(p, val) {
  const help = p.help ? `<div class="help">${esc(p.help)}</div>` : '';
  const unit = p.type === 'percent' ? '%' : p.unit || '';
  let ctl;
  if (p.type === 'tri' || p.type === 'tri_percent') {
    const v = { low: 0, likely: 0, high: 0, ...(typeof val === 'object' && val ? val : { low: +val || 0, likely: +val ||
          0, high: +val || 0 }) };
    const max = p.type === 'tri_percent' ? 'max="100"' : '';
    const bad = !(v.low <= v.likely && v.likely <= v.high) ? 'bad' : '';
    ctl = `<div class="tri">${['low', 'likely', 'high'].map((k) => `<div><div class="sub">${k === 'likely' ? 'Most likely' : k}</div><input type="number" min="0" ${max} step="any" data-k="${k}" class="${bad}" value="${esc(v[k])}" aria-label="${esc(p.label)} ${k}"></div>`).join('')}${triSvg(v)}</div>
      <div class="pert-note">${triNote(v, p)}</div>`;
    return `<div class="field" data-key="${esc(p.key)}"><label class="lbl"><span>${esc(p.label)}${p.type === 'tri_percent' ? ' (%)' : unit ? ` (${esc(unit)})` : ''}</span><button data-spread type="button" style="padding:0 6px;font-size:11px" title="Fill low/high from most likely (−20% / +50%)">spread</button></label>${ctl}${help}</div>`;
  }
  if (p.type === 'select') {
    const opts = (p.options || []).slice();
    if (val != null && !opts.includes(val)) opts.push(val);
    ctl =
      `<select aria-label="${esc(p.label)}">${opts.map((o) => `<option value="${esc(o)}" ${o === val ? 'selected' : ''}>${esc(p.option_labels?.[o] ?? o)}${!(p.options || []).includes(o) ? ' (unknown)' : ''}</option>`).join('')}</select>`;
  } else if (p.type === 'textarea') {
    ctl = `<textarea aria-label="${esc(p.label)}">${esc(val ?? '')}</textarea>`;
  } else if (p.type === 'text') {
    ctl = `<input type="text" value="${esc(val ?? '')}" aria-label="${esc(p.label)}">`;
  } else {
    const attrs =
      `${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : p.type === 'percent' ? 'max="100"' : ''} step="${p.step ?? (p.type === 'int' ? 1 : 'any')}"`;
    ctl =
      `<div class="unit-wrap"><input type="number" ${attrs} value="${val ?? ''}" placeholder="${p.default === null ? 'default' : ''}" aria-label="${esc(p.label)}">${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</div>`;
  }
  return `<div class="field" data-key="${esc(p.key)}"><label class="lbl"><span>${esc(p.label)}</span></label>${ctl}${help}</div>`;
}

function triSvg(v) {
  const W = 64,
    H = 30;
  const lo = +v.low,
    m = +v.likely,
    hi = +v.high;
  if (!(hi > lo) || !(lo <= m && m <= hi))
  return `<svg width="${W}" height="${H}" aria-hidden="true"><line x1="4" x2="${W - 4}" y1="${H - 3}" y2="${H - 3}" stroke="var(--axis)"/><line x1="${W / 2}" x2="${W / 2}" y1="4" y2="${H - 3}" stroke="var(--series-1)" stroke-width="2"/></svg>`;
  const x = scale(lo, hi, 4, W - 4);
  return `<svg width="${W}" height="${H}" aria-hidden="true"><path d="M${x(lo)},${H - 3}L${x(m)},4L${x(hi)},${H - 3}Z"/></svg>`;
}

function triNote(v, p) {
  const pert = (+v.low + 4 * +v.likely + +v.high) / 6;
  const sd = (+v.high - +v.low) / 6;
  const u = p.type === 'tri_percent' ? '%' : '';
  return `PERT mean ${fmtN(pert, pert < 100 && pert % 1 ? 1 : 0)}${u} · σ≈${fmtN(sd, sd < 100 && sd % 1 ? 1 : 0)}${u}`;
}

function sectionSummary(sec, a) {
  const tri = (k) => { const v = a[k]; return v && typeof v === 'object' ? +v.likely || 0 : +v || 0; };
  if (sec === 'General') return esc([a.language, a.maturity].filter(Boolean).join(' · '));
  if (sec === 'Existing baseline') return a.existing_sloc ? fmtCompact(+a.existing_sloc) + ' SLOC' : '';
  if (sec === 'New development') return tri('new_sloc') ? fmtCompact(tri('new_sloc')) + ' SLOC' : tri(
    'new_requirements') ? fmtN(tri('new_requirements')) + ' reqs' : '';
  if (sec === 'Modification of existing') return tri('percent_code_modified') ? `CM ${tri('percent_code_modified')}%` :
    '';
  return '';
}

function refreshSummary(ed, sec, attrs) {
  const d = $(`details[data-sec="${CSS.escape(sec)}"] .count`, ed);
  if (d) d.innerHTML = sectionSummary(sec, attrs);
}

// ======================================================================= modals
function openModal(html, onMount) {
  const bd = $('#modal'),
    m = $('.modal', bd);
  m.innerHTML = html;
  bd.hidden = false;
  const close = () => { bd.hidden = true;
    m.innerHTML = '';
    document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation();
      close(); } };
  document.addEventListener('keydown', onKey, true);
  bd.onclick = (e) => { if (e.target === bd) close(); };
  $$('[data-close]', m).forEach((b) => b.addEventListener('click', close));
  onMount?.(m, close);
  ($('[autofocus]', m) || $('input,button', m))?.focus();
}

function confirmDiscard() { return !S.dirty || confirm('You have unsaved changes. Discard them?'); }

async function doSave(path) {
  try {
    const r = await api('/api/save', { project: S.project, path: path || S.file });
    S.file = r.file;
    S.dirty = false;
    renderStatus();
    toast('Saved to ' + r.file);
    return true;
  } catch (e) { toast('Save failed: ' + e.message, true); return false; }
}

function saveAsDialog() {
  const def = S.file || ((S.project.project?.name || 'estimate').replace(/[^\w.-]+/g, '_') + '.yaml');
  openModal(`<header><h2>Save as</h2></header><div class="body">
    <div class="field"><label class="lbl">File path on this machine (relative paths are relative to where the server was started)</label>
    <input id="saPath" class="mono" value="${esc(def)}" autofocus></div>
    <p class="help">To save a copy elsewhere via the browser instead, use <b>Download</b>.</p></div>
    <footer><button data-close>Cancel</button><button class="primary" id="saGo">Save</button></footer>`, (m,
  close) => {
    const go = async () => { if (await doSave($('#saPath', m).value.trim())) close(); };
    $('#saGo', m).addEventListener('click', go);
    $('#saPath', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
}

function openDialog() {
  if (!confirmDiscard()) return;
  openModal(`<header><h2>Open project</h2></header><div class="body">
    <div class="field"><label class="lbl">Open a YAML file from this machine by path (Save will write back to it)</label>
    <div style="display:flex;gap:8px"><input id="opPath" class="mono" placeholder="/path/to/project.yaml" value="${esc(S.file || '')}" autofocus><button class="primary" id="opGo">Open</button></div></div>
    <p class="help" style="margin:16px 0 6px">…or upload a file through the browser (you'll be asked for a path when saving):</p>
    <button id="opUpload">Choose file…</button></div>
    <footer><button data-close>Cancel</button></footer>`, (m, close) => {
    const go = async () => {
      try {
        const r = await api('/api/open', { path: $('#opPath', m).value.trim() });
        await loadProject(r.project, r.file);
        close();
        toast('Opened ' + r.file);
      } catch (e) { toast('Open failed: ' + e.message, true); }
    };
    $('#opGo', m).addEventListener('click', go);
    $('#opPath', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    $('#opUpload', m).addEventListener('click', () => { close();
      $('#fileInput').click(); });
  });
}
async function importFile(file) {
  try {
    const text = await file.text();
    const r = await api('/api/parse', text, { raw: true });
    await loadProject(r.project, null);
    S.dirty = true;
    renderStatus();
    toast(`Loaded ${file.name} — use Save as to choose where to save`);
  } catch (e) { toast('Could not read YAML: ' + e.message, true); }
}
async function download() {
  try {
    const text = await api('/api/dump', S.project, { text: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/yaml' }));
    a.download = (S.project.project?.name || 'estimate').replace(/[^\w.-]+/g, '_') + '.yaml';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  } catch (e) { toast('Download failed: ' + e.message, true); }
}

// ----------------------------------------------------------------------- settings dialog
function settingsDialog() {
  const draft = clone(S.settings);
  draft.maturity.forEach((m) => (m._orig = m.name));
  draft.languages.forEach((l) => (l._orig = l.name));
  const multRows = Object.entries(draft.multipliers).map(([k, m]) => ({ _orig: k, key: k, label: m.label, default: m
      .default, options: Object.entries(m.options).map(([o, f]) => `${o}=${f}`).join(', ') }));
  let tab = 'general',
    yamlText = null,
    yamlDirty = false;
  const num = (path, label, step = 'any') => {
    const v = path.split('.').reduce((o, k) => o?.[k], draft);
    return `<div class="field"><label class="lbl">${label}</label><input type="number" step="${step}" data-path="${path}" value="${v ?? ''}"></div>`;
  };
  const body = () => {
    if (tab === 'general')
    return `
      <h4>Cost & effort</h4><div class="grid-form">
        <div class="field"><label class="lbl">Currency symbol</label><input data-path="currency" value="${esc(draft.currency)}"></div>
        ${num('labour_rate_per_hour', 'Labour rate per hour')}${num('hours_per_pm', 'Hours per person-month')}
        ${num('effort.A', 'Effort coefficient A')}${num('effort.B', 'Effort exponent B (diseconomy of scale)')}
        ${num('schedule.C', 'Schedule coefficient C')}${num('schedule.D', 'Schedule exponent D')}</div>
      <p class="help">Effort PM = A × KESLOC<sup>B</sup> × multipliers. Schedule months = C × PM<sup>D</sup>.</p>
      <h4>Adaptation of existing code</h4><div class="grid-form">
        ${num('adaptation_weights.design', 'Design weight (DM)')}${num('adaptation_weights.code', 'Code weight (CM)')}${num('adaptation_weights.integration', 'Integration weight (IM)')}</div>
      <p class="help">Adapted ESLOC = existing SLOC × (wDM·DM + wCM·CM + wIM·IM).</p>
      <h4>Sizing conversions</h4><div class="grid-form">
        ${num('sizing.sloc_per_requirement', 'SLOC per requirement')}${num('sizing.sloc_per_use_case', 'SLOC per use case')}</div>
      <h4>Monte Carlo</h4><div class="grid-form">
        ${num('monte_carlo.iterations', 'Iterations', 1)}${num('monte_carlo.seed', 'Random seed', 1)}${num('monte_carlo.correlation', 'Correlation between components (0–1)')}</div>
      <p class="help">Correlation models common-cause risk: 0 treats components as independent (narrow roll-up), 1 makes them move together.</p>`;
    if (tab === 'maturity') return `<p class="help">Holchin growth: % growth from today's estimate to delivered size, by programme maturity. Applied separately to new and adapted code. <b>Defaults are illustrative — calibrate to your own growth data.</b></p>
      <table class="edit"><thead><tr><th>Maturity</th><th colspan="3">New code growth % (low / likely / high)</th><th colspan="3">Adapted code growth % (low / likely / high)</th><th></th></tr></thead><tbody>
      ${draft.maturity.map((m, i) => `<tr data-i="${i}"><td><input data-f="name" value="${esc(m.name)}"></td>${['growth_new', 'growth_reused'].map((g) => ['low', 'likely', 'high'].map((k) => `<td><input type="number" step="any" data-g="${g}" data-k="${k}" value="${m[g]?.[k] ?? 0}"></td>`).join('')).join('')}<td><button data-del="${i}" aria-label="Remove">✕</button></td></tr>`).join('')}
      </tbody></table><button id="addRow" style="margin-top:8px">＋ Add maturity level</button>`;
    if (tab === 'languages') return `<p class="help">The language effort factor multiplies effort (1.0 = baseline).</p>
      <table class="edit"><thead><tr><th>Language</th><th>Effort factor</th><th></th></tr></thead><tbody>
      ${draft.languages.map((l, i) => `<tr data-i="${i}"><td><input data-f="name" value="${esc(l.name)}"></td><td><input type="number" step="any" data-f="effort_factor" value="${l.effort_factor}"></td><td><button data-del="${i}" aria-label="Remove">✕</button></td></tr>`).join('')}
      </tbody></table><button id="addRow" style="margin-top:8px">＋ Add language</button>`;
    if (tab === 'mults') return `<p class="help">Each driver appears as a dropdown under <b>Effort adjustment</b> on every component and multiplies effort. Options are <span class="mono">Name=factor</span>, comma-separated.</p>
      <table class="edit"><thead><tr><th style="width:16%">Key</th><th style="width:22%">Label</th><th style="width:14%">Default</th><th>Options</th><th></th></tr></thead><tbody>
      ${multRows.map((r, i) => `<tr data-i="${i}"><td><input class="mono" data-f="key" value="${esc(r.key)}"></td><td><input data-f="label" value="${esc(r.label)}"></td><td><input data-f="default" value="${esc(r.default)}"></td><td><input class="mono" data-f="options" value="${esc(r.options)}"></td><td><button data-del="${i}" aria-label="Remove">✕</button></td></tr>`).join('')}
      </tbody></table><button id="addRow" style="margin-top:8px">＋ Add effort driver</button>`;
    return `<p class="help">Edit the <span class="mono">settings:</span> block directly. Other keys in this text are ignored.</p><textarea class="yaml" id="yamlBox" spellcheck="false">${esc(yamlText ?? 'loading…')}</textarea>`;
  };
  openModal(
    `<header><h2>Model settings & calibration</h2><button data-close aria-label="Close">✕</button></header>
    <div class="body"><div class="tabs">${[['general', 'General'], ['maturity', 'Holchin growth'], ['languages', 'Languages'], ['mults', 'Effort drivers'], ['yaml', 'YAML']].map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</div><div id="tabBody"></div></div>
    <footer><button id="resetDefaults" style="margin-right:auto">Reset to defaults</button><button data-close>Cancel</button><button class="primary" id="applySettings">Apply</button></footer>`,
    (m, close) => {
      const draw = async () => {
        $$('[data-tab]', m).forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
        $('#tabBody', m).innerHTML = body();
        bindTab();
        if (tab === 'yaml' && yamlText === null) {
          const t = await api('/api/dump', { project: { name: 'settings' }, settings: stripPriv(collect()),
            tree: [] }, { text: true });
          yamlText = t.slice(t.indexOf('settings:'), t.indexOf('\ntree:'));
          $('#yamlBox', m).value = yamlText;
        }
      };
      const bindTab = () => {
        $$('[data-path]', m).forEach((i) => i.addEventListener('input', () => {
          const ks = i.dataset.path.split('.');
          let o = draft;
          ks.slice(0, -1).forEach((k) => (o = o[k] = o[k] || {}));
          o[ks[ks.length - 1]] = i.type === 'number' ? (i.value === '' ? null : +i.value) : i.value;
          yamlText = null;
        }));
        const list = tab === 'maturity' ? draft.maturity : tab === 'languages' ? draft.languages : multRows;
        $$('tr[data-i]', m).forEach((tr) => {
          const row = list[+tr.dataset.i];
          $$('input', tr).forEach((i) => i.addEventListener('input', () => {
            yamlText = null;
            if (i.dataset.g) { row[i.dataset.g] = row[i.dataset.g] || {};
              row[i.dataset.g][i.dataset.k] = +i.value; } else row[i.dataset.f] = i.type === 'number' ? +i
              .value : i.value;
          }));
        });
        $$('[data-del]', m).forEach((b) => b.addEventListener('click', () => { list.splice(+b.dataset.del, 1);
          yamlText = null;
          draw(); }));
        $('#addRow', m)?.addEventListener('click', () => {
          if (tab === 'maturity') list.push({ name: 'New level', growth_new: { low: 0, likely: 10, high: 25 },
            growth_reused: { low: 0, likely: 5, high: 15 } });
          else if (tab === 'languages') list.push({ name: 'New language', effort_factor: 1 });
          else list.push({ key: 'driver_' + (list.length + 1), label: 'New driver', default: 'Nominal',
            options: 'Low=0.9, Nominal=1, High=1.15' });
          yamlText = null;
          draw();
        });
        $('#yamlBox', m)?.addEventListener('input', (e) => { yamlText = e.target.value;
          yamlDirty = true; });
      };
      const collect = () => {
        const out = clone(draft);
        out.multipliers = {};
        for (const r of multRows) {
          const options = {};
          String(r.options).split(',').forEach((p) => { const [o, f] = p.split('='); if (o && o.trim()) options[o
              .trim()] = +f || 1; });
          const key = String(r.key).trim().replace(/\W+/g, '_') || 'driver';
          out.multipliers[key] = { label: r.label || key, default: options[r.default] != null ? r.default : Object
              .keys(options)[0], options };
        }
        return out;
      };
      $$('[data-tab]', m).forEach((b) => b.addEventListener('click', () => { if (tab === 'yaml' && yamlDirty) { if (!
            confirm('Discard YAML edits?')) return;
          yamlDirty = false; } tab = b.dataset.tab;
        yamlText = null;
        draw(); }));
      $('#resetDefaults', m).addEventListener('click', async () => {
        if (!confirm('Reset all settings to the built-in defaults?')) return;
        const d = await api('/api/defaults');
        applySettings(clone(d.settings), {}, {}, {});
        close();
      });
      $('#applySettings', m).addEventListener('click', async () => {
        let out;
        if (tab === 'yaml' && yamlDirty) {
          try { out = (await api('/api/parse', $('#yamlBox', m).value, { raw: true })).project.settings ||
            {}; } catch (e) { return toast('YAML error: ' + e.message, true); }
        } else out = collect();
        const renMat = {},
          renLang = {},
          renMult = {};
        (draft.maturity || []).forEach((x) => { if (x._orig && x._orig !== x.name) renMat[x._orig] = x.name; });
        (draft.languages || []).forEach((x) => { if (x._orig && x._orig !== x.name) renLang[x._orig] = x
            .name; });
        multRows.forEach((r) => { const k = String(r.key).trim().replace(/\W+/g, '_'); if (r._orig && r
            ._orig !== k) renMult[r._orig] = k; });
        applySettings(stripPriv(out), renMat, renLang, renMult);
        close();
      });
      draw();
    });
}

function stripPriv(s) {
  s = clone(s);
  (s.maturity || []).forEach((x) => delete x._orig);
  (s.languages || []).forEach((x) => delete x._orig);
  return s;
}
async function applySettings(settings, renMat, renLang, renMult) {
  mutate(() => {
    S.project.settings = settings;
    forEachComponent((c) => {
      const a = c.attributes;
      if (renMat[a.maturity]) a.maturity = renMat[a.maturity];
      if (renLang[a.language]) a.language = renLang[a.language];
      for (const [o, nk] of Object.entries(renMult))
        if ('mult_' + o in a) { a['mult_' + nk] = a['mult_' + o];
          delete a['mult_' + o]; }
    });
  }, { tree: false });
  await loadSchema();
  // add defaults for any new parameters (e.g. new drivers)
  forEachComponent((c) => { for (const [k, v] of Object.entries(S.defaults))
      if (!(k in c.attributes)) c.attributes[k] = clone(v); });
  renderMain();
  toast('Settings applied');
}

// ======================================================================= load / init
async function loadProject(project, file) {
  S.project = project;
  S.file = file;
  S.project.project = S.project.project || { name: 'Untitled' };
  S.undo = [];
  S.redo = [];
  S.dirty = false;
  S.results = {};
  const want = decodeURIComponent(location.hash.slice(1));
  S.sel = new Set([ROOT]);
  S.primary = ROOT;
  buildIndex();
  if (want && S.idx.has(want)) { S.sel = new Set([want]);
    S.primary = want; }
  await loadSchema();
  renderAll();
  scheduleEstimate(0);
}

function initChrome() {
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#menu')) hideMenu();
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'new') { if (confirmDiscard()) api('/api/new').then((r) => loadProject(r.project, null)); } else if (
      a === 'import') openDialog();
    else if (a === 'save') S.file ? doSave() : saveAsDialog();
    else if (a === 'saveas') saveAsDialog();
    else if (a === 'download') download();
    else if (a === 'undo') undo();
    else if (a === 'redo') redo();
    else if (a === 'settings') settingsDialog();
    else if (a === 'theme') {
      const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ?
        'dark' : 'light');
      const next = cur === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('holchin-theme', next); } catch (_) { /* ignore */ }
      drawCharts();
    } else if (a === 'add-group') addNode('group');
    else if (a === 'add-component') addNode('component');
    else if (a === 'expand-all') setAllExpanded(true);
    else if (a === 'collapse-all') setAllExpanded(false);
  });
  $('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) importFile(f);
    e.target.value = ''; });
  $('#projectName').addEventListener('input', (e) => {
    mutate(() => { S.project.project.name = e.target.value; }, { coalesce: 'projname' });
    if (S.primary === ROOT) { const t = $('.title-input'); if (t) t.value = e.target.value; }
  });
  $('#treeFilter').addEventListener('input', (e) => { S.filter = e.target.value.trim().toLowerCase();
    renderTree(); });
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = e.target.matches('input,textarea,select');
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault();
      S.file ? doSave() : saveAsDialog(); } else if (mod && !inField && e.key.toLowerCase() === 'z') { e
        .preventDefault();
      e.shiftKey ? redo() : undo(); } else if (mod && !inField && e.key.toLowerCase() === 'y') { e.preventDefault();
      redo(); } else if (e.key === 'Escape') hideMenu();
  });
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault();
      e.returnValue = ''; } });
  window.addEventListener('blur', hideMenu);

  // sidebar resize
  const rz = $('#resizer'),
    sb = $('#sidebar');
  try { const w = localStorage.getItem('holchin-sidebar'); if (w) sb.style.width = w; } catch (_) { /* ignore */ }
  rz.addEventListener('mousedown', (e) => {
    e.preventDefault();
    rz.classList.add('active');
    const move = (ev) => { sb.style.width = Math.max(220, Math.min(innerWidth * 0.7, ev.clientX)) + 'px'; };
    const up = () => {
      rz.classList.remove('active');
      removeEventListener('mousemove', move);
      removeEventListener('mouseup', up);
      try { localStorage.setItem('holchin-sidebar', sb.style.width); } catch (_) { /* ignore */ }
      drawCharts();
    };
    addEventListener('mousemove', move);
    addEventListener('mouseup', up);
  });
  let rt, lastW = 0;
  chartObserver = new ResizeObserver(() => {
    const w = $('#results')?.clientWidth || 0;
    if (w === lastW) return;
    lastW = w;
    clearTimeout(rt);
    rt = setTimeout(drawCharts, 100);
  });
  chartObserver.observe($('#main'));
}

(async function init() {
  try { const t = localStorage.getItem('holchin-theme'); if (t) document.documentElement.dataset.theme =
    t; } catch (_) { /* ignore */ }
  initChrome();
  initTree();
  try {
    const r = await api('/api/project');
    await loadProject(r.project, r.file);
  } catch (e) {
    $('#main').innerHTML = `<div class="empty">Could not reach the estimation server: ${esc(e.message)}</div>`;
  }
})();
