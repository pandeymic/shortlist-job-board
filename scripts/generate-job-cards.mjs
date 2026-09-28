// Shortlist carousel: cover + one job per slide + closing call to action.
// SVG layout is rasterized to both lossless design PNG and Meta-ready JPEG.
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadEnvironment } from '../server.mjs';
import { createGoogleReader } from '../lib/google.mjs';
import { validate, SafeError } from '../lib/core.mjs';

const exec = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, 'public', 'ig');
const STATE_FILE = process.env.IG_STATE_FILE || path.join(ROOT, 'automation', 'instagram-posted.json');
// Instagram's ten-slide ceiling includes the cover and CTA.
const requested = Number(process.env.CARDS_PER_POST || 3);
const CARD_COUNT = Number.isFinite(requested) ? Math.min(8, Math.max(1, Math.floor(requested))) : 3;
const W = 1080, H = 1350, L = 96, R = 984, CW = R - L;
const LIGHT = '#FAF9F6', DARK = '#0E0E10', INK = '#111111', WHITE = '#FFFFFF', ACCENT = '#2E5BFF';
const FONT = 'Noto Sans, DejaVu Sans, sans-serif';
const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[^\x20-\x7E\u00A0-\u00FF\u20B9]/g, ch => ({'–':'-', '—':'-', '…':'...', '•':'·'}[ch] || ''));
const esc = value => safe(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain = value => safe(value).replace(/\s+/g, ' ').trim();

// Conservative font measure; lines are capped before SVG rendering, never clipped by an SVG mask.
export function textWidth(text, size) {
  let units = 0;
  for (const c of String(text)) units += c === ' ' ? .29 : 'iljtf.,:;!|()[]'.includes(c) ? .32 : 'MW@%'.includes(c) ? .92 : /[A-Z]/.test(c) ? .70 : /[0-9]/.test(c) ? .62 : .60;
  return units * size;
}
export function wrapText(text, size, maxWidth = CW) {
  const words = plain(text).split(' ').filter(Boolean), lines = [];
  let line = '';
  for (let word of words) {
    // Hard split unusually long identifiers so nothing bleeds into the safe margin.
    while (textWidth(word, size) > maxWidth) {
      let n = word.length - 1;
      while (n > 1 && textWidth(word.slice(0, n) + '-', size) > maxWidth) n--;
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, n) + '-'); word = word.slice(n);
    }
    const next = line ? `${line} ${word}` : word;
    if (textWidth(next, size) > maxWidth && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}
function fit(text, desired, min, maxLines, width = CW) {
  for (let size = desired; size >= min; size -= 2) {
    const lines = wrapText(text, size, width);
    if (lines.length <= maxLines) return {size, lines};
  }
  const lines = wrapText(text, min, width);
  const visible = lines.slice(0, maxLines);
  let last = visible[maxLines - 1] || '';
  while (last && textWidth(last + '...', min) > width) last = last.slice(0, -1);
  visible[maxLines - 1] = last + '...';
  return {size:min, lines:visible};
}
function t(x, y, text, size, weight = 400, color = INK, anchor = 'start') {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${esc(text)}</text>`;
}
function linesAt(block, x, y, leading, color, weight) {
  return block.lines.map((line, i) => t(x, y + i * leading, line, block.size, weight, color)).join('');
}
function shell(bg, body, cue, index = '') {
  const color = bg === DARK ? WHITE : INK;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><rect width="1080" height="1350" fill="${bg}"/>${body}${t(L, 1232, 'SHORTLIST', 30, 700, color)}${index ? t(540, 1232, index, 30, 700, color, 'middle') : ''}${t(R, 1232, cue, 30, 700, color, 'end')}</svg>`;
}
function salaryOf(job) { return plain(job.salary_text) || 'Salary not listed'; }
// Only take an explicit maximum if it has a monetary unit. Never invent a salary from a range.
function salaryLead(jobs) {
  const text = jobs.map(j => salaryOf(j)).find(s => /(?:₹|Rs\.?|LPA|lakhs?|lacs?)/i.test(s) && /\d/.test(s));
  if (!text) return 'Salary details on each slide';
  const block = fit(`Featured salary: ${text}`, 56, 40, 2);
  return block.lines.join(' ');
}
function companyMark(name, x, y, width = 160) {
  // A type-only company label, not an invented official logo. Verified logo assets can replace this later.
  const {size, lines} = fit(name || 'Company', 26, 22, 2, width - 22);
  return `<rect x="${x}" y="${y}" width="${width}" height="96" rx="12" fill="#FFFFFF" stroke="#DCDDE1" stroke-width="2"/>` + linesAt({size,lines}, x + 12, y + (lines.length === 1 ? 59 : 39), 29, INK, 700);
}
export function buildCoverSvg(jobs) {
  const count = jobs.length;
  const headline = fit(`${count} tech ${count === 1 ? 'job' : 'jobs'} worth a look`, 116, 90, 3);
  // Five proof marks max. They are explicitly typographic company labels, not counterfeit logos.
  const names = [...new Set(jobs.map(j => plain(j.company)).filter(Boolean))].slice(0, 5);
  const markWidth = Math.min(160, Math.floor((CW - 16 * (names.length - 1)) / Math.max(names.length, 1)));
  const marks = names.map((n, i) => companyMark(n, L + i * (markWidth + 16), 302, markWidth)).join('');
  const lead = fit(salaryLead(jobs), 56, 40, 2);
  const body = `${t(L, 208, 'SHORTLIST / TECH JOBS', 30, 700, WHITE)}` + marks
    + linesAt(headline, L, 550, 126, WHITE, 800)
    + linesAt(lead, L, 1000, 72, '#C8D4FF', 600);
  return shell(DARK, body, 'swipe to see them');
}
function fact(label, value, y) {
  const clean = plain(value);
  const block = fit(clean, 46, 38, 2, 610);
  return `${t(L, y, label, 42, 700)}${linesAt(block, 374, y, 58, INK, 400)}`;
}
export function buildCardSvg(job, index = 1, total = 1) {
  const role = fit(job.title || 'Open role', 80, 60, 3);
  const company = fit(job.company || 'Company not listed', 54, 40, 2);
  const location = [plain(job.location), plain(job.work_arrangement)].filter(Boolean).join(' · ') || 'Not listed';
  const batch = plain(job.batch || job.batch_years || job.eligible_batch);
  const titleBottom = 390 + (role.lines.length - 1) * 90;
  const companyY = titleBottom + 102;
  const firstFactY = Math.max(740, companyY + (company.lines.length - 1) * 62 + 150);
  const gap = batch ? 128 : 155;
  const body = `${companyMark(job.company, L, 186, 180)}`
    + linesAt(role, L, 390, 90, INK, 700)
    + linesAt(company, L, companyY, 62, INK, 500)
    + `<rect x="${L}" y="${firstFactY - 66}" width="888" height="2" fill="#DCDDE1"/>`
    + fact('Salary', salaryOf(job), firstFactY)
    + fact('Location', location, firstFactY + gap)
    + (batch ? fact('Batch', batch, firstFactY + gap * 2) : '');
  return shell(LIGHT, body, 'swipe for more', `${index} / ${total}`);
}
export function buildCtaSvg() {
  const body = `${t(L, 218, 'YOUR NEXT MOVE', 32, 700, WHITE)}`
    + linesAt(fit('Save this post. Share it with a friend.', 68, 56, 3), L, 415, 84, WHITE, 700)
    + `<rect x="${L}" y="720" width="888" height="3" fill="${ACCENT}"/>`
    + linesAt(fit('Comment "JOBS" for more roles like these.', 62, 50, 3), L, 832, 78, WHITE, 700)
    + linesAt(fit('Apply links: link in bio.', 58, 50, 2), L, 1100, 74, WHITE, 700);
  return shell(DARK, body, 'save for later');
}
export function buildCarouselCaption(jobs) {
  const lines = jobs.map((c, i) => `${i+1}. ${c.title} at ${c.company} - ${salaryOf(c)}`);
  return ['Looking for your next tech role? Start here.', '', ...lines, '', 'Apply links: link in bio. Follow for more curated roles.', 'Comment JOBS for more roles like these. Save and share with a friend.', '', '#techjobs #indiajobs #hiring #jobsearch #softwarejobs', '', 'Tech jobs, fresher jobs, software careers in India. Job details and availability may change; confirm on the employer site.'].join('\n');
}
async function available(cmd) { try { await exec(cmd, ['--version'], {timeout:10000}); return true; } catch { return false; } }
async function rasterize(svgPath, pngPath, jpgPath) {
  if (await available('rsvg-convert')) {
    await exec('rsvg-convert', ['-w','1080','-h','1350','-f','png','-o',pngPath,svgPath], {timeout:60000});
    await exec(await available('magick') ? 'magick' : 'convert', [pngPath, '-quality','93',jpgPath], {timeout:60000});
  } else {
    const cmd = await available('magick') ? 'magick' : 'convert';
    if (!await available(cmd)) throw new SafeError('NO_SVG_RASTERIZER');
    await exec(cmd, ['-background','white','-density','96',svgPath,'-resize','1080x1350!',pngPath], {timeout:60000});
    await exec(cmd, [pngPath, '-quality','93',jpgPath], {timeout:60000});
  }
}
async function readState() {
  try { const state = JSON.parse(await readFile(STATE_FILE,'utf8')); if (state?.posted && typeof state.posted === 'object') return state; } catch {}
  return {posted:{}};
}
const stem = id => String(id).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0,120);
export async function main(readSheetOverride) {
  loadEnvironment();
  const values = await (readSheetOverride || createGoogleReader())();
  const rows = validate(values);
  const state = await readState();
  const candidates = rows.filter(r => r.publish && !state.posted[r.data.job_id]).slice(0,CARD_COUNT);
  await mkdir(OUT_DIR,{recursive:true});
  const slides = [], cards = [], keep = new Set();
  async function add(file, svg, kind, jobId) {
    const base = file.replace(/\.jpg$/, '');
    const svgPath = path.join(OUT_DIR, `.${base}.svg`);
    await writeFile(svgPath, svg, 'utf8');
    try { await rasterize(svgPath, path.join(OUT_DIR,`${base}.png`), path.join(OUT_DIR,file)); }
    finally { await unlink(svgPath).catch(()=>{}); }
    keep.add(`${base}.png`); keep.add(file);
    slides.push({file, kind, ...(jobId ? {job_id:jobId} : {})});
  }
  if (candidates.length) {
    const jobs = candidates.map(r => r.data);
    await add('card-cover.jpg', buildCoverSvg(jobs), 'cover');
    for (let i=0; i<jobs.length; i++) {
      const j=jobs[i], file=`card-${stem(j.job_id)}.jpg`;
      await add(file, buildCardSvg(j,i+1,jobs.length), 'job', j.job_id);
      cards.push({job_id:j.job_id,file,title:j.title,company:j.company,salary_text:j.salary_text});
    }
    await add('card-cta.jpg',buildCtaSvg(),'cta');
  }
  for (const entry of await readdir(OUT_DIR)) if (/^card-.*\.(?:jpg|jpeg|png)$/.test(entry) && !keep.has(entry)) await unlink(path.join(OUT_DIR,entry));
  const manifest = {generated_at:new Date().toISOString(),count:cards.length,cards,slides,carousel_caption:buildCarouselCaption(cards)};
  await writeFile(path.join(OUT_DIR,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  console.log(JSON.stringify({generated:cards.length,slides:slides.map(s=>s.file)}));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e instanceof SafeError ? e.code : e);process.exitCode=1;});
