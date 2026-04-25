# Hero GIF instructions

The README hero references `docs/assets/hero.gif`. Until you record one, the
image link will 404 (which most markdown renderers handle gracefully).

## Recording the hero

Goal: 8-12 second loop, ≤5MB, demonstrates the moat (communities, click-to-explain).

### Setup

1. Index this repo (or another good demo repo with multiple communities).
   ```bash
   ANTHROPIC_API_KEY=sk-... hald scan
   ```
2. Make sure your terminal/browser is in light mode for the recording (people
   compare GIFs against white backgrounds in README previews).
3. Set browser viewport to ~1280x720 for crisp scaling.

### Story (the 10-second arc)

1. Open the page (vendor loads instantly, top-5 nodes labeled, communities
   floating with their titles).
2. Hover one community label — tooltip with summary appears.
3. Click that community label — overlay opens with title + summary + top
   entities.
4. Click an entity in the overlay — sidebar slides in showing details.
5. Toggle a type chip — graph filters live.
6. Click the moon icon — switches to dark mode.

### Tools

- macOS: QuickTime → Screen Recording, then `gifski --fps 24 --width 820 -o hero.gif input.mov`
- Cross-platform: [Peek](https://github.com/phw/peek), [LICEcap](https://www.cockos.com/licecap/), [terminalizer](https://terminalizer.com/) for CLI.
- Optimize: `gifsicle -O3 --lossy=80 hero.gif > hero.optimized.gif`

### Once recorded

```bash
mv hero.gif docs/assets/hero.gif
git add docs/assets/hero.gif
git commit -m "docs: add README hero GIF"
```

The `<img>` tag in README.md already points at `docs/assets/hero.gif`.
