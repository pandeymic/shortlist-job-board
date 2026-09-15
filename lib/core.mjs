import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const COLUMNS=['job_id','title','company','location','work_arrangement','employment_type','salary_text','description','application_url','source_url','posted_at','collected_at','status'];
export const INTERVAL_MS=15*60*1000;
export class SafeError extends Error { constructor(code){super(code);this.code=code} }
export function safeUrl(value){try{if(!value||/[\u0000-\u0020]/.test(value))return '';const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!u.hostname)return '';return u.href}catch{return ''}}
export function canonicalUrl(value){const url=safeUrl(value);if(!url)return '';const u=new URL(url);u.hash='';for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k)||['fbclid','gclid'].includes(k))u.searchParams.delete(k);u.searchParams.sort();return u.href.replace(/\/$/,'')}
export function csvCell(value){let s=String(value??'');if(/^[\s\u0000-\u001f]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'}
export function csvTemplate(){return COLUMNS.map(csvCell).join(',')+'\r\n'+['example-pending-001','Example Product Designer','Fictional Example Studio','Eligibility not specified','Remote','Full-time','','FICTIONAL EXAMPLE — replace or delete this row.','https://example.com/jobs/sample','','','','Pending'].map(csvCell).join(',')+'\r\n'}
export function openDatabase(filename){if(filename!==':memory:'){mkdirSync(path.dirname(filename),{recursive:true,mode:0o700})}const db=new DatabaseSync(filename);db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY,payload TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,validation TEXT NOT NULL DEFAULT '[]',missing INTEGER NOT NULL DEFAULT 0,last_seen TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sync_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,started_at TEXT NOT NULL,finished_at TEXT,state TEXT NOT NULL,summary TEXT,error_code TEXT);
 CREATE TABLE IF NOT EXISTS sync_control(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,next_run INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO sync_control(id) VALUES(1);
 CREATE TABLE IF NOT EXISTS source_config(id INTEGER PRIMARY KEY CHECK(id=1),identity TEXT NOT NULL);`);if(filename!==':memory:'){try{chmodSync(filename,0o600)}catch{}}return db}
export function bindSource(db,identity){const old=db.prepare('SELECT identity FROM source_config WHERE id=1').get();if(old&&old.identity!==identity)throw new SafeError('SOURCE_CHANGED_USE_NEW_DATABASE');db.prepare('INSERT OR IGNORE INTO source_config(id,identity) VALUES(1,?)').run(identity)}
function getRows(values){if(!Array.isArray(values)||!values.length||!Array.isArray(values[0]))throw new SafeError('SHEET_HEADER_MISSING');if(values.length>50001)throw new SafeError('SHEET_TOO_LARGE');const header=values[0].map(c=>String(c??'').trim().replace(/^\uFEFF/,''));if(new Set(header.filter(Boolean)).size!==header.filter(Boolean).length)throw new SafeError('DUPLICATE_COLUMN_NAMES');if(COLUMNS.some(c=>!header.includes(c)))throw new SafeError('SHEET_COLUMNS_MISMATCH');return values.slice(1).map((cells,i)=>{if(!Array.isArray(cells))throw new SafeError('SHEET_ROW_FORMAT');return {row:i+2,data:Object.fromEntries(COLUMNS.map(c=>[c,String(cells[header.indexOf(c)]??'').trim()]))}}).filter(r=>Object.values(r.data).some(Boolean))}
function dateValid(value){if(!value)return true;if(!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value))return false;const day=value.slice(0,10);return Number.isFinite(Date.parse(value))&&new Date(day).toISOString().slice(0,10)===day}
export function validate(values){const rows=getRows(values),ids=new Map(),urls=new Map();for(const r of rows){const id=r.data.job_id;if(id)ids.set(id,(ids.get(id)||0)+1);if(r.data.status==='Approved'){const u=canonicalUrl(r.data.application_url);if(u){const set=urls.get(u)||new Set();set.add(id);urls.set(u,set)}}}
 return rows.map(({row,data})=>{const errors=[];if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(data.job_id))errors.push('INVALID_JOB_ID');if(ids.get(data.job_id)>1)errors.push('DUPLICATE_JOB_ID');if(!['Pending','Approved','Rejected','Closed'].includes(data.status))errors.push('INVALID_STATUS');
 for(const c of COLUMNS){if(data[c].startsWith('='))errors.push('FORMULA_NOT_ALLOWED:'+c);if(data[c].length>(c==='description'?30000:2048))errors.push('FIELD_TOO_LONG:'+c)}
 if(data.status==='Approved'){
  for(const c of ['title','company','description','application_url'])if(!data[c])errors.push('REQUIRED:'+c);
  if(!safeUrl(data.application_url))errors.push('INVALID_APPLICATION_URL');
  if(data.source_url&&!safeUrl(data.source_url))errors.push('INVALID_SOURCE_URL');
  if((urls.get(canonicalUrl(data.application_url))?.size||0)>1)errors.push('DUPLICATE_APPLICATION_URL');
  if(data.work_arrangement&&!['Remote','Hybrid','On-site'].includes(data.work_arrangement))errors.push('INVALID_WORK_ARRANGEMENT');
  if(data.employment_type&&!['Full-time','Part-time','Contract','Internship','Freelance','Temporary'].includes(data.employment_type))errors.push('INVALID_EMPLOYMENT_TYPE');
  for(const c of ['posted_at','collected_at'])if(!dateValid(data[c]))errors.push('INVALID_DATE:'+c);
 }
 return {row,data,errors,publish:data.status==='Approved'&&!errors.length};
 })}
export function applyRows(db,validated,now=new Date().toISOString()){
 const incoming=new Set(validated.map(r=>r.data.job_id));
 const retainedUrls=new Set(db.prepare('SELECT job_id,payload FROM jobs WHERE published=1').all().filter(j=>!incoming.has(j.job_id)).map(j=>canonicalUrl(JSON.parse(j.payload).application_url)).filter(Boolean));
 for(const r of validated)if(r.publish&&retainedUrls.has(canonicalUrl(r.data.application_url))){r.publish=false;r.errors.push('DUPLICATE_RETAINED_APPLICATION_URL')}
 const summary={rows:validated.length,additions:0,updates:0,closures:0,unchanged:0,validationFailures:0,missingFromSheet:0,issues:[]},seen=new Set();
 const get=db.prepare('SELECT * FROM jobs WHERE job_id=?');const put=db.prepare(`INSERT INTO jobs(job_id,payload,published,status,validation,missing,last_seen,updated_at) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(job_id) DO UPDATE SET payload=excluded.payload,published=excluded.published,status=excluded.status,validation=excluded.validation,missing=0,last_seen=excluded.last_seen,updated_at=excluded.updated_at`);
 for(const r of validated){if(r.errors.length){summary.validationFailures++;if(summary.issues.length<100)summary.issues.push({row:r.row,codes:r.errors})}
 const id=r.data.job_id;if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id)||seen.has(id))continue;seen.add(id);const old=get.get(id);const payload=JSON.stringify(r.data);const published=r.publish?1:0;
 if(published&&!old?.published)summary.additions++;else if(!published&&old?.published)summary.closures++;else if(published&&old?.payload!==payload)summary.updates++;else summary.unchanged++;
 put.run(id,payload,published,r.data.status,JSON.stringify(r.errors),now,old&&old.payload===payload&&old.published===published?old.updated_at:now);
 }
 const missing=db.prepare('UPDATE jobs SET missing=1 WHERE job_id=?');for(const row of db.prepare('SELECT job_id FROM jobs').all())if(!seen.has(row.job_id)){missing.run(row.job_id);summary.missingFromSheet++}
 return summary;
}
export function publicJobs(db){return db.prepare('SELECT payload FROM jobs WHERE published=1 ORDER BY updated_at DESC').all().map(r=>{const d=JSON.parse(r.payload);return {job_id:d.job_id,title:d.title,company:d.company,location:d.location,work_arrangement:d.work_arrangement,employment_type:d.employment_type,salary_text:d.salary_text,description:d.description,application_url:safeUrl(d.application_url),source_url:safeUrl(d.source_url),posted_at:d.posted_at}})}
export function syncStatus(db){const latest=db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();const success=db.prepare("SELECT finished_at FROM sync_runs WHERE state='success' ORDER BY id DESC LIMIT 1").get();return {lastAttempt:latest?.started_at||null,lastSuccess:success?.finished_at||null,state:latest?.state||'not_started',errorCode:latest?.error_code||null,summary:latest?.summary?JSON.parse(latest.summary):null,nextRun:db.prepare('SELECT next_run FROM sync_control WHERE id=1').get().next_run}}
export async function runSync(db,fetchValues,{force=false,nowMs=Date.now(),intervalMs=INTERVAL_MS}={}){
 const owner=randomUUID();let runId;
 db.exec('BEGIN IMMEDIATE');try{const c=db.prepare('SELECT * FROM sync_control WHERE id=1').get();if(c.lease_until>nowMs||(!force&&c.next_run>nowMs)){db.exec('COMMIT');return {skipped:true,reason:c.lease_until>nowMs?'already_running':'not_due'}}
 db.prepare("UPDATE sync_runs SET state='failed',finished_at=?,error_code='INTERRUPTED' WHERE state='running'").run(new Date(nowMs).toISOString());
 db.prepare('UPDATE sync_control SET owner=?,lease_until=?,next_run=? WHERE id=1').run(owner,nowMs+5*60*1000,nowMs+intervalMs);
 runId=db.prepare("INSERT INTO sync_runs(started_at,state) VALUES(?,'running')").run(new Date(nowMs).toISOString()).lastInsertRowid;db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e}
 try{const values=await fetchValues();const rows=validate(values);db.exec('BEGIN IMMEDIATE');try{if(db.prepare('SELECT owner FROM sync_control WHERE id=1').get().owner!==owner)throw new SafeError('SYNC_LEASE_LOST');const summary=applyRows(db,rows);db.prepare("UPDATE sync_runs SET state='success',finished_at=?,summary=? WHERE id=?").run(new Date().toISOString(),JSON.stringify(summary),runId);db.prepare('UPDATE sync_control SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?').run(owner);db.prepare('DELETE FROM sync_runs WHERE id NOT IN (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 100)').run();db.exec('COMMIT');return {ok:true,...summary}}catch(e){db.exec('ROLLBACK');throw e}
 }catch(e){const code=e instanceof SafeError?e.code:'SYNC_FAILED';db.exec('BEGIN IMMEDIATE');try{db.prepare("UPDATE sync_runs SET state='failed',finished_at=?,error_code=? WHERE id=?").run(new Date().toISOString(),code,runId);db.prepare('UPDATE sync_control SET owner=NULL,lease_until=0 WHERE id=1 AND owner=?').run(owner);db.exec('COMMIT')}catch{db.exec('ROLLBACK')}return {ok:false,errorCode:code}}
}
