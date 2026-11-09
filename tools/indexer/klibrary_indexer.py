"""KLibrary Indexer: builds an AI search index of the library with the Gemini API.

For each book in the catalog it extracts the text (local PDF/EPUB/TXT/DOCX, or the Internet Archive OCR text for
online-only books), cuts it into passages that keep their page numbers, embeds every passage with a Gemini embedding
model and asks a Gemini text model for a short book card (summaries, themes, keywords). Results are written as one JSON
file per book, then merged into parse.json + parse_chunks.jsonl, which an AI search bar can query.

The API key is typed in the app and stored only in %APPDATA%/KLibraryIndexer/config.json on this computer.
Work is resumable: finished books are skipped, and a daily-quota error pauses the run until the next launch.
"""
import base64
import datetime as dt
import html
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zipfile

import numpy as np
import pymupdf
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

APP = "KLibrary Indexer"
VERSION = "1.0"
API = "https://generativelanguage.googleapis.com/v1beta"
UA = "KLibraryIndexer/1.0"
CONF_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "KLibraryIndexer")
CONF_FILE = os.path.join(CONF_DIR, "config.json")

DEFAULT_LIB = r"C:\Users\admin\Downloads\livres mystiques"
DEFAULTS = {
    "api_key": "",
    "library_dir": DEFAULT_LIB if os.path.isdir(DEFAULT_LIB) else "",
    "out_dir": os.path.join(DEFAULT_LIB, "_index_ia") if os.path.isdir(DEFAULT_LIB) else "",
    "scope": "public",            # public = public-domain + L'Arbre d'Or only; all = also personal files (local use only)
    "gen_model": "gemini-2.5-flash-lite",
    "embed_model": "gemini-embedding-001",
    "dims": 768,
    "chunk_chars": 1800,
    "overlap": 200,
    "make_cards": True,
    "online_books": True,
    "max_pages": 0,               # 0 = whole book
    "embed_rpm": 90, "embed_tpm": 28000, "embed_batch": 50,
    "gen_rpm": 12,
    "site_url": "https://klibrary.vercel.app",
}


# ----------------------------------------------------------------- config / helpers
def load_conf():
    c = dict(DEFAULTS)
    try:
        with open(CONF_FILE, encoding="utf-8") as fh:
            c.update(json.load(fh))
    except (OSError, ValueError):
        pass
    return c


def save_conf(c):
    os.makedirs(CONF_DIR, exist_ok=True)
    tmp = CONF_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(c, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, CONF_FILE)


def write_json(path, obj, compact=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, separators=(",", ":") if compact else None, indent=None if compact else 1)
    os.replace(tmp, path)


def q8(vec):
    """Normalise then quantise a vector to int8, base64-encoded (dims bytes)."""
    v = np.asarray(vec, dtype=np.float32)
    v /= (np.linalg.norm(v) or 1.0)
    return base64.b64encode(np.clip(np.round(v * 127), -127, 127).astype(np.int8).tobytes()).decode()


def unq8(s):
    return np.frombuffer(base64.b64decode(s), dtype=np.int8).astype(np.float32) / 127.0


class DailyQuota(Exception):
    pass


class Stopped(Exception):
    pass


# ----------------------------------------------------------------- Gemini client
class Gemini:
    def __init__(self, key, log, stop):
        self.key, self.log, self.stop = key, log, stop
        self.win = {}  # name -> list of (t, tokens)

    def _throttle(self, name, rpm, tpm=0, tokens=0):
        w = self.win.setdefault(name, [])
        while True:
            if self.stop.is_set():
                raise Stopped()
            now = time.time()
            w[:] = [x for x in w if now - x[0] < 60]
            if len(w) < rpm and (not tpm or sum(x[1] for x in w) + tokens <= tpm or not w):
                w.append((now, tokens))
                return
            time.sleep(0.5)

    def _call(self, method, path, body=None, timeout=180):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"{API}/{path}", data=data, method=method,
                                     headers={"x-goog-api-key": self.key, "Content-Type": "application/json", "User-Agent": UA})
        for attempt in range(6):
            if self.stop.is_set():
                raise Stopped()
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                txt = e.read().decode("utf-8", "replace")
                if e.code == 429:
                    if re.search(r"PerDay|per day|daily", txt, re.I):
                        raise DailyQuota(txt[:300])
                    m = re.search(r'"retryDelay":\s*"(\d+)', txt)
                    wait = int(m.group(1)) + 2 if m else 20 * (attempt + 1)
                    self.log(f"  limite par minute atteinte, pause {wait} s")
                    self._sleep(wait)
                    continue
                if e.code in (500, 502, 503, 504):
                    self._sleep(5 * (attempt + 1))
                    continue
                if e.code in (400, 401, 403):
                    raise RuntimeError(f"Erreur API {e.code} : {txt[:300]}")
                raise RuntimeError(f"HTTP {e.code} : {txt[:300]}")
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                self.log(f"  réseau : {e} (nouvel essai)")
                self._sleep(5 * (attempt + 1))
        raise RuntimeError("API injoignable après plusieurs essais")

    def _sleep(self, s):
        end = time.time() + s
        while time.time() < end:
            if self.stop.is_set():
                raise Stopped()
            time.sleep(0.5)

    def models(self):
        out, token = [], ""
        while True:
            r = self._call("GET", "models?pageSize=200" + (f"&pageToken={token}" if token else ""))
            out += r.get("models", [])
            token = r.get("nextPageToken")
            if not token:
                return out

    def embed(self, model, texts, task, dims, rpm, tpm, title=None):
        reqs = []
        for t in texts:
            r = {"model": f"models/{model}", "content": {"parts": [{"text": t}]}, "taskType": task,
                 "outputDimensionality": int(dims)}
            if title and task == "RETRIEVAL_DOCUMENT":
                r["title"] = title[:200]
            reqs.append(r)
        self._throttle("embed", rpm, tpm, sum(len(t) for t in texts) // 4 + 1)
        res = self._call("POST", f"models/{model}:batchEmbedContents", {"requests": reqs})
        return [e["values"] for e in res["embeddings"]]

    def generate(self, model, prompt, rpm, as_json=False, temperature=0.2):
        self._throttle("gen", rpm)
        cfg = {"temperature": temperature}
        if as_json:
            cfg["responseMimeType"] = "application/json"
        res = self._call("POST", f"models/{model}:generateContent",
                         {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": cfg})
        try:
            return "".join(p.get("text", "") for p in res["candidates"][0]["content"]["parts"])
        except (KeyError, IndexError):
            raise RuntimeError("réponse vide du modèle : " + json.dumps(res)[:300])


# ----------------------------------------------------------------- text extraction
def clean(t):
    t = t.replace("\r", "\n").replace("\u00ad", "")
    t = re.sub(r"(\w)-\n(\w)", r"\1\2", t)           # re-join hyphenated words
    t = re.sub(r"[ \t\f\v]+", " ", t)
    t = re.sub(r"\n\s*\n+", "\n\n", t)
    return t.strip()


def pdf_pages(path, max_pages=0):
    pages = []
    with pymupdf.open(path) as doc:
        n = doc.page_count if not max_pages else min(doc.page_count, max_pages)
        for i in range(n):
            pages.append((i + 1, clean(doc.load_page(i).get_text("text"))))
    return pages


def strip_tags(s):
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s)
    s = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</h\d>", "\n", s)
    return html.unescape(re.sub(r"<[^>]+>", " ", s))


def epub_pages(path):
    out = []
    with zipfile.ZipFile(path) as z:
        names = sorted(n for n in z.namelist() if n.lower().endswith((".xhtml", ".html", ".htm")))
        for i, n in enumerate(names, 1):
            out.append((i, clean(strip_tags(z.read(n).decode("utf-8", "replace")))))
    return out


def docx_pages(path):
    with zipfile.ZipFile(path) as z:
        x = z.read("word/document.xml").decode("utf-8", "replace")
    x = re.sub(r"</w:p>", "\n", x)
    return [(1, clean(html.unescape(re.sub(r"<[^>]+>", "", x))))]


def txt_pages(path):
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            with open(path, encoding=enc) as fh:
                t = fh.read()
            break
        except UnicodeDecodeError:
            continue
    parts = t.split("\f") if "\f" in t else [t]
    return [(i + 1, clean(p)) for i, p in enumerate(parts)]


def ia_text(ident, stop):
    """Internet Archive OCR text. Page breaks (form feeds) are kept when present."""
    meta = json.loads(http_get(f"https://archive.org/metadata/{urllib.parse.quote(ident)}"))
    files = [f["name"] for f in meta.get("files", []) if f["name"].endswith("_djvu.txt")]
    if not files:
        return []
    if stop.is_set():
        raise Stopped()
    raw = http_get(f"https://archive.org/download/{urllib.parse.quote(ident)}/{urllib.parse.quote(files[0])}", 300)
    t = raw.decode("utf-8", "replace")
    parts = t.split("\f") if t.count("\f") > 3 else [t]
    return [(i + 1 if len(parts) > 1 else None, clean(p)) for i, p in enumerate(parts)]


def http_get(url, timeout=120):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
                return r.read()
        except Exception:
            if i == 3:
                raise
            time.sleep(4 * (i + 1))


def chunk(pages, size, overlap):
    """Cut (page, text) pairs into ~size-character passages; each passage keeps its first and last page."""
    out, buf, p0, p1 = [], "", None, None
    for pno, text in pages:
        for para in text.split("\n\n"):
            para = para.strip()
            if not para:
                continue
            while len(para) > size * 1.5:          # very long paragraph: hard split on a sentence end
                cut = para.rfind(". ", 0, size)
                cut = cut + 1 if cut > size // 2 else size
                piece, para = para[:cut], para[cut:].strip()
                if buf:
                    out.append((p0, p1, buf))
                    buf = buf[-overlap:]
                out.append((pno, pno, (buf + " " + piece).strip()))
                buf, p0 = piece[-overlap:], pno
            if p0 is None:
                p0 = pno
            buf = (buf + "\n" + para).strip()
            p1 = pno
            if len(buf) >= size:
                out.append((p0, p1, buf))
                buf, p0 = buf[-overlap:], pno
    if buf.strip() and (not out or buf.strip() != out[-1][2][-len(buf.strip()):]):
        out.append((p0, p1, buf))
    return [(a, b, t) for a, b, t in out if len(t) > 80]


# ----------------------------------------------------------------- indexing job
CARD_PROMPT = """Tu catalogues une bibliothèque de livres anciens d'ésotérisme, de magie et de mystique.
Livre : « {title} » — {author} ({year}). Rubrique : {category}.
Voici des extraits du texte (OCR possible, avec des fautes) :
<<<
{excerpt}
>>>
Réponds en JSON strict avec ces clés :
"resume_fr" (3 à 5 phrases en français), "resume_en" (the same in English), "resume_ht" (menm bagay an kreyòl ayisyen),
"themes" (5 à 10 thèmes courts en français), "mots_cles" (10 à 25 termes techniques, noms, entités, rituels, symboles cités),
"pratiques" (pratiques ou procédés décrits, liste vide si aucun), "epoque" (siècle ou période du texte),
"niveau" ("introduction", "intermédiaire" ou "avancé").
N'invente rien qui ne soit pas appuyé par les extraits."""


def load_confidential(lib):
    pats = []
    f = os.path.join(lib, "website", "tools", "confidential.local.txt")
    try:
        with open(f, encoding="utf-8") as fh:
            pats = [l.strip() for l in fh if l.strip() and not l.startswith("#")]
    except OSError:
        pass
    return [re.compile(p) for p in pats]


def catalog_books(conf):
    lib = conf["library_dir"]
    path = os.path.join(lib, "website", "data", "catalog.private.json")
    if not os.path.exists(path):
        path = os.path.join(lib, "website", "data", "catalog.json")
    books = json.load(open(path, encoding="utf-8"))["books"]
    conf_pats = load_confidential(lib)
    out = []
    for b in books:
        ref = (b.get("file") or b.get("path") or b.get("title") or "").lower()
        if any(p.search(ref) for p in conf_pats):
            continue
        if conf["scope"] == "public" and b.get("source") not in ("pd", "ab"):
            continue
        if b.get("online") and not conf["online_books"]:
            continue
        out.append(b)
    return out


def book_text(b, conf, stop):
    f = b.get("file") or b.get("path")
    pages = []
    if f:
        full = os.path.join(conf["library_dir"], f.replace("/", os.sep))
        ext = os.path.splitext(full)[1].lower()
        if os.path.exists(full):
            if ext == ".pdf":
                pages = pdf_pages(full, int(conf["max_pages"] or 0))
            elif ext == ".epub":
                pages = epub_pages(full)
            elif ext == ".docx":
                pages = docx_pages(full)
            elif ext == ".txt":
                pages = txt_pages(full)
    chars = sum(len(t) for _, t in pages)
    # scanned PDF without a text layer: fall back on the Internet Archive OCR when the book comes from there
    if b.get("ia") and (not pages or chars < 300 * max(1, len(pages)) * 0.2):
        try:
            ia = ia_text(b["ia"], stop)
            if sum(len(t) for _, t in ia) > chars:
                pages = ia
        except Stopped:
            raise
        except Exception:
            pass
    return [(p, t) for p, t in pages if t]


class Indexer:
    def __init__(self, conf, log, progress, stop):
        self.c, self.log, self.progress, self.stop = conf, log, progress, stop
        self.out = conf["out_dir"]
        self.state_file = os.path.join(self.out, "state.json")
        self.gem = Gemini(conf["api_key"], log, stop)

    def state(self):
        try:
            return json.load(open(self.state_file, encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def run(self):
        c = self.c
        books = catalog_books(c)
        st = self.state()
        todo = [b for b in books if st.get(b["id"], {}).get("status") not in ("ok", "no_text")]
        self.log(f"{len(books)} livres dans le périmètre « {c['scope']} », {len(books) - len(todo)} déjà faits, {len(todo)} à traiter.")
        done = len(books) - len(todo)
        for b in todo:
            if self.stop.is_set():
                break
            label = f"{b.get('title', '')[:70]} — {b.get('author', '')}"
            self.progress(done, len(books), label)
            try:
                info = self.index_book(b)
                st[b["id"]] = dict(info, at=dt.datetime.now().isoformat(timespec="seconds"))
                done += 1
            except DailyQuota as e:
                self.log("Quota journalier gratuit atteint. Relance l'application demain : elle reprendra ici.\n  " + str(e)[:200])
                break
            except Stopped:
                self.log("Arrêt demandé.")
                break
            except Exception as e:
                self.log(f"  ERREUR {label} : {e}")
                st[b["id"]] = {"status": "error", "error": str(e)[:300], "at": dt.datetime.now().isoformat(timespec="seconds")}
            write_json(self.state_file, st, compact=False)
        self.progress(done, len(books), "terminé" if done == len(books) else "en pause")
        self.log(f"Fini pour cette session : {done}/{len(books)} livres indexés.")

    def index_book(self, b):
        c = self.c
        self.log(f"▶ {b.get('title', '')[:80]} ({b.get('author', '')})")
        pages = book_text(b, c, self.stop)
        chars = sum(len(t) for _, t in pages)
        if chars < 500:
            self.log("  pas de texte exploitable (scan sans OCR) : ignoré")
            return {"status": "no_text"}
        chunks = chunk(pages, int(c["chunk_chars"]), int(c["overlap"]))
        self.log(f"  {len(pages)} pages, {chars:,} caractères, {len(chunks)} passages".replace(",", " "))

        # resume a half-done book from its partial file
        path = os.path.join(self.out, "books", f"{b['id']}.json")
        partial = {}
        if os.path.exists(path + ".partial"):
            try:
                partial = json.load(open(path + ".partial", encoding="utf-8"))
            except ValueError:
                partial = {}
        vecs = partial.get("vecs", []) if partial.get("n") == len(chunks) else []

        bs = max(1, int(c["embed_batch"]))
        title = f"{b.get('title', '')} — {b.get('author', '')}"
        for i in range(len(vecs), len(chunks), bs):
            batch = [t for _, _, t in chunks[i:i + bs]]
            vecs += [q8(v) for v in self.gem.embed(c["embed_model"], batch, "RETRIEVAL_DOCUMENT", c["dims"],
                                                   int(c["embed_rpm"]), int(c["embed_tpm"]), title)]
            write_json(path + ".partial", {"n": len(chunks), "vecs": vecs})
            self.log(f"  embeddings {len(vecs)}/{len(chunks)}")

        card = partial.get("card")
        if c["make_cards"] and not card:
            full = "\n".join(t for _, t in pages)
            mid = len(full) // 2
            excerpt = (full[:9000] + "\n[…]\n" + full[mid:mid + 5000] + "\n[…]\n" + full[-3000:]) if len(full) > 18000 else full
            prompt = CARD_PROMPT.format(title=b.get("title", ""), author=b.get("author", "?"), year=b.get("year", "?"),
                                        category=b.get("category", ""), excerpt=excerpt)
            try:
                card = json.loads(self.gem.generate(c["gen_model"], prompt, int(c["gen_rpm"]), as_json=True))
            except (ValueError, RuntimeError) as e:
                self.log(f"  fiche non générée : {str(e)[:120]}")
                card = None
            write_json(path + ".partial", {"n": len(chunks), "vecs": vecs, "card": card})

        mat = np.stack([unq8(v) for v in vecs])
        bv = mat.mean(axis=0)
        doc = {
            "id": b["id"], "title": b.get("title"), "author": b.get("author"), "year": b.get("year"),
            "category": b.get("category"), "source": b.get("source"), "ia": b.get("ia"), "ab": b.get("ab"),
            "lang": b.get("lang", "fr"), "embed_model": c["embed_model"], "dims": int(c["dims"]),
            "card": card, "v": q8(bv),
            "chunks": [{"i": i, "p": [p0, p1] if p0 else None, "t": t, "v": vecs[i]} for i, (p0, p1, t) in enumerate(chunks)],
        }
        write_json(path, doc)
        try:
            os.remove(path + ".partial")
        except OSError:
            pass
        return {"status": "ok", "chunks": len(chunks), "chars": chars}


def merge(out_dir, log):
    """books/*.json -> parse.json (book cards + book vectors) and parse_chunks.jsonl (one passage per line)."""
    bdir = os.path.join(out_dir, "books")
    files = sorted(f for f in os.listdir(bdir) if f.endswith(".json")) if os.path.isdir(bdir) else []
    books, n = [], 0
    tmp = os.path.join(out_dir, "parse_chunks.jsonl.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        for f in files:
            d = json.load(open(os.path.join(bdir, f), encoding="utf-8"))
            chunks = d.pop("chunks")
            d["n_chunks"] = len(chunks)
            books.append(d)
            for ch in chunks:
                fh.write(json.dumps({"b": d["id"], **ch}, ensure_ascii=False, separators=(",", ":")) + "\n")
                n += 1
    os.replace(tmp, os.path.join(out_dir, "parse_chunks.jsonl"))
    meta = {"app": APP, "version": VERSION, "created": dt.datetime.now().isoformat(timespec="seconds"),
            "embed_model": books[0]["embed_model"] if books else None, "dims": books[0]["dims"] if books else None,
            "vector_format": "int8 base64, normalised, value/127", "books": books}
    write_json(os.path.join(out_dir, "parse.json"), meta)
    mb = lambda p: os.path.getsize(os.path.join(out_dir, p)) / 2 ** 20
    log(f"Fusion : {len(books)} livres, {n} passages → parse.json ({mb('parse.json'):.1f} Mo), "
        f"parse_chunks.jsonl ({mb('parse_chunks.jsonl'):.1f} Mo)")


# ----------------------------------------------------------------- search (test tab)
ANSWER_PROMPT = """Tu es le bibliothécaire de KLibrary, une bibliothèque de livres anciens de magie, d'ésotérisme et de mystique.
Réponds à la question en t'appuyant UNIQUEMENT sur les extraits numérotés ci-dessous.
- Réponds dans la langue de la question (français, anglais ou créole haïtien).
- Cite tes sources dans le texte avec leur numéro entre crochets, par exemple [2] ou [1][4].
- Si les extraits ne permettent pas de répondre, dis-le franchement et indique les livres les plus proches.
- Présente les pratiques comme ce que disent les auteurs anciens, sans les garantir.

Question : {q}

Extraits :
{ctx}"""


class Searcher:
    def __init__(self, conf, log):
        self.c, self.log = conf, log
        self.books, self.meta, self.mat = {}, [], None

    def load(self):
        bdir = os.path.join(self.c["out_dir"], "books")
        vec, meta = [], []
        for f in sorted(os.listdir(bdir)) if os.path.isdir(bdir) else []:
            if not f.endswith(".json"):
                continue
            d = json.load(open(os.path.join(bdir, f), encoding="utf-8"))
            self.books[d["id"]] = {k: d.get(k) for k in ("id", "title", "author", "year", "ia", "ab", "category")}
            for ch in d["chunks"]:
                vec.append(np.frombuffer(base64.b64decode(ch["v"]), dtype=np.int8))
                meta.append((d["id"], ch["p"], ch["t"]))
        if not vec:
            raise RuntimeError("Index vide : lance d'abord l'indexation.")
        self.mat = np.stack(vec).astype(np.float32) / 127.0
        self.meta = meta
        self.log(f"Index chargé : {len(self.books)} livres, {len(meta)} passages.")

    def ask(self, question, k=12, per_book=3):
        g = Gemini(self.c["api_key"], self.log, threading.Event())
        qv = np.asarray(g.embed(self.c["embed_model"], [question], "RETRIEVAL_QUERY", self.c["dims"], 60, 0)[0], np.float32)
        qv /= (np.linalg.norm(qv) or 1.0)
        scores = self.mat @ qv
        picked, count = [], {}
        for idx in np.argsort(-scores)[:400]:
            bid = self.meta[idx][0]
            if count.get(bid, 0) >= per_book:
                continue
            count[bid] = count.get(bid, 0) + 1
            picked.append(int(idx))
            if len(picked) >= k:
                break
        refs, ctx = [], []
        for n, idx in enumerate(picked, 1):
            bid, pages, text = self.meta[idx]
            b = self.books[bid]
            page = f", p. {pages[0]}" + (f"-{pages[1]}" if pages and pages[1] != pages[0] else "") if pages else ""
            ctx.append(f"[{n}] {b['title']} — {b['author']}{page}\n{text}")
            refs.append({"n": n, "book": b, "pages": pages, "score": float(scores[idx])})
        answer = g.generate(self.c["gen_model"], ANSWER_PROMPT.format(q=question, ctx="\n\n".join(ctx)), 30, temperature=0.3)
        return answer, refs


# ----------------------------------------------------------------- GUI
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f"{APP} {VERSION}")
        self.geometry("980x700")
        self.minsize(820, 560)
        self.conf = load_conf()
        self.q = queue.Queue()
        self.stop = threading.Event()
        self.worker = None
        self.searcher = None
        self.vars = {}
        style = ttk.Style(self)
        if "vista" in style.theme_names():
            style.theme_use("vista")
        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=8, pady=8)
        nb.add(self.tab_settings(nb), text="  Réglages  ")
        nb.add(self.tab_index(nb), text="  Indexation  ")
        nb.add(self.tab_search(nb), text="  Tester la recherche  ")
        nb.add(self.tab_help(nb), text="  Aide  ")
        self.after(150, self.pump)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # --- settings
    def field(self, parent, row, label, key, kind="entry", width=60, browse=None, show=None, values=None):
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w", padx=6, pady=4)
        if kind == "check":
            v = tk.BooleanVar(value=bool(self.conf[key]))
            ttk.Checkbutton(parent, variable=v).grid(row=row, column=1, sticky="w", padx=6)
        elif kind == "combo":
            v = tk.StringVar(value=str(self.conf[key]))
            w = ttk.Combobox(parent, textvariable=v, width=width, values=values or [])
            w.grid(row=row, column=1, sticky="we", padx=6)
            setattr(self, f"combo_{key}", w)
        else:
            v = tk.StringVar(value=str(self.conf[key]))
            ttk.Entry(parent, textvariable=v, width=width, show=show).grid(row=row, column=1, sticky="we", padx=6)
        if browse:
            ttk.Button(parent, text="Parcourir…", command=lambda: self.pick_dir(v)).grid(row=row, column=2, padx=4)
        self.vars[key] = v

    def pick_dir(self, var):
        d = filedialog.askdirectory(initialdir=var.get() or os.path.expanduser("~"))
        if d:
            var.set(os.path.normpath(d))

    def tab_settings(self, nb):
        f = ttk.Frame(nb, padding=10)
        f.columnconfigure(1, weight=1)
        r = 0
        self.field(f, r, "Clé API Gemini", "api_key", show="•"); r += 1
        ttk.Label(f, text="Gratuite sur aistudio.google.com/apikey. Elle reste sur ce PC (dossier %APPDATA%\\KLibraryIndexer).",
                  foreground="#666").grid(row=r, column=1, sticky="w", padx=6); r += 1
        self.field(f, r, "Dossier de la bibliothèque", "library_dir", browse=True); r += 1
        self.field(f, r, "Dossier de sortie (index)", "out_dir", browse=True); r += 1
        self.field(f, r, "Périmètre", "scope", kind="combo", width=20, values=["public", "all"]); r += 1
        ttk.Label(f, text="public = domaine public + Arbre d'Or (publiable).  all = ajoute tes fichiers personnels (usage local uniquement).",
                  foreground="#666").grid(row=r, column=1, sticky="w", padx=6); r += 1
        self.field(f, r, "Modèle de texte", "gen_model", kind="combo", width=40); r += 1
        self.field(f, r, "Modèle d'embeddings", "embed_model", kind="combo", width=40); r += 1
        ttk.Button(f, text="Vérifier la clé et charger les modèles", command=self.load_models).grid(row=r, column=1, sticky="w", padx=6, pady=4); r += 1
        self.field(f, r, "Dimensions des vecteurs", "dims", width=10); r += 1
        self.field(f, r, "Taille des passages (caractères)", "chunk_chars", width=10); r += 1
        self.field(f, r, "Chevauchement (caractères)", "overlap", width=10); r += 1
        self.field(f, r, "Générer une fiche par livre", "make_cards", kind="check"); r += 1
        self.field(f, r, "Inclure les livres en ligne (texte IA)", "online_books", kind="check"); r += 1
        self.field(f, r, "Pages max par livre (0 = tout)", "max_pages", width=10); r += 1
        lim = ttk.LabelFrame(f, text="Limites de l'offre gratuite (à ajuster si Google les change)", padding=6)
        lim.grid(row=r, column=0, columnspan=3, sticky="we", pady=8); r += 1
        lim.columnconfigure(1, weight=1)
        self.field(lim, 0, "Embeddings : requêtes / minute", "embed_rpm", width=10)
        self.field(lim, 1, "Embeddings : jetons / minute", "embed_tpm", width=10)
        self.field(lim, 2, "Passages par requête", "embed_batch", width=10)
        self.field(lim, 3, "Texte : requêtes / minute", "gen_rpm", width=10)
        self.field(f, r, "Adresse du site (liens)", "site_url"); r += 1
        ttk.Button(f, text="Enregistrer", command=self.save).grid(row=r, column=1, sticky="w", padx=6, pady=10)
        return f

    def read_vars(self):
        c = dict(self.conf)
        for k, v in self.vars.items():
            val = v.get()
            if isinstance(DEFAULTS.get(k), bool):
                c[k] = bool(val)
            elif isinstance(DEFAULTS.get(k), int):
                try:
                    c[k] = int(str(val).strip())
                except ValueError:
                    c[k] = DEFAULTS[k]
            else:
                c[k] = str(val).strip()
        return c

    def save(self, quiet=False):
        self.conf = self.read_vars()
        save_conf(self.conf)
        if not quiet:
            self.log("Réglages enregistrés.")
        return self.conf

    def load_models(self):
        c = self.save(quiet=True)
        if not c["api_key"]:
            messagebox.showwarning(APP, "Saisis d'abord ta clé API.")
            return

        def job():
            try:
                ms = Gemini(c["api_key"], self.log, threading.Event()).models()
                gen = sorted(m["name"].split("/", 1)[1] for m in ms if "generateContent" in m.get("supportedGenerationMethods", []))
                emb = sorted(m["name"].split("/", 1)[1] for m in ms if "embedContent" in m.get("supportedGenerationMethods", [])
                             or "batchEmbedContents" in m.get("supportedGenerationMethods", []))
                self.q.put(("models", gen, emb))
            except Exception as e:
                self.q.put(("log", f"Clé ou réseau en erreur : {e}"))
        threading.Thread(target=job, daemon=True).start()

    # --- indexing
    def tab_index(self, nb):
        f = ttk.Frame(nb, padding=10)
        bar = ttk.Frame(f)
        bar.pack(fill="x")
        self.btn_start = ttk.Button(bar, text="▶  Démarrer / reprendre", command=self.start)
        self.btn_start.pack(side="left")
        self.btn_stop = ttk.Button(bar, text="■  Arrêter", command=self.request_stop, state="disabled")
        self.btn_stop.pack(side="left", padx=6)
        ttk.Button(bar, text="Fusionner → parse.json", command=self.do_merge).pack(side="left", padx=6)
        ttk.Button(bar, text="Ouvrir le dossier de sortie", command=self.open_out).pack(side="left", padx=6)
        ttk.Button(bar, text="Réessayer les erreurs", command=self.reset_errors).pack(side="left", padx=6)
        self.pbar = ttk.Progressbar(f, mode="determinate")
        self.pbar.pack(fill="x", pady=(10, 2))
        self.plabel = ttk.Label(f, text="Prêt.")
        self.plabel.pack(anchor="w")
        self.logbox = tk.Text(f, height=20, wrap="word", font=("Consolas", 9))
        self.logbox.pack(fill="both", expand=True, pady=6)
        return f

    def start(self):
        c = self.save(quiet=True)
        if not c["api_key"]:
            messagebox.showwarning(APP, "Saisis ta clé API dans l'onglet Réglages.")
            return
        if not os.path.isdir(c["library_dir"]):
            messagebox.showwarning(APP, "Dossier de la bibliothèque introuvable.")
            return
        os.makedirs(c["out_dir"], exist_ok=True)
        self.stop.clear()
        self.btn_start.config(state="disabled")
        self.btn_stop.config(state="normal")

        def job():
            try:
                Indexer(c, self.log, lambda d, t, l: self.q.put(("prog", d, t, l)), self.stop).run()
            except Exception as e:
                self.log(f"Erreur : {e}")
            finally:
                self.q.put(("done",))
        self.worker = threading.Thread(target=job, daemon=True)
        self.worker.start()

    def request_stop(self):
        self.stop.set()
        self.log("Arrêt en cours (fin de la requête en cours)…")

    def do_merge(self):
        c = self.save(quiet=True)
        threading.Thread(target=lambda: self._safe(merge, c["out_dir"], self.log), daemon=True).start()

    def reset_errors(self):
        p = os.path.join(self.read_vars()["out_dir"], "state.json")
        try:
            st = json.load(open(p, encoding="utf-8"))
        except (OSError, ValueError):
            return
        n = 0
        for k in list(st):
            if st[k].get("status") == "error":
                del st[k]
                n += 1
        write_json(p, st, compact=False)
        self.log(f"{n} livres en erreur remis dans la file.")

    def open_out(self):
        d = self.read_vars()["out_dir"]
        if os.path.isdir(d):
            os.startfile(d)

    def _safe(self, fn, *a):
        try:
            fn(*a)
        except Exception as e:
            self.log(f"Erreur : {e}")

    # --- search
    def tab_search(self, nb):
        f = ttk.Frame(nb, padding=10)
        top = ttk.Frame(f)
        top.pack(fill="x")
        self.qvar = tk.StringVar()
        e = ttk.Entry(top, textvariable=self.qvar, font=("Segoe UI", 11))
        e.pack(side="left", fill="x", expand=True)
        e.bind("<Return>", lambda _e: self.ask())
        ttk.Button(top, text="Demander", command=self.ask).pack(side="left", padx=6)
        ttk.Button(top, text="Recharger l'index", command=lambda: setattr(self, "searcher", None)).pack(side="left")
        self.answer = tk.Text(f, wrap="word", font=("Segoe UI", 10))
        self.answer.pack(fill="both", expand=True, pady=8)
        self.answer.tag_config("h", font=("Segoe UI", 10, "bold"))
        self.answer.tag_config("link", foreground="#2a5db0", underline=True)
        return f

    def ask(self):
        qtext = self.qvar.get().strip()
        if not qtext:
            return
        c = self.save(quiet=True)
        self.answer.delete("1.0", "end")
        self.answer.insert("end", "Recherche…\n")

        def job():
            try:
                if self.searcher is None:
                    s = Searcher(c, self.log)
                    s.load()
                    self.searcher = s
                ans, refs = self.searcher.ask(qtext)
                self.q.put(("answer", ans, refs, c))
            except Exception as e:
                self.q.put(("answer", f"Erreur : {e}", [], c))
        threading.Thread(target=job, daemon=True).start()

    def show_answer(self, ans, refs, c):
        a = self.answer
        a.delete("1.0", "end")
        a.insert("end", ans.strip() + "\n\n")
        if refs:
            a.insert("end", "Références\n", "h")
        for r in refs:
            b, pages = r["book"], r["pages"]
            page = f", p. {pages[0]}" if pages else ""
            a.insert("end", f"[{r['n']}] {b['title']} — {b['author']}{page}  ")
            url = (f"https://archive.org/details/{b['ia']}" + (f"/page/n{max(0, pages[0] - 1)}" if pages else "")) if b.get("ia") \
                else (b.get("ab") or f"{c['site_url'].rstrip('/')}/#/book/{b['id']}")
            tag = f"l{r['n']}"
            a.insert("end", "ouvrir", ("link", tag))
            a.tag_bind(tag, "<Button-1>", lambda _e, u=url: webbrowser.open(u))
            a.insert("end", "\n")

    def tab_help(self, nb):
        f = ttk.Frame(nb, padding=12)
        t = tk.Text(f, wrap="word", font=("Segoe UI", 10))
        t.pack(fill="both", expand=True)
        t.insert("end", HELP)
        t.config(state="disabled")
        return f

    # --- plumbing
    def log(self, msg):
        self.q.put(("log", msg))

    def pump(self):
        try:
            while True:
                m = self.q.get_nowait()
                if m[0] == "log":
                    self.logbox.insert("end", f"{time.strftime('%H:%M:%S')}  {m[1]}\n")
                    self.logbox.see("end")
                elif m[0] == "prog":
                    _, d, total, label = m
                    self.pbar.config(maximum=max(1, total), value=d)
                    self.plabel.config(text=f"{d}/{total} livres · {label}")
                elif m[0] == "done":
                    self.btn_start.config(state="normal")
                    self.btn_stop.config(state="disabled")
                elif m[0] == "models":
                    _, gen, emb = m
                    self.combo_gen_model.config(values=gen)
                    self.combo_embed_model.config(values=emb)
                    self.log(f"Clé valide. {len(gen)} modèles de texte, {len(emb)} modèles d'embeddings disponibles.")
                elif m[0] == "answer":
                    self.show_answer(*m[1:])
        except queue.Empty:
            pass
        self.after(150, self.pump)

    def on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(APP, "L'indexation tourne encore. Arrêter et quitter ? (la progression est sauvegardée)"):
                return
            self.stop.set()
        self.destroy()


HELP = """KLibrary Indexer — mode d'emploi

1. Réglages : colle ta clé API Gemini (gratuite sur aistudio.google.com/apikey), puis clique « Vérifier la clé et charger les modèles ». Garde les modèles proposés par défaut s'ils apparaissent dans la liste ; sinon choisis le modèle « flash-lite » le plus récent pour le texte et un modèle « embedding » pour les vecteurs.

2. Indexation : clique « Démarrer ». Pour chaque livre, l'application :
   • lit le texte du PDF (ou le texte OCR d'Internet Archive pour les livres en ligne et les scans sans texte) ;
   • le découpe en passages qui gardent leurs numéros de page ;
   • calcule un vecteur par passage (embeddings Gemini) ;
   • demande une fiche du livre : résumés FR / EN / créole, thèmes, mots-clés, pratiques, époque.
   Chaque livre terminé est écrit dans <sortie>\\books\\<id>.json. Tu peux arrêter quand tu veux : au prochain démarrage, l'application reprend là où elle s'était arrêtée, même au milieu d'un livre.

3. Quotas gratuits : l'application respecte les limites par minute. Quand le quota du jour est épuisé, elle s'arrête proprement ; relance-la le lendemain. Indexer toute la bibliothèque prend donc plusieurs jours avec l'offre gratuite.

4. Fusionner → parse.json : regroupe tout en deux fichiers :
   • parse.json : un enregistrement par livre (fiche, vecteur du livre) — léger ;
   • parse_chunks.jsonl : un passage par ligne (texte, pages, vecteur) — volumineux.
   Les vecteurs sont normalisés et stockés en int8 (base64) : valeur / 127.

5. Tester la recherche : pose une question en français, anglais ou créole. L'application retrouve les passages les plus proches, puis Gemini rédige une réponse qui cite ses sources [1], [2]… avec un lien vers le livre (et la page sur Internet Archive).

Confidentialité : en périmètre « public », seuls les livres du domaine public et de L'Arbre d'Or sont indexés. Les fichiers listés dans confidential.local.txt sont toujours exclus. Le périmètre « all » ajoute tes fichiers personnels : n'en publie jamais l'index.
"""


if __name__ == "__main__":
    App().mainloop()
