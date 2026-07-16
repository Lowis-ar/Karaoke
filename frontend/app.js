/* =============================================================
   Karaoke System - Application Logic
   =============================================================
   Modules:
     1. ApiClient      - Backend communication (ngrok headers)
     2. AudioEngine    - Web Audio API playback engine
     3. LrcParser      - LRC format parser (multi-timestamp)
     4. LyricsRenderer - Synchronized lyrics display
     5. ManualSync     - Tap-sync interface
     6. AppController  - Orchestration and UI state
   ============================================================= */

"use strict";

/* =============================================================
   Module 0: Database (IndexedDB)
   ============================================================= */
const Database = (() => {
    const DB_NAME = "KaraokeDB";
    const STORE_NAME = "songs";
    const DB_VERSION = 1;
    let db = null;

    return {
        async init() {
            if (navigator.storage && navigator.storage.persist) {
                await navigator.storage.persist();
            }

            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                
                request.onupgradeneeded = (e) => {
                    db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
                    }
                };
                
                request.onsuccess = (e) => {
                    db = e.target.result;
                    resolve();
                };
                
                request.onerror = (e) => reject(e.target.error);
            });
        },

        async saveSong(songData) {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                const store = tx.objectStore(STORE_NAME);
                
                // Add timestamp
                songData.createdAt = new Date().toISOString();
                
                const request = store.put(songData);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        },

        async getSongs() {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readonly");
                const store = tx.objectStore(STORE_NAME);
                const request = store.getAll();
                
                request.onsuccess = () => {
                    // Sort by newest first
                    const songs = request.result.sort((a, b) => 
                        new Date(b.createdAt) - new Date(a.createdAt)
                    );
                    resolve(songs);
                };
                request.onerror = () => reject(request.error);
            });
        },

        async updateLyrics(id, lyrics_lrc) {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                const store = tx.objectStore(STORE_NAME);
                const req = store.get(id);
                
                req.onsuccess = () => {
                    if (req.result) {
                        const song = req.result;
                        song.lyrics_lrc = lyrics_lrc;
                        store.put(song);
                        resolve();
                    } else {
                        reject(new Error("Song not found"));
                    }
                };
                req.onerror = () => reject(req.error);
            });
        },

        async deleteSong(id) {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(STORE_NAME, "readwrite");
                const store = tx.objectStore(STORE_NAME);
                const req = store.delete(id);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }
    };
})();

/* =============================================================
   Module 0.1: MetadataExtractor (jsmediatags wrapper)
   ============================================================= */
const MetadataExtractor = (() => {
    return {
        async extract(file) {
            return new Promise((resolve) => {
                const defaultMeta = {
                    title: file.name.replace(/\.[^/.]+$/, ""), // filename without ext
                    artist: "Unknown Artist",
                    album: "Unknown Album",
                    cover_blob: null
                };

                if (!window.jsmediatags) {
                    resolve(defaultMeta);
                    return;
                }

                jsmediatags.read(file, {
                    onSuccess: (tag) => {
                        const tags = tag.tags || {};
                        let cover_blob = null;

                        if (tags.picture) {
                            const data = tags.picture.data;
                            const format = tags.picture.format;
                            let byteArray = new Uint8Array(data);
                            cover_blob = new Blob([byteArray], { type: format });
                        }

                        resolve({
                            title: tags.title || defaultMeta.title,
                            artist: tags.artist || defaultMeta.artist,
                            album: tags.album || defaultMeta.album,
                            cover_blob: cover_blob
                        });
                    },
                    onError: () => {
                        resolve(defaultMeta);
                    }
                });
            });
        }
    };
})();

/* =============================================================
   Module 1: API Client
   ============================================================= */
const ApiClient = (() => {
    let baseUrl = "";

    const HEADERS = {
        "ngrok-skip-browser-warning": "true",
    };

    return {
        setBaseUrl(url) {
            let formattedUrl = url.trim().replace(/\/+$/, "");
            if (!/^https?:\/\//i.test(formattedUrl)) {
                formattedUrl = "https://" + formattedUrl;
            }
            baseUrl = formattedUrl;
            console.log("Backend API Base URL configured to:", baseUrl);
        },

        getBaseUrl() {
            return baseUrl;
        },

        async checkHealth() {
            // Try /health first, fall back to root / if 404
            let resp = await fetch(`${baseUrl}/health`, { headers: HEADERS });
            if (resp.status === 404) {
                resp = await fetch(`${baseUrl}/`, { headers: HEADERS });
            }
            if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`);
            return resp.json();
        },

        /**
         * Upload audio file for processing.
         * Uses XMLHttpRequest for upload progress tracking.
         * @param {File} file
         * @param {function} onProgress - callback(percent: 0-100)
         * @returns {Promise<object>} - server JSON response
         */
        processAudio(file, onProgress) {
            return new Promise((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", `${baseUrl}/upload`);

                // Set ngrok bypass header
                Object.entries(HEADERS).forEach(([k, v]) =>
                    xhr.setRequestHeader(k, v)
                );

                // Upload progress (0-50%)
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && onProgress) {
                        onProgress(Math.round((e.loaded / e.total) * 50));
                    }
                };

                // Upload complete, waiting for Demucs processing
                xhr.upload.onload = () => {
                    if (onProgress) onProgress(-1); // Signal indeterminate
                };

                xhr.onload = () => {
                    if (xhr.status >= 200 && xhr.status < 300) {
                        try {
                            resolve(JSON.parse(xhr.responseText));
                        } catch {
                            reject(new Error("Invalid JSON response"));
                        }
                    } else {
                        reject(
                            new Error(
                                `Server error ${xhr.status}: ${xhr.responseText.substring(0, 200)}`
                            )
                        );
                    }
                };

                xhr.onerror = () => reject(new Error("Network error"));
                xhr.timeout = 600000; // 10 minutes
                xhr.ontimeout = () => reject(new Error("Request timed out"));

                const formData = new FormData();
                formData.append("file", file);
                xhr.send(formData);
            });
        },

        /**
         * Fetch an audio file as Blob for offline storage.
         * @param {string} path - relative path from backend
         * @returns {Promise<Blob>}
         */
        async fetchAudioBlob(path) {
            const url = `${baseUrl}${path}`;
            console.log(`[ApiClient] Fetching: ${url}`);
            try {
                const resp = await fetch(url, { headers: HEADERS });
                console.log(`[ApiClient] Response status for ${path}: ${resp.status} ${resp.statusText}`);
                if (!resp.ok) throw new Error(`Failed to fetch audio: ${resp.status}`);
                const blob = await resp.blob();
                console.log(`[ApiClient] Successfully fetched blob for ${path}, size: ${blob.size} bytes`);
                return blob;
            } catch (err) {
                console.error(`[ApiClient] Error fetching ${path}:`, err);
                throw err;
            }
        },

        /**
         * Call /sync-ai to generate synced lyrics with Whisper.
         * @param {string} songName - base_name from upload response
         * @param {string} [lyricsText] - optional user lyrics for alignment
         * @returns {Promise<{lyrics_lrc: string, lyrics_found: boolean}>}
         */
        async syncWithAi(songName, lyricsText = "") {
            const resp = await fetch(`${baseUrl}/sync-ai`, {
                method: "POST",
                headers: {
                    ...HEADERS,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    song_name: songName,
                    lyrics_text: lyricsText,
                }),
            });
            if (!resp.ok) {
                let errMsg = `AI sync failed: ${resp.status}`;
                try {
                    const errData = await resp.json();
                    if (errData && errData.detail) {
                        errMsg += ` - ${errData.detail}`;
                    }
                } catch (e) {}
                throw new Error(errMsg);
            }
            return resp.json();
        },
    };
})();

/* =============================================================
   Module 2: Audio Engine (Web Audio API)
   ============================================================= */
const AudioEngine = (() => {
    let audioCtx = null;
    let vocalBuffer = null;
    let instBuffer = null;
    let vocalSource = null;
    let instSource = null;
    let vocalGain = null;
    let instGain = null;
    let startedAt = 0;
    let pausedAt = 0;
    let isPlaying = false;

    /** Ensure AudioContext exists and is running. */
    function ensureContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            vocalGain = audioCtx.createGain();
            instGain = audioCtx.createGain();
            vocalGain.connect(audioCtx.destination);
            instGain.connect(audioCtx.destination);
        }
        if (audioCtx.state === "suspended") {
            audioCtx.resume();
        }
    }

    /** Safely stop and dereference both source nodes. */
    function stopSources() {
        if (vocalSource) {
            try {
                vocalSource.onended = null;
                vocalSource.stop();
            } catch (_) {
                /* already stopped */
            }
            vocalSource.disconnect();
            vocalSource = null;
        }
        if (instSource) {
            try {
                instSource.onended = null;
                instSource.stop();
            } catch (_) {
                /* already stopped */
            }
            instSource.disconnect();
            instSource = null;
        }
    }

    /** Create and start source nodes from the stored buffers. */
    function createAndStart(offset) {
        vocalSource = audioCtx.createBufferSource();
        vocalSource.buffer = vocalBuffer;
        vocalSource.connect(vocalGain);

        instSource = audioCtx.createBufferSource();
        instSource.buffer = instBuffer;
        instSource.connect(instGain);

        vocalSource.start(0, offset);
        instSource.start(0, offset);

        // Auto-stop at end of longest buffer
        const duration = Math.max(vocalBuffer.duration, instBuffer.duration);

        vocalSource.onended = () => {
            if (isPlaying && AudioEngine.getCurrentTime() >= duration - 0.05) {
                AudioEngine.stop();
                if (AudioEngine.onEnded) AudioEngine.onEnded();
            }
        };
    }

    return {
        /** Callback invoked when playback reaches the end naturally. */
        onEnded: null,

        /**
         * Load and decode two stems from Blobs (offline support). Releases previous buffers to prevent leaks.
         * @param {Blob} vocalBlob - vocal stem blob
         * @param {Blob} instBlob - instrumental stem blob
         */
        async loadStems(vocalBlob, instBlob) {
            ensureContext();

            // --- Memory cleanup: release previous buffers ---
            stopSources();
            isPlaying = false;
            startedAt = 0;
            pausedAt = 0;
            vocalBuffer = null;
            instBuffer = null;

            // Suspend context while decoding to free resources
            await audioCtx.suspend();

            const [vocalData, instData] = await Promise.all([
                vocalBlob.arrayBuffer(),
                instBlob.arrayBuffer(),
            ]);

            // Resume context for decoding
            await audioCtx.resume();

            vocalBuffer = await audioCtx.decodeAudioData(vocalData);
            instBuffer = await audioCtx.decodeAudioData(instData);
        },

        play() {
            if (!vocalBuffer || !instBuffer || isPlaying) return;
            ensureContext();

            const offset = pausedAt;
            createAndStart(offset);
            startedAt = audioCtx.currentTime - offset;
            isPlaying = true;
        },

        pause() {
            if (!isPlaying) return;
            pausedAt = audioCtx.currentTime - startedAt;
            stopSources();
            isPlaying = false;
        },

        stop() {
            stopSources();
            isPlaying = false;
            startedAt = 0;
            pausedAt = 0;
        },

        seek(time) {
            const wasPlaying = isPlaying;
            stopSources();
            isPlaying = false;
            pausedAt = Math.max(0, Math.min(time, this.getDuration()));
            if (wasPlaying) {
                this.play();
            }
        },

        getCurrentTime() {
            if (isPlaying) {
                return audioCtx.currentTime - startedAt;
            }
            return pausedAt;
        },

        getDuration() {
            if (!vocalBuffer || !instBuffer) return 0;
            return Math.max(vocalBuffer.duration, instBuffer.duration);
        },

        isReady() {
            return vocalBuffer !== null && instBuffer !== null;
        },

        getIsPlaying() {
            return isPlaying;
        },

        setVocalVolume(value) {
            if (!vocalGain) return;
            ensureContext();
            vocalGain.gain.setValueAtTime(value, audioCtx.currentTime);
        },

        setInstVolume(value) {
            if (!instGain) return;
            ensureContext();
            instGain.gain.setValueAtTime(value, audioCtx.currentTime);
        },
    };
})();

/* =============================================================
   Module 3: LRC Parser
   ============================================================= */
const LrcParser = (() => {
    /**
     * Regex for a single timestamp tag: [mm:ss.xx] or [mm:ss.xxx]
     * Uses non-global version for per-line iteration.
     */
    const TIMESTAMP_PATTERN = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;

    /**
     * Convert a regex match groups to seconds.
     */
    function matchToSeconds(min, sec, ms) {
        const minutes = parseInt(min, 10);
        const seconds = parseInt(sec, 10);
        let millis = ms;
        // Normalize: "50" -> 500ms, "500" -> 500ms
        if (millis.length === 2) millis += "0";
        return minutes * 60 + seconds + parseInt(millis, 10) / 1000;
    }

    return {
        /**
         * Parse an LRC string into a sorted array of { time, text } objects.
         * Supports multiple timestamps per line (chorus notation):
         *   [01:10.00][02:30.00]Chorus text
         * Each timestamp produces an independent entry.
         *
         * @param {string} lrcString
         * @returns {Array<{time: number, text: string}>}
         */
        parse(lrcString) {
            if (!lrcString) return [];

            const lines = lrcString.split("\n");
            const result = [];

            for (const line of lines) {
                const timestamps = [];
                let match;

                // Reset and find all timestamp tags in this line
                TIMESTAMP_PATTERN.lastIndex = 0;
                while ((match = TIMESTAMP_PATTERN.exec(line)) !== null) {
                    timestamps.push(matchToSeconds(match[1], match[2], match[3]));
                }

                if (timestamps.length === 0) continue;

                // Extract text after all timestamp tags
                const text = line
                    .replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, "")
                    .trim();

                if (!text) continue;

                // Push one entry per timestamp (unfold repeated choruses)
                for (const time of timestamps) {
                    result.push({ time, text });
                }
            }

            // Sort by timestamp ascending
            result.sort((a, b) => a.time - b.time);
            return result;
        },
    };
})();

/* =============================================================
   Module 4: Lyrics Renderer
   ============================================================= */
const LyricsRenderer = (() => {
    let lyrics = [];
    let currentIndex = -1;
    let animFrameId = null;

    // DOM references (set in init)
    let viewport = null;
    let track = null;

    /**
     * Binary search for the active lyric index at a given time.
     * Returns the index of the last lyric whose time <= currentTime.
     */
    function findActiveIndex(time) {
        let low = 0;
        let high = lyrics.length - 1;
        let result = -1;

        while (low <= high) {
            const mid = (low + high) >>> 1;
            if (lyrics[mid].time <= time) {
                result = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return result;
    }

    /** Animation frame callback for synchronizing lyrics highlight. */
    function syncLoop() {
        const time = AudioEngine.getCurrentTime();
        const newIndex = findActiveIndex(time);

        if (newIndex !== currentIndex) {
            // Remove previous highlight
            if (currentIndex >= 0 && currentIndex < track.children.length) {
                track.children[currentIndex].classList.remove("active");
            }

            currentIndex = newIndex;

            // Apply new highlight and center
            if (currentIndex >= 0 && currentIndex < track.children.length) {
                const activeLine = track.children[currentIndex];
                activeLine.classList.add("active");

                // Calculate translateY to center active line in viewport
                const vpHeight = viewport.clientHeight;
                const lineTop = activeLine.offsetTop;
                const lineHeight = activeLine.offsetHeight;
                const targetY = lineTop - vpHeight / 2 + lineHeight / 2;
                track.style.transform = `translateY(${-targetY}px)`;
            }
        }

        // Also update seekbar and time displays
        AppController.updateTimeDisplay();

        if (AudioEngine.getIsPlaying()) {
            animFrameId = requestAnimationFrame(syncLoop);
        }
    }

    return {
        init(viewportEl, trackEl) {
            viewport = viewportEl;
            track = trackEl;
        },

        /**
         * Render lyric lines into the DOM.
         * @param {Array<{time: number, text: string}>} parsedLyrics
         */
        setLyrics(parsedLyrics) {
            lyrics = parsedLyrics;
            currentIndex = -1;
            track.innerHTML = "";
            track.style.transform = "translateY(0)";

            for (const line of lyrics) {
                const p = document.createElement("p");
                p.classList.add("lyric-line");
                p.textContent = line.text;
                track.appendChild(p);
            }
        },

        startSync() {
            if (animFrameId) cancelAnimationFrame(animFrameId);
            animFrameId = requestAnimationFrame(syncLoop);
        },

        stopSync() {
            if (animFrameId) {
                cancelAnimationFrame(animFrameId);
                animFrameId = null;
            }
        },

        resetPosition() {
            currentIndex = -1;
            if (track) {
                for (let i = 0; i < track.children.length; i++) {
                    track.children[i].classList.remove("active");
                }
                track.style.transform = "translateY(0)";
            }
        },

        hasLyrics() {
            return lyrics.length > 0;
        },

        shiftLyrics(offset) {
            lyrics = lyrics.map(line => {
                line.time = Math.max(0, line.time + offset);
                return line;
            });
        },

        getLyrics() {
            return lyrics;
        },
    };
})();

/* =============================================================
   Module 5: Manual Sync (Tap-Sync)
   ============================================================= */
const ManualSync = (() => {
    let lines = [];
    let originalTimes = []; // Store original timestamps for editing
    let currentLineIndex = 0;
    let timestamps = [];
    let isActive = false;
    let onCompleteCallback = null;

    // DOM references (set in init)
    let syncModal = null;
    let currentLineEl = null;
    let nextLineEl = null;
    let progressEl = null;

    /** Update the sync modal display with current/next line. */
    function updateDisplay() {
        if (currentLineIndex < lines.length) {
            currentLineEl.textContent = lines[currentLineIndex];
            nextLineEl.textContent =
                currentLineIndex + 1 < lines.length
                    ? lines[currentLineIndex + 1]
                    : "---";
            progressEl.textContent = `${currentLineIndex + 1} / ${lines.length}`;
        } else {
            currentLineEl.textContent = "---";
            nextLineEl.textContent = "---";
            progressEl.textContent = `${lines.length} / ${lines.length}`;
        }
    }

    /** Keydown handler: Space marks the current timestamp. */
    function handleKeydown(e) {
        if (!isActive) return;
        if (e.code !== "Space") return;
        e.preventDefault();

        const time = AudioEngine.getCurrentTime();
        timestamps.push(time);
        currentLineIndex++;
        updateDisplay();

        if (currentLineIndex >= lines.length) {
            finish();
        }
    }

    /** Generate an LRC string from accumulated timestamps. */
    function generateLrc() {
        let lrc = "";
        for (let i = 0; i < lines.length; i++) {
            const t = timestamps[i] || 0;
            const min = Math.floor(t / 60);
            const sec = Math.floor(t % 60);
            const ms = Math.floor((t % 1) * 100);
            const tag =
                `[${String(min).padStart(2, "0")}:` +
                `${String(sec).padStart(2, "0")}.` +
                `${String(ms).padStart(2, "0")}]`;
            lrc += `${tag}${lines[i]}\n`;
        }
        return lrc.trim();
    }

    /** Complete the sync process. */
    function finish() {
        isActive = false;
        document.removeEventListener("keydown", handleKeydown);
        syncModal.classList.add("hidden");

        const lrcString = generateLrc();
        if (onCompleteCallback) onCompleteCallback(lrcString);
    }

    return {
        init(modal, currentEl, nextEl, progressElement) {
            syncModal = modal;
            currentLineEl = currentEl;
            nextLineEl = nextEl;
            progressEl = progressElement;
        },

        /**
         * Start the tap-sync process.
         * @param {string|Array<{text: string, time: number}>} lyricsData - pasted raw lyrics or structured lyrics array
         * @param {function} callback - called with generated LRC string on completion
         */
        start(lyricsData, callback) {
            if (typeof lyricsData === "string") {
                lines = lyricsData
                    .split("\n")
                    .map((l) => l.trim())
                    .filter((l) => l.length > 0);
                originalTimes = lines.map(() => null);
            } else if (Array.isArray(lyricsData)) {
                lines = lyricsData.map(item => item.text);
                originalTimes = lyricsData.map(item => item.time);
            } else {
                return;
            }

            if (lines.length === 0) return;

            currentLineIndex = 0;
            timestamps = [];
            isActive = true;
            onCompleteCallback = callback;

            updateDisplay();
            syncModal.classList.remove("hidden");

            document.addEventListener("keydown", handleKeydown);

            // Start playback from the beginning
            if (!AudioEngine.getIsPlaying()) {
                AudioEngine.seek(0);
                AudioEngine.play();
                AppController.syncPlayState(true);
            }
        },

        cancel() {
            isActive = false;
            document.removeEventListener("keydown", handleKeydown);
            syncModal.classList.add("hidden");
        },

        /**
         * Force finish (triggered by "Finish" button).
         * Preserves original timestamps for remaining lines if they exist and are sequential.
         */
        forceFinish() {
            if (!isActive) return;
            const time = AudioEngine.getCurrentTime();
            
            // Reference time to make sure timestamps are sequential (ascending order)
            let lastTime = timestamps.length > 0 ? timestamps[timestamps.length - 1] : time;

            while (timestamps.length < lines.length) {
                const idx = timestamps.length;
                const orig = originalTimes[idx];
                if (orig !== null && orig !== undefined && orig >= lastTime) {
                    timestamps.push(orig);
                    lastTime = orig;
                } else {
                    timestamps.push(lastTime);
                }
            }
            finish();
        },

        /**
         * Download the generated LRC as a file.
         * @param {string} filename - original audio filename
         */
        downloadLrc(filename) {
            const lrc = generateLrc();
            if (!lrc) return;
            const blob = new Blob([lrc], { type: "text/plain;charset=utf-8" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = filename.replace(/\.[^.]+$/, "") + ".lrc";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
        },
    };
})();

/* =============================================================
   Module 6: App Controller (Orchestration)
   ============================================================= */
const AppController = (() => {
    // Application state
    let state = "idle"; // idle | uploading | processing | ready | playing | paused | syncing
    let currentView = "library"; // library | player
    let currentFilename = "";
    let currentBaseName = "";
    let currentSongId = null; // To update lyrics later
    let currentLyricsOffset = 0; // accumulated sync offset in seconds

    // DOM element cache
    const $ = (id) => document.getElementById(id);

    let els = {};

    /** Format seconds to m:ss display. */
    function formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return "0:00";
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, "0")}`;
    }

    /** Update play/pause button visual state. */
    function setPlayIcon(playing) {
        const playIcon = els.playPauseBtn.querySelector(".play-icon");
        const pauseIcon = els.playPauseBtn.querySelector(".pause-icon");
        if (playing) {
            playIcon.classList.remove("visible");
            pauseIcon.classList.add("visible");
            els.playPauseBtn.setAttribute("aria-label", "Pause");
        } else {
            pauseIcon.classList.remove("visible");
            playIcon.classList.add("visible");
            els.playPauseBtn.setAttribute("aria-label", "Play");
        }
    }

    /** Transition to a new app state and update UI accordingly. */
    function setState(newState) {
        state = newState;

        // Reset visibility inside player view
        els.progressSection.classList.add("hidden");
        els.lyricsSection.classList.add("hidden");
        els.noLyricsMessage.classList.add("hidden");
        
        // Hide drop zone if we are not idle
        if (state !== "idle" && state !== "uploading" && state !== "processing") {
            els.uploadSection.classList.add("hidden");
        } else {
            els.uploadSection.classList.remove("hidden");
        }

        // Enable/disable controls
        const controlsEnabled = ["ready", "playing", "paused"].includes(state);
        els.playPauseBtn.disabled = !controlsEnabled;
        els.stopBtn.disabled = !controlsEnabled;
        els.seekbar.disabled = !controlsEnabled;

        const hasLyrics = LyricsRenderer.hasLyrics();
        els.syncAdjustDelay.disabled = !controlsEnabled || !hasLyrics;
        els.syncAdjustAdvance.disabled = !controlsEnabled || !hasLyrics;
        els.editLyricsBtn.disabled = !controlsEnabled;

        switch (state) {
            case "uploading":
            case "processing":
                els.progressSection.classList.remove("hidden");
                els.uploadSection.classList.add("hidden");
                break;
            case "ready":
            case "playing":
            case "paused":
                if (LyricsRenderer.hasLyrics()) {
                    els.lyricsSection.classList.remove("hidden");
                } else {
                    els.noLyricsMessage.classList.remove("hidden");
                }
                break;
        }
    }

    function setView(viewName) {
        currentView = viewName;
        if (viewName === "library") {
            els.viewLibrary.classList.add("view-active");
            els.viewLibrary.classList.remove("view-hidden");
            els.viewPlayer.classList.add("view-hidden");
            els.viewPlayer.classList.remove("view-active");
            els.navLibraryBtn.classList.add("active");
            els.navPlayerBtn.classList.remove("active");
        } else {
            els.viewPlayer.classList.add("view-active");
            els.viewPlayer.classList.remove("view-hidden");
            els.viewLibrary.classList.add("view-hidden");
            els.viewLibrary.classList.remove("view-active");
            els.navPlayerBtn.classList.add("active");
            els.navLibraryBtn.classList.remove("active");
        }
    }

    /** Show processing progress. */
    function showProgress(percent, text) {
        els.progressText.textContent = text;
        if (percent === -1) {
            // Indeterminate
            els.progressBarFill.classList.add("indeterminate");
            els.progressBarFill.style.width = "";
        } else {
            els.progressBarFill.classList.remove("indeterminate");
            els.progressBarFill.style.width = `${percent}%`;
        }
    }

    /** Handle file selection (from input or drop). */
    async function handleFile(file) {
        if (!file) return;
        if (!ApiClient.getBaseUrl()) {
            alert("Connect to the backend first.");
            return;
        }

        currentFilename = file.name;
        
        // Show modal and hide close button during upload
        els.uploadModal.classList.remove("hidden");
        els.cancelUploadBtn.classList.add("hidden");

        // 1. Extract metadata before uploading
        showProgress(0, "Extracting metadata...");
        const metadata = await MetadataExtractor.extract(file);
        
        setState("uploading");
        showProgress(0, "Uploading...");

        try {
            // 2. Upload and process
            const result = await ApiClient.processAudio(file, (percent) => {
                if (percent === -1) {
                    setState("processing");
                    showProgress(-1, "Separating audio tracks (this may take a few minutes)...");
                } else {
                    showProgress(percent, `Uploading... ${percent}%`);
                }
            });

            // 3. Download Blobs for offline usage
            showProgress(-1, "Downloading stems for offline usage...");
            const vocalUrl = result.vocal_url;
            const instUrl = result.instrumental_url || result.inst_url;
            console.log("[handleFile] Backend separation completed. Initiating stems download...", { vocalUrl, instUrl });
            
            const [vocalBlob, instBlob] = await Promise.all([
                ApiClient.fetchAudioBlob(vocalUrl),
                ApiClient.fetchAudioBlob(instUrl)
            ]);
            console.log("[handleFile] Stems downloaded successfully.", { vocalBlob, instBlob });

            // Store base_name for AI sync
            currentBaseName = result.base_name || "";
            if (!currentBaseName && result.vocal_url) {
                const parts = result.vocal_url.split("/");
                currentBaseName = parts.length >= 2 ? parts[parts.length - 2] : "";
            }

            // 4. Save to IndexedDB
            showProgress(-1, "Saving to Library...");
            const lyrics_lrc = (result.lyrics_found && result.lyrics_lrc) ? result.lyrics_lrc : "";
            const songId = await Database.saveSong({
                title: metadata.title,
                artist: metadata.artist,
                album: metadata.album,
                cover_blob: metadata.cover_blob,
                base_name: currentBaseName,
                vocal_blob: vocalBlob,
                inst_blob: instBlob,
                lyrics_lrc: lyrics_lrc
            });
            currentSongId = songId;

            // Set Player metadata panel info and dynamic fluid background
            const coverUrl = metadata.cover_blob 
                ? URL.createObjectURL(metadata.cover_blob) 
                : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
            els.playerCoverArt.src = coverUrl;
            els.lyricsBgArt.style.backgroundImage = `url('${coverUrl}')`;
            els.playerSongTitle.textContent = metadata.title;
            els.playerSongArtist.textContent = metadata.artist;

            // Load into engine directly from Blobs
            await AudioEngine.loadStems(vocalBlob, instBlob);

            // Handle lyrics
            if (lyrics_lrc) {
                const parsed = LrcParser.parse(lyrics_lrc);
                LyricsRenderer.setLyrics(parsed);
            } else {
                LyricsRenderer.setLyrics([]);
            }

            // Update UI
            els.timeTotal.textContent = formatTime(AudioEngine.getDuration());
            els.seekbar.max = "1000";
            els.seekbar.value = "0";
            els.seekbarFill.style.width = "0%";
            setPlayIcon(false);
            currentLyricsOffset = 0;
            updateOffsetLabel();
            setState("ready");
            
            // Switch to player view and refresh library
            await renderLibrary();
            setView("player");
            
            // Close the upload modal
            els.uploadModal.classList.add("hidden");
            
        } catch (err) {
            console.error("Processing failed:", err);
            alert(`Processing failed: ${err.message}`);
            setState("idle");
            els.cancelUploadBtn.classList.remove("hidden");
        }
    }

    async function loadSongFromDb(songId) {
        try {
            const songs = await Database.getSongs();
            const song = songs.find(s => s.id === songId);
            if (!song) return;

            showProgress(-1, "Loading song...");
            setState("processing");
            setView("player");

            currentBaseName = song.base_name;
            currentSongId = song.id;

            // Set Player metadata panel info and dynamic fluid background
            const coverUrl = song.cover_blob 
                ? URL.createObjectURL(song.cover_blob) 
                : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';
            els.playerCoverArt.src = coverUrl;
            els.lyricsBgArt.style.backgroundImage = `url('${coverUrl}')`;
            els.playerSongTitle.textContent = song.title;
            els.playerSongArtist.textContent = song.artist;

            await AudioEngine.loadStems(song.vocal_blob, song.inst_blob);

            if (song.lyrics_lrc) {
                const parsed = LrcParser.parse(song.lyrics_lrc);
                LyricsRenderer.setLyrics(parsed);
            } else {
                LyricsRenderer.setLyrics([]);
            }

            els.timeTotal.textContent = formatTime(AudioEngine.getDuration());
            els.seekbar.max = "1000";
            els.seekbar.value = "0";
            els.seekbarFill.style.width = "0%";
            currentLyricsOffset = 0;
            updateOffsetLabel();
            setState("playing");
            AudioEngine.play();
            LyricsRenderer.startSync();
            setPlayIcon(true);
            
        } catch (err) {
            console.error("Failed to load song:", err);
            alert("Error loading song from library.");
            setState("idle");
        }
    }

    function updateOffsetLabel() {
        const sign = currentLyricsOffset >= 0 ? "+" : "";
        els.syncOffsetLabel.textContent = `Sync ${sign}${currentLyricsOffset.toFixed(1)}s`;
    }

    function serializeLyrics(lyricsArray) {
        return lyricsArray.map(line => {
            const t = line.time;
            const min = Math.floor(t / 60);
            const sec = Math.floor(t % 60);
            const ms = Math.floor((t % 1) * 100);
            const tag = `[${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(2, "0")}]`;
            return `${tag}${line.text}`;
        }).join("\n");
    }

    async function adjustLyricsTime(amount) {
        if (!currentSongId) return;

        currentLyricsOffset += amount;
        updateOffsetLabel();

        // Shift timestamps in LyricsRenderer
        LyricsRenderer.shiftLyrics(amount);

        // Save the newly shifted lyrics to the database
        const shiftedLrc = serializeLyrics(LyricsRenderer.getLyrics());
        try {
            await Database.updateLyrics(currentSongId, shiftedLrc);
        } catch (err) {
            console.error("Failed to save adjusted lyrics:", err);
        }
    }

    async function renderLibrary() {
        const songs = await Database.getSongs();
        els.libraryGrid.innerHTML = "";
        els.sidebarSongList.innerHTML = "";

        songs.forEach(song => {
            const coverUrl = song.cover_blob 
                ? URL.createObjectURL(song.cover_blob) 
                : 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>';

            // Render Library Grid Card
            const card = document.createElement("div");
            card.className = "song-card";
            card.innerHTML = `
                <button class="delete-song-btn" title="Eliminar canción">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="3 6 5 6 21 6"></polyline>
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                </button>
                <img class="cover-art" src="${coverUrl}" alt="Cover Art">
                <div class="song-title">${song.title}</div>
                <div class="song-artist">${song.artist}</div>
                <span class="offline-badge">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Offline
                </span>
            `;
            card.addEventListener("click", () => loadSongFromDb(song.id));
            
            const deleteBtn = card.querySelector(".delete-song-btn");
            deleteBtn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (confirm(`¿Estás seguro de que quieres eliminar "${song.title}"?`)) {
                    try {
                        await Database.deleteSong(song.id);
                        if (currentSongId === song.id) {
                            AudioEngine.stop();
                            LyricsRenderer.setLyrics([]);
                            els.timeCurrent.textContent = "00:00";
                            els.timeTotal.textContent = "00:00";
                            els.seekbar.value = "0";
                            els.seekbarFill.style.width = "0%";
                            setState("idle");
                            currentSongId = null;
                        }
                        await renderLibrary();
                    } catch (err) {
                        alert("Error al eliminar la canción: " + err.message);
                    }
                }
            });

            els.libraryGrid.appendChild(card);

            // Render Sidebar Item
            const sideItem = document.createElement("li");
            sideItem.className = "sidebar-song-item";
            sideItem.innerHTML = `
                <img src="${coverUrl}" alt="Cover">
                <div class="sidebar-song-info">
                    <div class="title">${song.title}</div>
                    <div class="artist">${song.artist}</div>
                </div>
            `;
            sideItem.addEventListener("click", () => loadSongFromDb(song.id));
            els.sidebarSongList.appendChild(sideItem);
        });
    }

    /** Main initialization. */
    async function init() {
        // Init Database
        await Database.init();

        // Cache DOM elements
        els = {
            backendUrlInput: $("backend-url-input"),
            connectBtn: $("connect-btn"),
            connectionIndicator: $("connection-indicator"),
            themeToggleBtn: $("theme-toggle-btn"),
            
            // Views & Nav
            viewLibrary: $("view-library"),
            viewPlayer: $("view-player"),
            navLibraryBtn: $("nav-library-btn"),
            navPlayerBtn: $("nav-player-btn"),
            playerSidebar: $("player-sidebar"),
            toggleSidebarBtn: $("toggle-sidebar-btn"),
            sidebarSongList: $("sidebar-song-list"),
            libraryGrid: $("library-grid"),
            uploadModal: $("upload-modal"),
            cancelUploadBtn: $("cancel-upload-btn"),
            headerUploadBtn: $("header-upload-btn"),

            uploadSection: $("upload-section"),
            dropZone: $("drop-zone"),
            fileInput: $("file-input"),
            progressSection: $("progress-section"),
            progressBarFill: $("progress-bar-fill"),
            progressText: $("progress-text"),
            lyricsSection: $("lyrics-section"),
            lyricsViewport: $("lyrics-viewport"),
            lyricsTrack: $("lyrics-track"),
            noLyricsMessage: $("no-lyrics-message"),
            openLyricsModalBtn: $("open-lyrics-modal-btn"),
            playPauseBtn: $("play-pause-btn"),
            stopBtn: $("stop-btn"),
            seekbar: $("seekbar"),
            seekbarFill: $("seekbar-fill"),
            timeCurrent: $("time-current"),
            timeTotal: $("time-total"),
            vocalSlider: $("vocal-slider"),
            instSlider: $("inst-slider"),
            vocalValue: $("vocal-value"),
            instValue: $("inst-value"),
            lyricsModal: $("lyrics-modal"),
            lyricsTextarea: $("lyrics-textarea"),
            startSyncBtn: $("start-sync-btn"),
            cancelLyricsBtn: $("cancel-lyrics-btn"),
            aiSyncBtn: $("ai-sync-btn"),
            aiSyncLyricsBtn: $("ai-sync-lyrics-btn"),
            syncModal: $("sync-modal"),
            syncCurrentLine: $("sync-current-line"),
            syncNextLine: $("sync-next-line"),
            syncProgress: $("sync-progress"),
            cancelSyncBtn: $("cancel-sync-btn"),
            finishSyncBtn: $("finish-sync-btn"),
            syncAdjustDelay: $("sync-adjust-delay"),
            syncAdjustAdvance: $("sync-adjust-advance"),
            syncOffsetLabel: $("sync-offset-label"),
            editLyricsBtn: $("edit-lyrics-btn"),
            playerCoverArt: $("player-cover-art"),
            playerSongTitle: $("player-song-title"),
            playerSongArtist: $("player-song-artist"),
            lyricsBgArt: $("lyrics-bg-art"),
        };

        // Initialize sub-modules
        LyricsRenderer.init(els.lyricsViewport, els.lyricsTrack);
        ManualSync.init(
            els.syncModal,
            els.syncCurrentLine,
            els.syncNextLine,
            els.syncProgress
        );

        // --- Theme Toggle ---
        const savedTheme = localStorage.getItem("karaoke-theme");
        if (savedTheme === "light") {
            document.documentElement.classList.add("light-mode");
        }

        els.themeToggleBtn.addEventListener("click", () => {
            document.documentElement.classList.toggle("light-mode");
            const isLight = document.documentElement.classList.contains("light-mode");
            localStorage.setItem("karaoke-theme", isLight ? "light" : "dark");
        });

        // --- Mobile Settings Menu Toggle ---
        const menuToggleBtn = $("header-menu-toggle-btn");
        const actionsContainer = $("header-actions-container");
        if (menuToggleBtn && actionsContainer) {
            menuToggleBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                actionsContainer.classList.toggle("menu-open");
            });

            document.addEventListener("click", () => {
                actionsContainer.classList.remove("menu-open");
            });

            actionsContainer.addEventListener("click", (e) => {
                e.stopPropagation();
            });
        }

        // --- View & Sidebar Navigation ---
        els.navLibraryBtn.addEventListener("click", () => setView("library"));
        els.navPlayerBtn.addEventListener("click", () => setView("player"));
        
        els.toggleSidebarBtn.addEventListener("click", () => {
            els.playerSidebar.classList.toggle("sidebar-collapsed");
        });

        // --- Upload Modal Controls ---
        els.headerUploadBtn.addEventListener("click", () => {
            els.uploadSection.classList.remove("hidden");
            els.progressSection.classList.add("hidden");
            els.cancelUploadBtn.classList.remove("hidden");
            els.uploadModal.classList.remove("hidden");
        });

        els.cancelUploadBtn.addEventListener("click", () => {
            els.uploadModal.classList.add("hidden");
        });

        // --- Sync Offset Controls ---
        els.syncAdjustDelay.addEventListener("click", () => {
            adjustLyricsTime(-0.2); // Shift lyrics earlier by 0.2s
        });

        els.syncAdjustAdvance.addEventListener("click", () => {
            adjustLyricsTime(0.2); // Shift lyrics later by 0.2s
        });

        els.editLyricsBtn.addEventListener("click", () => {
            const plainText = LyricsRenderer.getLyrics().map(line => line.text).join("\n");
            els.lyricsTextarea.value = plainText;
            els.lyricsModal.classList.remove("hidden");
        });

        // --- Backend Connection ---
        els.connectBtn.addEventListener("click", async () => {
            const url = els.backendUrlInput.value.trim();
            if (!url) return;

            ApiClient.setBaseUrl(url);
            els.connectionIndicator.classList.remove("connected");

            try {
                await ApiClient.checkHealth();
                els.connectionIndicator.classList.add("connected");
                localStorage.setItem("karaoke-backend-url", url); // Save URL
            } catch (err) {
                els.connectionIndicator.classList.remove("connected");
                alert(`Cannot connect: ${err.message}`);
            }
        });

        // Also connect on Enter key
        els.backendUrlInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") els.connectBtn.click();
        });

        // --- File Upload ---
        els.dropZone.addEventListener("click", () => els.fileInput.click());

        els.fileInput.addEventListener("change", (e) => {
            if (e.target.files.length > 0) {
                handleFile(e.target.files[0]);
                e.target.value = ""; // Reset for re-upload
            }
        });

        // Drag and drop
        els.dropZone.addEventListener("dragover", (e) => {
            e.preventDefault();
            els.dropZone.classList.add("drag-over");
        });
        els.dropZone.addEventListener("dragleave", () => {
            els.dropZone.classList.remove("drag-over");
        });
        els.dropZone.addEventListener("drop", (e) => {
            e.preventDefault();
            els.dropZone.classList.remove("drag-over");
            if (e.dataTransfer.files.length > 0) {
                handleFile(e.dataTransfer.files[0]);
            }
        });

        // --- Transport Controls ---
        els.playPauseBtn.addEventListener("click", () => {
            if (!AudioEngine.isReady()) return;

            if (AudioEngine.getIsPlaying()) {
                AudioEngine.pause();
                LyricsRenderer.stopSync();
                setPlayIcon(false);
                setState("paused");
            } else {
                AudioEngine.play();
                LyricsRenderer.startSync();
                setPlayIcon(true);
                setState("playing");
            }
        });

        els.stopBtn.addEventListener("click", () => {
            AudioEngine.stop();
            LyricsRenderer.stopSync();
            LyricsRenderer.resetPosition();
            setPlayIcon(false);
            els.seekbar.value = "0";
            els.seekbarFill.style.width = "0%";
            els.timeCurrent.textContent = "0:00";
            setState("ready");
        });

        // Auto-stop callback
        AudioEngine.onEnded = () => {
            LyricsRenderer.stopSync();
            LyricsRenderer.resetPosition();
            setPlayIcon(false);
            els.seekbar.value = "0";
            els.seekbarFill.style.width = "0%";
            els.timeCurrent.textContent = "0:00";
            setState("ready");
        };

        // --- Seekbar ---
        let isSeeking = false;

        els.seekbar.addEventListener("mousedown", () => (isSeeking = true));
        els.seekbar.addEventListener("touchstart", () => (isSeeking = true));

        els.seekbar.addEventListener("input", () => {
            const ratio = parseInt(els.seekbar.value) / 1000;
            const duration = AudioEngine.getDuration();
            els.seekbarFill.style.width = `${ratio * 100}%`;
            els.timeCurrent.textContent = formatTime(ratio * duration);
        });

        const onSeekEnd = () => {
            if (!isSeeking) return;
            isSeeking = false;
            const ratio = parseInt(els.seekbar.value) / 1000;
            const duration = AudioEngine.getDuration();
            AudioEngine.seek(ratio * duration);
        };

        els.seekbar.addEventListener("mouseup", onSeekEnd);
        els.seekbar.addEventListener("touchend", onSeekEnd);
        els.seekbar.addEventListener("change", onSeekEnd);

        // --- Volume Sliders ---
        els.vocalSlider.addEventListener("input", () => {
            const val = parseInt(els.vocalSlider.value);
            AudioEngine.setVocalVolume(val / 100);
            els.vocalValue.textContent = val;
        });

        els.instSlider.addEventListener("input", () => {
            const val = parseInt(els.instSlider.value);
            AudioEngine.setInstVolume(val / 100);
            els.instValue.textContent = val;
        });

        // --- Manual Lyrics Modal ---
        els.openLyricsModalBtn.addEventListener("click", () => {
            els.lyricsModal.classList.remove("hidden");
        });

        els.cancelLyricsBtn.addEventListener("click", () => {
            els.lyricsModal.classList.add("hidden");
        });

        els.startSyncBtn.addEventListener("click", () => {
            const text = els.lyricsTextarea.value.trim();
            if (!text) return;

            els.lyricsModal.classList.add("hidden");

            // Convert lines of text to structured {text, time} by matching with current lyrics in memory
            const inputLines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
            const originalLyrics = LyricsRenderer.getLyrics();
            
            const matchedLyrics = inputLines.map(line => {
                const match = originalLyrics.find(orig => orig.text.toLowerCase() === line.toLowerCase());
                return {
                    text: line,
                    time: match ? match.time : null
                };
            });

            ManualSync.start(matchedLyrics, async (generatedLrc) => {
                // Parse the generated LRC and feed to renderer
                const parsed = LrcParser.parse(generatedLrc);
                LyricsRenderer.setLyrics(parsed);

                // Show lyrics view
                els.noLyricsMessage.classList.add("hidden");
                els.lyricsSection.classList.remove("hidden");
                
                // Save to DB
                if (currentSongId) {
                    await Database.updateLyrics(currentSongId, generatedLrc);
                }

                // Offer download
                if (confirm("Sync complete! Download the generated .lrc file?")) {
                    ManualSync.downloadLrc(currentFilename);
                }
            });
        });

        // --- Sync Modal Controls ---
        els.cancelSyncBtn.addEventListener("click", () => {
            ManualSync.cancel();
        });

        els.finishSyncBtn.addEventListener("click", () => {
            ManualSync.forceFinish();
        });

        // --- AI Sync: Auto-detect (no user text needed) ---
        els.aiSyncBtn.addEventListener("click", async () => {
            if (!ApiClient.getBaseUrl()) {
                alert("Connect to the backend first.");
                return;
            }
            if (!currentBaseName) {
                alert("No song processed yet.");
                return;
            }
            els.aiSyncBtn.disabled = true;
            els.aiSyncBtn.textContent = "Processing...";
            try {
                const result = await ApiClient.syncWithAi(currentBaseName);
                if (result.lyrics_found && result.lyrics_lrc) {
                    const parsed = LrcParser.parse(result.lyrics_lrc);
                    LyricsRenderer.setLyrics(parsed);
                    els.noLyricsMessage.classList.add("hidden");
                    els.lyricsSection.classList.remove("hidden");
                    
                    if (currentSongId) {
                        await Database.updateLyrics(currentSongId, result.lyrics_lrc);
                    }
                } else {
                    alert("Whisper could not detect lyrics in this track.");
                }
            } catch (err) {
                alert(`AI sync failed: ${err.message}`);
                setState(AudioEngine.getIsPlaying() ? "playing" : "ready");
            } finally {
                els.aiSyncBtn.disabled = false;
                els.aiSyncBtn.textContent = "Auto-sync (AI)";
            }
        });

        // --- AI Sync: Align user-pasted lyrics ---
        els.aiSyncLyricsBtn.addEventListener("click", async () => {
            if (!ApiClient.getBaseUrl()) {
                alert("Connect to the backend first.");
                return;
            }
            const text = els.lyricsTextarea.value.trim();
            if (!text) {
                alert("Paste lyrics first.");
                return;
            }
            if (!currentBaseName) {
                alert("No song processed yet.");
                return;
            }
            els.lyricsModal.classList.add("hidden");
            els.noLyricsMessage.classList.remove("hidden");
            els.aiSyncBtn.disabled = true;
            els.aiSyncBtn.textContent = "Processing...";
            try {
                const result = await ApiClient.syncWithAi(currentBaseName, text);
                if (result.lyrics_found && result.lyrics_lrc) {
                    const parsed = LrcParser.parse(result.lyrics_lrc);
                    LyricsRenderer.setLyrics(parsed);
                    els.noLyricsMessage.classList.add("hidden");
                    els.lyricsSection.classList.remove("hidden");
                    
                    if (currentSongId) {
                        await Database.updateLyrics(currentSongId, result.lyrics_lrc);
                    }
                } else {
                    alert("AI alignment could not produce synced lyrics.");
                }
            } catch (err) {
                alert(`AI sync failed: ${err.message}`);
                setState(AudioEngine.getIsPlaying() ? "playing" : "ready");
            } finally {
                els.aiSyncBtn.disabled = false;
                els.aiSyncBtn.textContent = "Auto-sync (AI)";
            }
        });

        // --- Initial state ---
        setState("idle");
        setView("library");
        renderLibrary();

        // --- Restore Backend Connection ---
        const savedUrl = localStorage.getItem("karaoke-backend-url");
        if (savedUrl) {
            els.backendUrlInput.value = savedUrl;
            ApiClient.setBaseUrl(savedUrl);
            ApiClient.checkHealth()
                .then(() => els.connectionIndicator.classList.add("connected"))
                .catch(() => els.connectionIndicator.classList.remove("connected"));
        }
    }

    return {
        init,

        /** Called from LyricsRenderer sync loop to update seekbar/time. */
        updateTimeDisplay() {
            if (els && !document.querySelector("#seekbar:active")) {
                const current = AudioEngine.getCurrentTime();
                const duration = AudioEngine.getDuration();
                if (duration > 0) {
                    const ratio = current / duration;
                    els.seekbar.value = String(Math.round(ratio * 1000));
                    els.seekbarFill.style.width = `${ratio * 100}%`;
                    els.timeCurrent.textContent = formatTime(current);
                }
            }
        },

        /** Public method for ManualSync to sync play button state. */
        syncPlayState(playing) {
            const playIcon = els.playPauseBtn.querySelector(".play-icon");
            const pauseIcon = els.playPauseBtn.querySelector(".pause-icon");
            if (playing) {
                playIcon.classList.remove("visible");
                pauseIcon.classList.add("visible");
            } else {
                pauseIcon.classList.remove("visible");
                playIcon.classList.add("visible");
            }
            LyricsRenderer.startSync();
        },
    };
})();

/* =============================================================
   Bootstrap
   ============================================================= */
document.addEventListener("DOMContentLoaded", AppController.init);
