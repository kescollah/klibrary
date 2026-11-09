"""Build the library catalog consumed by the website.

Usage (from anywhere):
    python website/tools/build_catalog.py

Writes:
    website/data/catalog.json          public catalog (public-domain books only, safe to deploy)
    website/data/catalog.private.json  full catalog incl. personal files (local use only, never deployed)
"""
import hashlib
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
LIBRARY = os.path.dirname(SITE)
DATA = os.path.join(SITE, "data")

SKIP_TOP = {"website", "LIVRES", "copilot", ".git", ".vercel"}

# Confidential material: never listed, not even in the private local catalog.
# Patterns (one regex per line, matched against the lowercased relative path) live in
# tools/confidential.local.txt, which is git-ignored so the names never reach the repository.
CONFIDENTIAL_FILE = os.path.join(HERE, "confidential.local.txt")


def load_confidential():
    try:
        with open(CONFIDENTIAL_FILE, encoding="utf-8") as fh:
            return [l.strip() for l in fh if l.strip() and not l.startswith("#")]
    except OSError:
        return []


CONFIDENTIAL = load_confidential()


def is_confidential(rel):
    low = rel.lower()
    return any(re.search(p, low) for p in CONFIDENTIAL)
BOOK_EXT = {".pdf", ".epub", ".djvu", ".doc", ".docx", ".txt", ".zip"}

NOISE = [r"\(\s*pdfdrive\s*\)", r"\bpdfdrive\b", r"\bz[ -]?lib(rary)?(\.org)?\b", r"\bz lib org\b",
         r"pdfcoffee\.?com_?", r"\bcompress(ed)?\b", r"\bpdf\b", r"\bfree\b", r"\bfrench edition\b", r"\bpdfconverted\b",
         r"\blien de telechargement\b", r"\blivres a lire\b", r"_\d{6}$"]


def clean_title(name):
    t = os.path.splitext(name)[0]
    t = t.replace("_", " ").strip(" _-")
    for n in NOISE:
        t = re.sub(n, " ", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -.,")
    return t or os.path.splitext(name)[0]


def year_of(s):
    m = re.search(r"\((1[4-9]\d\d)\)", s) or re.search(r"\b(1[4-9]\d\d|20[0-2]\d)\b", s)
    return int(m.group(1)) if m else None


def bid(path):
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:10]


def main():
    ia = {e["path"]: e for e in json.load(open(os.path.join(HERE, "ia_sources.json"), encoding="utf-8"))}
    ab_file = os.path.join(HERE, "arbre_sources.json")
    ab = {e["path"]: e for e in json.load(open(ab_file, encoding="utf-8"))} if os.path.exists(ab_file) else {}
    books = []
    for top in sorted(os.listdir(LIBRARY)):
        full_top = os.path.join(LIBRARY, top)
        if top in SKIP_TOP or top.startswith((".", "_")) or not os.path.isdir(full_top):
            continue
        for dp, dn, fn in os.walk(full_top):
            dn.sort()
            for f in sorted(fn):
                ext = os.path.splitext(f)[1].lower()
                if ext not in BOOK_EXT:
                    continue
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, LIBRARY).replace("\\", "/")
                if is_confidential(rel):
                    continue
                parts = rel.split("/")
                sub = parts[1:-1]
                e = ia.get(rel)
                a = ab.get(rel)
                b = {
                    "id": bid(rel),
                    "category": top,
                    "size": os.path.getsize(full),
                    "ext": ext[1:],
                    "file": rel,  # local path, kept out of the public catalog
                }
                if a and not e:
                    b.update(title=a["title"], author=a["author"], year=a.get("year"), source="ab", ab=a["url"], abpdf=a["pdf"])
                elif e:
                    b.update(title=re.sub(r"\s*\(\d{4}\)\s*$", "", e["title"]), author=e["author"],
                             year=year_of(e["title"]), source="pd", ia=e["ia"], lang=e.get("lang"))
                else:
                    b.update(title=clean_title(f), author=sub[0] if sub else "",
                             collection="/".join(sub[1:]) if len(sub) > 1 else "",
                             year=year_of(f), source="own", path=rel)
                books.append({k: v for k, v in b.items() if v not in ("", None)})

    # Online-only public-domain books (read through the Internet Archive, no local copy).
    have = {b.get("ia") for b in books}
    extra_file = os.path.join(HERE, "ia_extra.json")
    extra = json.load(open(extra_file, encoding="utf-8")) if os.path.exists(extra_file) else []
    for e in extra:
        if e["ia"] in have or is_confidential(e["title"]):
            continue
        have.add(e["ia"])
        b = {"id": bid("ia:" + e["ia"]), "category": e["category"], "title": e["title"], "author": e["author"],
             "year": e.get("year"), "source": "pd", "ia": e["ia"], "pages": e.get("pages"), "lang": e.get("lang"), "online": True}
        books.append({k: v for k, v in b.items() if v not in ("", None)})

    os.makedirs(DATA, exist_ok=True)
    public = [{k: v for k, v in b.items() if k != "file"} for b in books if b["source"] in ("pd", "ab")]
    for name, items in (("catalog.json", public), ("catalog.private.json", books)):
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as fh:
            json.dump({"books": items}, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"public: {len(public)} books | private (local): {len(books)} books")


if __name__ == "__main__":
    main()
