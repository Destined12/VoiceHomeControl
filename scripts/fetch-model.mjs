import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, rename, readdir, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import extract from 'extract-zip';

const DEFAULT_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const MODEL_URL = process.env.VOSK_MODEL_URL || DEFAULT_URL;
const TARGET = path.resolve(process.env.VOSK_MODEL_PATH || 'model');

function log(...args) {
  console.log('[fetch-model]', ...args);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeModel(dir) {
  return (await exists(path.join(dir, 'am'))) && (await exists(path.join(dir, 'conf')));
}

async function download(url, dest) {
  log('downloading', url);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
  log('downloaded to', dest);
}

async function main() {
  if (process.env.SKIP_MODEL_FETCH === '1') {
    log('SKIP_MODEL_FETCH=1 set, skipping.');
    return;
  }

  if (await looksLikeModel(TARGET)) {
    log(`Model already present at ${TARGET}, skipping.`);
    return;
  }

  const work = await mkdtemp(path.join(tmpdir(), 'vosk-model-'));
  const zipPath = path.join(work, 'model.zip');
  const extractPath = path.join(work, 'extract');

  try {
    await download(MODEL_URL, zipPath);
    await mkdir(extractPath, { recursive: true });
    log('extracting...');
    await extract(zipPath, { dir: extractPath });

    const entries = await readdir(extractPath, { withFileTypes: true });
    const inner = entries.find(entry => entry.isDirectory());
    if (!inner) throw new Error('archive did not contain a model directory');

    await rm(TARGET, { recursive: true, force: true });
    await mkdir(path.dirname(TARGET), { recursive: true });
    await rename(path.join(extractPath, inner.name), TARGET);
    log(`model ready at ${TARGET}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.VOSK_STRICT === '1') {
    console.error('[fetch-model] failed:', message);
    process.exit(1);
  }
  console.warn(
    `[fetch-model] warning: could not prepare model (${message}). ` +
      'The app will build, but transcription stays disabled until a model is available.'
  );
});
