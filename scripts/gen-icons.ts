import { mkdirSync } from 'node:fs';
import sharp from 'sharp';

/** Generates PWA icons from an inline SVG (no third-party artwork). */
const svg = (pad: number, radius: number) => `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect x="${pad}" y="${pad}" width="${512 - pad * 2}" height="${512 - pad * 2}" rx="${radius}" fill="#2f6151"/>
  <circle cx="256" cy="256" r="${118 - pad / 4}" fill="none" stroke="#e3eee9" stroke-width="30"/>
  <path d="M256 ${174 + pad / 4} V256 L310 290" fill="none" stroke="#ffffff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

async function main() {
  mkdirSync('public/icons', { recursive: true });
  const full = Buffer.from(svg(0, 112));
  const maskable = Buffer.from(svg(0, 0));
  await sharp(full).resize(192, 192).png().toFile('public/icons/icon-192.png');
  await sharp(full).resize(512, 512).png().toFile('public/icons/icon-512.png');
  await sharp(maskable).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png');
  await sharp(maskable).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png');
  await sharp(full).resize(32, 32).png().toFile('public/favicon.png');
  console.log('✓ icons generated in public/icons');
}
main();
