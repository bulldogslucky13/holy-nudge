// Regenerate the brand PNGs from their sources. One-off tool, not part of the app or the build.
//
//   node scripts/gen-brand-assets.mjs                 icons only (from public/icon.svg and public/favicon.svg)
//   node scripts/gen-brand-assets.mjs --og            icons + public/og.png (renders scripts/brand/og.html in headless Chrome)
//   node scripts/gen-brand-assets.mjs --wildwood DIR  also refresh the Wildwood College logos from the official
//                                                     "Branding 2026" folder (DIR is that folder)
//
// Uses sharp, which wrangler already installs (wrangler > miniflare > sharp); no extra dependency.
// --og needs Google Chrome (or set CHROME=/path/to/chrome).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('sharp is not installed. Run `npm install` (wrangler brings it in) and try again.');
  process.exit(1);
}

const pub = (p) => resolve('public', p);
const NAVY = '#29303E';
const args = process.argv.slice(2);

async function png(input, out, { size, flatten = false, palette = true } = {}) {
  let img = sharp(input, { density: 600 }).resize(size, size);
  if (flatten) img = img.flatten({ background: NAVY }).removeAlpha();
  await img.png({ compressionLevel: 9, palette, quality: 95, effort: 10 }).toFile(out);
  console.log(`${out}  ${statSync(out).size} bytes`);
}

const icon = readFileSync(pub('icon.svg'));
const favicon = readFileSync(pub('favicon.svg'));

// Full-bleed navy squares: the platforms round the corners themselves.
await png(icon, pub('icon-192.png'), { size: 192, flatten: true });
await png(icon, pub('icon-512.png'), { size: 512, flatten: true });
// iOS home screen icon: opaque, no transparency.
await png(icon, pub('apple-touch-icon.png'), { size: 180, flatten: true });
// Browser tab: the rounded favicon, transparent corners.
await png(favicon, pub('favicon-32.png'), { size: 32 });

// Maskable: the artwork at 80% on a navy bleed, so the bell stays inside the circular safe zone.
{
  const inner = await sharp(icon, { density: 600 }).resize(410, 410).png().toBuffer();
  const out = pub('icon-maskable-512.png');
  await sharp({ create: { width: 512, height: 512, channels: 3, background: NAVY } })
    .composite([{ input: inner, left: 51, top: 51 }])
    .png({ compressionLevel: 9, palette: true, quality: 95, effort: 10 })
    .toFile(out);
  console.log(`${out}  ${statSync(out).size} bytes`);
}

// Wildwood College secondary logo (sprig + WILDWOOD COLLEGE): official artwork, resized and compressed only.
const wi = args.indexOf('--wildwood');
if (wi !== -1) {
  const dir = args[wi + 1];
  if (!dir) throw new Error('--wildwood needs the path of the "Branding 2026" folder');
  for (const [src, dest] of [
    ['SECONDARY LOGO/WC_SECONDARY_navy_2.png', 'brand/wildwood-college-navy.png'],
    ['SECONDARY LOGO/WC_SECONDARY_white_2.png', 'brand/wildwood-college-white.png'],
  ]) {
    const out = pub(dest);
    // 150 CSS px wide at 3x.
    await sharp(join(dir, src)).resize({ width: 450 }).png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile(out);
    console.log(`${out}  ${statSync(out).size} bytes`);
  }
}

// Link preview card (1200x630), drawn in HTML with the app's own font and rendered by headless Chrome.
if (args.includes('--og')) {
  const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const tmp = mkdtempSync(join(tmpdir(), 'hn-og-'));
  const shot = join(tmp, 'og.png');
  try {
    execFileSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--allow-file-access-from-files',
      '--virtual-time-budget=3000',
      '--window-size=1200,630',
      `--screenshot=${shot}`,
      pathToFileURL(resolve('scripts/brand/og.html')).href,
    ], { stdio: 'ignore' });
    const out = pub('og.png');
    await sharp(shot).resize(1200, 630).removeAlpha().png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 }).toFile(out);
    console.log(`${out}  ${statSync(out).size} bytes`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
