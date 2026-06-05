# Assets

`hero.gif` — the README hero. A recording of the real `hald graph` viewer on the
built-in mock fixture, looping through the moat: community-clustered graph →
click a cluster to explain it (LLM summary + top entities/experts) → toggle a
type filter → switch to dark mode.

## Regenerating the hero

The graph engine is WebGL, so it must be recorded through a real GPU-backed
browser (Google Chrome), not a plain headless shell. Prereqs: Chrome, `ffmpeg`,
and Playwright (`npx playwright`).

```bash
# 1. Build and boot the mock viewer (zero API cost: ~50 entities, 6 communities)
npm run build
node dist/cli.js graph --mock --no-open --port 3799 &

# 2. Record the arc through real Chrome (save as capture.mjs, run with Playwright on PATH)
cat > /tmp/capture.mjs <<'EOF'
import { chromium } from 'playwright';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5,
  recordVideo: { dir: '/tmp/hald-vid', size: { width: 1280, height: 720 } } });
const p = await ctx.newPage();
await p.goto('http://localhost:3799', { waitUntil: 'networkidle' });
await p.waitForFunction(() => document.querySelectorAll('#graph-container canvas').length > 0, { timeout: 20000 });
await sleep(2800);
const label = p.locator('.community-label').first();
await label.hover(); await sleep(1400); await label.click(); await sleep(3000);
await p.keyboard.press('Escape'); await sleep(1100);
const chip = p.locator('.filter-chip').nth(3);
await chip.click(); await sleep(1500); await chip.click(); await sleep(900);
await p.click('#btn-theme'); await sleep(3000);
await ctx.close(); await b.close();
EOF
node /tmp/capture.mjs

# 3. Encode an optimized GIF (diff palette → clean quality at small size)
ffmpeg -y -ss 1.3 -i /tmp/hald-vid/*.webm \
  -vf "fps=16,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4" \
  -loop 0 docs/assets/hero.gif
```

Keep it a 12–17s loop and ≤5MB so it renders fast on GitHub and npm.
