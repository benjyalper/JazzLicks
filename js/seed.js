// One-time setup of the "Cats" tab: artist groups, and an index of Barry
// Galbraith's "The Fingerboard Workbook" (Jamey Aebersold Jazz). Each entry has
// the exercise's key, chord changes and length but no notes: the lines
// themselves are the book's, so they are entered by hand from your copy.
//
// Fixed ids and updatedAt 0 mean every device creates identical entries, any
// edit you make wins when syncing, and a deleted entry stays deleted.

const SEED_KEY = 'jazzlicks.seed.cats';
const BOOK = 'The Fingerboard Workbook';
const SEP = ' › ';

// "Dm7 G7 | Cmaj7 | -" → measures. "-" is a bar with no new chord.
function bars(spec) {
  return spec.split('|').map((bar) => {
    const chords = bar.trim().split(/\s+/).filter((c) => c && c !== '-').map((c) => {
      const m = c.match(/^([A-G][b#]?)(maj7|m7b5|m7|7)$/);
      return m ? { root: m[1], quality: m[2] } : null;
    });
    return { chords: [chords[0] || null, chords[1] || null], notes: [] };
  });
}

const entry = (id, group, title, keySig, spec, text, extra = {}) => ({
  id: `galbraith-fw-${id}`,
  updatedAt: 0,
  title,
  category: 'cats',
  group: ['Barry Galbraith', BOOK, group].join(SEP),
  keySig, tempo: 120, instrument: 'guitar',
  style: 'swing', chords: 'held', bass: false, drums: false, countIn: false, loop: false, degrees: true,
  measures: bars(spec),
  text,
  ...extra,
});

// A few short examples entered from the book as a start ("C5" = C in octave
// 5, "Bb5"/"An5" = flat / natural; durations 8 = eighth, q = quarter, h = half).
function line(spec) {
  return spec.split('|').map((bar) => bar.trim().split(/\s+/).map((t) => {
    const m = t.match(/^([A-G])(b|#|n)?(\d)\/(8|q|h)$/);
    return { rest: false, step: m[1], alter: m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0, oct: Number(m[3]), dur: m[4], dots: 0, tie: false };
  }));
}
const NOTES = {
  'galbraith-fw-ex1-cmaj': line('D5/8 B4/8 C5/8 D5/8 B4/8 G4/8 A4/8 B4/8 | G4/8 E4/8 D4/8 C4/8 B3/8 G3/8 A3/q'),
  'galbraith-fw-ex1-ebmaj': line('Bb5/8 An5/8 Ab5/8 G5/8 F5/8 Eb5/8 D5/8 C5/8 | Bn4/8 D5/8 F5/8 Ab5/8 G5/h'),
  'galbraith-fw-ex2-cmaj': line('C4/8 E4/8 G4/8 B4/8 D5/8 B4/8 C5/8 D5/8 | E5/8 F5/8 G5/8 A5/8 B5/8 C6/8 D6/8 E6/8 | G5/h'),
};
const withNotes = (p) => {
  const notes = NOTES[p.id];
  if (notes) notes.forEach((bar, k) => { if (p.measures[k]) p.measures[k].notes = bar.map((n) => ({ ...n })); });
  return p;
};

const EX = 'Fingering examples';
const MAJ = 'II–V–I major';
const MIN = 'II–V–I minor';
const STD = 'Standard progression';
const todo = 'Enter the notes from the book.';

function workbook() {
  return [
    // Fingering concepts (pp. 4–8). Chords are simplified to the app's four types.
    entry('ex1-cmaj', EX, 'Ex. 1 – Second position (Cmaj9)', 'C', 'Cmaj7 | -', 'p. 4. One finger per fret, no shifting. Notes entered from the book; the fingering is in the book.'),
    entry('ex1-ebmaj', EX, 'Ex. 1 – Third position (E♭maj)', 'Eb', 'Ebmaj7 | -', 'p. 4. Notes entered from the book; the fingering is in the book.'),
    entry('ex1a-cmaj', EX, 'Ex. 1a – One-fret slide (Cmaj)', 'C', 'Cmaj7 | -', `p. 4. Extending the position with a 1st- or 4th-finger slide. ${todo}`),
    entry('ex1a-ebmaj', EX, 'Ex. 1a – One-fret slide (E♭maj)', 'Eb', 'Ebmaj7 | -', `p. 4. ${todo}`),
    entry('ex1a-f7', EX, 'Ex. 1a – One-fret slide (F7)', 'F', 'F7 | -', `p. 4. ${todo}`),
    entry('ex1a-gm7', EX, 'Ex. 1a – One-fret slide (Gm7 – C7♭9)', 'F', 'Gm7 | C7', `p. 4. C7♭9 in the book. ${todo}`),
    entry('ex2-ebmaj', EX, 'Ex. 2 – Extended fingering + slides (E♭maj)', 'Eb', 'Ebmaj7 | - | -', `p. 5. ${todo}`),
    entry('ex2-cmaj', EX, 'Ex. 2 – Extended fingering + slides (Cmaj)', 'C', 'Cmaj7 | - | -', 'p. 5. Notes entered from the book; the slides and fingering are in the book.'),
    entry('ex3-gmaj', EX, 'Ex. 3 – Skips with the 1st finger (Gmaj)', 'G', 'Gmaj7 | -', `p. 5. ${todo}`),
    entry('ex3-am11', EX, 'Ex. 3 – Skips with the 1st finger (Am11)', 'C', 'Am7 | -', `p. 5. Am11 in the book. ${todo}`),
    entry('ex3-dbmaj', EX, 'Ex. 3 – Skips with the 1st finger (D♭maj9)', 'Db', 'Dbmaj7 | -', `p. 5. ${todo}`),
    entry('ex3a-cmaj', EX, 'Ex. 3a – 4th-finger skips, high positions (Cmaj)', 'C', 'Cmaj7 | -', `p. 5. ${todo}`),
    entry('ex3a-gm7', EX, 'Ex. 3a – 4th-finger skips (Gm7 – C7)', 'F', 'Gm7 | - | C7', `p. 6. ${todo}`),
    entry('ex3a-fm9', EX, 'Ex. 3a – 4th-finger skips (Fm9)', 'Ab', 'Fm7 | -', `p. 6. Fm9 in the book. ${todo}`),
    entry('ex4', EX, 'Ex. 4 – Skips to triad forms', 'G', '- | -', `p. 6. Several short phrases in different keys. ${todo}`),
    entry('ex5', EX, 'Ex. 5 – Series of triads, finger to a fret', 'C', '- | -', `p. 6. ${todo}`),
    entry('ex5a', EX, 'Ex. 5a – Extended fingering on seventh chords', 'C', '- | - | -', `p. 7. ${todo}`),
    entry('ex6-11', EX, 'Ex. 6 – Consecutive 1st–4th fingers', 'C', '- | -', `p. 7. For diminished, minor 11th and major 9th shapes. ${todo}`),
    entry('ex6-bm7', EX, 'Ex. 6 – Consecutive 1st–4th fingers (Bm7 – E7♭9 – Am)', 'C', 'Bm7 | E7 | Am7 | -', `p. 7. ${todo}`),
    entry('ex6-maj9', EX, 'Ex. 6 – Same fingering for major 9th', 'F', '- | - | -', `p. 8. ${todo}`),
    entry('ex7', EX, 'Ex. 7 – Sequences', 'F', '- | - | - | -', `p. 8. Keep the same fingering for each repeat of the pattern. ${todo}`),

    // II–V–I major (pp. 36–37): each key is ii | V | I | I.
    ...[
      ['c', 'C', 'Dm7 | G7 | Cmaj7 | -'], ['bb', 'Bb', 'Cm7 | F7 | Bbmaj7 | -'], ['ab', 'Ab', 'Bbm7 | Eb7 | Abmaj7 | -'],
      ['gb', 'Gb', 'Abm7 | Db7 | Gbmaj7 | -'], ['e', 'E', 'F#m7 | B7 | Emaj7 | -'], ['d', 'D', 'Em7 | A7 | Dmaj7 | -'],
      ['db', 'Db', 'Ebm7 | Ab7 | Dbmaj7 | -'], ['b', 'B', 'C#m7 | F#7 | Bmaj7 | -'], ['a', 'A', 'Bm7 | E7 | Amaj7 | -'],
      ['g', 'G', 'Am7 | D7 | Gmaj7 | -'], ['f', 'F', 'Gm7 | C7 | Fmaj7 | -'], ['eb', 'Eb', 'Fm7 | Bb7 | Ebmaj7 | -'],
    ].map(([id, key, spec], k) => entry(`251maj-${id}`, MAJ, `II–V–I in ${spec.split('|')[2].trim().replace('maj7', '').replace('b', '♭').replace('#', '♯')}`, key, spec,
      `p. ${k < 6 ? 36 : 37}. A continuous eighth-note line through the progression. ${todo}`)),

    // II–V–I minor (pp. 38–39): iiø | V7(♭9) | i | i. Minor i is written as m7.
    ...[
      ['dm', 'F', 'Em7b5 | A7 | Dm7 | -'], ['cm', 'Eb', 'Dm7b5 | G7 | Cm7 | -'], ['bbm', 'Db', 'Cm7b5 | F7 | Bbm7 | -'],
      ['abm', 'Gb', 'Bbm7b5 | Eb7 | Abm7 | -'], ['f#m', 'A', 'G#m7b5 | C#7 | F#m7 | -'], ['em', 'G', 'F#m7b5 | B7 | Em7 | -'],
      ['c#m', 'E', 'D#m7b5 | G#7 | C#m7 | -'], ['bm', 'D', 'C#m7b5 | F#7 | Bm7 | -'], ['am', 'C', 'Bm7b5 | E7 | Am7 | -'],
      ['gm', 'Bb', 'Am7b5 | D7 | Gm7 | -'], ['fm', 'Ab', 'Gm7b5 | C7 | Fm7 | -'], ['ebm', 'Gb', 'Fm7b5 | Bb7 | Ebm7 | -'],
    ].map(([id, key, spec], k) => entry(`251min-${id}`, MIN, `II–V–I in ${spec.split('|')[2].trim().replace('m7', 'm').replace('b', '♭').replace('#', '♯')}`, key, spec,
      `p. ${k < 6 ? 38 : 39}. V7♭9 in the book. ${todo}`)),

    // Standard progression (p. 40), in 8-bar parts.
    entry('std-1', STD, 'Standard progression – bars 1–8', 'Ab', 'Fm7 | Bbm7 | Eb7 | Abmaj7 | Dbmaj7 | Dm7 G7 | Cmaj7 | -', `p. 40. ${todo}`),
    entry('std-2', STD, 'Standard progression – bars 9–16', 'Ab', 'Cm7 | Fm7 | Bb7 | Ebmaj7 | Abmaj7 | Am7 D7 | Gmaj7 | -', `p. 40. ${todo}`),
    entry('std-3', STD, 'Standard progression – bars 17–24', 'G', 'Am7 | D7 | Gmaj7 | - | F#m7 | B7 | Emaj7 | C7', `p. 40. C+ (augmented) in the book. ${todo}`),
    entry('std-4', STD, 'Standard progression – bars 25–32', 'Ab', 'Fm7 | Bbm7 | Eb7 | Abmaj7 | Dbmaj7 | Dbm7 | Cm7 | -', `p. 40. Bar 32 is B° (diminished) in the book, which the app can't show yet. ${todo}`),
    entry('std-5', STD, 'Standard progression – bars 33–36', 'Ab', 'Bbm7 | Eb7 | Abmaj7 | C7', `p. 40. ${todo}`),
  ];
}

/** Add the Cats set-up once per device. Returns true if anything changed. */
export function seedCats(state) {
  try {
    if (localStorage.getItem(SEED_KEY)) return false;
    localStorage.setItem(SEED_KEY, String(Date.now()));
  } catch (e) {
    return false;
  }
  let changed = false;
  // The Coleman Hawkins example moves to Cats › Coleman Hawkins, unless you
  // already put it somewhere yourself.
  const hawkins = state.phrases.find((p) => p.id === 'example-hawkins');
  if (hawkins && !hawkins.category && !hawkins.group) {
    hawkins.category = 'cats';
    hawkins.group = 'Coleman Hawkins';
    changed = true;
  }
  const have = new Set(state.phrases.map((p) => p.id));
  for (const p of workbook()) {
    if (have.has(p.id) || state.deleted[p.id]) continue;
    state.phrases.push(withNotes(p));
    changed = true;
  }
  return changed;
}

/** Second step: put the example notes into entries made before they existed,
 *  if those entries are still empty. */
export function seedCatsNotes(state) {
  const KEY = 'jazzlicks.seed.cats.notes';
  try {
    if (localStorage.getItem(KEY)) return false;
    localStorage.setItem(KEY, String(Date.now()));
  } catch (e) {
    return false;
  }
  let changed = false;
  for (const p of state.phrases) {
    if (!NOTES[p.id] || p.measures.some((m) => m.notes.length)) continue;
    withNotes(p);
    changed = true;
  }
  return changed;
}
