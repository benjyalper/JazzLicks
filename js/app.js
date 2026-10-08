import {
  KEY_SIGS, DURATIONS, TRIPLET_DURATIONS, DUR_TICKS, MEASURE_TICKS, transposeMeasures, CHORD_QUALITIES, CHORD_ROOTS,
  keyAlter, isFlatKey, fromDiatonic, diatonicIndex, MIN_DIATONIC, MAX_DIATONIC,
  noteTicks, measureTicks, midi, prettyRoot, pitchLabel, STEPS,
} from './music.js';
import { renderPhrase, hitTest, ghostAt, noteElement } from './render.js';
import { player, previewNote, warmUp } from './player.js';
import { STYLES } from './backing.js';
import { initSync, notifyChange, connect, disconnect, syncNow, syncInfo } from './sync.js';

const STORAGE_KEY = 'jazzlicks.v1';
const MAX_MEASURES = 6;

// ---------------------------------------------------------------- state

const state = {
  phrases: [],
  editingId: null,
  sel: null, // { m, i } in the phrase being edited
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

function newPhrase() {
  return {
    id: uid(), title: 'New lick', keySig: 'C', tempo: 160, instrument: 'piano',
    style: 'swing', chords: 'comp', bass: true, drums: true, countIn: false, loop: false,
    measures: [emptyMeasure(), emptyMeasure()], text: '',
  };
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
  state.phrases = data.phrases;
  state.deleted = data.deleted;
  state.orderUpdatedAt = data.orderUpdatedAt;
  rememberSaved();
  writeLocal();
  if (state.editingId && !byId(state.editingId)) { state.editingId = null; state.sel = null; }
  if (player.currentId && !byId(player.currentId)) player.stop();
  if (state.phrases.map((p) => p.id).join() !== orderBefore) return renderAll();
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
  state.sel = null;
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

function renderAll() {
  const list = $('#licks');
  list.innerHTML = '';
  cards.clear();
  if (!state.phrases.length) {
    list.append(h('div', { class: 'empty' },
      h('p', {}, 'No licks yet.'),
      h('button', { class: 'btn primary', onclick: addPhrase }, '+ New lick')));
    return;
  }
  for (const p of state.phrases) list.append(buildCard(p));
  drawAllStaves();
}

function rebuildCard(id) {
  const old = cards.get(id);
  const p = byId(id);
  if (!old || !p) return renderAll();
  const card = buildCard(p);
  old.el.replaceWith(card);
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
    class: 'title', value: p.title, 'aria-label': 'Lick name', maxlength: 80,
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
      h('button', { onclick: () => movePhrase(p.id, -1) }, 'Move up'),
      h('button', { onclick: () => movePhrase(p.id, 1) }, 'Move down'),
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
    h('div', { class: 'checks' },
      check('Count-in', 'countIn'),
      check('Loop', 'loop')));

  const host = h('div', { class: 'stave-host' + (isEditing ? ' editing' : '') });
  const notes = h('textarea', {
    class: 'notes', rows: 2, placeholder: 'Words about this lick: where it\'s from, how to use it…',
    oninput: (e) => { p.text = e.target.value; save(); autoGrow(e.target); },
  });
  notes.value = p.text || '';
  requestAnimationFrame(() => autoGrow(notes));

  const card = h('article', { class: 'lick' + (isEditing ? ' is-editing' : ''), 'data-id': p.id },
    h('header', { class: 'lick-head' }, playBtn, title, editBtn, menu),
    settings,
    isEditing ? buildToolbar(p) : null,
    host,
    isEditing ? h('p', { class: 'hint' }, hintText()) : null,
    notes);

  if (isEditing) attachStaveEvents(p, host);
  else host.addEventListener('dblclick', () => setEditing(p.id));

  Object.assign(ref, { el: card, host, playBtn, layout: null });
  cards.set(p.id, ref);
  return card;
}

function autoGrow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(52, t.scrollHeight + 2) + 'px';
}

function hintText() {
  const touch = matchMedia('(pointer: coarse)').matches;
  return touch
    ? 'Tap the staff to add a note, tap a note to select it, tap above the staff to add a chord.'
    : 'Click the staff to add a note · click above it for a chord · keys: A–G notes, ↑↓ pitch, 1–5 length, . dot, / triplet, R rest, T tie, ⌫ delete, Space play.';
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

  tb.append(
    group(...durBtns, dotBtn, tripBtn, restBtn),
    group(accBtn(-1, '♭', 'Flat (-)'), accBtn(0, '♮', 'Natural (N)'), accBtn(1, '♯', 'Sharp (+)'), tieBtn),
    group(
      h('button', { class: 'tb', title: 'Pitch up (↑)', disabled: !sel || sel.rest, onclick: () => movePitch(1) }, '▲'),
      h('button', { class: 'tb', title: 'Pitch down (↓)', disabled: !sel || sel.rest, onclick: () => movePitch(-1) }, '▼'),
      h('button', { class: 'tb', title: 'Previous note (←)', onclick: () => moveSel(-1) }, '◀'),
      h('button', { class: 'tb', title: 'Next note (→)', onclick: () => moveSel(1) }, '▶'),
      h('button', { class: 'tb danger', title: 'Delete note (Backspace)', disabled: !sel, onclick: deleteSelected, html: '<svg viewBox="0 0 24 24" aria-hidden="true" class="del-icon"><path d="M9 4h6M5 7h14M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' })),
    group(
      h('span', { class: 'tb-label' }, 'Bars'),
      h('button', { class: 'tb', title: 'Remove last bar', disabled: p.measures.length <= 1, onclick: () => changeMeasures(-1) }, '−'),
      h('span', { class: 'tb-count' }, String(p.measures.length)),
      h('button', { class: 'tb', title: 'Add a bar', disabled: p.measures.length >= MAX_MEASURES, onclick: () => changeMeasures(1) }, '+'),
      h('button', { class: 'tb', title: 'Undo (Ctrl+Z)', disabled: !state.undo.length, onclick: undo }, '↶')),
    h('span', { class: 'tb-status' }, sel ? (sel.rest ? 'Rest' : pitchLabel(sel)) : ''));
  return tb;
}

function refreshToolbar() {
  const p = editing();
  if (!p) return;
  const ref = cards.get(p.id);
  const old = ref && $('.toolbar', ref.el);
  if (old) old.replaceWith(buildToolbar(p));
}

// ---------------------------------------------------------------- staves

function drawStave(id) {
  const ref = cards.get(id);
  const p = byId(id);
  if (!ref || !p) return;
  const isEditing = state.editingId === id;
  try {
    ref.layout = renderPhrase(ref.host, p, {
      width: ref.host.clientWidth,
      editing: isEditing,
      selected: isEditing ? state.sel : null,
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
  }
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
    if (e.pointerType !== 'mouse') return;
    const ref = cards.get(p.id);
    if (!ref || !ref.layout) return;
    const { x, y } = svgPoint(ref.layout, e);
    const g = $('.ghost', ref.layout.svg);
    if (!g) return;
    const hit = hitTest(ref.layout, x, y);
    const ghost = hit && hit.type === 'staff' ? ghostAt(ref.layout, x, y) : null;
    if (!ghost) { g.innerHTML = ''; host.title = ''; return; }
    const ledgers = ghost.ledgers.map((ly) => `<line x1="${ghost.x - 10}" x2="${ghost.x + 10}" y1="${ly}" y2="${ly}"/>`).join('');
    g.innerHTML = `${ledgers}<ellipse cx="${ghost.x}" cy="${ghost.y}" rx="6" ry="4.4" transform="rotate(-20 ${ghost.x} ${ghost.y})"/>`;
  });
  host.addEventListener('pointerleave', () => {
    const ref = cards.get(p.id);
    const g = ref && ref.layout && $('.ghost', ref.layout.svg);
    if (g) g.innerHTML = '';
  });
  host.addEventListener('pointerdown', (e) => {
    const ref = cards.get(p.id);
    if (!ref || !ref.layout || e.button > 0) return;
    const { x, y } = svgPoint(ref.layout, e);
    const hit = hitTest(ref.layout, x, y);
    if (!hit) return;
    e.preventDefault();
    // Clicking the staff takes keyboard focus away from the title / notes fields.
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (hit.type === 'chord') return openChordPicker(p, hit.m, hit.slot, e.clientX, e.clientY);
    if (hit.type === 'note') {
      const note = p.measures[hit.m].notes[hit.i];
      const isSel = state.sel && state.sel.m === hit.m && state.sel.i === hit.i;
      if (isSel && !note.rest && diatonicIndex(note.step, note.oct) !== hit.diatonic) {
        snapshot(p);
        const { step, oct } = fromDiatonic(hit.diatonic);
        Object.assign(note, { step, oct, alter: keyAlter(p.keySig, step) });
        audition(p, note);
        return changed(p);
      }
      state.sel = { m: hit.m, i: hit.i };
      if (!note.rest) audition(p, note);
      return changed(p, false);
    }
    if (hit.type === 'staff') {
      const { step, oct } = fromDiatonic(hit.diatonic);
      const note = { rest: false, step, oct, alter: keyAlter(p.keySig, step), dur: state.tool.dur, dots: state.tool.dots, trip: state.tool.trip, tie: false };
      insertNote(p, hit.m, hit.insertIndex, note);
    }
  });
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
  let measure = p.measures[m];

  // Filling a triplet placeholder of the same length: just replace it.
  const at = measure.notes[index];
  if (note.trip && at && at.hold && at.dur === note.dur) {
    snapshot(p);
    measure.notes[index] = note;
    state.sel = { m, i: index };
    audition(p, note);
    changed(p);
    return true;
  }
  // Never split a triplet group: move past its placeholders.
  while (measure.notes[index] && measure.notes[index].hold) index++;

  // A new triplet note starts a whole group of three (note + 2 placeholders).
  const group = note.trip ? [note, holdRest(note.dur), holdRest(note.dur)] : [note];
  const needed = group.reduce((sum, n) => sum + noteTicks(n), 0);
  if (!fits(measure, needed)) {
    // Typing past the end of a full bar continues in the next bar.
    if (index >= measure.notes.length && m + 1 < p.measures.length && fits(p.measures[m + 1], needed)) {
      m += 1;
      index = 0;
      measure = p.measures[m];
    } else {
      const what = note.trip ? `a ${DUR_NAMES[note.dur].toLowerCase()} triplet` : `a ${DUR_NAMES[note.dur].toLowerCase()} note`;
      toast(`Not enough room in bar ${m + 1} for ${what}.`);
      return false;
    }
  }
  snapshot(p);
  measure.notes.splice(index, 0, ...group);
  state.sel = { m, i: index };
  audition(p, note);
  changed(p);
  return true;
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
    if (!fits(measure, noteTicks(next), noteTicks(note))) {
      toast('That note is too long for the space left in this bar.');
      return refreshToolbar();
    }
    snapshot(p);
    Object.assign(note, next);
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
    const next = { ...note, dots: note.dots ? 0 : 1 };
    if (!fits(p.measures[state.sel.m], noteTicks(next), noteTicks(note))) return toast('Not enough room in this bar for a dot.');
    snapshot(p);
    note.dots = next.dots;
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
  const note = selectedNote();
  if (note) audition(p, note);
  changed(p, false);
}

function deleteSelected() {
  const p = editing();
  if (!p || !state.sel) return;
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
  if (prev && prev !== id) rebuildCard(prev);
  if (id) rebuildCard(id);
  else if (prev) rebuildCard(prev);
  if (id) {
    const ref = cards.get(id);
    ref && ref.el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function addPhrase() {
  const p = newPhrase();
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
  const j = i + dir;
  if (i < 0 || j < 0 || j >= state.phrases.length) return;
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
      if (ref) setPlayIcon(ref.playBtn, st);
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
    if (typing) return t.blur();
    if (state.sel) { state.sel = null; const p = editing(); return p && changed(p, false); }
    if (state.editingId) return setEditing(null);
    return;
  }
  if (typing) return;
  const p = editing();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    return undo();
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
    case 'ArrowLeft': handled(); return moveSel(-1);
    case 'ArrowRight': handled(); return moveSel(1);
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
    h('h3', {}, 'Add your phone or another computer'),
    h('p', {}, 'Send yourself this link (WhatsApp, email…) and open it on the other device. It turns sync on there automatically.'),
    h('div', { class: 'link-row' }, copyBtn, shareBtn),
    h('p', { class: 'muted' }, 'The link contains your key, so only send it to yourself.'),
    h('div', { class: 'modal-actions' },
      h('button', { class: 'btn danger-btn', onclick: () => { disconnect(); toast('Sync turned off on this device. Your licks stay here.'); refreshSyncDialog(); } }, 'Turn off on this device'),
      h('button', { class: 'btn primary', onclick: () => syncNow().then(refreshSyncDialog) }, 'Sync now')));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && syncDialog) closeSyncDialog();
}, true);

// ---------------------------------------------------------------- boot

function boot() {
  load();
  $('#new-lick').addEventListener('click', addPhrase);
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
