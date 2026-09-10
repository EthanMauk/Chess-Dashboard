import { mkdir, copyFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const sourceDir = resolve(root, 'node_modules', 'stockfish', 'bin');
const targetDir = resolve(root, 'public', 'stockfish');
const files = ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm'];

await mkdir(targetDir, { recursive: true });
for (const file of files) {
  const src = resolve(sourceDir, file);
  try {
    await access(src);
  } catch {
    throw new Error(`Missing ${src}. Run npm install so the stockfish package can install its engine binaries.`);
  }
  await copyFile(src, resolve(targetDir, file));
}
console.log('Stockfish 18 lite-single copied to public/stockfish/.');
