from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from difflib import SequenceMatcher
import subprocess
import os
import re
import httpx

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs("/content/audios", exist_ok=True)
os.makedirs("/content/separated/htdemucs", exist_ok=True)

app.mount("/tracks", StaticFiles(directory="/content/separated/htdemucs"), name="tracks")


# ==============================================================
# Global Exception Handler (to prevent CORS errors on crashes)
# ==============================================================
from fastapi.responses import JSONResponse
from fastapi.requests import Request

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": f"Backend Error: {str(exc)} (check Colab console)"},
    )


# ==============================================================
# Helpers
# ==============================================================

def clean_for_search(filename):
    """Clean filename noise for LRCLIB search."""
    name = os.path.splitext(filename)[0]
    name = re.sub(r'^\d{1,3}[\s._\-]+', '', name)
    name = name.replace('_', ' ')
    name = re.sub(r'[\[\(][^\]\)]*[\]\)]', '', name)
    name = re.sub(
        r'\b(official\s*(music\s*)?video|lyric\s*video|audio|hd|hq|4k|remaster(ed)?)\b',
        '', name, flags=re.IGNORECASE
    )
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def search_lyrics(query):
    """Search LRCLIB. Returns first result with valid syncedLyrics."""
    try:
        resp = httpx.get(
            "https://lrclib.net/api/search",
            params={"q": query},
            headers={"User-Agent": "KaraokeApp/1.0"},
            timeout=15.0
        )
        if resp.status_code != 200:
            return None
        results = resp.json()
        if not isinstance(results, list):
            return None
        for item in results:
            synced = item.get("syncedLyrics")
            if synced and isinstance(synced, str) and synced.strip():
                return synced.strip()
        return None
    except Exception:
        return None


def format_lrc_tag(seconds):
    """Format seconds to [mm:ss.xx] LRC tag."""
    m = int(seconds // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 100)
    return f"[{m:02d}:{s:02d}.{ms:02d}]"


def align_lyrics_with_words(user_lines, all_words):
    """Align user lyrics to Whisper word-level timestamps using sequence lookahead."""
    result = []
    word_cursor = 0
    n_words = len(all_words)
    
    for i, line in enumerate(user_lines):
        line_words = [re.sub(r'[^\w]', '', w).lower() for w in line.split()]
        line_words = [w for w in line_words if w]
        
        if not line_words:
            result.append((0, line))
            continue
            
        best_match_idx = -1
        best_match_score = 0
        
        # Lookahead window of 40 words
        lookahead = min(40, n_words - word_cursor)
        for j in range(lookahead):
            idx = word_cursor + j
            match_count = 0
            check_len = min(len(line_words), 4, n_words - idx)
            if check_len == 0:
                continue
            for k in range(check_len):
                if all_words[idx + k]["word"] == line_words[k]:
                    match_count += 1
            
            score = match_count / check_len
            if score > best_match_score:
                best_match_score = score
                best_match_idx = idx
                if score == 1.0:
                    break
        
        if best_match_score >= 0.5 and best_match_idx != -1:
            chosen_start = all_words[best_match_idx]["start"]
            result.append((chosen_start, line))
            word_cursor = min(best_match_idx + len(line_words), n_words - 1)
        else:
            if word_cursor < n_words:
                chosen_start = all_words[word_cursor]["start"]
                result.append((chosen_start, line))
                word_cursor = min(word_cursor + max(1, len(line_words)), n_words - 1)
            else:
                chosen_start = all_words[-1]["start"] if n_words > 0 else 0
                result.append((chosen_start, line))
                
    return result


# ==============================================================
# Whisper model (lazy-loaded on first /sync-ai call)
# ==============================================================
whisper_model = None


# ==============================================================
# Endpoints
# ==============================================================

@app.get("/")
def home():
    return {"status": "Backend de Karaoke activo y funcionando"}


@app.post("/upload")
async def process_audio(file: UploadFile = File(...)):
    file_path = f"/content/audios/{file.filename}"
    with open(file_path, "wb+") as f:
        f.write(file.file.read())

    # Demucs separation with MP3 output to reduce size from 41MB to 4-6MB
    command = ["demucs", "--two-stems", "vocals", "--mp3", file_path]
    subprocess.run(command, check=True)

    base_name = os.path.splitext(file.filename)[0]

    # Auto-search lyrics on LRCLIB
    query = clean_for_search(file.filename)
    lyrics_lrc = search_lyrics(query)

    return {
        "message": "Separacion exitosa",
        "vocal_url": f"/tracks/{base_name}/vocals.mp3",
        "instrumental_url": f"/tracks/{base_name}/no_vocals.mp3",
        "base_name": base_name,
        "lyrics_lrc": lyrics_lrc or "",
        "lyrics_found": lyrics_lrc is not None,
        "search_query": query
    }


class SyncRequest(BaseModel):
    song_name: str
    lyrics_text: str = ""


@app.post("/sync-ai")
async def sync_with_ai(req: SyncRequest):
    """
    Generate synced lyrics using Whisper.
    - lyrics_text empty  -> auto-transcribe vocals and return LRC
    - lyrics_text given  -> align user text to Whisper timestamps
    """
    global whisper_model
    import whisper

    if whisper_model is None:
        whisper_model = whisper.load_model("base")

    vocal_path = f"/content/separated/htdemucs/{req.song_name}/vocals.mp3"
    if not os.path.exists(vocal_path):
        vocal_path = f"/content/separated/htdemucs/{req.song_name}/vocals.wav"
        
    if not os.path.exists(vocal_path):
        raise HTTPException(status_code=404, detail=f"Vocal track not found: {req.song_name}")

    # Set word_timestamps=True to get exact word timings
    result = whisper_model.transcribe(vocal_path, word_timestamps=True)
    
    # Flatten word list
    all_words = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []):
            cleaned_word = re.sub(r'[^\w]', '', w["word"]).lower()
            if cleaned_word:
                all_words.append({
                    "word": cleaned_word,
                    "start": w["start"],
                    "end": w["end"]
                })

    if not req.lyrics_text.strip():
        # Fallback to segment-level transcription
        lrc_lines = []
        for seg in result.get("segments", []):
            tag = format_lrc_tag(seg["start"])
            lrc_lines.append(f"{tag}{seg['text'].strip()}")
        return {
            "lyrics_lrc": "\n".join(lrc_lines),
            "lyrics_found": len(lrc_lines) > 0
        }
    else:
        # Perform word-level forced alignment
        user_lines = [l.strip() for l in req.lyrics_text.strip().split("\n") if l.strip()]
        aligned = align_lyrics_with_words(user_lines, all_words)
        lrc_lines = [f"{format_lrc_tag(t)}{text}" for t, text in aligned]
        return {
            "lyrics_lrc": "\n".join(lrc_lines),
            "lyrics_found": len(lrc_lines) > 0
        }
