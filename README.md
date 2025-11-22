# Youtube_Video_Downloader
This app accepts a YouTube URL or ID from the frontend, normalizes it, and attempts to stream the video directly to the browser. If direct streaming fails it falls back to multiple strategies (ytdl-core, play-dl, yt-dlp to a temp file, and yt-dlp background tasks into durable storage).
