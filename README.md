Project description — YouTube Downloader (MERN)

Short summary (1 line)
A full-stack MERN web app that lets users paste a YouTube link and download videos (or audio) with fallbacks, live progress updates (SSE), temporary caching and durable storage — built for reliability and good UX.

What this project does (detailed)

This app accepts a YouTube URL or ID from the frontend, normalizes it, and attempts to stream the video directly to the browser. If direct streaming fails it falls back to multiple strategies (ytdl-core, play-dl, yt-dlp to a temp file, and yt-dlp background tasks into durable storage). While a background download runs, the server broadcasts live progress updates over Server-Sent Events (SSE) so the frontend can show a live progress bar, ETA and speed. Files are stored temporarily or cached in a storage folder for later retrieval.

Key features

Paste YouTube link or ID → download video or audio.

Multiple streaming fallbacks:

ytdl-core (fast streaming)

play-dl fallback

yt-dlp to temp file (with parsing of progress)

yt-dlp background storage task with SSE progress

Live progress UI via SSE (/tasks/:id/events) and polling (/tasks/:id).

Safe filename generation and filename sanitization.

Configurable temporary and storage directories.

Automatic cleanup of temp files after streaming completes.

Quality selection (1080 / 720 / 360) and audio-only option.

Resilient logging and error handling with helpful server messages.

Background tasks with unique taskId for asynchronous downloads (start via /tasks/start).

Tech stack

Frontend: React (MERN client) — simple UI to paste URL, pick quality/audio, start download, and subscribe to SSE.

Backend: Node.js + Express (server.js you provided)

Libraries/tools:

ytdl-core, play-dl for streaming

yt-dlp (spawned) for robust downloads and progress

ffmpeg required on PATH for some formats/merging

sanitize-filename, uuid

Storage: local filesystem (TMP_DIR, STORAGE_DIR). Easy to swap for S3 / cloud storage later.

Important endpoints (server)

GET /download?url=<YOUTUBE_URL>&quality=720&audio=true — tries streaming immediately; uses fallbacks.

POST /tasks/start — start a background yt-dlp task, returns { taskId }.

GET /tasks/:id/events — SSE stream for live progress updates for a taskId.

GET /tasks/:id — poll task status (json).

GET / — serves index.html (simple frontend).

How it works (flow)

Frontend sends a YouTube URL to /download (or /tasks/start for background).

Server normalizes input to a canonical watch URL (handles raw IDs, youtu.be, shorts).

Server tries streaming (ytdl-core → play-dl → yt-dlp temp → yt-dlp storage).

If yt-dlp storage path used, server returns file stream after download completes; SSE updates broadcast progress during download.

Temp files are removed after stream completes or on failure.

How to run (developer notes)

Ensure Node (v16+/18+) installed.

Install yt-dlp and ffmpeg and make sure they are on PATH.

npm install (install dependencies: express, ytdl-core, play-dl, sanitize-filename, uuid, cors, etc.)

Configure paths (TMP_DIR, STORAGE_DIR) at top of server.js or use env vars.

node server.js (or npm start) — server listens on PORT (default 3000).

Use the frontend to paste a URL, click Download, or call the API.

Security & operational notes

Running yt-dlp and streaming video can consume CPU and disk — set limits or quota for production.

Validate and rate-limit incoming requests before exposing publicly.

Consider scanning / quarantining stored files if exposing downloads.

For production, use cloud storage (S3) and ephemeral worker instances for downloads; store metadata in a DB (MongoDB) for persistent task tracking.

Ensure CORS and proper headers for frontend integration.

Improvements & future work

Add user accounts and per-user storage quotas.

Replace filesystem storage with S3 (or other object storage) and serve signed URLs.

Use a job queue (BullMQ / Redis) to manage downloads and retries.

Add resumable downloads and explicit cancel API for tasks.

Add prettier frontend with progress, queue list, ability to re-download from storage.

Add unit/integration tests and Dockerfile for easy deployment.

Add server metrics (prometheus) and health checks.

README-ready description (copy/paste)

YouTube Downloader — MERN
A reliable YouTube downloader with multiple streaming fallbacks and live progress. Paste a link, choose quality (1080/720/360) or audio-only, and download. If direct streaming fails the server automatically falls back to yt-dlp with progress reporting via SSE and durable storage. Built with Node.js, Express, ytdl-core, play-dl and yt-dlp.

Features: streaming fallbacks, SSE progress, temp & storage cache, sanitized filenames, quality/audio options, background task system.

Requirements: Node.js, yt-dlp, ffmpeg.
