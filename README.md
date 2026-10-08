# JazzLicks

Write short jazz phrases (1–6 bars) on a treble staff, add chord symbols, and hear them played back on piano or classical (nylon) guitar.

**Live app:** https://benjyalper.github.io/JazzLicks/

## Features

- Treble-clef notation in a hand-written jazz style (VexFlow + Petaluma font)
- Chord symbols above the staff: all 12 roots × maj7, m7, m7♭5 (ø), 7. Up to two per bar (beats 1 and 3)
- Play / pause per lick, with piano or classical guitar, tempo, count-in and loop
- Rhythm section generated from the chords: **Swing** (walking bass, ride cymbal, hi-hat on 2 & 4) or **Latin** (bossa nova bass, shaker, cross-stick, kick). Bass and drums can each be switched off
- Chords can be **Held** (sustained), **Comping** (rhythmic, in the style) or **Off**
- Key signatures (changing the key transposes all notes and chords), accidentals, dotted notes, triplets, rests, ties
- Chord degrees under the notes (1, 3, 5 and ♭7 / 7 for chord tones; ♭9, 9, ♯9, 11, ♯11, ♭13, 13 for tensions in orange), switchable per lick
- A text box under each lick for your notes
- Licks are saved in the browser, and **Sync** keeps them the same on all your devices (via a private GitHub gist). Export / Import makes backup files

## Editing

Press **Edit** on a lick (or double-click the staff).

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Add a note | Click the staff | `A`–`G` |
| Select a note | Click it | `←` `→` |
| Change pitch | Click the selected note at a new height, or ▲▼ | `↑` `↓` (Shift = octave) |
| Note length | Toolbar | `1` 16th · `2` 8th · `3` quarter · `4` half · `5` whole |
| Dot / triplet / rest / tie | Toolbar | `.` / `/` / `R` / `T` |
| Sharp / flat / natural | Toolbar | `+` / `-` / `N` |
| Delete | 🗑 | `Backspace` |
| Chord | Click above the staff | — |
| Play / pause | ▶ | `Space` |
| Undo | ↶ | `Ctrl+Z` |

## Running locally

It's a static site with no build step. Serve the folder with any web server, for example:

```
python -m http.server 8000
```

then open http://localhost:8000. (Opening `index.html` directly from disk won't work because browsers block ES modules on `file://`.)

Sounds are streamed from the Tone.js Salamander piano and the tonejs-instruments guitar samples, so playback needs an internet connection.

## Sync between devices

Press **Sync** in the top bar:

1. Create a GitHub key with the link in the dialog (only the `gist` permission is needed, and it's pre-selected).
2. Paste it and press **Connect**. Your licks are stored in a private gist named `jazzlicks.json`.
3. Press **Copy link** and open that link on your phone or other computer. Sync turns on there automatically.

Each lick keeps the most recently edited version, and deletions carry over to other devices. The key stays in the browser on your devices; the sync link contains it, so only send it to yourself.
