# KLibrary

Created by **Kescollah**.

A static website for browsing a library of French esoteric, magical and mystical books. It has no build step and no dependencies: plain HTML, CSS and JavaScript plus a JSON catalog.

- **Public site:** lists only the public-domain books. Reading and downloading go straight to the Internet Archive, so the site hosts no PDFs.
- **Private local mode:** lists the whole library, including personal files, on your own computer only.

## Deploy to Vercel

1. Import this repository in Vercel (**Add New → Project**).
2. Framework preset: **Other**. Leave the build command and output directory empty.
3. Deploy.

`vercel.json` sets security headers (including a CSP that allows the Internet Archive reader) and caching. `.vercelignore` keeps the private catalog and local tools out of deployments.

## Run privately with your personal files

The site expects to live in a `website/` folder inside the library folder (`livres mystiques/website`).

```bash
python website/tools/build_catalog.py   # rescan the library, rebuild both catalogs
python website/serve_local.py           # opens http://127.0.0.1:8000
```

The local server listens on `127.0.0.1` only. It serves a personal file only if that file appears in `data/catalog.private.json`.

## Updating the catalog

After adding books to the library folders, run `tools/build_catalog.py`, then commit `data/catalog.json` and push. Vercel redeploys automatically.

- Public-domain books are matched to their Internet Archive identifiers through `tools/ia_sources.json`.
- Every other file is treated as personal: it appears only in `data/catalog.private.json`, which is git-ignored.

## Structure

```
index.html               app shell
assets/app.js            routing, search, filters, views, generated covers
assets/categories.js     subject labels (English) and colors
assets/styles.css        dark and light themes, responsive layout
data/catalog.json        public catalog (public-domain books only)
tools/build_catalog.py   catalog generator
serve_local.py           private local server
```

## Languages

The interface is available in **English, French and Haitian Creole** (`assets/i18n.js`, subject names in `assets/categories.js`). The language is chosen from the browser settings and can be changed from the menu in the header; the choice is remembered.

## Confidential material

`tools/build_catalog.py` skips confidential files entirely (patterns in the git-ignored `tools/confidential.local.txt`, one regex per line). They are never listed, not even in the private local catalog, so the local server cannot serve them either.
