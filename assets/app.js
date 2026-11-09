(function () {
  "use strict";

  const CFG = window.KLIBRARY_CONFIG || {};
  const CATS = window.KLIBRARY_CATEGORIES || {};
  const I18N = window.KLIBRARY_I18N || {};
  const LANGS = window.KLIBRARY_LANGS || [{ code: "en", label: "English" }];
  const PAGE = 48;
  const main = document.getElementById("main");
  const qInput = document.getElementById("q");
  const langSel = document.getElementById("langSel");

  let BOOKS = [];
  let BY_ID = new Map();
  let shown = PAGE;
  let LANG = pickLang();

  // ---------- i18n ----------
  function pickLang() {
    const ok = (c) => c && I18N[c];
    try { const s = localStorage.getItem("klibrary-lang"); if (ok(s)) return s; } catch (e) {}
    for (const l of navigator.languages || [navigator.language || "en"]) {
      const c = String(l).toLowerCase().slice(0, 2);
      if (ok(c)) return c;
    }
    return "en";
  }
  function t(key, vars) {
    let s = (I18N[LANG] && I18N[LANG][key]) ?? (I18N.en && I18N.en[key]) ?? key;
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  }
  const countLabel = (n) => t(n === 1 ? "count.one" : "count.other", { n });
  const locale = () => (LANG === "en" ? "en" : "fr");

  function applyStatic() {
    document.documentElement.lang = LANG;
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
    document.getElementById("footSources").innerHTML = esc(t("footer.sources")).replace("{ia}", '<a href="https://archive.org" rel="noopener">Internet Archive</a>');
    document.getElementById("credit").innerHTML = esc(t("footer.credit")).replace("{name}", "<strong>Kescollah</strong>");
    updateModeNote();
  }
  function updateModeNote() {
    if (!BOOKS.length) return;
    const own = BOOKS.filter((b) => b.source === "own").length;
    document.getElementById("modeNote").textContent = own
      ? t("mode.private", { n: BOOKS.length, own })
      : t("mode.public", { n: BOOKS.length });
  }

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const catInfo = (c) => CATS[c] || { hue: 260 };
  const catText = (c) => { const i = catInfo(c); return i[LANG] || i.en || [c, ""]; };
  const catLabel = (c) => catText(c)[0];
  const catBlurb = (c) => catText(c)[1] || "";
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
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- mathematical cover figures ----------
  // Each book gets a real mathematical curve, computed from its equation and
  // parameterised deterministically by the book id. The equation is printed on the cover.
  const TAU = Math.PI * 2;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

  // Fit point sets (math coords, y up) into the 100x100 box, keeping aspect ratio.
  function fitter(sets, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of sets) for (const [x, y] of s) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const s = (100 - 2 * pad) / Math.max(x1 - x0, y1 - y0, 1e-9);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const f = (x, y) => [50 + (x - cx) * s, 50 - (y - cy) * s];
    f.scale = s;
    return f;
  }
  const fx = (n) => n.toFixed(1);
  const poly = (pts, f) => "M" + pts.map(([x, y]) => { const q = f(x, y); return fx(q[0]) + " " + fx(q[1]); }).join("L");
  const circlePts = (cx, cy, rad, n = 120) => Array.from({ length: n + 1 }, (_, i) => [cx + rad * Math.cos((i * TAU) / n), cy + rad * Math.sin((i * TAU) / n)]);
  const faint = (d) => `<path d="${d}" class="g"/>`;

  const FIGURES = {
    // Rose curve (rhodonea): r = cos(kθ), k = n/d in lowest terms.
    rose(r) {
      let n, d;
      do { n = between(r, 2, 8); d = pick(r, [1, 1, 2, 3, 4, 5]); } while (n === d || gcd(n, d) !== 1);
      const k = n / d, end = (n * d) % 2 ? Math.PI * d : TAU * d, N = Math.min(1600, 240 * d);
      const pts = Array.from({ length: N + 1 }, (_, i) => { const t = (i * end) / N, q = Math.cos(k * t); return [q * Math.cos(t), q * Math.sin(t)]; });
      const unit = circlePts(0, 0, 1);
      const f = fitter([unit], 7);
      return { fam: "rose", cap: d === 1 ? `r = cos ${n}θ` : `r = cos(${n}θ/${d})`, svg: faint(poly(unit, f)) + `<path d="${poly(pts, f)}"/>` };
    },
    // Hypotrochoid / epitrochoid: a point at distance d on a circle of radius r rolling inside/outside a fixed circle R.
    trochoid(r, forceEpi) {
      const epi = forceEpi || r() < 0.4;
      let R, q, g;
      do {
        R = between(r, 4, 11); q = between(r, 2, epi ? 7 : R - 1); g = gcd(R, q);
      } while ((!epi && 2 * q === R) || q / g > 9 || q / g < 2);
      const d = between(r, 1, q + 1);
      const end = (TAU * q) / g, N = Math.min(1800, Math.round(180 * (q / g)));
      const pts = Array.from({ length: N + 1 }, (_, i) => {
        const t = (i * end) / N;
        return epi
          ? [(R + q) * Math.cos(t) - d * Math.cos(((R + q) / q) * t), (R + q) * Math.sin(t) - d * Math.sin(((R + q) / q) * t)]
          : [(R - q) * Math.cos(t) + d * Math.cos(((R - q) / q) * t), (R - q) * Math.sin(t) - d * Math.sin(((R - q) / q) * t)];
      });
      const fixed = circlePts(0, 0, R);
      const f = fitter([pts, fixed], 7);
      return { fam: epi ? "epi" : "hypo", cap: `R=${R}, r=${q}, d=${d}`, svg: faint(poly(fixed, f)) + `<path d="${poly(pts, f)}"/>` };
    },
    epi(r) { return FIGURES.trochoid(r, true); },
    // Lissajous curve: x = sin(at + δ), y = sin(bt).
    lissajous(r) {
      const [a, b] = pick(r, [[1, 2], [2, 3], [3, 4], [3, 5], [4, 5], [5, 6], [2, 5], [1, 3], [3, 7], [5, 7], [4, 7]]);
      const [delta, dl] = pick(r, [[Math.PI / 2, "π/2"], [Math.PI / 4, "π/4"], [Math.PI / 3, "π/3"], [Math.PI / 6, "π/6"]]);
      const N = 1000;
      const pts = Array.from({ length: N + 1 }, (_, i) => { const t = (i * TAU) / N; return [Math.sin(a * t + delta), Math.sin(b * t)]; });
      const box = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
      const f = fitter([box], 9);
      return { fam: "lissajous", cap: `${a}:${b}, δ = ${dl}`, svg: faint(poly(box, f)) + `<path d="${poly(pts, f)}"/>` };
    },
    // Regular star polygon {n/k}, with its circumcircle and convex hull {n}.
    star(r) {
      let n, k;
      do { n = between(r, 5, 12); k = between(r, 2, Math.floor((n - 1) / 2)); } while (gcd(n, k) !== 1 || 2 * k >= n);
      const v = (i) => [Math.cos(Math.PI / 2 + (i * TAU) / n), Math.sin(Math.PI / 2 + (i * TAU) / n)];
      const starPts = Array.from({ length: n + 1 }, (_, i) => v((i * k) % n));
      const hull = Array.from({ length: n + 1 }, (_, i) => v(i % n));
      const circ = circlePts(0, 0, 1);
      const f = fitter([circ], 8);
      return { fam: "star", cap: `{${n}/${k}}`, svg: faint(poly(circ, f)) + faint(poly(hull, f)) + `<path d="${poly(starPts, f)}"/>` };
    },
    // Modular multiplication on a circle: chord from k to m·k mod N (envelopes: cardioid, nephroid…).
    modular(r) {
      const N = pick(r, [72, 90, 100, 120, 144, 180]), m = between(r, 2, 9);
      const pt = (i) => [Math.cos((i * TAU) / N), Math.sin((i * TAU) / N)];
      const circ = circlePts(0, 0, 1);
      const f = fitter([circ], 8);
      let d = "";
      for (let i = 0; i < N; i++) {
        const j = (m * i) % N;
        if (j === i) continue;
        const a = f(...pt(i)), b = f(...pt(j));
        d += `M${fx(a[0])} ${fx(a[1])}L${fx(b[0])} ${fx(b[1])}`;
      }
      return { fam: "modular", cap: `k ↦ ${m}k mod ${N}`, svg: faint(poly(circ, f)) + `<path d="${d}" class="thin"/>` };
    },
    // Maurer rose: points of r = sin(nθ) at θ = k·d degrees, k = 0..360, joined in order.
    maurer(r) {
      const n = between(r, 2, 7), d = pick(r, [11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97]);
      const at = (deg) => { const t = (deg * Math.PI) / 180, q = Math.sin(n * t); return [q * Math.cos(t), q * Math.sin(t)]; };
      const walk = Array.from({ length: 361 }, (_, k) => at(k * d));
      const rose = Array.from({ length: 721 }, (_, i) => at(i / 2));
      const f = fitter([circlePts(0, 0, 1)], 7);
      return { fam: "maurer", cap: `n=${n}, d=${d}°`, svg: `<path d="${poly(walk, f)}" class="thin"/>` + `<path d="${poly(rose, f)}"/>` };
    },
    // Golden spiral: quarter arcs inscribed in successive Fibonacci squares.
    golden(r) {
      const F = [1, 1, 2, 3, 5, 8, 13, 21, 34], count = between(r, 7, 9);
      let bx0 = 0, by0 = 0, bx1 = 1, by1 = 1;
      const squares = [], arcs = [];
      for (let i = 0; i < count; i++) {
        const s = F[i];
        let x, y, cx, cy;
        if (i === 0) { x = 0; y = 0; cx = 0; cy = 0; }
        else {
          const dir = (i - 1) % 4;
          if (dir === 0) { x = bx1; y = by0; cx = x; cy = y + s; }
          else if (dir === 1) { x = bx0; y = by1; cx = x; cy = y; }
          else if (dir === 2) { x = bx0 - s; y = by0; cx = x + s; cy = y; }
          else { x = bx0; y = by0 - s; cx = x + s; cy = y + s; }
          bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x + s); by1 = Math.max(by1, y + s);
        }
        squares.push([[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]);
        // arc between the two corners adjacent to the centre corner, sweeping through the square
        const mx = x + s / 2 - cx, my = y + s / 2 - cy, mid = Math.atan2(my, mx);
        const arc = Array.from({ length: 25 }, (_, j) => { const a = mid - Math.PI / 4 + (j * Math.PI) / 2 / 24; return [cx + s * Math.cos(a), cy + s * Math.sin(a)]; });
        if (arcs.length) {
          const [lx, ly] = arcs[arcs.length - 1];
          const d0 = Math.hypot(arc[0][0] - lx, arc[0][1] - ly), d1 = Math.hypot(arc[24][0] - lx, arc[24][1] - ly);
          if (d1 < d0) arc.reverse();
        }
        arcs.push(...arc);
      }
      const rot = between(r, 0, 3), mir = r() < 0.5;
      const tr = ([x, y]) => { for (let i = 0; i < rot; i++) [x, y] = [-y, x]; return mir ? [-x, y] : [x, y]; };
      const sq = squares.map((s) => s.map(tr)), sp = arcs.map(tr);
      const f = fitter(sq, 8);
      return { fam: "golden", cap: "φ = (1+√5)/2", svg: sq.map((s) => faint(poly(s, f))).join("") + `<path d="${poly(sp, f)}"/>` };
    },
    // Phyllotaxis (Vogel's model): seed k at angle k·137.508° and radius √k.
    phyllo(r) {
      const N = between(r, 140, 320), alpha = (137.50776 * Math.PI) / 180;
      const pts = Array.from({ length: N }, (_, k) => [Math.sqrt(k) * Math.cos(k * alpha), Math.sqrt(k) * Math.sin(k * alpha)]);
      const f = fitter([circlePts(0, 0, Math.sqrt(N))], 9);
      const d = pts.map(([x, y]) => { const q = f(x, y); return `M${fx(q[0])} ${fx(q[1])}h0`; }).join("");
      return { fam: "phyllo", cap: `n = ${N}, 137.5°`, svg: `<path d="${d}" class="dots"/>` };
    },
  };

  const FIG_BY_CAT = {
    "Magie et Grimoires": ["star", "maurer", "star", "modular"],
    "Démonologie et Sorcellerie": ["star", "maurer"],
    "Occultisme": ["maurer", "star", "trochoid", "rose"],
    "Alchimie": ["golden", "phyllo", "trochoid"],
    "Kabbale et Hermétisme": ["star", "modular", "rose"],
    "Martinisme et Illuminisme": ["star", "rose", "maurer"],
    "Rose-Croix": ["rose", "maurer", "star"],
    "Tarot": ["star", "rose"],
    "Astrologie": ["trochoid", "epi"],
    "Divination et Numérologie": ["modular", "phyllo"],
    "Magnétisme et Hypnose": ["lissajous"],
    "Spiritisme": ["lissajous", "rose"],
    "Plan astral, Rêves et Conscience": ["lissajous", "trochoid"],
    "Tradition et Ésotérisme": ["golden", "star", "modular"],
    "Gnose et Apocryphes": ["rose", "maurer"],
    "Théosophie et Anthroposophie": ["trochoid", "epi", "rose"],
    "Mystique chrétienne": ["rose", "golden"],
    "Anges, Prières et Psaumes": ["rose", "star"],
    "Franc-maçonnerie": ["golden", "star"],
    "Vaudou et traditions afro-caribéennes": ["maurer", "star", "modular"],
    "Magie sexuelle et Tantra": ["rose", "lissajous"],
    "Santé, Plantes et Énergétique": ["phyllo", "golden"],
    "Développement personnel": ["golden", "phyllo"],
    "Revues ésotériques": ["modular", "lissajous"],
    "Prophéties": ["epi", "trochoid"],
  };
  const ALL_FIGS = ["rose", "trochoid", "lissajous", "star", "modular", "maurer", "golden", "phyllo"];
  const FIG_CACHE = new Map();

  function figure(b) {
    let fig = FIG_CACHE.get(b.id);
    if (!fig) {
      const r = rng(seedOf(b.id));
      const fam = pick(r, FIG_BY_CAT[b.category] || ALL_FIGS);
      fig = FIGURES[fam](r);
      FIG_CACHE.set(b.id, fig);
    }
    return fig;
  }

  // Decorative astrolabe for the home hero.
  function astrolabe() {
    const ticks = [];
    for (let i = 0; i < 72; i++) {
      const a = (i * Math.PI) / 36, r1 = i % 6 ? 44 : 41.5;
      ticks.push(`<path d="M${(50 + 46 * Math.cos(a)).toFixed(2)} ${(50 + 46 * Math.sin(a)).toFixed(2)}L${(50 + r1 * Math.cos(a)).toFixed(2)} ${(50 + r1 * Math.sin(a)).toFixed(2)}" stroke-width="0.6"/>`);
    }
    const planets = ["SOL", "LVNA", "MARS", "MERCVRIVS", "IVPITER", "VENVS", "SATVRNVS"];
    const labels = planets.map((p, i) => `<text x="50" y="12.2" text-anchor="middle" transform="rotate(${((i * 360) / planets.length).toFixed(1)} 50 50)">${p}</text>`).join("");
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

  function cover(b, large) {
    const fig = figure(b);
    return `<div class="cover${large ? " lg" : ""}" style="--h:${b._h}">
      <svg class="figure" viewBox="0 0 100 100" aria-hidden="true">${fig.svg}</svg>
      <span class="c-cat">${esc(catLabel(b.category))}</span>
      <span class="c-title">${esc(b.title)}</span>
      <span class="c-foot"><span class="c-year">${b.year ? esc(b.year) : ""}</span><span class="c-eq">${large ? esc(t("fig." + fig.fam)) + " · " : ""}${esc(fig.cap)}</span></span></div>`;
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
    if (replace) { history.replaceState(null, "", url); render(); } else location.hash = url;
  }

  // ---------- search & filter ----------
  function search(list, q) {
    const toks = norm(q).split(/\s+/).filter(Boolean);
    if (!toks.length) return list.map((b) => [b, 0]);
    const out = [];
    for (const b of list) {
      let score = 0, ok = true;
      for (const tk of toks) {
        if (!b._hay.includes(tk)) { ok = false; break; }
        score += b._t.includes(tk) ? 3 : b._a.includes(tk) ? 2 : 1;
        if (b._t.startsWith(tk)) score += 2;
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
    const early = pd.filter((b) => b.year && !magic.has(b.category)).sort((a, b) => a.year - b.year).slice(0, 14);
    const cats = counts(BOOKS.map((b) => [b]), "category");
    main.innerHTML = `
      <div class="hero-wrap"><section class="hero">
        <span class="eyebrow">${esc(t("home.eyebrow"))}</span>
        <h1>${t("home.title")}</h1>
        <p class="lead">${esc(t("home.lead"))}</p>
        <div class="stats">
          <div class="stat"><b>${BOOKS.length}</b><span>${esc(t("stat.books"))}</span></div>
          <div class="stat"><b>${cats.length}</b><span>${esc(t("stat.subjects"))}</span></div>
          <div class="stat"><b>${authors.size}</b><span>${esc(t("stat.authors"))}</span></div>
          ${oldest ? `<div class="stat"><b>${oldest}</b><span>${esc(t("stat.oldest"))}</span></div>` : ""}
        </div>
        <div class="hero-actions">
          <a class="btn primary" href="#/browse">${esc(t("btn.browse"))}</a>
          <button class="btn" type="button" data-random>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>${esc(t("btn.random"))}</button>
        </div>
      </section>${astrolabe()}</div>
      ${rare.length ? `<section class="section">
        <div class="section-head"><div><h2>${esc(t("rare.title"))}</h2><p>${esc(t("rare.sub"))}</p></div>
        <a href="#/browse?cat=${encodeURIComponent("Magie et Grimoires")}&sort=oldest">${esc(t("rare.all"))}</a></div>
        <div class="shelf">${rare.map(card).join("")}</div></section>` : ""}
      <section class="section">
        <div class="section-head"><div><h2>${esc(t("subjects.title"))}</h2><p>${esc(t("subjects.sub", { n: cats.length }))}</p></div></div>
        <div class="cat-grid">${cats.map(([c, n]) => `<a class="cat-card" style="--h:${catInfo(c).hue}" href="#/browse?cat=${encodeURIComponent(c)}">
            <span class="count">${n}</span><h3>${esc(catLabel(c))}</h3>${LANG !== "fr" ? `<span class="fr">${esc(c)}</span>` : ""}<p>${esc(catBlurb(c))}</p></a>`).join("")}</div>
      </section>
      ${early.length ? `<section class="section">
        <div class="section-head"><div><h2>${esc(t("early.title"))}</h2><p>${esc(t("early.sub"))}</p></div>
        <a href="#/browse?sort=oldest">${esc(t("early.all"))}</a></div>
        <div class="shelf">${early.map(card).join("")}</div></section>` : ""}`;
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
    const title = cat ? esc(catLabel(cat)) : p.get("q") ? esc(t("browse.results", { q: p.get("q") })) : esc(t("browse.all"));
    const chips = [];
    if (p.get("q")) chips.push(["q", `“${p.get("q")}”`]);
    if (cat) chips.push(["cat", catLabel(cat)]);
    if (p.get("author")) chips.push(["author", p.get("author")]);
    if (src) chips.push(["src", src === "pd" ? t("src.pd") : t("src.ownChip")]);
    const sorts = ["relevance", "title", "author", "oldest", "newest"];

    main.innerHTML = `<div class="browse">
      <aside class="filters" id="filters" aria-label="${esc(t("f.filters"))}">
        ${hasOwn() ? `<div><h4>${esc(t("f.source"))}</h4><div class="seg">
          <button type="button" data-set="src" data-val="" aria-pressed="${!src}">${esc(t("src.all"))}</button>
          <button type="button" data-set="src" data-val="pd" aria-pressed="${src === "pd"}">${esc(t("src.pd"))}</button>
          <button type="button" data-set="src" data-val="own" aria-pressed="${src === "own"}">${esc(t("src.own"))}</button></div></div>` : ""}
        <div><h4>${esc(t("f.sort"))}</h4><select class="sort" id="sortSel" aria-label="${esc(t("f.sort"))}">
          ${sorts.map((v) => `<option value="${v}"${v === sort ? " selected" : ""}>${esc(t("sort." + v))}</option>`).join("")}</select></div>
        <div><h4>${esc(t("f.subjects"))}</h4><div class="facet">
          <button type="button" data-set="cat" data-val="" aria-pressed="${!cat}"><span>${esc(t("f.allSubjects"))}</span><span>${filtered(p, "cat").length}</span></button>
          ${facetButtons(catCounts, "cat", p, catLabel)}</div></div>
        ${authCounts.length ? `<div><h4>${esc(t("f.authors"))}</h4><div class="facet">${facetButtons(authCounts, "author", p)}</div></div>` : ""}
      </aside>
      <section>
        <div class="results-head"><h1>${title}</h1>
          <span class="count">${esc(countLabel(res.length))}</span>
          <button class="btn filter-toggle" type="button" id="filterToggle" aria-controls="filters">${esc(t("f.filters"))}</button></div>
        ${chips.length ? `<div class="chips">${chips.map(([k, l]) => `<button class="chip" type="button" data-set="${k}" data-val="">${esc(l)} ✕</button>`).join("")}</div>` : ""}
        ${res.length ? `<div class="book-grid">${res.slice(0, shown).map(([b]) => card(b)).join("")}</div>` : `<div class="empty">${esc(t("empty"))}</div>`}
        ${res.length > shown ? `<div class="more"><button class="btn" type="button" id="moreBtn">${esc(t("more", { n: res.length - shown }))}</button></div>` : ""}
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
    if (!b) { main.innerHTML = `<div class="empty">${esc(t("book.notFound"))}</div>`; return; }
    document.title = `${b.title} · KLibrary`;
    const label = catLabel(b.category);
    const sameAuthor = (x) => b.author && x.author === b.author;
    const pool = BOOKS.filter((x) => x.id !== b.id && (sameAuthor(x) || x.category === b.category));
    pool.sort((x, y) => sameAuthor(y) - sameAuthor(x) || (x.year || 9999) - (y.year || 9999));
    const related = pool.slice(0, 14);
    const facts = [[t("fact.subject"), `<a href="#/browse?cat=${encodeURIComponent(b.category)}">${esc(label)}</a>${LANG !== "fr" ? `<br><span class="muted">${esc(b.category)}</span>` : ""}`]];
    if (b.year) facts.push([t("fact.edition"), esc(b.year)]);
    facts.push([t("fact.format"), `${esc(b.ext.toUpperCase())} · ${fmtSize(b.size)}`]);
    if (b.collection) facts.push([t("fact.collection"), esc(b.collection)]);
    const fig = figure(b);
    facts.push([t("fact.figure"), `${esc(t("fig." + fig.fam))}<br><span class="muted eq">${esc(fig.cap)}</span>`]);
    facts.push([t("fact.source"), b.source === "pd" ? `Internet Archive<br><span class="muted">${esc(b.ia)}</span>` : esc(t("source.personal"))]);

    const actions = b.source === "pd"
      ? `<button class="btn primary" type="button" id="readBtn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H2zM22 5h-7a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h8z"/></svg><span>${esc(t("read"))}</span></button>
         <a class="btn" href="https://archive.org/download/${encodeURIComponent(b.ia)}" target="_blank" rel="noopener"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16"/></svg>${esc(t("download"))}</a>
         <a class="btn" href="https://archive.org/details/${encodeURIComponent(b.ia)}" target="_blank" rel="noopener">${esc(t("viewIA"))}</a>`
      : `<a class="btn primary" href="${fileUrl(b.path)}" target="_blank" rel="noopener">${esc(t("open"))}</a>`;
    const relTitle = related.length && sameAuthor(related[0]) ? t("related.author", { a: b.author }) : t("related.cat", { c: label });

    main.innerHTML = `<article class="book-page">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/browse">${esc(t("crumb.library"))}</a> / <a href="#/browse?cat=${encodeURIComponent(b.category)}">${esc(label)}</a></nav>
      <div>${cover(b, true)}</div>
      <div class="book-info">
        <span class="badge ${b.source === "pd" ? "pd" : ""}">${esc(t(b.source === "pd" ? "badge.pd" : "badge.own"))}</span>
        <h1>${esc(b.title)}</h1>
        ${b.author ? `<div class="by">${esc(t("by", { a: "\u0000" })).replace("\u0000", `<a href="#/browse?author=${encodeURIComponent(b.author)}">${esc(b.author)}</a>`)}</div>` : ""}
        <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
        <div class="actions">${actions}</div>
        ${b.source === "pd" ? `<p class="note">${esc(t("note.pd"))}</p>` : ""}
      </div>
      <div class="reader" id="reader" hidden></div>
      ${related.length ? `<section class="related section"><div class="section-head"><div><h2>${esc(relTitle)}</h2></div></div>
        <div class="shelf">${related.map(card).join("")}</div></section>` : ""}
    </article>`;

    const rb = document.getElementById("readBtn");
    rb && rb.addEventListener("click", () => {
      const r = document.getElementById("reader");
      const lbl = rb.querySelector("span");
      if (r.hidden) {
        r.innerHTML = `<iframe src="https://archive.org/embed/${encodeURIComponent(b.ia)}" title="${esc(b.title)}" allowfullscreen loading="lazy"></iframe>`;
        r.hidden = false;
        lbl.textContent = t("close");
        r.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        r.hidden = true; r.innerHTML = ""; lbl.textContent = t("read");
      }
    });
  }

  function viewAbout() {
    const pd = BOOKS.filter((b) => b.source === "pd").length;
    main.innerHTML = `<div class="prose">${t("about").replace("{n}", pd)}</div>`;
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
    if (e.target.closest("[data-random]")) {
      const b = BOOKS[Math.floor(Math.random() * BOOKS.length)];
      location.hash = "#/book/" + b.id;
      return;
    }
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
      go("/browse", p, path === "/browse");
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

  langSel.innerHTML = LANGS.map((l) => `<option value="${l.code}">${esc(l.label)}</option>`).join("");
  langSel.value = LANG;
  langSel.addEventListener("change", () => {
    LANG = langSel.value;
    try { localStorage.setItem("klibrary-lang", LANG); } catch (e) {}
    applyStatic();
    if (BOOKS.length) render();
  });
  applyStatic();

  // ---------- boot ----------
  fetch(CFG.catalogUrl || "data/catalog.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((data) => {
      BOOKS = data.books.map((b) => {
        const ti = norm(b.title), au = norm(b.author), ci = catInfo(b.category);
        const labels = ["en", "fr", "ht"].map((l) => (ci[l] ? norm(ci[l][0]) : "")).join(" ");
        return Object.assign(b, { _t: ti, _a: au, _h: ci.hue, _hay: [ti, au, norm(b.category), labels, norm(b.collection), b.year || ""].join(" ") });
      });
      BY_ID = new Map(BOOKS.map((b) => [b.id, b]));
      updateModeNote();
      render();
    })
    .catch(() => { main.innerHTML = `<div class="empty">${esc(t("error.catalog"))}</div>`; });
})();
