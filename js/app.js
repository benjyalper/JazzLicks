import {
  KEY_SIGS, DURATIONS, TRIPLET_DURATIONS, DUR_TICKS, MEASURE_TICKS, transposeMeasures, CHORD_QUALITIES, CHORD_ROOTS,
  keyAlter, isFlatKey, fromDiatonic, diatonicIndex, MIN_DIATONIC, MAX_DIATONIC,
  noteTicks, measureTicks, midi, prettyRoot, pitchLabel, STEPS, spellMidi,
} from './music.js';
import { renderPhrase, hitTest, ghostAt, noteElement, diatonicUnder, pointAt } from './render.js';
import { player, previewNote, warmUp } from './player.js';
import { STYLES } from './backing.js';
import { initSync, notifyChange, connect, disconnect, syncNow, syncInfo } from './sync.js';

const STORAGE_KEY = 'jazzlicks.v1';
const MAX_MEASURES = 8;

// ---------------------------------------------------------------- state

const state = {
  phrases: [],
  editingId: null,
  sel: null, // { m, i } in the phrase being edited (the cursor / range start)
  selEnd: null, // { m, i } other end of a selected range, or null
  mode: 'write', // 'write': taps add notes · 'select': taps/drags select, for copy & paste
  area: null, // Select mode: { m0, m1, whole } — the bars the selection touches
  replace: false, // Replace mode: tapping overwrites instead of inserting
  tool: { dur: '8', dots: 0, trip: false },
  undo: [], // [{ id, json }]
  deleted: {}, // id -> time deleted (so deletions sync to other devices)
  orderUpdatedAt: 0,
};
const cards = new Map(); // id -> { el, host, layout, playBtn, ... }

const uid = () => Math.random().toString(36).slice(2, 10);
const emptyMeasure = () => ({ chords: [null, null], notes: [] });
const N = (step, alter, oct, dur = '8', extra = {}) => ({ rest: false, step, alter, oct, dur, dots: 0, tie: false, ...extra });
const R = (dur = '8') => ({ rest: true, dur, dots: 0, tie: false });

function newPhrase(category = 'licks') {
  return {
    id: uid(), title: CATEGORIES.find((c) => c.id === category).newTitle, category,
    keySig: 'C', tempo: 160, instrument: 'piano',
    style: 'swing', chords: 'comp', bass: true, drums: true, countIn: false, loop: false,
    degrees: category !== 'minus1',
    measures: [emptyMeasure(), emptyMeasure()], text: '',
  };
}

// ---------------------------------------------------------------- tabs

const CATEGORIES = [
  { id: 'licks', label: 'Licks', newTitle: 'New lick', empty: 'No licks yet.' },
  { id: 'scales', label: 'Scales', newTitle: 'New scale', empty: 'No scales yet.' },
  { id: 'minus1', label: 'Minus 1', newTitle: 'New track', empty: 'No Minus 1 tracks yet (chords only, no notes).' },
];
const TAB_KEY = 'jazzlicks.tab';
const HEBREW = /[\u0590-\u05FF]/;

const hasNotes = (p) => (p.measures || []).some((m) => m.notes.some((n) => !n.rest));

// Which tab a piece belongs to. Pieces moved by hand keep their tab; older
// pieces are sorted automatically (nothing is changed or removed by this).
function categoryOf(p) {
  if (p.category && CATEGORIES.some((c) => c.id === p.category)) return p.category;
  if (!hasNotes(p)) return 'minus1';
  if (p.id === 'example-hawkins' || HEBREW.test(p.title || '')) return 'licks';
  return 'scales';
}

let activeTab = 'licks';
try {
  const saved = localStorage.getItem(TAB_KEY);
  if (CATEGORIES.some((c) => c.id === saved)) activeTab = saved;
} catch (e) { /* ignore */ }

function setTab(id) {
  activeTab = id;
  try { localStorage.setItem(TAB_KEY, id); } catch (e) { /* ignore */ }
  if (state.editingId && categoryOf(byId(state.editingId) || {}) !== id) {
    state.editingId = null;
    state.sel = null;
  }
  closeChordPicker();
  renderAll();
  window.scrollTo({ top: 0 });
}

function renderTabs() {
  const bar = $('#tabs');
  bar.innerHTML = '';
  for (const c of CATEGORIES) {
    const count = state.phrases.filter((p) => categoryOf(p) === c.id).length;
    bar.append(h('button', {
      class: 'tab' + (activeTab === c.id ? ' on' : ''), role: 'tab', 'aria-selected': activeTab === c.id ? 'true' : 'false',
      onclick: () => setTab(c.id),
    }, c.label, h('span', { class: 'tab-count' }, String(count))));
  }
  const cat = CATEGORIES.find((c) => c.id === activeTab);
  $('#new-lick').innerHTML = `+ New<span class="long"> ${cat.newTitle.replace('New ', '')}</span>`;
}

function moveToCategory(id, category) {
  const p = byId(id);
  if (!p) return;
  p.category = category;
  if (state.editingId === id) { state.editingId = null; state.sel = null; }
  save();
  renderAll();
  toast(`Moved “${p.title}” to ${CATEGORIES.find((c) => c.id === category).label}.`);
}

// One-time safety copy of everything before the tabs version first runs.
function backupOnce() {
  try {
    const key = 'jazzlicks.backup.before-tabs';
    if (!localStorage.getItem(key)) {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) localStorage.setItem(key, raw);
    }
  } catch (e) { /* ignore */ }
}

// Transcribed from the Coleman Hawkins "Desafinado" example.
function exampleLick() {
  return {
    id: 'example-hawkins', // fixed id so every device shares the same example
    updatedAt: 0,
    title: 'Hawkins – Desafinado (minor ii–V)',
    keySig: 'F', tempo: 150, instrument: 'piano', style: 'latin', bass: true, drums: true, countIn: false, loop: false,
    measures: [
      {
        chords: [{ root: 'E', quality: 'm7b5' }, null],
        notes: [R('8'), N('C', 0, 5), N('B', -1, 4), N('G', 0, 4), N('A', 0, 4), N('C', 1, 5), N('D', 0, 5), N('F', 0, 5)],
      },
      {
        chords: [{ root: 'A', quality: '7' }, null],
        notes: [N('E', 0, 5), N('G', 0, 4), N('A', 0, 4), N('B', -1, 4), N('C', 1, 5), N('E', 0, 5), N('G', 0, 5), N('B', -1, 5)],
      },
    ],
    text: 'Eø → A7(♭9) arpeggio line. Starts on the ♭7 of Eø, lands on the 3rd (C♯) of A7 and climbs to the ♭9.',
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (Array.isArray(data.phrases)) {
        state.phrases = data.phrases;
        state.deleted = data.deleted || {};
        state.orderUpdatedAt = data.orderUpdatedAt || 0;
        rememberSaved();
        return;
      }
    }
  } catch (e) { /* ignore */ }
  state.phrases = [exampleLick()];
  rememberSaved();
}

// What each lick looked like when last saved, to know which ones changed.
const savedJson = new Map();
let savedOrder = '';
const contentJson = (p) => JSON.stringify({ ...p, updatedAt: undefined });

function rememberSaved() {
  savedJson.clear();
  for (const p of state.phrases) savedJson.set(p.id, contentJson(p));
  savedOrder = state.phrases.map((p) => p.id).join();
}

// Give changed licks a new timestamp (the newest version wins when syncing).
function stampChanges() {
  const now = Date.now();
  for (const p of state.phrases) {
    const j = contentJson(p);
    if (savedJson.get(p.id) !== j) {
      p.updatedAt = now;
      savedJson.set(p.id, j);
    }
  }
  const order = state.phrases.map((p) => p.id).join();
  if (order !== savedOrder) {
    state.orderUpdatedAt = now;
    savedOrder = order;
  }
}

function writeLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2, phrases: state.phrases, deleted: state.deleted, orderUpdatedAt: state.orderUpdatedAt,
    }));
  } catch (e) {
    toast('Could not save in this browser (storage is full or blocked).');
  }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    stampChanges();
    writeLocal();
    notifyChange();
  }, 250);
}

function syncData() {
  stampChanges();
  return { phrases: state.phrases, deleted: state.deleted, orderUpdatedAt: state.orderUpdatedAt };
}

// Apply licks merged from another device, re-drawing only what changed.
function applySynced(data) {
  const before = new Map(state.phrases.map((p) => [p.id, JSON.stringify(p)]));
  const orderBefore = state.phrases.map((p) => p.id).join();
  // Where each lick is listed (tab and group): if that changes the whole list is redrawn.
  const placeOf = (list) => list.map((p) => `${p.id}:${categoryOf(p)}:${p.group || ''}`).join('|');
  const placesBefore = placeOf(state.phrases);
  state.phrases = data.phrases;
  state.deleted = data.deleted;
  state.orderUpdatedAt = data.orderUpdatedAt;
  rememberSaved();
  writeLocal();
  if (state.editingId && !byId(state.editingId)) { state.editingId = null; state.sel = null; }
  if (player.currentId && !byId(player.currentId)) player.stop();
  if (state.phrases.map((p) => p.id).join() !== orderBefore || placeOf(state.phrases) !== placesBefore) return renderAll();
  for (const p of state.phrases) {
    if (before.get(p.id) === JSON.stringify(p)) continue;
    const ref = cards.get(p.id);
    if (ref && ref.el.contains(document.activeElement)) continue; // don't interrupt typing
    if (state.editingId === p.id) state.sel = null;
    rebuildCard(p.id);
  }
}

const byId = (id) => state.phrases.find((p) => p.id === id);
const editing = () => byId(state.editingId);

function snapshot(phrase) {
  state.undo.push({ id: phrase.id, json: JSON.stringify(phrase) });
  if (state.undo.length > 100) state.undo.shift();
}

function undo() {
  const last = state.undo.pop();
  if (!last) return toast('Nothing to undo');
  const idx = state.phrases.findIndex((p) => p.id === last.id);
  if (idx < 0) return;
  state.phrases[idx] = JSON.parse(last.json);
  clearSelection();
  closeSelMenu();
  save();
  rebuildCard(last.id);
}

// ---------------------------------------------------------------- ui helpers

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  loading: '<svg viewBox="0 0 24 24" aria-hidden="true" class="spin"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="30 60"/></svg>',
};

// Small note-value icons for the toolbar.
function durIcon(dur) {
  const filled = dur !== 'w' && dur !== 'h';
  const stem = dur !== 'w';
  const flags = dur === '8' ? 1 : dur === '16' ? 2 : 0;
  let s = `<svg viewBox="0 0 20 26" aria-hidden="true" class="dur-icon">`;
  s += `<ellipse cx="7" cy="20" rx="5" ry="3.6" transform="rotate(-22 7 20)" ${filled ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.6"'}/>`;
  if (stem) s += `<path d="M11.4 19V2.5" stroke="currentColor" stroke-width="1.5"/>`;
  for (let f = 0; f < flags; f++) s += `<path d="M11.4 ${2.5 + f * 5}c1 3 6 4 5 9" fill="none" stroke="currentColor" stroke-width="1.6"/>`;
  return s + '</svg>';
}
const DUR_NAMES = { '16': 'Sixteenth', '8': 'Eighth', q: 'Quarter', h: 'Half', w: 'Whole' };

// ---------------------------------------------------------------- building cards

let searchQuery = '';
const COLLAPSED_KEY = 'jazzlicks.collapsed';
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []); } catch (e) { /* ignore */ }

function toggleGroup(key) {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch (e) { /* ignore */ }
  renderAll();
}

const matches = (p, q) => !q || `${p.title || ''} ${p.text || ''} ${p.group || ''}`.toLowerCase().includes(q);

function renderAll() {
  const list = $('#licks');
  list.innerHTML = '';
  cards.clear();
  renderTabs();
  document.body.classList.toggle('is-editing', !!state.editingId);
  const q = searchQuery.trim().toLowerCase();
  const inTab = state.phrases.filter((p) => categoryOf(p) === activeTab);
  const visible = inTab.filter((p) => matches(p, q));
  const cat = CATEGORIES.find((c) => c.id === activeTab);
  if (!visible.length) {
    list.append(q
      ? h('div', { class: 'empty' }, h('p', {}, `Nothing matches “${searchQuery.trim()}”.`))
      : h('div', { class: 'empty' },
        h('p', {}, cat.empty),
        h('button', { class: 'btn primary', onclick: () => addPhrase() }, `+ ${cat.newTitle}`)));
    return;
  }
  // Pieces without a group first, then each group (and its subgroups) under its own header.
  const renderNode = (node, depth) => {
    for (const p of node.items) {
      const card = buildCard(p);
      if (depth) card.style.setProperty('--depth', depth);
      list.append(card);
    }
    for (const child of node.children.values()) {
      const key = `${activeTab}:${child.path}`;
      const isOpen = q || !collapsed.has(key);
      list.append(groupHeader(child, depth, isOpen, () => toggleGroup(key), cat));
      if (isOpen) renderNode(child, depth + 1);
    }
  };
  renderNode(groupTree(visible), 0);
  drawAllStaves();
}

// Groups can hold subgroups: a lick's group is a path like "Minor 251 › Bebop".
const GROUP_SEP = ' › ';
const groupParts = (g) => (g ? g.split(GROUP_SEP) : []);
const cleanGroupName = (name) => name.replace(/›/g, '-').trim();

function groupTree(phrases) {
  const root = { path: '', name: '', items: [], children: new Map(), count: 0 };
  for (const p of phrases) {
    let node = root;
    node.count++;
    for (const part of groupParts(p.group)) {
      if (!node.children.has(part)) {
        const path = node.path ? node.path + GROUP_SEP + part : part;
        node.children.set(part, { path, name: part, items: [], children: new Map(), count: 0 });
      }
      node = node.children.get(part);
      node.count++;
    }
    node.items.push(p);
  }
  return root;
}

// Every group and subgroup of a tab, parents before children.
function groupPaths(category) {
  const out = [];
  const walk = (node) => { for (const c of node.children.values()) { out.push(c.path); walk(c); } };
  walk(groupTree(state.phrases.filter((x) => categoryOf(x) === category)));
  return out;
}

function groupHeader(node, depth, isOpen, onToggle, cat) {
  const kind = cat.newTitle.replace('New ', '');
  const menu = h('details', { class: 'menu group-menu' },
    h('summary', { 'aria-label': `${node.name} options`, title: 'Group options' }, '⋯'));
  const item = (label, fn) => h('button', { onclick: () => { menu.open = false; fn(); } }, label);
  menu.append(h('div', { class: 'menu-items' },
    item(`New ${kind} here`, () => addPhrase(node.path)),
    item('New subgroup…', () => {
      const name = prompt(`Name of the new subgroup inside “${node.name}”:`, '');
      if (name && cleanGroupName(name)) addPhrase(node.path + GROUP_SEP + cleanGroupName(name));
    }),
    item('Rename…', () => renameGroup(node.path))));
  return h('div', { class: 'group-head', style: `--depth:${depth}` },
    h('button', { class: 'group-toggle' + (depth ? ' sub' : ''), 'aria-expanded': isOpen ? 'true' : 'false', onclick: onToggle, dir: 'auto' },
      h('span', { class: 'group-caret' }, isOpen ? '▾' : '▸'), node.name, h('span', { class: 'tab-count' }, String(node.count))),
    h('button', { class: 'group-add', title: `New ${kind} in “${node.name}”`, 'aria-label': `Add to ${node.name}`, onclick: () => addPhrase(node.path) }, '+'),
    menu);
}

function renameGroup(path) {
  const parts = groupParts(path);
  const old = parts[parts.length - 1];
  const name = prompt(`Rename “${old}” to:`, old);
  if (!name || !cleanGroupName(name) || cleanGroupName(name) === old) return;
  const renamed = [...parts.slice(0, -1), cleanGroupName(name)].join(GROUP_SEP);
  let n = 0;
  for (const p of state.phrases) {
    if (categoryOf(p) !== activeTab || !p.group) continue;
    if (p.group === path) { p.group = renamed; n++; }
    else if (p.group.startsWith(path + GROUP_SEP)) { p.group = renamed + p.group.slice(path.length); n++; }
  }
  // Keep collapsed groups collapsed under their new name.
  const prefix = `${activeTab}:${path}`;
  collapsed = new Set([...collapsed].map((k) => (k === prefix || k.startsWith(prefix + GROUP_SEP) ? `${activeTab}:${renamed}${k.slice(prefix.length)}` : k)));
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch (e) { /* ignore */ }
  save();
  renderAll();
  toast(`Renamed to “${cleanGroupName(name)}” (${n} item${n === 1 ? '' : 's'}).`);
}

// Group dialog: pick an existing group of this tab, type a new one, or none.
function openGroupDialog(id) {
  const p = byId(id);
  if (!p) return;
  const existing = groupPaths(categoryOf(p));
  const back = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === back) back.remove(); } });
  const setGroup = (g) => {
    p.group = g || undefined;
    if (!g) delete p.group;
    save();
    back.remove();
    renderAll();
    toast(g ? `Added to “${g}”.` : 'Removed from its group.');
  };
  const input = h('input', { class: 'token-input', placeholder: 'New group name, e.g. Minor 251', dir: 'auto', maxlength: 60 });
  // A new group can go inside an existing one (a subgroup).
  const parent = h('select', { class: 'group-parent', 'aria-label': 'Inside' },
    h('option', { value: '' }, 'Top level'),
    ...existing.map((g) => h('option', { value: g, selected: p.group === g }, `Inside: ${g}`)));
  const create = () => {
    const name = cleanGroupName(input.value);
    if (name) setGroup(parent.value ? parent.value + GROUP_SEP + name : name);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
  back.append(h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Group' },
    h('button', { class: 'modal-close', 'aria-label': 'Close', onclick: () => back.remove() }, '×'),
    h('h2', {}, 'Group'),
    h('p', { dir: 'auto' }, `Put “${p.title}” in a group:`),
    existing.length ? h('div', { class: 'group-choices tree' }, existing.map((g) => h('button', {
      class: 'btn' + (p.group === g ? ' primary' : ''), dir: 'auto', style: `--depth:${groupParts(g).length - 1}`, onclick: () => setGroup(g),
    }, groupParts(g).pop()))) : null,
    h('p', { class: 'muted' }, 'Or make a new group:'),
    existing.length ? parent : null,
    h('div', { class: 'token-row' }, input, h('button', { class: 'btn primary', onclick: create }, 'Add')),
    p.group ? h('div', { class: 'modal-actions' }, h('button', { class: 'btn danger-btn', onclick: () => setGroup(null) }, 'Remove from group')) : null));
  document.body.append(back);
  if (!existing.length) input.focus();
}

function rebuildCard(id) {
  const old = cards.get(id);
  const p = byId(id);
  if (p && !old && categoryOf(p) !== activeTab) return; // not on this tab
  if (!old || !p) return renderAll();
  const card = buildCard(p);
  old.el.replaceWith(card);
  // Keep a "12 keys" transposition and its badge while playback continues.
  const ref = cards.get(id);
  if (ref && player.currentId === id && old.override) ref.override = old.override;
  if (ref && player.currentId === id && !old.passBadge.hidden) {
    ref.passBadge.hidden = false;
    ref.passBadge.textContent = old.passBadge.textContent;
  }
  drawStave(id);
}

function buildCard(p) {
  const isEditing = state.editingId === p.id;
  const ref = { id: p.id };

  const playBtn = h('button', {
    class: 'play', 'aria-label': 'Play / pause', title: 'Play / pause',
    onclick: () => togglePlay(p.id),
  });
  const playing = player.currentId === p.id ? player.state : 'stopped';
  setPlayIcon(playBtn, playing);

  const title = h('input', {
    class: 'title', value: p.title, 'aria-label': 'Name', maxlength: 80, dir: 'auto',
    oninput: (e) => { p.title = e.target.value; save(); },
  });

  const editBtn = h('button', {
    class: 'btn' + (isEditing ? ' primary' : ''),
    onclick: () => setEditing(isEditing ? null : p.id),
  }, isEditing ? 'Done' : 'Edit');

  const menu = h('details', { class: 'menu' },
    h('summary', { 'aria-label': 'More actions', title: 'More' }, '⋯'),
    h('div', { class: 'menu-items' },
      h('button', { onclick: () => duplicatePhrase(p.id) }, 'Duplicate'),
      h('button', { onclick: () => openGroupDialog(p.id) }, p.group ? `Group: ${p.group}…` : 'Group…'),
      h('button', { onclick: () => copyAllBars(p.id) }, 'Copy all bars'),
      h('button', { onclick: () => pasteIntoLick(p.id) }, 'Paste copied bars'),
      h('button', { onclick: () => newLickFrom(clipboard()) }, 'New lick from copied'),
      h('button', { onclick: () => movePhrase(p.id, -1) }, 'Move up'),
      h('button', { onclick: () => movePhrase(p.id, 1) }, 'Move down'),
      ...CATEGORIES.filter((c) => c.id !== categoryOf(p)).map((c) => h('button', { onclick: () => moveToCategory(p.id, c.id) }, `Move to ${c.label}`)),
      h('button', { class: 'danger', onclick: () => deletePhrase(p.id) }, 'Delete')));

  const keySel = h('select', {
    'aria-label': 'Key signature',
    onchange: (e) => changeKey(p, e.target.value),
  }, KEY_SIGS.map((k) => h('option', { value: k.key, selected: k.key === p.keySig }, k.label)));

  const tempo = h('input', {
    type: 'number', min: 40, max: 360, step: 1, value: p.tempo, 'aria-label': 'Tempo (BPM)',
    onchange: (e) => {
      const v = Math.max(40, Math.min(360, parseInt(e.target.value, 10) || 160));
      p.tempo = v; e.target.value = v; save(); restartIfPlaying(p.id);
    },
  });

  // Segmented control (one of several options).
  const seg = (label, options, get, set) => h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([value, text]) => h('button', {
      class: get() === value ? 'on' : '',
      'aria-pressed': get() === value ? 'true' : 'false',
      onclick: (e) => {
        set(value); save();
        e.currentTarget.parentElement.querySelectorAll('button').forEach((b) => {
          const on = b === e.currentTarget;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        restartIfPlaying(p.id);
      },
    }, text)));

  const sound = seg('Instrument', [['piano', 'Piano'], ['guitar', 'Guitar']],
    () => p.instrument, (v) => { p.instrument = v; warmUp(v); });
  const style = seg('Style', STYLES.map((st) => [st.id, st.label]),
    () => p.style || 'swing', (v) => { p.style = v; });

  const practiceSeg = seg('Practice', [['off', 'Normal'], ['keys', '12 keys'], ['speed', `Speed up`]],
    () => p.practice || 'off', (v) => { p.practice = v; });

  const chordsSeg = seg('Chords', [['held', 'Held'], ['comp', 'Comping'], ['off', 'Off']],
    () => p.chords || 'comp', (v) => { p.chords = v; });

  // Checkbox; `def` is the value when the lick doesn't have the setting yet.
  const check = (label, prop, def = false) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox', checked: p[prop] === undefined ? def : !!p[prop],
      onchange: (e) => { p[prop] = e.target.checked; save(); restartIfPlaying(p.id); },
    }), label);

  const settings = h('div', { class: 'settings' },
    h('label', { class: 'field' }, h('span', {}, 'Key'), keySel),
    h('label', { class: 'field' }, h('span', {}, 'Tempo'), tempo, h('span', { class: 'unit' }, 'bpm')),
    sound,
    style,
    h('div', { class: 'field' }, h('span', {}, 'Chords'), chordsSeg),
    h('div', { class: 'checks' },
      h('span', { class: 'checks-label' }, 'Band'),
      check('Bass', 'bass', true),
      check('Drums', 'drums', true)),
    h('div', { class: 'field' }, h('span', {}, 'Practice'), practiceSeg),
    h('div', { class: 'checks' },
      check('Melody', 'melody', true),
      check('Count-in', 'countIn'),
      check('Loop', 'loop'),
      h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: p.degrees !== false,
          onchange: (e) => { p.degrees = e.target.checked; save(); drawStave(p.id); },
        }), 'Degrees')));

  const host = h('div', { class: 'stave-host' + (isEditing ? ' editing' : '') + (isEditing && state.mode === 'select' ? ' select-mode' : '') });
  const notes = h('textarea', {
    class: 'notes', rows: 2, dir: 'auto', placeholder: 'Words about this lick: where it\'s from, how to use it…',
    oninput: (e) => { p.text = e.target.value; save(); autoGrow(e.target); },
  });
  notes.value = p.text || '';
  requestAnimationFrame(() => autoGrow(notes));

  // Close the ⋯ menu after choosing an item.
  menu.addEventListener('click', (e) => { if (e.target.closest('.menu-items button')) menu.removeAttribute('open'); });
  const passBadge = h('span', { class: 'pass-badge', hidden: true });
  const card = h('article', { class: 'lick' + (isEditing ? ' is-editing' : ''), 'data-id': p.id },
    h('header', { class: 'lick-head' }, playBtn, title, passBadge, editBtn, menu),
    settings,
    isEditing ? buildToolbar(p) : null,
    host,
    isEditing ? h('p', { class: 'hint' }, hintText()) : null,
    notes);

  if (isEditing) attachStaveEvents(p, host);
  else host.addEventListener('dblclick', () => setEditing(p.id));

  Object.assign(ref, { el: card, host, playBtn, passBadge, layout: null, override: null });
  cards.set(p.id, ref);
  return card;
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(52, t.scrollHeight + 2) + 'px';
}

function hintText() {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (state.mode === 'select') {
    return touch
      ? 'Select mode: press and hold on the staff, then slide across the notes or bars you want. Tap a note or an empty bar to pick just that. A menu with Copy and Paste opens when you let go.'
      : 'Select mode: drag across the staff (or hold the mouse down and drag) over the notes or bars you want. Click a note or an empty bar to pick just that. A menu with Copy and Paste opens when you let go.';
  }
  return touch
    ? 'Tap the staff to add a note (tap an empty spot to put it on that beat), tap a note to select it, drag a selected note up/down to change its pitch, tap above the staff for a chord.'
    : 'Click the staff to add a note · click above it for a chord · Shift+click to select a range · keys: A–G notes, ↑↓ pitch, Shift+↑↓ octave, 1–5 length, . dot, / triplet, R rest, T tie, ⌫ delete, Ctrl+C/V/D copy/paste/duplicate, Space play.';
}

function buildToolbar(p) {
  const tb = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Note tools' });
  const group = (...items) => h('div', { class: 'tb-group' }, ...items);
  const sel = selectedNote();

  const curDur = sel ? sel.dur : state.tool.dur;
  const durBtns = DURATIONS.map((d, k) => h('button', {
    class: 'tb' + (curDur === d ? ' on' : ''), title: `${DUR_NAMES[d]} (${k + 1})`, 'aria-label': DUR_NAMES[d],
    html: durIcon(d), onclick: () => setDuration(d),
  }));
  const curDots = sel ? sel.dots : state.tool.dots;
  const dotBtn = h('button', { class: 'tb' + (curDots ? ' on' : ''), title: 'Dotted (.)', onclick: toggleDot }, '•');
  const curTrip = state.tool.trip;
  const tripBtn = h('button', {
    class: 'tb' + (curTrip ? ' on' : ''), title: 'Enter triplets (/)', 'aria-label': 'Triplets', onclick: toggleTrip,
    html: '<svg viewBox="0 0 26 20" class="trip-icon" aria-hidden="true"><path d="M2 9V4h22v5" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="13" y="19" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" font-family="DM Sans, sans-serif">3</text></svg>',
  });
  const restBtn = h('button', {
    class: 'tb wide' + (sel && sel.rest ? ' on' : ''), title: sel ? 'Make rest / note (R)' : 'Add a rest (R)', onclick: toggleRest,
  }, sel && sel.rest ? 'Note' : 'Rest');

  const accBtn = (alter, label, title) => h('button', {
    class: 'tb' + (sel && !sel.rest && sel.alter === alter ? ' on' : ''), title, disabled: !sel || sel.rest,
    onclick: () => setAlter(alter),
  }, label);
  const tieBtn = h('button', {
    class: 'tb' + (sel && sel.tie ? ' on' : ''), title: 'Tie to next note (T)', disabled: !sel || sel.rest,
    onclick: toggleTie, html: '<svg viewBox="0 0 24 14" class="tie-icon" aria-hidden="true"><path d="M2 4c5 8 15 8 20 0" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  });

  const range = state.selEnd ? selectedRange().length : 0;
  const hasSel = !!sel;
  const status = range ? `${range} notes` : sel ? (sel.rest ? 'Rest' : pitchLabel(sel)) : '';
  const row = (cls, ...groups) => h('div', { class: `tb-row ${cls}` }, ...groups);

  const upBtn = h('button', { class: 'tb', title: range ? 'Up a semitone (↑)' : 'Pitch up (↑)', disabled: !sel || (!range && sel.rest), onclick: () => movePitch(1) }, '▲');
  const downBtn = h('button', { class: 'tb', title: range ? 'Down a semitone (↓)' : 'Pitch down (↓)', disabled: !sel || (!range && sel.rest), onclick: () => movePitch(-1) }, '▼');
  const delBtn = h('button', { class: 'tb danger', title: 'Delete (Backspace)', disabled: !hasSel, onclick: deleteSelected, html: '<svg viewBox="0 0 24 24" aria-hidden="true" class="del-icon"><path d="M9 4h6M5 7h14M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' });
  const undoBtn = h('button', { class: 'tb', title: 'Undo (Ctrl+Z)', disabled: !state.undo.length, onclick: undo }, '↶');
  const wide = (label, title, onclick, disabled = false, on = false) => h('button', { class: 'tb wide' + (on ? ' on' : ''), title, disabled, onclick }, label);

  const modeSeg = h('div', { class: 'seg seg-small mode-seg', role: 'group', 'aria-label': 'Mode' },
    h('button', { class: state.mode === 'write' ? 'on' : '', title: 'Write notes', onclick: () => setMode('write') }, '✎ Write'),
    h('button', { class: state.mode === 'select' ? 'on' : '', title: 'Select notes or bars to copy and paste', onclick: () => setMode('select') }, '⬚ Select'));

  tb.append(
    row('tb-row-notes',
      group(modeSeg),
      group(...durBtns, dotBtn, tripBtn, restBtn),
      h('span', { class: 'tb-status' }, status)),
    row('tb-row-pitch',
      group(accBtn(-1, '♭', 'Flat (-)'), accBtn(0, '♮', 'Natural (N)'), accBtn(1, '♯', 'Sharp (+)'), tieBtn),
      group(upBtn, downBtn),
      group(delBtn, undoBtn)),
    row('tb-row-more',
      group(
        h('button', { class: 'tb', title: 'Previous note (←)', onclick: () => moveSel(-1) }, '◀'),
        h('button', { class: 'tb', title: 'Next note (→)', onclick: () => moveSel(1) }, '▶')),
      state.mode === 'write'
        ? group(
          h('div', { class: 'seg seg-small', role: 'group', 'aria-label': 'Tap mode' },
            h('button', { class: state.replace ? '' : 'on', title: 'Tapping inserts a note', onclick: () => { state.replace = false; refreshToolbar(); } }, 'Insert'),
            h('button', { class: state.replace ? 'on' : '', title: 'Tapping overwrites what is there', onclick: () => { state.replace = true; refreshToolbar(); } }, 'Replace')))
        : group(
          wide('Select all', 'Select every bar', selectAllBars),
          wide('Menu', 'Copy / paste options for the selection', () => openSelMenuNear(p), !state.area)),
      group(
        wide('8va ▲', 'Octave up (Shift+↑)', () => shiftOctave(1), !hasSel),
        wide('8va ▼', 'Octave down (Shift+↓)', () => shiftOctave(-1), !hasSel),
        wide('½ ▲', 'Up a semitone', () => shiftSemitone(1), !hasSel),
        wide('½ ▼', 'Down a semitone', () => shiftSemitone(-1), !hasSel)),
      group(
        h('span', { class: 'tb-label' }, 'Bars'),
        h('button', { class: 'tb', title: 'Remove last bar', disabled: p.measures.length <= 1, onclick: () => changeMeasures(-1) }, '−'),
        h('span', { class: 'tb-count' }, String(p.measures.length)),
        h('button', { class: 'tb', title: 'Add a bar', disabled: p.measures.length >= MAX_MEASURES, onclick: () => changeMeasures(1) }, '+'))));
  return tb;
}

function refreshToolbar() {
  const p = editing();
  if (!p) return;
  const ref = cards.get(p.id);
  const old = ref && $('.toolbar', ref.el);
  if (old) old.replaceWith(buildToolbar(p));
  const hint = ref && $('.hint', ref.el);
  if (hint) hint.textContent = hintText();
  if (ref) ref.host.classList.toggle('select-mode', state.mode === 'select');
}

// ---------------------------------------------------------------- staves

function drawStave(id) {
  const ref = cards.get(id);
  const p = byId(id);
  if (!ref || !p) return;
  const isEditing = state.editingId === id;
  try {
    ref.layout = renderPhrase(ref.host, ref.override || p, {
      width: ref.host.clientWidth,
      editing: isEditing,
      degrees: p.degrees !== false,
      selected: isEditing ? selectedSet() : null,
    });
  } catch (e) {
    console.error(e);
    ref.host.innerHTML = '<p class="error">Could not draw this lick.</p>';
    ref.layout = null;
  }
  if (isEditing) {
    const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    ghost.setAttribute('class', 'ghost');
    ref.layout && ref.layout.svg.appendChild(ghost);
    if (ref.layout && state.mode === 'select' && state.area && !ref.override) drawSelArea(ref.layout, p);
  }
}

// ---------------------------------------------------------------- select mode: highlight

// Left edge of a bar's highlight (after the clef on the first bar of a line).
function barLeft(layout, ml) {
  const firstOnLine = !layout.measures.some((o) => o.line === ml.line && o.m < ml.m);
  return firstOnLine ? ml.noteStart - 12 : ml.x0 + 2;
}

// Highlight boxes from (m0, x0) to (m1, x1), one per line of music.
function spanRects(layout, m0, x0, m1, x1) {
  const rects = [];
  for (const ml of layout.measures) {
    if (ml.m < m0 || ml.m > m1) continue;
    const l = ml.m === m0 ? x0 : barLeft(layout, ml);
    const r = ml.m === m1 ? x1 : ml.x1 - 2;
    const last = rects[rects.length - 1];
    if (last && last.line === ml.line) last.r = r;
    else rects.push({ line: ml.line, l, r, top: ml.bandTop + 4, bottom: ml.bandBottom - 2 });
  }
  return rects;
}

function paintRects(layout, rects) {
  const svg = layout.svg;
  const old = $('.sel-area', svg);
  if (old) old.remove();
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('class', 'sel-area');
  for (const r of rects) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    el.setAttribute('x', Math.min(r.l, r.r));
    el.setAttribute('y', r.top);
    el.setAttribute('width', Math.max(4, Math.abs(r.r - r.l)));
    el.setAttribute('height', r.bottom - r.top);
    el.setAttribute('rx', 6);
    g.appendChild(el);
  }
  svg.insertBefore(g, svg.firstChild);
}

// While dragging: the raw area between the two points.
function drawDragArea(layout, a, b) {
  const [s, t] = isBefore(a, b) ? [a, b] : [b, a];
  paintRects(layout, spanRects(layout, s.m, s.x, t.m, t.x));
}

const isBefore = (a, b) => a.m < b.m || (a.m === b.m && a.x <= b.x);

// The settled selection: whole bars, or a box around the chosen notes.
function drawSelArea(layout, p) {
  const a = state.area;
  if (a.whole) {
    const first = layout.measures.find((ml) => ml.m === a.m0);
    const last = layout.measures.find((ml) => ml.m === a.m1);
    if (first && last) paintRects(layout, spanRects(layout, a.m0, barLeft(layout, first), a.m1, last.x1 - 2));
    return;
  }
  const set = selectedSet();
  const xs = layout.notes.filter((nt) => !nt.pad && set.has(`${nt.m}:${nt.i}`));
  if (!xs.length) return;
  paintRects(layout, spanRects(layout, xs[0].m, xs[0].x - 12, xs[xs.length - 1].m, xs[xs.length - 1].x + 12));
}

function drawAllStaves() {
  for (const id of cards.keys()) drawStave(id);
}

function svgPoint(layout, e) {
  const r = layout.svg.getBoundingClientRect();
  return { x: (e.clientX - r.left) / layout.scale, y: (e.clientY - r.top) / layout.scale + layout.offsetY };
}

function attachStaveEvents(p, host) {
  host.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || gesture) return;
    const ref = cards.get(p.id);
    if (!ref || !ref.layout) return;
    const { x, y } = svgPoint(ref.layout, e);
    const g = $('.ghost', ref.layout.svg);
    if (!g) return;
    const hit = hitTest(ref.layout, x, y);
    const ghost = hit && hit.type === 'staff' ? ghostAt(ref.layout, x, y) : null;
    if (!ghost) { g.innerHTML = ''; return; }
    const ledgers = ghost.ledgers.map((ly) => `<line x1="${ghost.x - 10}" x2="${ghost.x + 10}" y1="${ly}" y2="${ly}"/>`).join('');
    g.innerHTML = `${ledgers}<ellipse cx="${ghost.x}" cy="${ghost.y}" rx="6" ry="4.4" transform="rotate(-20 ${ghost.x} ${ghost.y})"/>`;
  });
  host.addEventListener('pointerleave', () => {
    const ref = cards.get(p.id);
    const g = ref && ref.layout && $('.ghost', ref.layout.svg);
    if (g) g.innerHTML = '';
  });

  // Touch on the selected note: stop the page from scrolling so the finger
  // can drag the note up and down. Anywhere else the page scrolls normally.
  host.addEventListener('touchstart', (e) => {
    const ref = cards.get(p.id);
    if (!ref || !ref.layout || e.touches.length !== 1 || state.mode === 'select') return;
    const hit = hitTest(ref.layout, ...Object.values(svgPoint(ref.layout, e.touches[0])));
    if (hit && hit.type === 'note' && isSelectedNote(hit.m, hit.i) && !p.measures[hit.m].notes[hit.i].rest) e.preventDefault();
  }, { passive: false });
  // Select mode: once a press-and-hold has started a selection, the finger
  // slides the selection instead of scrolling the page.
  host.addEventListener('touchmove', (e) => {
    if (gesture && gesture.select && gesture.area) e.preventDefault();
  }, { passive: false });
  host.addEventListener('contextmenu', (e) => {
    if (state.mode === 'select' && state.editingId === p.id) e.preventDefault();
  });

  host.addEventListener('pointerdown', (e) => {
    const ref = cards.get(p.id);
    if (!ref || !ref.layout || e.button > 0) return;
    const pt = svgPoint(ref.layout, e);
    const hit = hitTest(ref.layout, pt.x, pt.y);
    if (state.mode === 'select' && state.editingId === p.id) {
      if (ref.override) return toast('Showing another key while practising. Stop playback to edit.');
      const anchor = pointAt(ref.layout, pt.x, pt.y);
      if (!anchor) return;
      if (e.pointerType === 'mouse') e.preventDefault();
      const g = { id: e.pointerId, select: true, mouse: e.pointerType === 'mouse', x0: e.clientX, y0: e.clientY, t0: Date.now(), hit, anchor, last: anchor, area: false };
      // Holding still for a moment starts a selection (needed on touch screens,
      // where a plain slide scrolls the page).
      g.timer = setTimeout(() => { if (gesture === g && !g.cancelled) startArea(p, g); }, 350);
      gesture = g;
      return;
    }
    if (!hit) return;
    if (e.pointerType === 'mouse') e.preventDefault();
    const note = hit.type === 'note' ? p.measures[hit.m].notes[hit.i] : null;
    const drag = note && !note.rest && isSelectedNote(hit.m, hit.i) && !e.shiftKey && !ref.override;
    gesture = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: Date.now(), hit, drag, dragged: false, snap: false, shift: e.shiftKey };
    if (drag) host.setPointerCapture(e.pointerId);
  });

  host.addEventListener('pointermove', (e) => {
    if (!gesture || gesture.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0);
    if (gesture.select) {
      if (!gesture.area) {
        if (gesture.mouse && moved > 5) startArea(p, gesture);
        else if (!gesture.mouse && moved > 10) { gesture.cancelled = true; clearTimeout(gesture.timer); }
        if (!gesture.area) return;
      }
      const ref = cards.get(p.id);
      if (!ref || !ref.layout) return;
      const pt = svgPoint(ref.layout, e);
      gesture.last = pointAt(ref.layout, pt.x, pt.y) || gesture.last;
      drawDragArea(ref.layout, gesture.anchor, gesture.last);
      return;
    }
    if (!gesture.drag) {
      if (moved > 10) gesture.cancelled = true; // it's a scroll, not a tap
      return;
    }
    // Dragging the selected note changes its pitch.
    const ref = cards.get(p.id);
    if (!ref || !ref.layout) return;
    const { y } = svgPoint(ref.layout, e);
    const d = diatonicUnder(ref.layout, gesture.hit.m, y);
    const note = selectedNote();
    if (d === null || !note || note.rest || d === diatonicIndex(note.step, note.oct)) return;
    if (!gesture.snap) { snapshot(p); gesture.snap = true; }
    gesture.dragged = true;
    const { step, oct } = fromDiatonic(d);
    Object.assign(note, { step, oct, alter: keyAlter(p.keySig, step) });
    audition(p, note);
    drawStave(p.id);
    refreshToolbar();
  });

  const finish = (e) => {
    if (!gesture || gesture.id !== e.pointerId) return;
    const g = gesture;
    gesture = null;
    if (g.select) return finishSelect(p, g, e);
    if (g.dragged) return changed(p);
    if (g.cancelled || e.type === 'pointercancel') return;
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 10 || Date.now() - g.t0 > 800) return;
    // Clicking the staff takes keyboard focus away from the title / notes fields.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    tapStaff(p, g.hit, e, g.shift);
  };
  host.addEventListener('pointerup', finish);
  host.addEventListener('pointercancel', finish);
}

let gesture = null;

function startArea(p, g) {
  const ref = cards.get(p.id);
  if (!ref || !ref.layout) return;
  g.area = true;
  clearTimeout(g.timer);
  closeSelMenu();
  if (g.mouse) { try { ref.host.setPointerCapture(g.id); } catch (e) { /* ignore */ } }
  if (!g.mouse && navigator.vibrate) navigator.vibrate(10);
  drawDragArea(ref.layout, g.anchor, g.last);
}

function finishSelect(p, g, e) {
  clearTimeout(g.timer);
  const ref = cards.get(p.id);
  if (!ref || !ref.layout) return;
  if (g.cancelled || e.type === 'pointercancel') {
    if (g.area) drawStave(p.id);
    return;
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const dragged = g.area && (g.last.m !== g.anchor.m || Math.abs(g.last.x - g.anchor.x) > 8);
  if (dragged) selectBetween(p, ref.layout, g.anchor, g.last);
  else selectAt(p, g.hit, g.anchor);
  changed(p, false);
  openSelMenuNear(p, e.clientX);
}

const isSelectedNote = (m, i) => !!state.sel && state.sel.m === m && state.sel.i === i && !state.selEnd;

// What a tap on the staff does.
function tapStaff(p, hit, e, shift) {
  const ref = cards.get(p.id);
  if (ref && ref.override) return toast('Showing another key while practising. Stop playback to edit.');
  if (hit.type === 'chord') return openChordPicker(p, hit.m, hit.slot, e.clientX, e.clientY);
  if (hit.type === 'note') {
    const note = p.measures[hit.m].notes[hit.i];
    // Shift+click extends a selection.
    if (shift && state.sel) {
      state.selEnd = { m: hit.m, i: hit.i };
      return changed(p, false);
    }
    const pitchDiffers = !note.rest && diatonicIndex(note.step, note.oct) !== hit.diatonic;
    if (state.replace && (note.rest || pitchDiffers) && !note.trip) {
      return overwriteAt(p, hit.m, hit.tick, newNoteAt(p, hit.diatonic));
    }
    if (isSelectedNote(hit.m, hit.i) && pitchDiffers) {
      snapshot(p);
      const { step, oct } = fromDiatonic(hit.diatonic);
      Object.assign(note, { step, oct, alter: keyAlter(p.keySig, step) });
      audition(p, note);
      return changed(p);
    }
    state.sel = { m: hit.m, i: hit.i };
    state.selEnd = null;
    if (!note.rest) audition(p, note);
    return changed(p, false);
  }
  if (hit.type === 'staff') {
    const note = newNoteAt(p, hit.diatonic);
    // Tapping the empty part of a bar puts the note on that beat.
    if (hit.padTick !== undefined && !note.trip) {
      // Snap to the grid of the chosen note length (at least an eighth note),
      // never before the music already in the bar.
      const grid = Math.max(12, DUR_TICKS[note.dur]);
      const used = measureTicks(p.measures[hit.m]);
      let tick = Math.floor(hit.padTick / grid) * grid;
      if (tick < used) tick = used;
      return placeAt(p, hit.m, tick, note);
    }
    insertNote(p, hit.m, hit.insertIndex, note);
  }
}

function newNoteAt(p, diatonic) {
  const { step, oct } = fromDiatonic(diatonic);
  return { rest: false, step, oct, alter: keyAlter(p.keySig, step), dur: state.tool.dur, dots: state.tool.dots, trip: state.tool.trip, tie: false };
}

function audition(p, note) {
  if (!note.rest) previewNote(midi(note), p.instrument);
}

// Re-draw after a change. `dirty` = the phrase data changed (needs saving).
function changed(p, dirty = true) {
  if (dirty) {
    save();
    if (player.currentId === p.id && player.state === 'paused') player.stop();
  }
  drawStave(p.id);
  refreshToolbar();
}

// ---------------------------------------------------------------- editing operations

function selectedNote() {
  const p = editing();
  if (!p || !state.sel) return null;
  const m = p.measures[state.sel.m];
  return (m && m.notes[state.sel.i]) || null;
}

function fits(measure, extraTicks, minusTicks = 0) {
  return measureTicks(measure) - minusTicks + extraTicks <= MEASURE_TICKS;
}

// A placeholder rest that keeps an unfinished triplet group complete.
const holdRest = (dur) => ({ rest: true, dur, dots: 0, trip: true, hold: true, tie: false });

function insertNote(p, m, index, note) {
  if (note.dur === '16') note.dots = 0;
  if (note.trip && !TRIPLET_DURATIONS.includes(note.dur)) note.trip = false;
  if (note.trip) note.dots = 0;
  const measure = p.measures[m];

  // Filling a triplet placeholder of the same length: just replace it.
  const at = measure.notes[index];
  if (note.trip && at && at.hold && at.dur === note.dur) {
    snapshot(p);
    measure.notes[index] = note;
    state.sel = { m, i: index };
    state.selEnd = null;
    audition(p, note);
    changed(p);
    return true;
  }
  // Never split a triplet group: move past its placeholders.
  while (measure.notes[index] && measure.notes[index].hold) index++;

  // A new triplet note starts a whole group of three (note + 2 placeholders).
  const group = note.trip ? [note, holdRest(note.dur), holdRest(note.dur)] : [note];
  if (!withOverflow(p, () => measure.notes.splice(index, 0, ...group))) return false;
  selectNote(p, note);
  audition(p, note);
  changed(p);
  return true;
}

// Make a change; if a bar overflows, push its last notes on to the next bar
// (adding bars up to the maximum). Restores everything if it can't fit.
function withOverflow(p, change) {
  const before = JSON.stringify(p.measures);
  change();
  for (let k = 0; k < p.measures.length; k++) {
    const ms = p.measures[k];
    const moved = [];
    while (measureTicks(ms) > MEASURE_TICKS && ms.notes.length) moved.unshift(ms.notes.pop());
    // Trailing rests that get pushed out are just space: drop them.
    while (moved.length && moved[moved.length - 1].rest && !moved[moved.length - 1].trip) moved.pop();
    if (!moved.length) continue;
    if (k + 1 >= p.measures.length) {
      if (p.measures.length >= MAX_MEASURES) {
        p.measures = JSON.parse(before);
        toast(`The phrase is full (${MAX_MEASURES} bars). Delete or shorten something first.`);
        return false;
      }
      p.measures.push(emptyMeasure());
    }
    p.measures[k + 1].notes.unshift(...moved);
  }
  state.undo.push({ id: p.id, json: JSON.stringify({ ...p, measures: JSON.parse(before) }) });
  return true;
}

function locate(p, note) {
  for (let m = 0; m < p.measures.length; m++) {
    const i = p.measures[m].notes.indexOf(note);
    if (i >= 0) return { m, i };
  }
  return null;
}

function selectNote(p, note, endNote = null) {
  state.sel = locate(p, note);
  state.selEnd = endNote && endNote !== note ? locate(p, endNote) : null;
}

// Rests filling `len` ticks starting at bar position `pos`.
function restsFor(pos, len) {
  const out = [];
  let t = pos;
  const end = pos + len;
  while (t < end) {
    const step = [[48, 'h'], [24, 'q'], [12, '8'], [6, '16']].find(([d]) => d <= end - t && t % d === 0);
    if (!step) break;
    out.push({ rest: true, dur: step[1], dots: 0, tie: false });
    t += step[0];
  }
  return out;
}

// Rests at the end of a bar are shown automatically; don't store them.
function trimTrailingRests(ms) {
  while (ms.notes.length) {
    const last = ms.notes[ms.notes.length - 1];
    if (last.rest && !last.trip) ms.notes.pop();
    else break;
  }
}

// Put a note on a given beat in the empty part of a bar (rests before it).
function placeAt(p, m, tick, note) {
  const ms = p.measures[m];
  const used = measureTicks(ms);
  if (tick < used) return overwriteAt(p, m, tick, note);
  const room = MEASURE_TICKS - tick;
  if (noteTicks(note) > room) {
    // Shorten to the longest value that fits on this beat.
    const fit = ['h', 'q', '8', '16'].find((d) => DUR_TICKS[d] <= room);
    if (!fit) return;
    Object.assign(note, { dur: fit, dots: 0 });
  }
  snapshot(p);
  ms.notes.push(...restsFor(used, tick - used), note);
  selectNote(p, note);
  audition(p, note);
  changed(p);
}

// Replace mode: the new note takes over the time from `tick`, overwriting
// whatever was there (the rhythm of everything after stays where it was).
function overwriteAt(p, m, tick, note) {
  const ms = p.measures[m];
  let t = 0;
  const items = ms.notes.map((n) => { const it = { n, start: t, end: t + noteTicks(n) }; t = it.end; return it; });
  if (tick >= t) return placeAt(p, m, tick, note);
  const len = noteTicks(note);
  if (tick + len > MEASURE_TICKS) return toast('That note is too long for the rest of this bar.');
  const hit = items.filter((it) => it.end > tick && it.start < tick + len);
  if (hit.some((it) => it.n.trip)) return toast('Can\'t overwrite part of a triplet. Tap the triplet note itself to change its pitch.');
  const crossing = items.find((it) => it.start < tick + len && it.end > tick + len);
  const before = items.filter((it) => it.end <= tick).map((it) => it.n);
  const after = items.filter((it) => it.start >= tick + len).map((it) => it.n);
  const tail = crossing ? restsFor(tick + len, crossing.end - (tick + len)) : [];
  const lead = items.length && before.length === 0 && tick > 0 ? restsFor(0, tick) : [];
  snapshot(p);
  ms.notes = [...lead, ...before, note, ...tail, ...after];
  trimTrailingRests(ms);
  selectNote(p, note);
  audition(p, note);
  changed(p);
}

function setDuration(dur) {
  state.tool.dur = dur;
  if (!TRIPLET_DURATIONS.includes(dur)) state.tool.trip = false;
  const p = editing();
  const note = selectedNote();
  if (p && note) {
    const measure = p.measures[state.sel.m];
    if (note.trip && dur !== note.dur) {
      toast('To change a triplet\'s length, delete it and enter it again.');
      return refreshToolbar();
    }
    const next = { ...note, dur, dots: dur === '16' ? 0 : note.dots };
    if (state.selEnd) return applyToRange((n) => { if (!n.trip) Object.assign(n, { dur, dots: dur === '16' ? 0 : n.dots }); }, true);
    if (!withOverflow(p, () => Object.assign(note, next))) return refreshToolbar();
    selectNote(p, note);
    return changed(p);
  }
  refreshToolbar();
}

function toggleDot() {
  const p = editing();
  const note = selectedNote();
  if (p && note) {
    if (note.dur === '16') return toast('Dotted sixteenths aren\'t supported.');
    if (note.trip) return toast('Triplet notes can\'t be dotted.');
    const dots = note.dots ? 0 : 1;
    if (!withOverflow(p, () => { note.dots = dots; })) return;
    selectNote(p, note);
    state.tool.dots = note.dots;
    return changed(p);
  }
  state.tool.dots = state.tool.dots ? 0 : 1;
  if (state.tool.dots) state.tool.trip = false;
  refreshToolbar();
}

// Triplet mode: new notes are entered as triplets.
function toggleTrip() {
  state.tool.trip = !state.tool.trip;
  if (state.tool.trip) {
    state.tool.dots = 0;
    if (!TRIPLET_DURATIONS.includes(state.tool.dur)) state.tool.dur = '8';
  }
  refreshToolbar();
}

function changeKey(p, toKey) {
  if (toKey === p.keySig) return;
  snapshot(p);
  p.measures = transposeMeasures(p.measures, p.keySig, toKey);
  p.keySig = toKey;
  save();
  drawStave(p.id);
  refreshToolbar();
  restartIfPlaying(p.id);
  const ks = KEY_SIGS.find((k) => k.key === toKey);
  toast(`Transposed to ${ks ? ks.label : toKey}`);
}

function toggleRest() {
  const p = editing();
  const note = selectedNote();
  if (!p) return;
  if (note) {
    snapshot(p);
    if (note.rest) {
      delete note.hold;
      const prev = previousPitched(p, state.sel.m, state.sel.i);
      Object.assign(note, { rest: false, step: prev ? prev.step : 'B', oct: prev ? prev.oct : 4, alter: prev ? prev.alter : keyAlter(p.keySig, 'B') });
    } else {
      note.rest = true;
      note.tie = false;
    }
    return changed(p);
  }
  // No selection: add a rest at the end of the first bar with room.
  const rest = { rest: true, dur: state.tool.dur, dots: state.tool.dots, trip: state.tool.trip, tie: false };
  const m = p.measures.findIndex((ms) => fits(ms, noteTicks(rest)));
  if (m < 0) return toast('All bars are full.');
  insertNote(p, m, p.measures[m].notes.length, rest);
}

function setAlter(alter) {
  const p = editing();
  const note = selectedNote();
  if (!p || !note || note.rest) return;
  snapshot(p);
  note.alter = alter;
  audition(p, note);
  changed(p);
}

function toggleTie() {
  const p = editing();
  const note = selectedNote();
  if (!p || !note || note.rest) return;
  snapshot(p);
  note.tie = !note.tie;
  changed(p);
}

function movePitch(dir, octave = false) {
  if (state.selEnd) return octave ? shiftOctave(dir) : shiftSemitone(dir);
  const p = editing();
  const note = selectedNote();
  if (!p || !note || note.rest) return;
  const d = diatonicIndex(note.step, note.oct) + dir * (octave ? 7 : 1);
  if (d < MIN_DIATONIC || d > MAX_DIATONIC) return;
  snapshot(p);
  const { step, oct } = fromDiatonic(d);
  Object.assign(note, { step, oct, alter: octave ? note.alter : keyAlter(p.keySig, step) });
  audition(p, note);
  changed(p);
}

function flatIndex(p) {
  const list = [];
  p.measures.forEach((ms, m) => ms.notes.forEach((_, i) => list.push({ m, i })));
  return list;
}

function moveSel(dir) {
  const p = editing();
  if (!p) return;
  const list = flatIndex(p);
  if (!list.length) return;
  let k = state.sel ? list.findIndex((s) => s.m === state.sel.m && s.i === state.sel.i) : -1;
  k = k < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, k + dir));
  state.sel = list[k];
  state.selEnd = null;
  areaFromSel(p);
  const note = selectedNote();
  if (note) audition(p, note);
  changed(p, false);
}

function extendSel(dir) {
  const p = editing();
  if (!p || !state.sel) return moveSel(dir);
  const list = flatIndex(p);
  const end = state.selEnd || state.sel;
  let k = list.findIndex((s) => s.m === end.m && s.i === end.i) + dir;
  k = Math.max(0, Math.min(list.length - 1, k));
  state.selEnd = list[k].m === state.sel.m && list[k].i === state.sel.i ? null : list[k];
  areaFromSel(p);
  changed(p, false);
}

function deleteSelected() {
  const p = editing();
  if (!p || !state.sel) return;
  if (state.selEnd) {
    snapshot(p);
    const range = selectedRange();
    const firstM = range[0].m;
    const firstI = range[0].i;
    for (const s of [...range].reverse()) {
      const notes = p.measures[s.m].notes;
      if (notes[s.i].trip) notes[s.i] = holdRest(notes[s.i].dur);
      else notes.splice(s.i, 1);
    }
    p.measures.forEach((ms) => removeEmptyTriplets(ms.notes));
    state.selEnd = null;
    const list = flatIndex(p);
    const before = list.filter((x) => x.m < firstM || (x.m === firstM && x.i < firstI));
    state.sel = before.length ? before[before.length - 1] : null;
    if (state.mode === 'select') clearSelection();
    return changed(p);
  }
  snapshot(p);
  const { m, i } = state.sel;
  const notes = p.measures[m].notes;
  const note = notes[i];
  if (note.trip) {
    // Inside a triplet the note becomes a placeholder; a group that is all
    // placeholders disappears.
    notes[i] = holdRest(note.dur);
    removeEmptyTriplets(notes);
  } else {
    notes.splice(i, 1);
  }
  const list = flatIndex(p);
  // Select the note before the deleted one (or nothing).
  const before = list.filter((s) => s.m < m || (s.m === m && s.i < i));
  state.sel = before.length ? before[before.length - 1] : null;
  if (state.mode === 'select') clearSelection();
  changed(p);
}

function removeEmptyTriplets(notes) {
  let k = 0;
  while (k < notes.length) {
    if (!notes[k].trip) { k++; continue; }
    const target = 2 * DUR_TICKS[notes[k].dur];
    let j = k;
    let sum = 0;
    while (j < notes.length && notes[j].trip && sum < target) sum += noteTicks(notes[j++]);
    if (notes.slice(k, j).every((n) => n.hold)) notes.splice(k, j - k);
    else k = j;
  }
}

function previousPitched(p, m, i) {
  const list = flatIndex(p);
  let k = list.findIndex((s) => s.m === m && s.i === i);
  if (k < 0) k = list.length;
  for (let j = k - 1; j >= 0; j--) {
    const n = p.measures[list[j].m].notes[list[j].i];
    if (!n.rest) return n;
  }
  return null;
}

// Typing a letter: add that note after the selection, in the octave closest
// to the previous note.
function typeLetter(step) {
  const p = editing();
  if (!p) return;
  let m;
  let index;
  if (state.sel) {
    m = state.sel.m;
    index = state.sel.i + 1;
  } else {
    m = p.measures.findIndex((ms) => measureTicks(ms) < MEASURE_TICKS);
    if (m < 0) return toast('All bars are full.');
    index = p.measures[m].notes.length;
  }
  const prev = state.sel ? previousPitched(p, m, index) : previousPitched(p, m, index);
  const ref = prev ? diatonicIndex(prev.step, prev.oct) : diatonicIndex('B', 4);
  let best = null;
  for (let oct = 3; oct <= 7; oct++) {
    const d = diatonicIndex(step, oct);
    if (d < MIN_DIATONIC || d > MAX_DIATONIC) continue;
    if (best === null || Math.abs(d - ref) < Math.abs(best - ref)) best = d;
  }
  const { oct } = fromDiatonic(best);
  insertNote(p, m, index, { rest: false, step, oct, alter: keyAlter(p.keySig, step), dur: state.tool.dur, dots: state.tool.dots, trip: state.tool.trip, tie: false });
}

// ---------------------------------------------------------------- selection & clipboard

const CLIP_KEY = 'jazzlicks.clipboard';

function selectedRange() {
  const p = editing();
  if (!p || !state.sel) return [];
  const list = flatIndex(p);
  const a = list.findIndex((s) => s.m === state.sel.m && s.i === state.sel.i);
  if (a < 0) return [];
  if (!state.selEnd) return [list[a]];
  const b = list.findIndex((s) => s.m === state.selEnd.m && s.i === state.selEnd.i);
  if (b < 0) return [list[a]];
  return list.slice(Math.min(a, b), Math.max(a, b) + 1);
}

function selectedSet() {
  return new Set(selectedRange().map((s) => `${s.m}:${s.i}`));
}

const rangeNotes = (p) => selectedRange().map((s) => p.measures[s.m].notes[s.i]);

// The clipboard lives in this browser, so it can be pasted into any lick.
// { notes: [...], bars: [{ chords, notes }] | null, from: { keySig, tempo, ... } }
function clipboard() {
  try {
    const c = JSON.parse(localStorage.getItem(CLIP_KEY));
    if (Array.isArray(c)) return { notes: c, bars: null };
    return c && Array.isArray(c.notes) ? c : { notes: [], bars: null };
  } catch (e) {
    return { notes: [], bars: null };
  }
}

function setClipboard(clip) {
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch (e) { /* ignore */ }
}

const deep = (x) => JSON.parse(JSON.stringify(x));
const clipFrom = (p) => ({ keySig: p.keySig, tempo: p.tempo, style: p.style, instrument: p.instrument, title: p.title });

// Bars m0..m1 as standalone bars: a bar that starts without a chord gets the
// chord that was sounding there, so the harmony comes along.
function barsOf(p, m0, m1) {
  const bars = [];
  let current = null;
  for (let m = 0; m <= m1; m++) {
    const ms = p.measures[m];
    if (m >= m0) {
      const bar = deep(ms);
      bar.chords = bar.chords || [null, null];
      if (!bar.chords[0] && current) bar.chords[0] = { ...current };
      bars.push(bar);
    }
    for (const c of ms.chords || []) if (c) current = c;
  }
  return bars;
}

const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
const barsLabel = (m0, m1) => (m0 === m1 ? `bar ${m0 + 1}` : `bars ${m0 + 1}–${m1 + 1}`);
const emptyBar = (ms) => !ms.notes.length && !(ms.chords || []).some(Boolean);

function copyNotes(p) {
  const notes = rangeNotes(p).map((n) => ({ ...n }));
  if (!notes.length) return toast('Select some notes first.');
  setClipboard({ notes, bars: null, from: clipFrom(p) });
  toast(`Copied ${plural(notes.length, 'note')}.`);
  refreshToolbar();
}

function copyBars(p, m0, m1) {
  const bars = barsOf(p, m0, m1);
  setClipboard({ notes: bars.flatMap((b) => deep(b.notes)), bars, from: clipFrom(p) });
  toast(`Copied ${plural(bars.length, 'bar')}${bars.some((b) => b.chords.some(Boolean)) ? ' (with chords)' : ''}.`);
  refreshToolbar();
}

// Ctrl+C.
function copySelection() {
  const p = editing();
  if (!p) return;
  const a = state.area;
  if (state.mode === 'select' && a) return a.whole ? copyBars(p, a.m0, a.m1) : copyNotes(p);
  if (!state.sel) return toast('Select some notes first.');
  // Whole bars selected (first to last note of bars): bring the chords too.
  const range = selectedRange();
  const first = range[0];
  const last = range[range.length - 1];
  const whole = first.i === 0 && last.i === p.measures[last.m].notes.length - 1;
  return whole ? copyBars(p, first.m, last.m) : copyNotes(p);
}

function copyAllBars(id) {
  const p = byId(id);
  if (!p) return;
  let last = p.measures.length - 1;
  while (last > 0 && emptyBar(p.measures[last])) last--;
  const bars = barsOf(p, 0, last);
  setClipboard({ notes: bars.flatMap((b) => deep(b.notes)), bars, from: clipFrom(p) });
  toast(`Copied ${plural(bars.length, 'bar')} of “${p.title}”. Paste them into any lick.`);
  if (state.editingId) refreshToolbar();
}

const isEmptyPhrase = (p) => p.measures.every(emptyBar);

// Put copied bars in at bar `start`: `over` writes over the bars there (adding
// bars at the end if needed), otherwise they are inserted.
function pasteBarsAt(p, bars, start, over, from) {
  const copies = deep(bars);
  const len = over ? Math.max(p.measures.length, start + copies.length) : p.measures.length + copies.length;
  if (len > MAX_MEASURES) {
    toast(`Not enough room: a lick can have at most ${MAX_MEASURES} bars.`);
    return null;
  }
  const wasEmpty = isEmptyPhrase(p);
  snapshot(p);
  if (over) copies.forEach((b, k) => { p.measures[start + k] = b; });
  else p.measures.splice(start, 0, ...copies);
  // An empty lick takes on the key of what's pasted into it.
  if (wasEmpty && from && from.keySig) p.keySig = from.keySig;
  return { start, count: copies.length };
}

// The first bar after the music (0 in an empty lick).
function afterMusic(p) {
  let m = p.measures.length;
  while (m > 0 && emptyBar(p.measures[m - 1])) m--;
  return m;
}

// Paste bars after bar `afterM`, using up empty bars there rather than
// pushing them along.
function pasteBarsAfter(p, clip, afterM) {
  const start = afterM + 1;
  const n = clip.bars.length;
  const over = p.measures.slice(start, start + n).every(emptyBar);
  return pasteBarsAt(p, clip.bars, start, over, clip.from);
}

// Select bars m0..m1 (and the notes in them).
function selectBars(p, m0, m1) {
  const list = [];
  for (let m = m0; m <= m1; m++) p.measures[m].notes.forEach((_, i) => list.push({ m, i }));
  setArea(p, m0, m1, list);
}

// Ctrl+V: paste after the selection (or after the music).
function pasteClipboard(clip = clipboard()) {
  const p = editing();
  if (!p) return;
  if (Array.isArray(clip)) clip = { notes: clip, bars: null };
  if (!clip.notes.length && !clip.bars) return toast('Nothing copied yet.');
  const range = selectedRange();
  if (clip.bars) {
    const afterM = state.mode === 'select' && state.area ? state.area.m1 : range.length ? range[range.length - 1].m : afterMusic(p) - 1;
    const put = pasteBarsAfter(p, clip, afterM);
    if (!put) return;
    // Select what was pasted, ready for octave / transpose.
    selectBars(p, put.start, put.start + put.count - 1);
    toast(`Pasted ${plural(put.count, 'bar')} into ${barsLabel(put.start, put.start + put.count - 1)}.`);
    return changed(p);
  }
  const copies = clip.notes.map((n) => ({ ...n }));
  let m;
  let index;
  if (range.length) {
    const last = range[range.length - 1];
    m = last.m;
    index = last.i + 1;
  } else {
    m = p.measures.length - 1;
    while (m > 0 && !p.measures[m].notes.length) m--;
    index = p.measures[m].notes.length;
  }
  if (!withOverflow(p, () => p.measures[m].notes.splice(index, 0, ...copies))) return;
  selectPasted(p, copies);
  changed(p);
}

function selectPasted(p, copies) {
  const locs = copies.map((n) => locate(p, n)).filter(Boolean);
  if (!locs.length) return clearSelection();
  setArea(p, locs[0].m, locs[locs.length - 1].m, locs);
}

// ---------------------------------------------------------------- select mode: choosing

function clearSelection() {
  state.sel = null;
  state.selEnd = null;
  state.area = null;
}

function setMode(mode) {
  state.mode = mode;
  clearSelection();
  closeSelMenu();
  const p = editing();
  if (p) changed(p, false);
}

// Select the notes `list` ({m, i} in order) within bars m0..m1. A bar at
// either end whose notes were all left out (the drag began after them) is
// dropped; an empty bar stays, so it can be pasted into.
function setArea(p, m0, m1, list) {
  if (list.length) {
    if (p.measures[m0].notes.length && list[0].m !== m0) m0 = list[0].m;
    if (p.measures[m1].notes.length && list[list.length - 1].m !== m1) m1 = list[list.length - 1].m;
  }
  state.sel = list.length ? { m: list[0].m, i: list[0].i } : null;
  state.selEnd = list.length > 1 ? { m: list[list.length - 1].m, i: list[list.length - 1].i } : null;
  let total = 0;
  for (let m = m0; m <= m1; m++) total += p.measures[m].notes.length;
  state.area = { m0, m1, whole: list.length === total };
}

// Everything between two dragged-to points.
function selectBetween(p, layout, a, b) {
  const [s, t] = isBefore(a, b) ? [a, b] : [b, a];
  const inside = layout.notes.filter((nt) => !nt.pad
    && (nt.m > s.m || (nt.m === s.m && nt.x >= s.x - 6))
    && (nt.m < t.m || (nt.m === t.m && nt.x <= t.x + 6)));
  setArea(p, s.m, t.m, inside.map((nt) => ({ m: nt.m, i: nt.i })));
}

// A tap: a note on its own, or else the whole bar.
function selectAt(p, hit, at) {
  if (hit && hit.type === 'note') return setArea(p, hit.m, hit.m, [{ m: hit.m, i: hit.i }]);
  selectBars(p, hit ? hit.m : at.m, hit ? hit.m : at.m);
}

// Keep the highlight in step when the selection moves by keyboard.
function areaFromSel(p) {
  if (state.mode !== 'select') return;
  const range = selectedRange();
  if (!range.length) { state.area = null; return; }
  setArea(p, range[0].m, range[range.length - 1].m, range);
}

function selectAllBars() {
  const p = editing();
  if (!p) return;
  selectBars(p, 0, Math.max(0, afterMusic(p) - 1));
  changed(p, false);
  openSelMenuNear(p);
}

function removeBars(p, m0, m1) {
  if (m1 - m0 + 1 >= p.measures.length) return toast('A lick needs at least one bar.');
  snapshot(p);
  p.measures.splice(m0, m1 - m0 + 1);
  clearSelection();
  toast(`Removed ${barsLabel(m0, m1)}.`);
  changed(p);
}

function pasteNotesHow(p, how) {
  const clip = clipboard();
  const copies = clip.notes.map((n) => ({ ...n }));
  const range = selectedRange();
  const a = state.area;
  if (!copies.length) return;
  const ok = withOverflow(p, () => {
    if (how === 'into') {
      p.measures[a.m0].notes.push(...copies);
    } else if (how === 'before') {
      p.measures[range[0].m].notes.splice(range[0].i, 0, ...copies);
    } else if (how === 'after') {
      const last = range[range.length - 1];
      p.measures[last.m].notes.splice(last.i + 1, 0, ...copies);
    } else {
      const { m, i } = range[0];
      for (const sel of [...range].reverse()) p.measures[sel.m].notes.splice(sel.i, 1);
      p.measures[m].notes.splice(i, 0, ...copies);
    }
  });
  if (!ok) return;
  if (how === 'replace') p.measures.forEach((ms) => removeEmptyTriplets(ms.notes));
  selectPasted(p, copies);
  toast(`Pasted ${plural(copies.length, 'note')}.`);
  changed(p);
}

function pasteBarsHow(p, how) {
  const clip = clipboard();
  const a = state.area;
  const start = how === 'after' ? a.m1 + 1 : a.m0;
  const put = pasteBarsAt(p, clip.bars, start, how === 'over', clip.from);
  if (!put) return;
  selectBars(p, put.start, put.start + put.count - 1);
  toast(`Pasted ${plural(put.count, 'bar')} into ${barsLabel(put.start, put.start + put.count - 1)}.`);
  changed(p);
}

// ---------------------------------------------------------------- select mode: the menu

let selMenu = null;

function closeSelMenu() {
  if (selMenu) {
    selMenu.el.remove();
    selMenu = null;
  }
}

// Open the menu just below (or above) the highlighted area, so it doesn't
// cover the selected notes.
function openSelMenuNear(p, cx) {
  const ref = cards.get(p.id);
  if (!ref) return;
  const rects = ref.layout ? [...ref.layout.svg.querySelectorAll('.sel-area rect')].map((r) => r.getBoundingClientRect()) : [];
  if (!rects.length) rects.push(ref.host.getBoundingClientRect());
  const box = {
    left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)),
    top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)),
  };
  openSelMenu(p, cx === undefined ? (box.left + box.right) / 2 : cx, box);
}

function openSelMenu(p, cx, box) {
  closeSelMenu();
  const a = state.area;
  if (!a) return;
  const n = selectedRange().length;
  const clip = clipboard();
  const where = barsLabel(a.m0, a.m1);
  const reopen = () => { if (state.area) openSelMenuNear(p, cx); };
  const btn = (label, fn, { keep = false, cls = '', title = '' } = {}) => h('button', {
    class: `sm-btn ${cls}`.trim(), title,
    onclick: () => { closeSelMenu(); fn(); if (keep) reopen(); },
  }, label);
  const section = (label, ...buttons) => h('div', { class: 'sm-section' },
    h('div', { class: 'sm-label' }, label), h('div', { class: 'sm-buttons' }, ...buttons.filter(Boolean)));

  const hasChords = p.measures.slice(a.m0, a.m1 + 1).some((ms) => (ms.chords || []).some(Boolean));
  const title = n ? `${plural(n, 'note')} · ${where}` : `${where[0].toUpperCase()}${where.slice(1)} (no notes)`;

  // Copy: when only part of a bar is chosen, offer the whole bar too.
  const withChords = hasChords ? ' with chords' : '';
  let copy = null;
  if (n && a.whole) {
    copy = section('Copy',
      btn(`Copy ${where}${withChords}`, () => copyBars(p, a.m0, a.m1), { cls: 'primary' }),
      hasChords ? btn('Copy the notes only', () => copyNotes(p)) : null);
  } else if (n) {
    copy = section('Copy',
      btn(n === 1 ? 'Copy this note' : `Copy these ${n} notes`, () => copyNotes(p), { cls: 'primary' }),
      btn(`Copy the whole ${where}${withChords}`, () => copyBars(p, a.m0, a.m1)));
  } else if (hasChords) {
    copy = section('Copy', btn(`Copy ${where} (chords)`, () => copyBars(p, a.m0, a.m1)));
  }

  let paste = null;
  if (clip.bars) {
    const len = clip.bars.length;
    const targetEmpty = p.measures.slice(a.m0, a.m0 + len).every(emptyBar);
    paste = section(`Paste the ${plural(len, 'copied bar')}`,
      btn(`${targetEmpty ? 'Paste into' : 'Paste over'} ${barsLabel(a.m0, a.m0 + len - 1)}`, () => pasteBarsHow(p, 'over'), { cls: targetEmpty ? 'primary' : '' }),
      btn(`Insert before ${barsLabel(a.m0, a.m0)}`, () => pasteBarsHow(p, 'before')),
      btn(`Insert after ${barsLabel(a.m1, a.m1)}`, () => pasteBarsHow(p, 'after')));
  } else if (clip.notes.length) {
    const label = `Paste the ${plural(clip.notes.length, 'copied note')}`;
    paste = n
      ? section(label,
        btn('Replace the selection', () => pasteNotesHow(p, 'replace')),
        btn('Insert before', () => pasteNotesHow(p, 'before')),
        btn('Insert after', () => pasteNotesHow(p, 'after')))
      : section(label, btn(`Paste into ${barsLabel(a.m0, a.m0)}`, () => pasteNotesHow(p, 'into'), { cls: 'primary' }));
  }

  const change = n ? section('Change',
    btn('8va ▲', () => shiftOctave(1), { keep: true, title: 'Octave up' }),
    btn('8va ▼', () => shiftOctave(-1), { keep: true, title: 'Octave down' }),
    btn('½ ▲', () => shiftSemitone(1), { keep: true, title: 'Up a semitone' }),
    btn('½ ▼', () => shiftSemitone(-1), { keep: true, title: 'Down a semitone' })) : null;

  const more = section('More',
    n ? btn('→ New lick', newLickFromSelection, { title: 'Make a new lick from the selection' }) : null,
    n ? btn('Delete notes', deleteSelected, { cls: 'danger' }) : null,
    a.whole && p.measures.length > a.m1 - a.m0 + 1 ? btn(`Remove ${where}`, () => removeBars(p, a.m0, a.m1), { cls: 'danger' }) : null);

  const el = h('div', { class: 'sel-menu', role: 'dialog', 'aria-label': 'Selection' },
    h('div', { class: 'sm-head' },
      h('span', {}, title),
      h('button', { class: 'sm-close', 'aria-label': 'Close', onclick: closeSelMenu }, '✕')),
    copy, paste, change,
    more.querySelector('button') ? more : null);
  document.body.appendChild(el);
  // Next to the pointer, kept on screen (and above the phone toolbar).
  const r = el.getBoundingClientRect();
  const bar = document.body.classList.contains('is-editing') && $('.toolbar') ? $('.toolbar').getBoundingClientRect() : null;
  const bottomLimit = bar && bar.top > window.innerHeight / 2 ? bar.top - 8 : window.innerHeight - 8;
  const left = Math.min(Math.max(8, cx - r.width / 2), window.innerWidth - r.width - 8);
  let top = box.bottom + 6;
  if (top + r.height > bottomLimit) {
    top = box.top - r.height - 6; // above the selection
    if (top < 8) top = Math.max(8, bottomLimit - r.height); // no room either way: as low as possible
  }
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${top}px`;
  selMenu = { el, id: p.id };
}

document.addEventListener('pointerdown', (e) => {
  if (selMenu && !selMenu.el.contains(e.target)) closeSelMenu();
}, true);

// Card menu: append the copied bars (or notes) to the end of a lick.
function pasteIntoLick(id) {
  const p = byId(id);
  const clip = clipboard();
  if (!p) return;
  if (!clip.notes.length && !clip.bars) return toast('Nothing copied yet.');
  if (clip.bars) {
    // Straight after the music, using up any empty bars there.
    if (!pasteBarsAt(p, clip.bars, afterMusic(p), true, clip.from)) return;
  } else {
    const copies = clip.notes.map((n) => ({ ...n }));
    let m = p.measures.length - 1;
    while (m > 0 && !p.measures[m].notes.length) m--;
    if (!withOverflow(p, () => p.measures[m].notes.splice(p.measures[m].notes.length, 0, ...copies))) return;
  }
  save();
  rebuildCard(id);
  toast(`Pasted into “${p.title}”.`);
}

// A new lick made from the clipboard (or the current selection).
function newLickFrom(clip, title) {
  if (!clip.notes.length && !clip.bars) return toast('Nothing copied yet.');
  const p = newPhrase(activeTab);
  const from = clip.from || {};
  Object.assign(p, {
    keySig: from.keySig || p.keySig,
    tempo: from.tempo || p.tempo,
    style: from.style || p.style,
    instrument: from.instrument || p.instrument,
    title: title || (from.title ? `${from.title} (part)` : p.title),
  });
  if (clip.bars) {
    p.measures = deep(clip.bars).slice(0, MAX_MEASURES);
  } else {
    p.measures = [emptyMeasure()];
    p.measures[0].notes = clip.notes.map((n) => ({ ...n }));
    if (!withOverflow(p, () => {})) return;
  }
  state.undo = state.undo.filter((u) => u.id !== p.id);
  state.phrases.unshift(p);
  save();
  state.editingId = p.id;
  clearSelection();
  closeSelMenu();
  renderAll();
  const ref = cards.get(p.id);
  if (ref) ref.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  toast('New lick created. Rename it at the top.');
}

function newLickFromSelection() {
  const p = editing();
  if (!p || !state.sel) return toast('Select some notes first.');
  copySelection();
  newLickFrom(clipboard());
}

function duplicateSelection() {
  const p = editing();
  if (!p || !state.sel) return toast('Select some notes first.');
  pasteClipboard(rangeNotes(p));
}

// Change every selected note; `reflow` re-checks bar lengths afterwards.
function applyToRange(fn, reflow = false) {
  const p = editing();
  if (!p || !state.sel) return;
  const notes = rangeNotes(p);
  const first = notes[0];
  const last = notes[notes.length - 1];
  if (reflow) {
    if (!withOverflow(p, () => notes.forEach(fn))) return;
  } else {
    snapshot(p);
    notes.forEach(fn);
  }
  selectNote(p, first, last);
  if (notes.length === 1 && !first.rest) audition(p, first);
  changed(p);
}

function shiftOctave(dir) {
  const p = editing();
  if (!p || !state.sel) return toast('Select some notes first.');
  const notes = rangeNotes(p).filter((n) => !n.rest);
  const ok = notes.every((n) => {
    const d = diatonicIndex(n.step, n.oct) + 7 * dir;
    return d >= MIN_DIATONIC && d <= MAX_DIATONIC;
  });
  if (!ok) return toast(`Can't go an octave ${dir > 0 ? 'higher' : 'lower'}: some notes would be out of range.`);
  applyToRange((n) => { if (!n.rest) n.oct += dir; });
}

function shiftSemitone(dir) {
  const p = editing();
  if (!p || !state.sel) return toast('Select some notes first.');
  const flats = dir < 0 || isFlatKey(p.keySig);
  applyToRange((n) => {
    if (n.rest) return;
    const sp = spellMidi(midi(n) + dir, flats);
    const d = diatonicIndex(sp.step, sp.oct);
    if (d >= MIN_DIATONIC && d <= MAX_DIATONIC) Object.assign(n, sp);
  });
}

function changeMeasures(delta) {
  const p = editing();
  if (!p) return;
  const n = p.measures.length + delta;
  if (n < 1 || n > MAX_MEASURES) return;
  snapshot(p);
  if (delta > 0) p.measures.push(emptyMeasure());
  else {
    p.measures.pop();
    if (state.sel && state.sel.m >= n) state.sel = null;
    if (state.area && state.area.m1 >= n) { clearSelection(); closeSelMenu(); }
  }
  changed(p);
}

// ---------------------------------------------------------------- chord picker

let picker = null;

function closeChordPicker() {
  if (picker) {
    picker.el.remove();
    picker = null;
  }
}

function openChordPicker(p, m, slot, cx, cy) {
  closeChordPicker();
  const current = p.measures[m].chords[slot];
  const st = { root: current ? current.root : null, quality: current ? current.quality : null };
  const flats = isFlatKey(p.keySig);
  const el = h('div', { class: 'picker', role: 'dialog', 'aria-label': 'Chord' });
  picker = { el, p, m, slot };
  let snapshotted = false;

  const commit = () => {
    if (!st.root || !st.quality) return;
    if (!snapshotted) { snapshot(p); snapshotted = true; }
    p.measures[m].chords[slot] = { root: st.root, quality: st.quality };
    save();
    drawStave(p.id);
  };

  const draw = () => {
    el.innerHTML = '';
    const roots = h('div', { class: 'roots' }, CHORD_ROOTS.map((names) => {
      if (names.length === 1) {
        return h('button', { class: 'root' + (st.root === names[0] ? ' on' : ''), onclick: () => { st.root = names[0]; commit(); draw(); } }, prettyRoot(names[0]));
      }
      const ordered = flats ? [names[1], names[0]] : names;
      return h('div', { class: 'root pair' }, ordered.map((nm) => h('button', {
        class: st.root === nm ? 'on' : '', onclick: () => { st.root = nm; commit(); draw(); },
      }, prettyRoot(nm))));
    }));
    const quals = h('div', { class: 'quals' }, CHORD_QUALITIES.map((q) => h('button', {
      class: 'qual' + (st.quality === q.id ? ' on' : ''), onclick: () => { st.quality = q.id; commit(); draw(); },
    }, q.label)));
    el.append(
      h('div', { class: 'picker-title' }, `Bar ${m + 1}, beat ${slot === 0 ? 1 : 3}`),
      roots, quals,
      h('div', { class: 'picker-actions' },
        h('button', {
          class: 'btn', disabled: !current && !(st.root && st.quality),
          onclick: () => { snapshot(p); p.measures[m].chords[slot] = null; save(); drawStave(p.id); closeChordPicker(); },
        }, 'Remove'),
        h('button', { class: 'btn primary', onclick: closeChordPicker }, 'Done')));
  };
  draw();
  document.body.append(el);
  const r = el.getBoundingClientRect();
  const left = Math.max(8, Math.min(cx - r.width / 2, window.innerWidth - r.width - 8));
  let top = cy + 14;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, cy - r.height - 14);
  el.style.left = `${left + window.scrollX}px`;
  el.style.top = `${top + window.scrollY}px`;
}

document.addEventListener('pointerdown', (e) => {
  if (picker && !picker.el.contains(e.target) && !e.target.closest('.stave-host')) closeChordPicker();
}, true);

// ---------------------------------------------------------------- phrase-level actions

function setEditing(id) {
  closeChordPicker();
  const prev = state.editingId;
  state.editingId = id;
  state.sel = null;
  state.selEnd = null;
  state.area = null;
  closeSelMenu();
  document.body.classList.toggle('is-editing', !!id);
  if (prev && prev !== id) rebuildCard(prev);
  if (id) rebuildCard(id);
  else if (prev) rebuildCard(prev);
  if (id) {
    const ref = cards.get(id);
    ref && ref.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function addPhrase(group) {
  const p = newPhrase(activeTab);
  if (typeof group === 'string') p.group = group;
  if (searchQuery) { searchQuery = ''; $('#search').value = ''; }
  state.phrases.unshift(p);
  save();
  state.editingId = p.id;
  state.sel = null;
  renderAll();
  const ref = cards.get(p.id);
  if (ref) {
    ref.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('.title', ref.el).select();
  }
}

function duplicatePhrase(id) {
  const p = byId(id);
  if (!p) return;
  const copy = { ...JSON.parse(JSON.stringify(p)), id: uid(), title: `${p.title} (copy)` };
  state.phrases.splice(state.phrases.indexOf(p) + 1, 0, copy);
  save();
  renderAll();
}

function movePhrase(id, dir) {
  const i = state.phrases.findIndex((p) => p.id === id);
  if (i < 0) return;
  const cat = categoryOf(state.phrases[i]);
  let j = i + dir;
  while (j >= 0 && j < state.phrases.length && categoryOf(state.phrases[j]) !== cat) j += dir;
  if (j < 0 || j >= state.phrases.length) return;
  [state.phrases[i], state.phrases[j]] = [state.phrases[j], state.phrases[i]];
  save();
  renderAll();
}

function deletePhrase(id) {
  const p = byId(id);
  if (!p) return;
  if (!confirm(`Delete “${p.title}”?`)) return;
  if (player.currentId === id) player.stop();
  state.phrases = state.phrases.filter((x) => x.id !== id);
  state.deleted[id] = Date.now();
  if (state.editingId === id) state.editingId = null;
  save();
  renderAll();
}

// ---------------------------------------------------------------- playback

function setPlayIcon(btn, st) {
  btn.innerHTML = st === 'playing' ? ICONS.pause : st === 'loading' ? ICONS.loading : ICONS.play;
  btn.classList.toggle('active', st === 'playing' || st === 'loading');
  btn.setAttribute('aria-label', st === 'playing' ? 'Pause' : 'Play');
}

let lastPlayingEl = null;
function hooksFor(id) {
  return {
    onState: (st) => {
      const ref = cards.get(id);
      if (!ref) return;
      setPlayIcon(ref.playBtn, st);
      if (st === 'stopped' && (ref.override || !ref.passBadge.hidden)) {
        ref.passBadge.hidden = true;
        if (ref.override) { ref.override = null; drawStave(id); }
      }
    },
    onPass: (ps) => {
      const ref = cards.get(id);
      if (!ref) return;
      ref.passBadge.hidden = false;
      ref.passBadge.textContent = ps.label;
      // In "12 keys", show the notation in the key being played.
      const p = byId(id);
      if (p && p.practice === 'keys') {
        ref.override = ps.k === 0 ? null : ps.phrase;
        drawStave(id);
      }
    },
    onNote: (m, i) => {
      if (lastPlayingEl) lastPlayingEl.classList.remove('playing');
      lastPlayingEl = null;
      if (m === null || m === undefined) return;
      const ref = cards.get(id);
      const el = ref && ref.layout && noteElement(ref.layout, m, i);
      if (el) {
        el.classList.add('playing');
        lastPlayingEl = el;
      }
    },
    onError: toast,
  };
}

function togglePlay(id) {
  const p = byId(id);
  if (!p) return;
  if (!p.measures.some((m) => m.notes.length || m.chords.some(Boolean))) return toast('Add some notes or chords first.');
  player.toggle(p, hooksFor(id));
}

function restartIfPlaying(id) {
  const p = byId(id);
  if (!p || player.currentId !== id) return;
  if (player.state === 'playing') player.play(p, hooksFor(id));
  else player.stop(); // paused: the next play starts fresh with the new settings
}

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'Escape') {
    if (picker) return closeChordPicker();
    if (selMenu) return closeSelMenu();
    if (typing) return t.blur();
    if (state.sel || state.area) { clearSelection(); const p = editing(); return p && changed(p, false); }
    if (state.editingId) return setEditing(null);
    return;
  }
  if (typing) return;
  const p = editing();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return undo();
  }
  if (p && (e.ctrlKey || e.metaKey) && ['c', 'v', 'd', 'a'].includes(e.key.toLowerCase())) {
    e.preventDefault();
    const k = e.key.toLowerCase();
    if (k === 'c') return copySelection();
    if (k === 'v') return pasteClipboard();
    if (k === 'd') return duplicateSelection();
    if (k === 'a') {
      const list = flatIndex(p);
      if (!list.length) return;
      state.sel = list[0];
      state.selEnd = list.length > 1 ? list[list.length - 1] : null;
      areaFromSel(p);
      return changed(p, false);
    }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ') {
    const id = state.editingId || (player.currentId) || (state.phrases[0] && state.phrases[0].id);
    if (id) { e.preventDefault(); togglePlay(id); }
    return;
  }
  if (!p) return;
  const key = e.key;
  const handled = () => e.preventDefault();
  if (/^[a-g]$/i.test(key)) { handled(); return typeLetter(key.toUpperCase()); }
  if (/^[1-5]$/.test(key)) { handled(); return setDuration(DURATIONS[Number(key) - 1]); }
  switch (key) {
    case 'ArrowUp': handled(); return movePitch(1, e.shiftKey);
    case 'ArrowDown': handled(); return movePitch(-1, e.shiftKey);
    case 'ArrowLeft': handled(); return e.shiftKey ? extendSel(-1) : moveSel(-1);
    case 'ArrowRight': handled(); return e.shiftKey ? extendSel(1) : moveSel(1);
    case 'Backspace': case 'Delete': handled(); return deleteSelected();
    case '.': handled(); return toggleDot();
    case 'r': case 'R': case '0': handled(); return toggleRest();
    case 't': case 'T': handled(); return toggleTie();
    case '/': handled(); return toggleTrip();
    case '+': case '=': case '#': handled(); return setAlter(1);
    case '-': case '_': handled(); return setAlter(-1);
    case 'n': case 'N': handled(); return setAlter(0);
    default:
  }
});

// ---------------------------------------------------------------- import / export

function exportLicks() {
  const blob = new Blob([JSON.stringify({ version: 1, phrases: state.phrases }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `jazzlicks-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function validPhrase(p) {
  return p && Array.isArray(p.measures) && p.measures.length >= 1 && p.measures.length <= MAX_MEASURES
    && p.measures.every((m) => Array.isArray(m.notes) && m.notes.every((n) => DURATIONS.includes(n.dur) && (n.rest || STEPS.includes(n.step))));
}

function importLicks(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const list = (Array.isArray(data) ? data : data.phrases || []).filter(validPhrase);
      if (!list.length) return toast('No licks found in that file.');
      for (const p of list) {
        p.id = uid();
        p.measures.forEach((m) => { m.chords = Array.isArray(m.chords) ? [m.chords[0] || null, m.chords[1] || null] : [null, null]; });
        state.phrases.push({ ...newPhrase(), ...p });
      }
      save();
      renderAll();
      toast(`Imported ${list.length} lick${list.length > 1 ? 's' : ''}.`);
    } catch (e) {
      toast('That file isn\'t a JazzLicks export.');
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- sync UI

const SYNC_LABELS = {
  off: 'Sync', idle: 'Synced', ok: 'Synced', pending: 'Saving…', syncing: 'Syncing…', offline: 'Offline', error: 'Sync problem',
};

function showSyncStatus(st) {
  const btn = $('#sync-btn');
  btn.dataset.state = st;
  $('.sync-label', btn).textContent = SYNC_LABELS[st] || 'Sync';
  btn.title = st === 'off' ? 'Sync your licks between devices' : `Sync: ${SYNC_LABELS[st]}`;
  refreshSyncDialog();
}

let syncDialog = null;

function timeAgo(t) {
  if (!t) return 'not yet';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(t).toLocaleString();
}

function openSyncDialog() {
  closeSyncDialog();
  syncDialog = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === syncDialog) closeSyncDialog(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sync' }));
  document.body.append(syncDialog);
  refreshSyncDialog();
}

function closeSyncDialog() {
  if (syncDialog) syncDialog.remove();
  syncDialog = null;
}

function appendAll(el, ...children) {
  el.append(...children.filter(Boolean));
}

function refreshSyncDialog() {
  if (!syncDialog) return;
  const box = $('.modal', syncDialog);
  const info = syncInfo();
  const focusedInput = box.querySelector('input:focus');
  if (focusedInput) return; // don't wipe what the user is typing
  box.innerHTML = '';
  const close = h('button', { class: 'modal-close', 'aria-label': 'Close', onclick: closeSyncDialog }, '×');
  const error = info.detail && (info.status === 'error' || info.status === 'off')
    ? h('p', { class: 'modal-error' }, info.detail) : null;

  if (!info.on) {
    const input = h('input', { type: 'password', class: 'token-input', placeholder: 'Paste your key or sync link', autocomplete: 'off', spellcheck: 'false' });
    const connectBtn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        connectBtn.disabled = true;
        connectBtn.textContent = 'Connecting…';
        try {
          await connect(input.value);
          toast('Sync is on.');
        } catch (e) { /* message shown via status */ }
        input.blur();
        refreshSyncDialog();
      },
    }, 'Connect');
    appendAll(box, close,
      h('h2', {}, 'Sync between your devices'),
      h('p', {}, 'Your licks are stored in a private gist (a small private file) on your GitHub account, so your phone and computer always show the same licks.'),
      h('ol', { class: 'steps' },
        h('li', {},
          h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=JazzLicks%20sync', target: '_blank', rel: 'noopener' }, 'Create a GitHub key'),
          ' (opens GitHub). The ', h('b', {}, 'gist'), ' box is already ticked — leave everything else. Set ', h('b', {}, 'Expiration'), ' to “No expiration”, then press ', h('b', {}, 'Generate token'), ' and copy it.'),
        h('li', {}, 'Paste it here:', h('div', { class: 'token-row' }, input, connectBtn))),
      error,
      h('p', { class: 'muted' }, 'Already set up on another device? Open the sync link from that device instead — no key needed.'));
    return;
  }

  const copyBtn = h('button', {
    class: 'btn',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(info.link);
        toast('Link copied. Send it to yourself and open it on your other device.');
      } catch (e) {
        prompt('Copy this link:', info.link);
      }
    },
  }, 'Copy link');
  const shareBtn = navigator.share ? h('button', {
    class: 'btn',
    onclick: () => navigator.share({ title: 'JazzLicks sync link', url: info.link }).catch(() => {}),
  }, 'Share…') : null;

  appendAll(box, close,
    h('h2', {}, 'Sync is on'),
    h('p', {}, `Connected to GitHub as `, h('b', {}, info.login || '?'), `. Last synced: ${timeAgo(info.lastSync)}.`),
    error,
    h('h3', {}, 'Add another device, or share with a friend'),
    h('p', {}, 'Open this link on your other device, or send it to a friend. Everyone who opens it shares this collection: you all see, add and edit the same licks.'),
    h('div', { class: 'link-row' }, copyBtn, shareBtn),
    h('p', { class: 'muted' }, 'The link contains your GitHub key, so only share it with people you trust. You can cancel it any time by deleting the key on GitHub.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn danger-btn', onclick: () => { disconnect(); toast('Sync turned off on this device. Your licks stay here.'); refreshSyncDialog(); } }, 'Turn off on this device'),
      h('button', { class: 'btn primary', onclick: () => syncNow().then(refreshSyncDialog) }, 'Sync now')));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && syncDialog) closeSyncDialog();
}, true);

// ---------------------------------------------------------------- boot

function boot() {
  backupOnce();
  load();
  $('#new-lick').addEventListener('click', () => addPhrase());
  const search = $('#search');
  let searchTimer = null;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { searchQuery = search.value; renderAll(); }, 150);
  });
  const headerMenu = $('#header-menu');
  const closeHeaderMenu = () => headerMenu.removeAttribute('open');
  $('#export').addEventListener('click', () => { closeHeaderMenu(); exportLicks(); });
  const fileInput = $('#import-file');
  $('#import').addEventListener('click', () => { closeHeaderMenu(); fileInput.click(); });
  document.addEventListener('pointerdown', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) importLicks(fileInput.files[0]);
    fileInput.value = '';
  });
  renderAll();

  $('#sync-btn').addEventListener('click', openSyncDialog);
  initSync({
    getData: syncData,
    applyData: applySynced,
    onStatus: showSyncStatus,
    onMessage: (msg) => { toast(msg); refreshSyncDialog(); },
  });

  let lastWidth = window.innerWidth;
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      closeChordPicker();
      drawAllStaves();
    }, 150);
  });

  // Start fetching sounds after the first interaction so the first play is quick.
  document.addEventListener('pointerdown', () => warmUp('piano'), { once: true });

  // Redraw once the chord font has loaded (it affects chord symbol widths).
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawAllStaves);
}

boot();
