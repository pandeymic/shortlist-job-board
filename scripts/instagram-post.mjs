// Posts the generated job cards to Instagram via the Graph API content-publishing
// flow: create container(s) -> poll status -> publish. Single card = photo post,
// multiple cards = carousel. Reads cards and captions from public/ig/manifest.json
// (written by generate-job-cards.mjs) and records posted job IDs in the state file
// so a job is never posted twice. No npm dependencies.
//
// Required env: IG_USER_ID, IG_ACCESS_TOKEN (or ACCESS_TOKEN), IMAGE_BASE_URL.
// Optional env: GRAPH_API_VERSION (default v21.0), IG_STATE_FILE.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvironment } from '../server.mjs';
import { SafeError } from '../lib/core.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MANIFEST_FILE = path.join(ROOT, 'public', 'ig', 'manifest.json');
const STATE_FILE = process.env.IG_STATE_FILE || path.join(ROOT, 'automation', 'instagram-posted.json');
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function config() {
  const igUserId = process.env.IG_USER_ID;
  const accessToken = process.env.IG_ACCESS_TOKEN || process.env.ACCESS_TOKEN;
  const baseUrl = process.env.IMAGE_BASE_URL;
  if (!igUserId || !/^\d+$/.test(igUserId)) throw new SafeError('IG_USER_ID_NOT_CONFIGURED');
  if (!accessToken) throw new SafeError('IG_ACCESS_TOKEN_NOT_CONFIGURED');
  let parsed;
  try { parsed = new URL(baseUrl || ''); } catch { throw new SafeError('IMAGE_BASE_URL_NOT_CONFIGURED'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new SafeError('IMAGE_BASE_URL_MUST_BE_HTTPS');
  return { igUserId, accessToken, baseUrl: parsed.origin };
}

async function graphCall(token, pathname, { method = 'GET', params = {} } = {}) {
  const url = new URL(GRAPH_BASE + pathname);
  url.searchParams.set('access_token', token);
  let init;
  if (method === 'POST') {
    init = { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params), redirect: 'error', signal: AbortSignal.timeout(30000) };
  } else {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    init = { redirect: 'error', signal: AbortSignal.timeout(30000) };
  }
  let response;
  try { response = await fetch(url, init); } catch { throw new SafeError('META_API_UNREACHABLE'); }
  let data;
  try { data = await response.json(); } catch { throw new SafeError('META_API_INVALID_RESPONSE'); }
  if (!response.ok || data.error) {
    const e = data.error || {};
    console.error(JSON.stringify({ event: 'meta_api_error', code: e.code, subcode: e.error_subcode, message: e.message }));
    throw new SafeError('META_API_ERROR_' + (e.code ?? response.status));
  }
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntilFinished(token, containerId, { tries = 36, intervalMs = 5000 } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const data = await graphCall(token, `/${containerId}`, { params: { fields: 'status_code,status' } });
    if (data.status_code === 'FINISHED') return;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      console.error(JSON.stringify({ event: 'container_failed', containerId, status: data.status }));
      throw new SafeError('META_CONTAINER_' + data.status_code);
    }
    await sleep(intervalMs);
  }
  throw new SafeError('META_CONTAINER_TIMEOUT');
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.posted && typeof parsed.posted === 'object') return parsed;
  } catch { /* missing or invalid state starts empty */ }
  return { posted: {} };
}

export async function main() {
  loadEnvironment();
  const { igUserId, accessToken, baseUrl } = config();
  let manifest;
  try { manifest = JSON.parse(await readFile(MANIFEST_FILE, 'utf8')); } catch { throw new SafeError('MANIFEST_MISSING_RUN_GENERATE_FIRST'); }
  if (!Array.isArray(manifest.cards)) throw new SafeError('MANIFEST_INVALID');

  const state = await readState();
  const pending = manifest.cards.filter(c => c && typeof c.job_id === 'string' && typeof c.file === 'string' && !state.posted[c.job_id]);
  if (!pending.length) { console.log(JSON.stringify({ posted: 0, reason: 'nothing_new' })); return; }
  // Never publish a partial carousel with the wrong count or stale job slides.
  if (pending.length !== manifest.cards.length || !Array.isArray(manifest.slides) ||
      manifest.slides.length !== pending.length + 2 || manifest.slides.length > 10 ||
      manifest.slides[0]?.kind !== 'cover' || manifest.slides.at(-1)?.kind !== 'cta' ||
      manifest.slides.slice(1,-1).some((s,i) => s.kind !== 'job' || s.job_id !== pending[i].job_id || s.file !== pending[i].file)) {
    throw new SafeError('MANIFEST_CAROUSEL_INVALID_OR_STALE');
  }
  const caption = manifest.carousel_caption || '';
  const imageUrlFor = file => {
    if (!/^card-[A-Za-z0-9._-]+\.jpg$/.test(file)) throw new SafeError('MANIFEST_FILE_INVALID');
    return `${baseUrl}/ig/${file}`;
  };
  const childIds = [];
  for (const slide of manifest.slides) {
    const child = await graphCall(accessToken, `/${igUserId}/media`, { method: 'POST', params: { image_url: imageUrlFor(slide.file), is_carousel_item: 'true' } });
    await waitUntilFinished(accessToken, child.id);
    childIds.push(child.id);
  }
  const carousel = await graphCall(accessToken, `/${igUserId}/media`, { method: 'POST', params: { media_type: 'CAROUSEL', children: childIds.join(','), caption } });
  const creationId = carousel.id;
  await waitUntilFinished(accessToken, creationId);

  const published = await graphCall(accessToken, `/${igUserId}/media_publish`, { method: 'POST', params: { creation_id: creationId } });
  const postedAt = new Date().toISOString();
  for (const card of pending) state.posted[card.job_id] = { posted_at: postedAt, ig_media_id: published.id };
  state.updated_at = postedAt;
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ posted: pending.length, ig_media_id: published.id, job_ids: pending.map(c => c.job_id) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e instanceof SafeError ? e.code : 'INSTAGRAM_POST_FAILED'); process.exitCode = 1; });
}
