// Draws a phrase with VexFlow and answers "what did the user click on?".
import {
  MEASURE_TICKS, noteTicks, measureTicks, accidentalString, chordParts,
  diatonicIndex, MIN_DIATONIC, MAX_DIATONIC,
} from './music.js';

const VF = Vex.Flow;
const SVG_NS = 'http://www.w3.org/2000/svg';

const LINE_H = 150; // height of one system (chord row + stave + room below)
const SPACE_ABOVE = 7; // stave "lines" of space above the top line
const MARGIN = 6;
const TOP_LINE_OFFSET = SPACE_ABOVE * 10; // top staff line y, relative to the system top
const CHORD_BASELINE = TOP_LINE_OFFSET - 44; // chord row, relative to the system top
const CHORD_ZONE = TOP_LINE_OFFSET - 37; // clicks above this y go to the chord row
const F5 = diatonicIndex('F', 5); // pitch on the top staff line

const PAD_STEPS = [[32, 'w'], [16, 'h'], [8, 'q'], [4, '8'], [2, '16'], [1, '32']];

// Rests that fill an incomplete measure, so it always looks like 4/4.
function padRests(used) {
  const out = [];
  let pos = used;
  while (pos < MEASURE_TICKS) {
    for (const [t, d] of PAD_STEPS) {
      if (t <= MEASURE_TICKS - pos && pos % t === 0) {
        out.push({ rest: true, dur: d, dots: 0, pad: true });
        pos += t;
        break;
      }
    }
  }
  return out;
}

function padTicks(n) {
  return { w: 32, h: 16, q: 8, '8': 4, '16': 2, '32': 1 }[n.dur];
}

function makeStaveNote(n) {
  const dur = n.dur + 'd'.repeat(n.dots || 0);
  let sn;
  if (n.rest) {
    sn = new VF.StaveNote({ keys: [n.dur === 'w' ? 'd/5' : 'b/4'], duration: dur + 'r' });
  } else {
    const key = `${n.step.toLowerCase()}${accidentalString(n.alter)}/${n.oct}`;
    sn = new VF.StaveNote({ keys: [key], duration: dur, auto_stem: true });
  }
  if (n.dots) VF.Dot.buildAndAttach([sn], { all: true });
  return sn;
}

const SELECTED = { fillStyle: '#d9480f', strokeStyle: '#d9480f' };
const PADDED = { fillStyle: '#c4c0b8', strokeStyle: '#c4c0b8' };

/**
 * Render `phrase` into `host`. Returns a layout object used for hit testing
 * and for highlighting notes during playback.
 */
export function renderPhrase(host, phrase, opts = {}) {
  host.innerHTML = '';
  const pixelWidth = Math.max(240, Math.floor(opts.width || host.clientWidth || 600));
  // Small screens get bigger notation so notes are easier to tap.
  const scale = pixelWidth < 700 ? 1.2 : 1;
  const width = pixelWidth / scale;
  const n = phrase.measures.length;
  const perLine = Math.max(1, Math.min(n, 4, Math.floor(width / 230)));
  const lineCount = Math.ceil(n / perLine);

  const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
  renderer.resize(pixelWidth, lineCount * LINE_H * scale);
  const ctx = renderer.getContext();
  ctx.scale(scale, scale);
  const svg = host.querySelector('svg');

  const layout = { svg, width, scale, perLine, measures: [], notes: [], chords: [] };
  const real = []; // real (non-pad) notes in order, for ties

  for (let L = 0; L < lineCount; L++) {
    const lineTop = L * LINE_H;
    const first = L * perLine;
    const count = Math.min(perLine, n - first);

    const probe = new VF.Stave(0, lineTop, 300, { space_above_staff_ln: SPACE_ABOVE });
    probe.addClef('treble').addKeySignature(phrase.keySig);
    if (L === 0) probe.addTimeSignature('4/4');
    const modW = probe.getNoteStartX() - probe.getX();
    const noteSpace = (width - 2 * MARGIN - modW) / perLine;

    let x = MARGIN;
    for (let k = 0; k < count; k++) {
      const m = first + k;
      const w = noteSpace + (k === 0 ? modW : 0);
      const stave = new VF.Stave(x, lineTop, w, { space_above_staff_ln: SPACE_ABOVE });
      if (k === 0) {
        stave.addClef('treble').addKeySignature(phrase.keySig);
        if (L === 0) stave.addTimeSignature('4/4');
      }
      if (m === n - 1) stave.setEndBarType(VF.Barline.type.END);
      stave.setContext(ctx).draw();

      const measure = phrase.measures[m];
      const items = measure.notes.map((note, i) => ({ note, i, pad: false }))
        .concat(padRests(measureTicks(measure)).map((note) => ({ note, i: -1, pad: true })));

      let tick = 0;
      const sns = items.map((it) => {
        const sn = makeStaveNote(it.note);
        if (it.pad && opts.editing) sn.setStyle(PADDED);
        if (!it.pad && opts.selected && opts.selected.m === m && opts.selected.i === it.i) {
          sn.setStyle(SELECTED);
        }
        it.sn = sn;
        it.tick = tick;
        tick += it.pad ? padTicks(it.note) : noteTicks(it.note);
        return sn;
      });

      const voice = new VF.Voice({ num_beats: 4, beat_value: 4 }).setMode(VF.Voice.Mode.SOFT);
      voice.addTickables(sns);
      VF.Accidental.applyAccidentals([voice], phrase.keySig);
      const beams = VF.Beam.generateBeams(sns, { groups: [new VF.Fraction(2, 4)] });
      new VF.Formatter().joinVoices([voice]).formatToStave([voice], stave);
      voice.draw(ctx, stave);
      beams.forEach((b) => b.setContext(ctx).draw());

      for (const it of items) {
        const info = {
          m, i: it.i, pad: it.pad, tick: it.tick, line: L, sn: it.sn, note: it.note,
          x: it.sn.getAbsoluteX() + it.sn.getGlyphWidth() / 2,
        };
        layout.notes.push(info);
        if (!it.pad) real.push(info);
      }

      layout.measures.push({
        m, line: L, stave, lineTop,
        x0: stave.getX(), x1: stave.getX() + stave.getWidth(),
        noteStart: stave.getNoteStartX(), noteEnd: stave.getNoteEndX(),
        topLine: stave.getYForLine(0),
        items,
      });
      x += w;
    }
  }

  drawTies(ctx, real);
  drawChords(svg, phrase, layout, opts);
  return layout;
}

function drawTies(ctx, real) {
  for (let k = 0; k < real.length; k++) {
    const a = real[k];
    if (!a.note.tie || a.note.rest) continue;
    const b = real[k + 1];
    if (!b || b.note.rest) {
      // Tie into nothing ("let ring"), like the end of a phrase.
      new VF.StaveTie({ first_note: a.sn, first_indices: [0] }).setContext(ctx).draw();
    } else if (a.line === b.line) {
      new VF.StaveTie({ first_note: a.sn, last_note: b.sn, first_indices: [0], last_indices: [0] })
        .setContext(ctx).draw();
    } else {
      new VF.StaveTie({ first_note: a.sn, first_indices: [0] }).setContext(ctx).draw();
      new VF.StaveTie({ last_note: b.sn, last_indices: [0] }).setContext(ctx).draw();
    }
  }
}

// x position of a given tick inside a measure (interpolated between notes).
function tickX(ml, tick) {
  const items = ml.items;
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    const next = items[k + 1];
    const t1 = next ? next.tick : MEASURE_TICKS;
    if (tick >= it.tick && tick < t1) {
      const x0 = it.sn.getAbsoluteX();
      const x1 = next ? next.sn.getAbsoluteX() : ml.noteEnd;
      return x0 + ((tick - it.tick) / (t1 - it.tick)) * (x1 - x0);
    }
  }
  return ml.noteStart;
}

function drawChords(svg, phrase, layout, opts) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'chords');
  svg.appendChild(g);
  for (const ml of layout.measures) {
    const chords = phrase.measures[ml.m].chords || [null, null];
    for (let slot = 0; slot < 2; slot++) {
      const chord = chords[slot];
      const x = slot === 0 ? Math.min(tickX(ml, 0), ml.noteStart + 4) - 2 : tickX(ml, 16) - 2;
      const y = ml.lineTop + CHORD_BASELINE;
      if (chord) {
        const parts = chordParts(chord);
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', y);
        t.setAttribute('class', 'chord');
        const main = document.createElementNS(SVG_NS, 'tspan');
        main.textContent = parts.main;
        const sup = document.createElementNS(SVG_NS, 'tspan');
        sup.textContent = parts.sup;
        sup.setAttribute('class', 'chord-sup');
        sup.setAttribute('dy', '-10');
        t.append(main, sup);
        g.appendChild(t);
        const bb = t.getBBox();
        layout.chords.push({ m: ml.m, slot, x0: bb.x - 4, x1: bb.x + bb.width + 4, y0: bb.y - 4, y1: bb.y + bb.height + 4 });
      } else if (opts.editing) {
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', x);
        t.setAttribute('y', y);
        t.setAttribute('class', 'chord-placeholder');
        t.textContent = '+';
        g.appendChild(t);
      }
    }
  }
}

function measureAt(layout, x, y) {
  return layout.measures.find((ml) => x >= ml.x0 && x <= ml.x1 && y >= ml.lineTop && y < ml.lineTop + LINE_H);
}

function diatonicAt(ml, y) {
  const steps = Math.round((y - ml.topLine) / 5);
  return Math.max(MIN_DIATONIC, Math.min(MAX_DIATONIC, F5 - steps));
}

export function yForDiatonic(ml, d) {
  return ml.topLine + (F5 - d) * 5;
}

/** Work out what is under the pointer at svg coordinates (x, y). */
export function hitTest(layout, x, y) {
  for (const c of layout.chords) {
    if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) return { type: 'chord', m: c.m, slot: c.slot };
  }
  const ml = measureAt(layout, x, y);
  if (!ml) return null;
  if (y < ml.lineTop + CHORD_ZONE) {
    const mid = tickX(ml, 16) - 6;
    return { type: 'chord', m: ml.m, slot: x < mid ? 0 : 1 };
  }
  const diatonic = diatonicAt(ml, y);
  const inMeasure = layout.notes.filter((nt) => nt.m === ml.m && !nt.pad);
  let best = null;
  for (const nt of inMeasure) {
    const d = Math.abs(nt.x - x);
    if (d < 13 && (!best || d < best.d)) best = { nt, d };
  }
  if (best) return { type: 'note', m: ml.m, i: best.nt.i, diatonic };
  const insertIndex = inMeasure.filter((nt) => nt.x < x).length;
  return { type: 'staff', m: ml.m, insertIndex, diatonic };
}

/** Where to draw the hover "ghost" note head. */
export function ghostAt(layout, x, y) {
  const ml = measureAt(layout, x, y);
  if (!ml || y < ml.lineTop + CHORD_ZONE) return null;
  const d = diatonicAt(ml, y);
  const gy = yForDiatonic(ml, d);
  const ledgers = [];
  const top = diatonicIndex('A', 5);
  const bottom = diatonicIndex('C', 4);
  for (let k = top; k <= d; k += 2) ledgers.push(yForDiatonic(ml, k));
  for (let k = bottom; k >= d; k -= 2) ledgers.push(yForDiatonic(ml, k));
  return { x, y: gy, diatonic: d, ledgers, m: ml.m };
}

export function noteElement(layout, m, i) {
  const info = layout.notes.find((nt) => nt.m === m && nt.i === i);
  return info ? info.sn.getSVGElement() : null;
}
