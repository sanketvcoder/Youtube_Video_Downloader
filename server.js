// server.js — merged version with streaming fallbacks, temp+storage, SSE task progress
import express from "express";
import cors from "cors";
import fs from "fs";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import ytdl from "ytdl-core";
import play from "play-dl";
import sanitize from "sanitize-filename";
import { v4 as uuidv4 } from "uuid";

const unlinkAsync = promisify(fs.unlink);
const statAsync = promisify(fs.stat);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(cors());
app.use(express.json());

// CONFIG — change these if needed
const TMP_DIR = "D:\\yt-temp";        // temporary download location
const STORAGE_DIR = "D:\\yt-storage"; // longer-lived cache location
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Task & SSE storage
const tasks = new Map();       // taskId -> task metadata/progress
const sseClients = new Map();  // taskId -> Set(res)

function safeFileName(title) {
  const base = sanitize(String(title || "video")).replace(/\s+/g, "_") || "video";
  const max = 120;
  return base.length > max ? base.slice(0, max) : base;
}

function extractYouTubeWatchUrl(input) {
  if (!input || typeof input !== "string") return null;
  input = input.trim();
  const idOnly = input.match(/^([A-Za-z0-9_-]{11})$/);
  if (idOnly) return `https://www.youtube.com/watch?v=${idOnly[1]}`;
  try {
    const u = new URL(input.includes('://') ? input : `https://${input}`);
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\//, '').split(/[?#]/)[0];
      if (id && /^[A-Za-z0-9_-]{6,11}$/.test(id)) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return `https://www.youtube.com/watch?v=${v}`;
      const shortMatch = u.pathname.match(/\/shorts\/([A-Za-z0-9_-]{6,11})/);
      if (shortMatch) return `https://www.youtube.com/watch?v=${shortMatch[1]}`;
      const lastPart = u.pathname.split('/').filter(Boolean).pop();
      if (lastPart && /^[A-Za-z0-9_-]{6,11}$/.test(lastPart)) return `https://www.youtube.com/watch?v=${lastPart}`;
    }
  } catch (e) {}
  const regex = /(?:v=|\/watch\?v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{6,11})/;
  const m = input.match(regex);
  if (m && m[1]) return `https://www.youtube.com/watch?v=${m[1]}`;
  return null;
}

function broadcastProgress(taskId) {
  const t = tasks.get(taskId);
  if (!t) return;
  // console fallback
  console.log('PROGRESS', taskId, JSON.stringify({ status: t.status, percent: t.percent, speed: t.speed, eta: t.eta, message: t.message }));
  const clients = sseClients.get(taskId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify({ type: 'progress', payload: {
    status: t.status, percent: t.percent, speed: t.speed, eta: t.eta, message: t.message, filename: t.filename, size: t.size || null
  }});
  for (const res of clients) {
    try { res.write(`data: ${payload}\n\n`); } catch (e) {}
  }
}

// --- streaming fallbacks (ytdl-core, play-dl, yt-dlp temp) ---
async function tryYtdl(normalized, res, safeTitle) {
  const info = await ytdl.getInfo(normalized);
  const format = ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' }) || ytdl.chooseFormat(info.formats, { quality: 'highest' });
  const ext = format?.container || (format?.mimeType?.includes('webm') ? 'webm' : 'mp4');
  const filename = `${safeTitle}.${ext}`;
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (format?.contentLength) { const len = Number(format.contentLength); if (!Number.isNaN(len)) res.setHeader('Content-Length', len); }
  if (format?.mimeType) res.setHeader('Content-Type', format.mimeType.split(';')[0]);
  const streamOptions = format ? { format } : { quality: 'highest', filter: 'audioandvideo' };
  const stream = ytdl(normalized, streamOptions);
  stream.on('error', (e) => { console.error('ytdl stream error:', e && (e.message || String(e))); try { stream.destroy(e); } catch (_) {} });
  stream.pipe(res);
  return stream;
}

async function tryPlayDl(normalized, res, safeTitle) {
  const streamInfo = await play.stream(normalized);
  const stream = streamInfo.stream || streamInfo;
  const type = streamInfo.type || 'video/mp4';
  const ext = (type?.includes('video')) ? 'mp4' : ((type?.includes('audio')) ? 'mp3' : 'mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
  res.setHeader('Content-Type', type?.includes('video') ? 'video/mp4' : (type?.includes('audio') ? 'audio/mpeg' : 'application/octet-stream'));
  stream.on('error', (e) => { console.error('play-dl stream error:', e && (e.message || String(e))); try { res.destroy(e); } catch (_) {} });
  stream.pipe(res);
  return stream;
}

// robust yt-dlp -> temp file with progress parsing
async function tryYtDlpToTemp(normalized, res, safeTitle, formatArg = 'best[ext=mp4]/best') {
  const id = uuidv4();
  const outName = `${safeTitle}_${id}.mp4`;
  const outPath = path.join(TMP_DIR, outName);
  const args = [ normalized, '-f', formatArg, '--merge-output-format', 'mp4', '-o', outPath, '--no-playlist', '--no-warnings' ];
  console.log('Spawning yt-dlp ->', outPath, ' args:', args.join(' '));
  const child = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] });

  let stderrBuffer = '';
  let stdoutBuffer = '';
  const state = { percent: null, speed: null, eta: null, message: null };
  function logProgress() {
    const pct = (typeof state.percent === 'number') ? `${state.percent}%` : '';
    const spd = state.speed ? `• ${state.speed}` : '';
    const eta = state.eta ? `• ETA ${state.eta}` : '';
    const msg = state.message ? `• ${state.message}` : '';
    console.log(`[yt-dlp ${id}] ${pct} ${spd} ${eta} ${msg}`);
  }
  function handleChunk(chunk) {
    const text = String(chunk);
    stderrBuffer += text;
    const normalizedText = text.replace(/\r(?!\n)/g, '\n');
    const lines = normalizedText.split(/\n/).filter(Boolean);
    for (const line of lines) parseProgressLine(line);
  }
  function parseProgressLine(text) {
    const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)%/);
    const speedMatch = text.match(/at\s+([0-9\.]+(?:KiB|MiB|GiB|KB|MB|GB)\/s)/i);
    const etaMatch = text.match(/ETA\s+([0-9:]+)/i);
    const mergingMatch = /Merging formats into/i.test(text);
    const messageMatch = text.match(/\[download\]\s+(.*)/i) || text.match(/\[ffmpeg\]\s+(.*)/i);
    let updated = false;
    if (percentMatch) { const p = Number(percentMatch[1]); if (state.percent !== p) { state.percent = p; updated = true; } }
    if (speedMatch) { const s = speedMatch[1]; if (state.speed !== s) { state.speed = s; updated = true; } }
    if (etaMatch) { const e = etaMatch[1]; if (state.eta !== e) { state.eta = e; updated = true; } }
    if (mergingMatch) { if (state.message !== 'merging') { state.message = 'merging'; updated = true; } }
    if (messageMatch) { const m = messageMatch[1].trim(); if (state.message !== m) { state.message = m; updated = true; } }
    if (updated) logProgress();
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', handleChunk);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdoutBuffer += String(c); const normalized = String(c).replace(/\r(?!\n)/g, '\n'); normalized.split(/\n/).filter(Boolean).forEach(parseProgressLine); });

  child.on('error', (err) => console.error(`[yt-dlp ${id}] spawn error:`, err && err.message ? err.message : err));

  const exitCode = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
  if (exitCode !== 0) {
    console.error(`[yt-dlp ${id}] exited with code ${exitCode}`);
    if (stderrBuffer) console.error(`[yt-dlp ${id}] stderr:\n${stderrBuffer}`);
    if (stdoutBuffer) console.error(`[yt-dlp ${id}] stdout:\n${stdoutBuffer}`);
    try { if (fs.existsSync(outPath)) await unlinkAsync(outPath); } catch (_) {}
    throw new Error(`yt-dlp failed with exit code ${exitCode}`);
  }
  if (!fs.existsSync(outPath)) throw new Error('yt-dlp did not produce an output file.');

  const stat = await statAsync(outPath);
  if (!res.headersSent) {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Type', 'video/mp4');
  }
  const readStream = fs.createReadStream(outPath);
  readStream.pipe(res);

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return; cleaned = true; try { readStream.destroy(); } catch(_) {}
    try { await unlinkAsync(outPath); console.log('Deleted temp file:', outPath); } catch (err) { if (err && err.code === 'ENOENT') return; console.warn('Failed to delete temp file:', err && err.message ? err.message : err); }
  };
  res.once('close', cleanup);
  res.once('finish', cleanup);
  return child;
}

// yt-dlp -> storage with progress + tasks + broadcasts
async function tryYtDlpToStorageWithProgress(normalized, res, safeTitle, formatArg = 'best[ext=mp4]/best') {
  const taskId = uuidv4();
  const id = uuidv4();
  const outName = `${safeTitle}_${id}.mp4`;
  const outPath = path.join(STORAGE_DIR, outName);
  tasks.set(taskId, { status: 'starting', percent: 0, speed: null, eta: null, filename: outName, startedAt: new Date().toISOString(), message: null, pid: null, size: null, outPath });
  broadcastProgress(taskId);

  const args = [ normalized, '-f', formatArg, '--merge-output-format', 'mp4', '-o', outPath, '--no-playlist', '--no-warnings' ];
  console.log('Spawning yt-dlp ->', outPath, ' args:', args.join(' '));
  const child = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] });
  const t = tasks.get(taskId); if (t) { t.pid = child.pid; t.status = 'running'; broadcastProgress(taskId); }

  let stderrBuf = '';
  let stdoutBuf = '';
  const state = { percent: null, speed: null, eta: null, message: null };

  function doBroadcastIfUpdated(updated=false) {
    const tt = tasks.get(taskId); if (!tt) return;
    tt.percent = state.percent ?? tt.percent; tt.speed = state.speed ?? tt.speed; tt.eta = state.eta ?? tt.eta; tt.message = state.message ?? tt.message;
    if (updated) { broadcastProgress(taskId); console.log(`[task ${taskId}] ${tt.percent}% • ${tt.speed||'-'} • ETA ${tt.eta||'-'} • ${tt.message||'-'}`); }
  }
  function parseProgressLineForTask(text) {
    const percentMatch = text.match(/(\d{1,3}(?:\.\d+)?)%/);
    const speedMatch = text.match(/at\s+([0-9\.]+(?:KiB|MiB|GiB|KB|MB|GB)\/s)/i);
    const etaMatch = text.match(/ETA\s+([0-9:]+)/i);
    const mergingMatch = /Merging formats into/i.test(text);
    const messageMatch = text.match(/\[download\]\s+(.*)/i) || text.match(/\[ffmpeg\]\s+(.*)/i);
    let updated = false;
    if (percentMatch) { const p = Number(percentMatch[1]); if (state.percent !== p) { state.percent = p; updated = true; } }
    if (speedMatch) { const s = speedMatch[1]; if (state.speed !== s) { state.speed = s; updated = true; } }
    if (etaMatch) { const e = etaMatch[1]; if (state.eta !== e) { state.eta = e; updated = true; } }
    if (mergingMatch) { if (state.message !== 'merging') { state.message = 'merging'; updated = true; } }
    if (messageMatch) { const m = messageMatch[1].trim(); if (state.message !== m) { state.message = m; updated = true; } }
    if (updated) doBroadcastIfUpdated(true);
  }

  function handleStderr(chunk) { const text = String(chunk); stderrBuf += text; const normalized = text.replace(/\r(?!\n)/g,'\n'); normalized.split(/\n/).filter(Boolean).forEach(parseProgressLineForTask); }
  child.stderr.setEncoding('utf8'); child.stderr.on('data', handleStderr);
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk)=>{ stdoutBuf += String(chunk); String(chunk).replace(/\r(?!\n)/g,'\n').split(/\n/).filter(Boolean).forEach(parseProgressLineForTask); });

  child.on('error', (err)=>{ const tt = tasks.get(taskId); if (tt) { tt.status = 'error'; tt.message = err.message || String(err); broadcastProgress(taskId); console.error(`[task ${taskId}] yt-dlp spawn error:`, tt.message); } });

  child.on('close', async (code) => {
    const tt = tasks.get(taskId); if (!tt) return;
    if (code !== 0) {
      tt.status = 'failed'; tt.message = `yt-dlp exit code ${code}`; tt.debug = { stderr: stderrBuf.slice(0,20000), stdout: stdoutBuf.slice(0,20000) }; broadcastProgress(taskId);
      console.error(`[task ${taskId}] yt-dlp failed with code ${code}`);
      if (stderrBuf) console.error(`[task ${taskId}] stderr:\n${stderrBuf}`);
      if (stdoutBuf) console.error(`[task ${taskId}] stdout:\n${stdoutBuf}`);
      try { if (fs.existsSync(outPath)) await unlinkAsync(outPath); } catch (_) {}
      return;
    }
    if (!fs.existsSync(outPath)) { tt.status = 'failed'; tt.message = 'yt-dlp did not produce output file'; broadcastProgress(taskId); console.error(`[task ${taskId}] output file missing after yt-dlp finished`); return; }
    const stat = await statAsync(outPath);
    tt.status = 'finished'; tt.percent = 100; tt.message = 'finished'; tt.size = stat.size; broadcastProgress(taskId);
    console.log(`[task ${taskId}] finished — ${tt.size} bytes -> ${outPath}`);
    try {
      if (!res.headersSent) { res.setHeader('Content-Disposition', `attachment; filename="${path.basename(outPath)}"`); res.setHeader('Content-Length', stat.size); res.setHeader('Content-Type', 'video/mp4'); }
      const readStream = fs.createReadStream(outPath); readStream.pipe(res);
      readStream.on('close', async ()=>{ try{ res.end(); }catch(_){} });
    } catch (e) { console.warn(`[task ${taskId}] Failed to stream after finish:`, e && e.message); }
  });

  return taskId;
}

/* Routes */
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'), (err)=>{ if (err) res.status(200).send('Use /download?url=<YOUTUBE_URL>'); });
});

app.get('/download', async (req, res) => {
  const rawUrl = req.query.url; if (!rawUrl) return res.status(400).json({ error: "Missing 'url' param." });
  const normalized = extractYouTubeWatchUrl(rawUrl); console.log('Normalized URL:', normalized, ' (raw:', rawUrl, ')'); if (!normalized) return res.status(400).json({ error: "Couldn't extract a valid YouTube video ID/URL from the input." });
  const q = req.query.quality ? Number(req.query.quality) : null;
  let formatArg = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  if (q === 1080) formatArg = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]';
  else if (q === 720) formatArg = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
  else if (q === 360) formatArg = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
  const audioOnly = req.query.audio === 'true' || req.query.audio === '1';
  let safeTitle = 'video';
  try { const info = await ytdl.getInfo(normalized).catch(()=>null); if (info?.videoDetails?.title) safeTitle = safeFileName(info.videoDetails.title); } catch(_){}
  safeTitle = safeFileName(safeTitle);

  try { console.log('Attempting ytdl-core...'); await tryYtdl(normalized, res, safeTitle); return; } catch (e) { console.warn('ytdl-core failed:', e && (e.message || String(e))); }
  try { console.log('Attempting play-dl fallback...'); await tryPlayDl(normalized, res, safeTitle); return; } catch (e) { console.warn('play-dl failed:', e && (e.message || String(e))); }
  try { console.log('Attempting yt-dlp temp-file fallback...'); await tryYtDlpToTemp(normalized, res, safeTitle, formatArg); return; } catch (e) { console.warn('yt-dlp temp-file fallback failed:', e && (e.message || String(e))); }
  try { console.log('Attempting yt-dlp storage fallback with progress...'); const taskId = await tryYtDlpToStorageWithProgress(normalized, res, safeTitle, formatArg); return; } catch (e) { console.warn('yt-dlp storage fallback failed:', e && (e.message || String(e))); }

  if (!res.headersSent) {
    res.status(500).json({ error: 'All methods failed to stream.', hint: 'Make sure yt-dlp and ffmpeg are installed and available on PATH; check server logs.' });
  } else { try { res.destroy(); } catch(_){} }
});

/* SSE endpoint for live updates */
app.get('/tasks/:id/events', (req, res) => {
  const taskId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  if (!sseClients.has(taskId)) sseClients.set(taskId, new Set());
  sseClients.get(taskId).add(res);
  const t = tasks.get(taskId) || { status: 'unknown', percent: 0 };
  const initPayload = JSON.stringify({ type: 'status', payload: { message: `${t.status}` } });
  res.write(`data: ${initPayload}\n\n`);
  req.on('close', ()=>{ const set = sseClients.get(taskId); if (set) { set.delete(res); if (set.size === 0) sseClients.delete(taskId); } });
});

/* Polling endpoint */
app.get('/tasks/:id', (req, res) => {
  const t = tasks.get(req.params.id); if (!t) return res.status(404).json({ error: 'Unknown taskId' });
  res.json({ taskId: req.params.id, status: t.status, percent: t.percent, speed: t.speed, eta: t.eta, message: t.message, filename: t.filename, size: t.size || null, startedAt: t.startedAt || null });
});

/* Background task starter endpoint */
async function startYtDlpTask(normalizedUrl, formatArg = 'best[ext=mp4]/best') {
  const taskId = uuidv4();
  const id = uuidv4();
  const outName = `video_${id}.mp4`;
  const outPath = path.join(STORAGE_DIR, outName);
  tasks.set(taskId, { status: 'starting', percent: 0, speed: null, eta: null, filename: outName, startedAt: new Date().toISOString(), message: null, pid: null, size: null, outPath });
  broadcastProgress(taskId);
  const args = [ normalizedUrl, '-f', formatArg, '--merge-output-format', 'mp4', '-o', outPath, '--no-playlist', '--no-warnings' ];
  const child = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] });
  const t = tasks.get(taskId); if (t) { t.pid = child.pid; t.status = 'running'; broadcastProgress(taskId); }
  let stderrBuf = '';
  let stdoutBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const text = String(chunk); stderrBuf += text; const normalized = text.replace(/\r(?!\n)/g,'\n'); normalized.split(/\n/).filter(Boolean).forEach((line)=>{
      const percentMatch = line.match(/(\d{1,3}(?:\.\d+)?)%/);
      const speedMatch = line.match(/at\s+([0-9\.]+(?:KiB|MiB|GiB|KB|MB|GB)\/s)/i);
      const etaMatch = line.match(/ETA\s+([0-9:]+)/i);
      const messageMatch = line.match(/\[download\]\s+(.*)/i) || line.match(/\[ffmpeg\]\s+(.*)/i);
      let updated = false;
      if (percentMatch) { const p = Number(percentMatch[1]); if (t.percent !== p) { t.percent = p; updated = true; } }
      if (speedMatch) { const s = speedMatch[1]; if (t.speed !== s) { t.speed = s; updated = true; } }
      if (etaMatch) { const e = etaMatch[1]; if (t.eta !== e) { t.eta = e; updated = true; } }
      if (/Merging formats into/i.test(line)) { if (t.message !== 'merging') { t.message = 'merging'; updated = true; } }
      if (messageMatch) { const m = messageMatch[1].trim(); if (t.message !== m) { t.message = m; updated = true; } }
      if (updated) broadcastProgress(taskId);
    }); process.stdout.write(text);
  });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', (c)=>{ stdoutBuf += String(c); });
  child.on('error', (err)=>{ const cur = tasks.get(taskId); if (cur) { cur.status = 'error'; cur.message = err.message || String(err); broadcastProgress(taskId); } });
  child.on('close', async (code)=>{
    const cur = tasks.get(taskId); if (!cur) return; if (code !== 0) { cur.status = 'failed'; cur.message = `yt-dlp exit code ${code}`; cur.debug = { stderr: stderrBuf.slice(0,20000), stdout: stdoutBuf.slice(0,20000) }; broadcastProgress(taskId); try { if (fs.existsSync(outPath)) await unlinkAsync(outPath); } catch(_){} return; }
    if (!fs.existsSync(outPath)) { cur.status = 'failed'; cur.message = 'yt-dlp did not produce an output file'; broadcastProgress(taskId); return; }
    const st = await statAsync(outPath); cur.status = 'finished'; cur.percent = 100; cur.message = 'finished'; cur.size = st.size; cur.completedAt = new Date().toISOString(); broadcastProgress(taskId); console.log(`[task ${taskId}] finished: ${outPath}`);
  });
  return taskId;
}

app.post('/tasks/start', express.json(), async (req, res) => {
  const { url, quality, audioOnly } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const normalized = extractYouTubeWatchUrl(url); if (!normalized) return res.status(400).json({ error: 'Invalid YouTube URL/ID' });
  let formatArg = audioOnly ? 'bestaudio[ext=m4a]/bestaudio' : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
  if (quality === 1080) formatArg = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]';
  else if (quality === 720) formatArg = 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
  else if (quality === 360) formatArg = 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
  try { const taskId = await startYtDlpTask(normalized, formatArg); return res.json({ taskId }); } catch (e) { console.error('Failed to start background task', e && e.message); return res.status(500).json({ error: 'failed to start task', message: e && e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ytd server listening on http://localhost:${PORT}`));
