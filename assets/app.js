(function () {
  "use strict";

  const CFG = window.KLIBRARY_CONFIG || {};
  const CATS = window.KLIBRARY_CATEGORIES || {};
  const PAGE = 48;
  const main = document.getElementById("main");
  const qInput = document.getElementById("q");

  let BOOKS = [];
  let BY_ID = new Map();
  let shown = PAGE;

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const catInfo = (c) => CATS[c] || { en: c, hue: 260, blurb: "" };
  const catLabel = (c) => catInfo(c).en;
  const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
  const hasOwn = () => BOOKS.some((b) => b.source === "own");

  function seedOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Procedural sigil: a unique geometric figure per book.
  function sigil(id) {
    const r = rng(seedOf(id));
    const n = 3 + Math.floor(r() * 7);
    const step = n > 4 && r() > 0.45 ? 2 : 1;
    const rot = r() * Math.PI * 2;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = rot + (i * 2 * Math.PI) / n;
      pts.push([50 + 34 * Math.cos(a), 50 + 34 * Math.sin(a)]);
    }
    let d = "";
    for (let i = 0, k = 0; i <= n; i++, k = (k + step) % n) d += (i ? "L" : "M") + pts[k][0].toFixed(1) + " " + pts[k][1].toFixed(1);
    let extra = "";
    const dots = 1 + Math.floor(r() * 3);
    for (let i = 0; i < dots; i++) {
      const p = pts[Math.floor(r() * n)];
      extra += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${(2 + r() * 3).toFixed(1)}"/>`;
    }
    if (r() > 0.4) extra += `<circle cx="50" cy="50" r="${(8 + r() * 10).toFixed(1)}"/>`;
    if (r() > 0.5) { const a = rot + r() * Math.PI; extra += `<path d="M${(50 + 46 * Math.cos(a)).toFixed(1)} ${(50 + 46 * Math.sin(a)).toFixed(1)}L${(50 - 46 * Math.cos(a)).toFixed(1)} ${(50 - 46 * Math.sin(a)).toFixed(1)}"/>`; }
    return `<svg class="sigil" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46"/><path d="${d}Z"/>${extra}</svg>`;
  }

  function cover(b, large) {
    return `<div class="cover${large ? " lg" : ""}" style="--h:${b._h}">${sigil(b.id)}
      <span class="c-cat">${esc(catLabel(b.category))}</span>
      <span class="c-title">${esc(b.title)}</span>
      <span class="c-year">${b.year ? esc(b.year) : ""}</span></div>`;
  }

  // Decorative astrolabe for the home hero.
  function astrolabe() {
    const ticks = [];
    for (let i = 0; i < 72; i++) {
      const a = (i * Math.PI) / 36, r1 = i % 6 ? 44 : 41.5;
      ticks.push(`<path d="M${(50 + 46 * Math.cos(a)).toFixed(2)} ${(50 + 46 * Math.sin(a)).toFixed(2)}L${(50 + r1 * Math.cos(a)).toFixed(2)} ${(50 + r1 * Math.sin(a)).toFixed(2)}" stroke-width="0.6"/>`);
    }
    const planets = ["SOL", "LVNA", "MARS", "MERCVRIVS", "IVPITER", "VENVS", "SATVRNVS"];
    const labels = planets.map((p, i) => {
      const a = (i * 360) / planets.length;
      return `<text x="50" y="12.2" text-anchor="middle" transform="rotate(${a.toFixed(1)} 50 50)">${p}</text>`;
    }).join("");
    let star = "";
    for (let i = 0; i <= 7; i++) {
      const k = (i * 3) % 7, a = -Math.PI / 2 + (k * 2 * Math.PI) / 7;
      star += (i ? "L" : "M") + (50 + 26 * Math.cos(a)).toFixed(2) + " " + (50 + 26 * Math.sin(a)).toFixed(2);
    }
    return `<svg class="astrolabe" viewBox="0 0 100 100" aria-hidden="true">
      <g class="ring"><circle cx="50" cy="50" r="46" stroke-width="0.8"/>${ticks.join("")}<circle cx="50" cy="50" r="41" stroke-width="0.4"/></g>
      <g class="ring rev" opacity="0.85">${labels}<circle cx="50" cy="50" r="33" stroke-width="0.5"/></g>
      <g opacity="0.75"><path d="${star}Z" stroke-width="0.6"/><circle cx="50" cy="50" r="26" stroke-width="0.4"/>
      <circle cx="50" cy="50" r="9" stroke-width="0.6"/><circle cx="50" cy="50" r="1.4" stroke-width="0.6"/>
      <path d="M50 4V96M4 50H96" stroke-width="0.25"/></g></svg>`;
  }

  function card(b) {
    return `<a class="book" href="#/book/${b.id}">${cover(b)}
      <span class="meta"><span class="t">${esc(b.title)}</span>
      <span class="a">${esc(b.author || catLabel(b.category))}</span></span></a>`;
  }

  // ---------- routing ----------
  function parseHash() {
    const h = location.hash.replace(/^#/, "") || "/";
    const [path, qs] = h.split("?");
    return { path, params: new URLSearchParams(qs || "") };
  }
  function go(path, params, replace) {
    const qs = params && [...params.keys()].length ? "?" + params.toString() : "";
    const url = "#" + path + qs;
    if (replace) history.replaceState(null, "", url); else location.hash = url;
    if (replace) render();
  }

  // ---------- search & filter ----------
  function search(list, q) {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return list.map((b) => [b, 0]);
    const out = [];
    for (const b of list) {
      let score = 0, ok = true;
      for (const t of toks) {
        if (!b._hay.includes(t)) { ok = false; break; }
        score += b._t.includes(t) ? 3 : b._a.includes(t) ? 2 : 1;
        if (b._t.startsWith(t)) score += 2;
      }
      if (ok) out.push([b, score]);
    }
    return out;
  }
  const SORTS = {
    relevance: (a, b) => b[1] - a[1] || (a[0].year || 9999) - (b[0].year || 9999),
    title: (a, b) => a[0].title.localeCompare(b[0].title, "fr"),
    author: (a, b) => (a[0].author || "~").localeCompare(b[0].author || "~", "fr") || a[0].title.localeCompare(b[0].title, "fr"),
    oldest: (a, b) => (a[0].year || 9999) - (b[0].year || 9999),
    newest: (a, b) => (b[0].year || 0) - (a[0].year || 0),
  };
  function filtered(p, skip) {
    let list = BOOKS;
    const src = p.get("src"), cat = p.get("cat"), author = p.get("author");
    if (src && skip !== "src") list = list.filter((b) => b.source === src);
    if (cat && skip !== "cat") list = list.filter((b) => b.category === cat);
    if (author && skip !== "author") list = list.filter((b) => (b.author || "") === author);
    return search(list, p.get("q") || "");
  }
  function counts(pairs, key) {
    const m = new Map();
    for (const [b] of pairs) { const k = b[key] || ""; if (k) m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"));
  }

  // ---------- views ----------
  function viewHome() {
    const pd = BOOKS.filter((b) => b.source === "pd");
    const authors = new Set(BOOKS.map((b) => b.author).filter(Boolean));
    const years = BOOKS.map((b) => b.year).filter((y) => y && y < 1960);
    const oldest = years.length ? Math.min(...years) : "";
    const magic = new Set(["Magie et Grimoires", "Démonologie et Sorcellerie", "Occultisme", "Alchimie"]);
    const rare = pd.filter((b) => magic.has(b.category) && b.year).sort((a, b) => a.year - b.year).slice(0, 18);
    const oldestBooks = pd.filter((b) => b.year && !magic.has(b.category)).sort((a, b) => a.year - b.year).slice(0, 14);
    const cats = counts(BOOKS.map((b) => [b]), "category");
    main.innerHTML = `
      <div class="hero-wrap"><section class="hero">
        <span class="eyebrow">Bibliothèque des sciences occultes</span>
        <h1>Rare books of <em>magic</em>, mysticism &amp; the hidden sciences</h1>
        <p class="lead">A curated French-language library: grimoires, Kabbalah, alchemy, Martinism, demonology and the great occultists of the nineteenth century. Every public-domain title can be read right here in your browser.</p>
        <div class="stats">
          <div class="stat"><b>${BOOKS.length}</b><span>books</span></div>
          <div class="stat"><b>${cats.length}</b><span>subjects</span></div>
          <div class="stat"><b>${authors.size}</b><span>authors &amp; collections</span></div>
          ${oldest ? `<div class="stat"><b>${oldest}</b><span>oldest edition</span></div>` : ""}
        </div>
        <div class="hero-actions">
          <a class="btn primary" href="#/browse">Browse the library</a>
          <button class="btn" type="button" data-random>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>Open a random book</button>
        </div>
      </section>${astrolabe()}</div>
      ${rare.length ? `<section class="section">
        <div class="section-head"><div><h2>Rare grimoires &amp; magical texts</h2><p>The oldest editions in the collection, from the sixteenth century onward.</p></div>
        <a href="#/browse?cat=${encodeURIComponent("Magie et Grimoires")}&sort=oldest">See all magic →</a></div>
        <div class="shelf">${rare.map(card).join("")}</div></section>` : ""}
      <section class="section">
        <div class="section-head"><div><h2>Subjects</h2><p>${cats.length} shelves, from Kabbalah to Vodou.</p></div></div>
        <div class="cat-grid">${cats.map(([c, n]) => {
          const i = catInfo(c);
          return `<a class="cat-card" style="--h:${i.hue}" href="#/browse?cat=${encodeURIComponent(c)}">
            <span class="count">${n}</span><h3>${esc(i.en)}</h3><span class="fr">${esc(c)}</span><p>${esc(i.blurb)}</p></a>`;
        }).join("")}</div>
      </section>
      ${oldestBooks.length ? `<section class="section">
        <div class="section-head"><div><h2>Mystics &amp; early editions</h2><p>Kabbalah, mysticism and hermetic philosophy in their first printings.</p></div>
        <a href="#/browse?sort=oldest">Sort by date →</a></div>
        <div class="shelf">${oldestBooks.map(card).join("")}</div></section>` : ""}`;
  }

  function facetButtons(entries, param, p, labeler) {
    const cur = p.get(param);
    return entries.map(([k, n]) => `<button type="button" data-set="${param}" data-val="${esc(k)}" aria-pressed="${cur === k}">
      <span>${esc(labeler ? labeler(k) : k)}</span><span>${n}</span></button>`).join("");
  }

  function viewBrowse(p, keepCount) {
    if (!keepCount) shown = PAGE;
    const sort = p.get("sort") || (p.get("q") ? "relevance" : "title");
    const res = filtered(p).sort(SORTS[sort] || SORTS.title);
    const catCounts = counts(filtered(p, "cat"), "category");
    const authCounts = counts(filtered(p, "author"), "author").slice(0, 40);
    const src = p.get("src") || "";
    const cat = p.get("cat");
    const title = cat ? catLabel(cat) : p.get("q") ? `Results for “${esc(p.get("q"))}”` : "The whole library";
    const chips = [];
    if (p.get("q")) chips.push(["q", `“${p.get("q")}”`]);
    if (cat) chips.push(["cat", catLabel(cat)]);
    if (p.get("author")) chips.push(["author", p.get("author")]);
    if (src) chips.push(["src", src === "pd" ? "Public domain" : "Personal files"]);

    main.innerHTML = `<div class="browse">
      <aside class="filters" id="filters" aria-label="Filters">
        ${hasOwn() ? `<div><h4>Source</h4><div class="seg">
          <button type="button" data-set="src" data-val="" aria-pressed="${!src}">All</button>
          <button type="button" data-set="src" data-val="pd" aria-pressed="${src === "pd"}">Public domain</button>
          <button type="button" data-set="src" data-val="own" aria-pressed="${src === "own"}">Personal</button></div></div>` : ""}
        <div><h4>Sort by</h4><select class="sort" id="sortSel" aria-label="Sort results">
          ${[["relevance", "Relevance"], ["title", "Title"], ["author", "Author"], ["oldest", "Oldest first"], ["newest", "Newest first"]]
            .map(([v, l]) => `<option value="${v}"${v === sort ? " selected" : ""}>${l}</option>`).join("")}</select></div>
        <div><h4>Subjects</h4><div class="facet">
          <button type="button" data-set="cat" data-val="" aria-pressed="${!cat}"><span>All subjects</span><span>${filtered(p, "cat").length}</span></button>
          ${facetButtons(catCounts, "cat", p, catLabel)}</div></div>
        ${authCounts.length ? `<div><h4>Authors &amp; collections</h4><div class="facet">${facetButtons(authCounts, "author", p)}</div></div>` : ""}
      </aside>
      <section>
        <div class="results-head"><h1>${title}</h1>
          <span class="count">${res.length} book${res.length === 1 ? "" : "s"}</span>
          <button class="btn filter-toggle" type="button" id="filterToggle" aria-controls="filters">Filters</button></div>
        ${chips.length ? `<div class="chips">${chips.map(([k, l]) => `<button class="chip" type="button" data-set="${k}" data-val="">${esc(l)} ✕</button>`).join("")}</div>` : ""}
        ${res.length ? `<div class="book-grid">${res.slice(0, shown).map(([b]) => card(b)).join("")}</div>` : `<div class="empty">Nothing found in the archive. Try fewer words.</div>`}
        ${res.length > shown ? `<div class="more"><button class="btn" type="button" id="moreBtn">Show more (${res.length - shown} left)</button></div>` : ""}
      </section></div>`;

    const sel = document.getElementById("sortSel");
    sel && sel.addEventListener("change", () => { p.set("sort", sel.value); go("/browse", p, true); });
    const more = document.getElementById("moreBtn");
    more && more.addEventListener("click", () => { shown += PAGE; const y = scrollY; viewBrowse(p, true); scrollTo(0, y); });
    const ft = document.getElementById("filterToggle");
    ft && ft.addEventListener("click", () => document.getElementById("filters").classList.toggle("open"));
  }

  function fileUrl(path) {
    return (CFG.filesBase || "/files/") + path.split("/").map(encodeURIComponent).join("/");
  }

  function viewBook(id) {
    const b = BY_ID.get(id);
    if (!b) { main.innerHTML = `<div class="empty">This book is not in the catalog.</div>`; return; }
    document.title = `${b.title} · KLibrary`;
    const i = catInfo(b.category);
    const pool = BOOKS.filter((x) => x.id !== b.id && ((b.author && x.author === b.author) || x.category === b.category));
    pool.sort((x, y) => (b.author && y.author === b.author) - (b.author && x.author === b.author) || (x.year || 9999) - (y.year || 9999));
    const related = pool.slice(0, 14);
    const facts = [["Subject", `<a href="#/browse?cat=${encodeURIComponent(b.category)}">${esc(i.en)}</a><br><span class="muted">${esc(b.category)}</span>`]];
    if (b.year) facts.push(["Edition", esc(b.year)]);
    facts.push(["Format", `${esc(b.ext.toUpperCase())} · ${fmtSize(b.size)}`]);
    if (b.collection) facts.push(["Collection", esc(b.collection)]);
    facts.push(["Source", b.source === "pd" ? `Internet Archive<br><span class="muted">${esc(b.ia)}</span>` : "Personal library"]);

    const actions = b.source === "pd"
      ? `<button class="btn primary" type="button" id="readBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2zM22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z"/></svg>Read online</button>
         <a class="btn" href="https://archive.org/download/${encodeURIComponent(b.ia)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"/></svg>Download</a>
         <a class="btn" href="https://archive.org/details/${encodeURIComponent(b.ia)}" target="_blank" rel="noopener">View on Internet Archive</a>`
      : `<a class="btn primary" href="${fileUrl(b.path)}" target="_blank" rel="noopener">Open file</a>`;

    main.innerHTML = `<article class="book-page">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">Library</a> / <a href="#/browse?cat=${encodeURIComponent(b.category)}">${esc(i.en)}</a></nav>
      <div>${cover(b, true)}</div>
      <div class="book-info">
        <span class="badge ${b.source === "pd" ? "pd" : ""}">${b.source === "pd" ? "Public domain" : "Personal file"}</span>
        <h1>${esc(b.title)}</h1>
        ${b.author ? `<div class="by">by <a href="#/browse?author=${encodeURIComponent(b.author)}">${esc(b.author)}</a></div>` : ""}
        <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
        <div class="actions">${actions}</div>
        ${b.source === "pd" ? `<p class="note">Scanned from the original edition and hosted by the Internet Archive. The reader loads their viewer, which supports full-text search inside the book.</p>` : ""}
      </div>
      <div class="reader" id="reader" hidden></div>
      ${related.length ? `<section class="related section"><div class="section-head"><div><h2>${b.author && pool[0] && pool[0].author === b.author ? "More by " + esc(b.author) : "More in " + esc(i.en)}</h2></div></div>
        <div class="shelf">${related.map(card).join("")}</div></section>` : ""}
    </article>`;

    const rb = document.getElementById("readBtn");
    rb && rb.addEventListener("click", () => {
      const r = document.getElementById("reader");
      if (r.hidden) {
        r.innerHTML = `<iframe src="https://archive.org/embed/${encodeURIComponent(b.ia)}" title="${esc(b.title)}" allowfullscreen loading="lazy"></iframe>`;
        r.hidden = false;
        rb.lastChild.textContent = "Close reader";
        r.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        r.hidden = true; r.innerHTML = ""; rb.lastChild.textContent = "Read online";
      }
    });
  }

  function viewAbout() {
    const pd = BOOKS.filter((b) => b.source === "pd").length;
    main.innerHTML = `<div class="prose">
      <h1>About the library</h1>
      <p>KLibrary gathers French-language books on magic, occultism, alchemy, Kabbalah, Martinism, mysticism and the history of witchcraft. It focuses on rare and hard-to-find titles: early grimoires, Renaissance demonologists, and the occult revival of nineteenth-century Paris.</p>
      <h2>Public domain</h2>
      <p>The ${pd} public-domain books here were written by authors who died more than seventy years ago. They were scanned by the Bibliothèque nationale de France, the Bibliothèque Sainte-Geneviève, BIU Santé, the Wellcome Collection and Google Books, and they are hosted by the <a href="https://archive.org" rel="noopener">Internet Archive</a>. Reading and downloading go directly through their servers.</p>
      <h2>How to use it</h2>
      <ul>
        <li>Press <code>/</code> anywhere to search. Search ignores accents, so <code>eliphas levi</code> finds Éliphas Lévi.</li>
        <li>Combine subject, author and sort filters. Every view has its own URL, so you can share it.</li>
        <li>Open any book and choose <em>Read online</em> to browse the original scan without leaving the page.</li>
      </ul>
    </div>`;
  }

  // ---------- render loop ----------
  function render() {
    const { path, params } = parseHash();
    document.title = "KLibrary";
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + path));
    if (document.activeElement !== qInput) qInput.value = path === "/browse" ? params.get("q") || "" : "";
    if (path.startsWith("/book/")) viewBook(decodeURIComponent(path.slice(6)));
    else if (path === "/browse") viewBrowse(params);
    else if (path === "/about") viewAbout();
    else viewHome();
  }

  // ---------- events ----------
  window.addEventListener("hashchange", () => { render(); scrollTo(0, 0); });

  main.addEventListener("click", (e) => {
    const rnd = e.target.closest("[data-random]");
    if (rnd) { const b = BOOKS[Math.floor(Math.random() * BOOKS.length)]; location.hash = "#/book/" + b.id; return; }
    const btn = e.target.closest("[data-set]");
    if (!btn) return;
    const { params } = parseHash();
    const k = btn.dataset.set, v = btn.dataset.val;
    if (!v || params.get(k) === v) params.delete(k); else params.set(k, v);
    if (k === "cat") params.delete("author");
    if (k === "q") qInput.value = "";
    go("/browse", params, true);
  });

  let timer;
  qInput.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const { path, params } = parseHash();
      const p = path === "/browse" ? params : new URLSearchParams();
      const v = qInput.value.trim();
      if (v) p.set("q", v); else p.delete("q");
      p.delete("sort");
      if (path === "/browse") go("/browse", p, true); else go("/browse", p);
    }, 180);
  });
  document.getElementById("searchForm").addEventListener("submit", (e) => e.preventDefault());
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); qInput.focus(); qInput.select(); }
    if (e.key === "Escape") { const f = document.getElementById("filters"); f && f.classList.remove("open"); }
  });

  document.getElementById("themeBtn").addEventListener("click", () => {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    const next = cur === "light" ? "dark" : "light";
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("klibrary-theme", next); } catch (e) {}
  });

  // ---------- boot ----------
  fetch(CFG.catalogUrl || "data/catalog.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      BOOKS = data.books.map((b) => {
        const t = norm(b.title), a = norm(b.author);
        return Object.assign(b, { _t: t, _a: a, _h: catInfo(b.category).hue, _hay: [t, a, norm(b.category), norm(catLabel(b.category)), norm(b.collection), b.year || ""].join(" ") });
      });
      BY_ID = new Map(BOOKS.map((b) => [b.id, b]));
      const own = BOOKS.filter((b) => b.source === "own").length;
      document.getElementById("modeNote").textContent = own
        ? `Private local mode: ${BOOKS.length} books, including ${own} personal files.`
        : `${BOOKS.length} public-domain books.`;
      render();
    })
    .catch(() => { main.innerHTML = `<div class="empty">The catalog could not be loaded.</div>`; });
})();
