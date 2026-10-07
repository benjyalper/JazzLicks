# JazzLicks

Write short jazz phrases (1–6 bars) on a treble staff, add chord symbols, and hear them played back on piano or guitar.

**Live app:** https://benjyalper.github.io/JazzLicks/

## Features

- Treble-clef notation in a hand-written jazz style (VexFlow + Petaluma font)
- Chord symbols above the staff: all 12 roots × maj7, m7, m7♭5 (ø), 7. Up to two per bar (beats 1 and 3)
- Play / pause per lick, with piano or guitar sounds, swing feel, tempo and loop
- Key signatures, accidentals, dotted notes, rests, ties
- A text box under each lick for your notes
- Licks are saved in the browser; Export / Import moves them between devices

## Editing

Press **Edit** on a lick (or double-click the staff).

| Action | Mouse / touch | Keyboard |
| --- | --- | --- |
| Add a note | Click the staff | `A`–`G` |
| Select a note | Click it | `←` `→` |
| Change pitch | Click the selected note at a new height, or ▲▼ | `↑` `↓` (Shift = octave) |
| Note length | Toolbar | `1` 16th · `2` 8th · `3` quarter · `4` half · `5` whole |
| Dot / rest / tie | Toolbar | `.` / `R` / `T` |
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
