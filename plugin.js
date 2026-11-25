/// <reference path="./kino.d.ts" />

// language: JavaScript ES module · file: plugin.js · target: Kino (QuickJS, apiVersion 6)
// fuente: cinehaxplus.com – SSR, sin login. El vídeo sale de la API del reproductor incrustado (pass del sitio).
// El sitio sirve enlaces relativos (/pelicula/…) en la portada, en las rejillas y en las busquedas;
// los absolutos solo aparecen en los <link> de navegacion. Todo lector acepta las dos formas.

const BASE = "https://cinehaxplus.com";

// La caché dura una semana: el catalogo cambia a diario, pero un titulo o una temporada no.
const CACHE_MS = 7 * 24 * 3600 * 1000;

// ──────────────────────────────────────────────────────────────
// HELPERS – URL, refs y texto
// ──────────────────────────────────────────────────────────────

/** Un href del sitio (relativo o absoluto) a URL absoluta. */
function siteUrl(href) {
  const s = String(href || "");
  return /^https?:\/\//i.test(s) ? s : BASE + (s.charAt(0) === "/" ? s : "/" + s);
}

/** Extrae type+slug de un href como /pelicula/spider-man-2026, venga relativo o absoluto. */
function parseHref(href) {
  const m = href && String(href).match(/\/(pelicula|serie)\/([^/#?]+)/);
  return m ? { type: m[1], slug: m[2] } : null;
}

function buildId(type, slug) {
  return `${type}.${slug}`;
}

function encodeRef(data) {
  return JSON.stringify(data);
}

function decodeRef(ref) {
  if (typeof ref === "object" && ref !== null) return ref;
  if (typeof ref !== "string") return null;
  const s = ref.trim();
  const alt = decodeAlt(s);
  if (alt) return { alt };
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {}

  const epMatch = s.match(/(?:serie|series)\/([^/#?]+)\/temporada\/(\d+)\/episodio\/(\d+)/i);
  if (epMatch) {
    return {
      type: "episodio",
      slug: epMatch[1],
      season: parseInt(epMatch[2], 10),
      episode: parseInt(epMatch[3], 10),
    };
  }

  const itemMatch = s.match(/\/(pelicula|serie)\/([^/#?]+)/i);
  if (itemMatch) {
    return { type: itemMatch[1].toLowerCase(), slug: itemMatch[2] };
  }

  const dotMatch = s.match(/^(pelicula|serie)\.([^/#?]+)$/i);
  if (dotMatch) {
    return { type: dotMatch[1].toLowerCase(), slug: dotMatch[2] };
  }

  const genMatch = s.match(/(?:\/genero\/|^genero-)([^/#?]+)/i);
  if (genMatch) {
    return { genero: genMatch[1].toLowerCase() };
  }

  if (/\/peliculas\/?$/i.test(s) || s === "peliculas") return { list: "peliculas" };
  if (/\/series\/?$/i.test(s) || s === "series") return { list: "series" };
  if (["rating", "popular", "trending", "series-rating", "series-popular", "series-trending"].includes(s)) {
    return { list: s };
  }
  if (s.startsWith("lista-")) {
    const map = {
      "lista-nuevas": "peliculas",
      "lista-trending": "trending",
      "lista-popular": "popular",
      "lista-valoradas": "rating",
      "lista-series-nuevas": "series",
      "lista-series-trending": "series-trending",
      "lista-series-popular": "series-popular",
      "lista-series-valoradas": "series-rating",
    };
    if (map[s]) return { list: map[s] };
  }

  if (/^[a-z0-9-]+$/i.test(s)) {
    return { type: "pelicula", slug: s };
  }

  return null;
}

/** El año del slug (termina en -YYYY), como texto. */
function yearFromSlug(slug) {
  const m = String(slug || "").match(/-(\d{4})$/);
  return m ? m[1] : undefined;
}

const ACCENTS = { á: "a", à: "a", ä: "a", â: "a", é: "e", è: "e", ë: "e", ê: "e", í: "i", ì: "i", ï: "i", î: "i", ó: "o", ò: "o", ö: "o", ô: "o", ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c" };

/** Texto a id seguro (^[A-Za-z0-9._~-]{1,128}$): "Películas nuevas" → "peliculas-nuevas". */
function slugify(value) {
  const s = String(value || "").toLowerCase().replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, (c) => ACCENTS[c] || c);
  return (s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "fila").slice(0, 60);
}

function decodeEntities(value) {
  return String(value)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}

/** Texto visible de un trozo de HTML: sin etiquetas, sin saltos, entidades resueltas. */
function textOf(html) {
  return decodeEntities(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Los JSON-LD (schema.org) de una página, aplanados. */
function jsonLd(html) {
  const out = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    try {
      const data = JSON.parse(m[1]);
      if (Array.isArray(data)) out.push(...data);
      else if (data && Array.isArray(data["@graph"])) out.push(...data["@graph"]);
      else if (data) out.push(data);
    } catch { /* JSON roto: se ignora y se sigue con el HTML */ }
  }
  return out;
}

/** El primer JSON-LD de los tipos dados, o null (también dentro de mainEntity: /generos lo anida en CollectionPage). */
function ldOf(html, types) {
  const all = jsonLd(html);
  const hasType = (x) => x && types && types.includes(x["@type"]);
  return all.find(hasType) || all.map((x) => x && x.mainEntity).find(hasType) || null;
}

/** fetch que no lanza: null cuando el sitio no contesta bien. Nunca registra lo que la persona escribió. */
async function getText(path, opts) {
  try {
    // Un timeout propio: sin él, un fetch colgado se come el presupuesto entero de la llamada.
    const r = await kino.fetch(siteUrl(path), { timeoutMs: 9000, ...(opts || {}) });
    return r.ok ? r.text() : null;
  } catch (e) {
    kino.log("cinehax: fetch fallido", e && e.code ? e.code : "network");
    return null;
  }
}

// ──────────────────────────────────────────────────────────────
// HELPERS – caché, tarjetas y buscador del sitio
// ──────────────────────────────────────────────────────────────

function cacheGet(key) {
  try {
    const raw = kino.storage.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function cacheSet(key, value, ttlMs) {
  try {
    const raw = JSON.stringify(value);
    // La caché del plugin pesa 256 KB en total: lo que no entra se queda sin caché, pero se avisa.
    if (raw && raw.length < 60000) kino.storage.set(key, raw, { ttlMs: ttlMs || CACHE_MS });
    else if (raw) kino.log(`cache: ${key.slice(0, 24)} no entra (${raw.length} bytes)`);
  } catch { /* llena o no disponible: se sigue sin caché */ }
}

function cacheDrop(prefix) {
  try {
    for (const key of kino.storage.keys()) if (key.startsWith(prefix)) kino.storage.remove(key);
  } catch { /* nada que borrar */ }
}

/**
 * Tarjetas del sitio: <a class="pc"> en rejillas y búsquedas, el Top 10 en <ol class="rk">,
 * y el marcado antiguo .cd/.t10 por si el sitio vuelve atrás.
 * Devuelve items con título, año, valoración, duración y la imagen que la tarjeta trae.
 */
function parseCards(html, limit) {
  const max = limit || 100;
  const out = [];
  const seen = new Set();
  const src = String(html || "");
  const blocks = [];
  const cardRe = /<a class="(?:pc|cd|t10)" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = cardRe.exec(src)) !== null) blocks.push([m[1], m[2]]);
  const rk = /<ol class="rk">([\s\S]*?)<\/ol>/.exec(src);
  if (rk) {
    const liRe = /<li><a href="([^"]+)">([\s\S]*?)<\/a><\/li>/g;
    while ((m = liRe.exec(rk[1])) !== null) blocks.push([m[1], m[2]]);
  }

  for (const [href, block] of blocks) {
    if (out.length >= max) break;
    const where = parseHref(href);
    if (!where) continue;
    const { type, slug } = where;
    const id = buildId(type, slug);
    if (seen.has(id)) continue;
    seen.add(id);

    const titleTag = /<span class="(?:pc-t|cd-t)">([\s\S]*?)<\/span>/.exec(block);
    const alt = /alt="([^"]*)"/.exec(block);
    const title = textOf(titleTag ? titleTag[1] : alt ? alt[1] : "") || slug.replace(/-/g, " ");

    const yearM = /<span>(\d{4})<\/span>/.exec(block);
    const runtimeM = /<span>(?:(\d+)h\s*(\d+)\s*m|(\d+)m)<\/span>/.exec(block);
    const stkM = /class="stk">([\d.]+)</.exec(block);
    const pctM = /class="match">(\d{1,3})%/.exec(block) || /(\d{1,3})%/.exec(block);
    const image = (/<img src="(https:\/\/image\.tmdb\.org\/[^"]+)"/.exec(block) || [])[1];

    const item = {
      id,
      ref: encodeRef({ type, slug }),
      title,
      kind: type === "pelicula" ? "movie" : "series",
      year: yearM ? yearM[1] : yearFromSlug(slug),
      poster: image,
      backdrop: image,
    };
    if (stkM) item.rating = Number(stkM[1]);
    else if (pctM) item.rating = Number(pctM[1]) / 10;
    if (runtimeM) {
      const minutes = runtimeM[1] ? Number(runtimeM[1]) * 60 + Number(runtimeM[2] || 0) : Number(runtimeM[3] || 0);
      if (minutes > 0) item.runtimeMinutes = minutes;
    }
    out.push(item);
  }
  return out;
}

/** El buscador del sitio (/api/suggest): títulos con póster vertical, año y nota. */
async function suggest(text) {
  const body = await getText(`${BASE}/api/suggest?q=${encodeURIComponent(text)}`);
  if (!body) return [];
  let data;
  try { data = JSON.parse(body); } catch { return []; }
  const out = [];
  for (const t of Array.isArray(data && data.titles) ? data.titles : []) {
    const where = parseHref(t && t.url);
    if (!where) continue;
    out.push({
      type: where.type,
      slug: where.slug,
      title: typeof t.title === "string" && t.title ? t.title : undefined,
      year: t.year ? String(t.year) : undefined,
      poster: typeof t.poster === "string" ? t.poster : undefined,
      rating: typeof t.rating === "number" ? t.rating : undefined,
    });
  }
  return out;
}

/** Lo mismo, con caché; si el texto completo no da nada, se prueba con su cabecera ("Avatar: …" → "Avatar"). */
async function suggestHits(text) {
  const key = `buscar:${String(text).toLowerCase()}`;
  const saved = cacheGet(key);
  if (Array.isArray(saved)) return saved;

  let hits = await suggest(text);
  if (!hits.length) {
    const head = kino.rank.shortQuery(text);
    if (head && head !== text) hits = await suggest(head);
  }
  if (hits.length) cacheSet(key, hits);
  return hits;
}

function suggestItem(x) {
  const item = {
    id: buildId(x.type, x.slug),
    ref: encodeRef({ type: x.type, slug: x.slug }),
    title: x.title || x.slug.replace(/-/g, " "),
    kind: x.type === "pelicula" ? "movie" : "series",
    year: x.year || yearFromSlug(x.slug),
    poster: x.poster,
    backdrop: x.poster,
  };
  if (typeof x.rating === "number") item.rating = x.rating;
  return item;
}

/** Mezcla en los items de la rejilla el póster vertical y la nota exacta del buscador. */
function mergeSuggest(items, extra) {
  if (!extra.length) return items;
  const byKey = new Map(extra.map((x) => [`${x.type}/${x.slug}`, x]));
  for (const item of items) {
    const data = decodeRef(item.ref);
    const hit = data && byKey.get(`${data.type}/${data.slug}`);
    if (!hit) continue;
    if (hit.poster) { item.poster = hit.poster; item.backdrop = hit.poster; }
    if (typeof hit.rating === "number") item.rating = hit.rating;
    if (hit.year) item.year = hit.year;
    if (hit.title && (!item.title || item.title === data.slug.replace(/-/g, " "))) item.title = hit.title;
  }
  return items;
}

// ──────────────────────────────────────────────────────────────
// SEARCH
// ──────────────────────────────────────────────────────────────

export async function search(query) {
  await null; // evita rejection trap en Kino ≤ 0.9.49
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const original = String((query && query.originalTitle) || "").trim();
  const wantOriginal = original && original.toLowerCase() !== q.toLowerCase();

  // 1) la página de resultados, que trae todos los títulos
  let html = await getText(`${BASE}/search?q=${encodeURIComponent(q)}`);
  let items = html ? parseCards(html, 100) : [];
  let fromHtml = items.length > 0;

  // 2) si no hay nada, se prueba con el título original (TMDB) que Kino manda en el query
  if (!items.length && wantOriginal) {
    html = await getText(`${BASE}/search?q=${encodeURIComponent(original)}`);
    items = html ? parseCards(html, 100) : [];
    fromHtml = items.length > 0;
  }

  // 3) si aun así no hay nada, el JSON del buscador del sitio (resultado degradado, se avisa)
  if (!items.length) {
    items = (await suggestHits(q)).map(suggestItem);
    if (!items.length && wantOriginal) items = (await suggestHits(original)).map(suggestItem);
    if (items.length) kino.log.report("search_fallback: la página de búsqueda no dio títulos, se usó el buscador del sitio");
  } else if (fromHtml) {
    mergeSuggest(items, await suggestHits(q));
  }

  if (!items.length) return [];

  // El orden de Kino: lo que más se parece a lo pedido primero, con todos los títulos que sabe.
  const titles = [q];
  if (original) titles.push(original);
  for (const t of (query && Array.isArray(query.altTitles) ? query.altTitles : [])) {
    if (typeof t === "string" && t.trim()) titles.push(t.trim());
  }
  const sorted = kino.rank.sortBySimilarity(items, titles);
  // filterRelevant deja fuera lo que no se parece: si se llevara todo, se conserva el orden anterior
  // (mejor una lista con casi-coincidencias que no encontrar un título que sí está).
  const relevant = kino.rank.filterRelevant(sorted, titles);
  items = relevant.length ? relevant : sorted;

  // `type` es una pista, nunca un filtro: lo pedido queda delante, el resto después.
  const wanted = query && query.type === "movie" ? "movie" : query && query.type === "series" ? "series" : null;
  if (wanted) items = [...items.filter((i) => i.kind === wanted), ...items.filter((i) => i.kind !== wanted)];

  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= 100) break;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────
// HOME
// ──────────────────────────────────────────────────────────────

// Las filas de la portada que tienen una lista real detrás (Ver más → browse).
// El sitio enlaca "Películas nuevas" a /peliculas (recién añadidas), no a ?sort=release (estreno):
// son listas distintas y la de estreno no es lo último subido al sitio.
const ROW_REFS = {
  "joyas-para-descubrir": { list: "peliculas" },
  "tendencia-esta-semana": { list: "trending" },
  "peliculas-nuevas": { list: "peliculas" },
  "series-nuevas": { list: "series" },
  "mejor-valoradas": { list: "rating" },
  drama: { genero: "drama" },
  comedia: { genero: "comedia" },
  suspense: { genero: "suspense" },
};
const ROW_GENRES = { "peliculas-nuevas": "peliculas", "series-nuevas": "series" };

/** La ref de una fila o pestaña a partir del enlace "Explorar todo" del propio sitio. */
function refFromMore(href) {
  const s = String(href || "");
  const lista = /^\/(peliculas|series)(?:\?sort=([a-z]+))?/.exec(s);
  if (lista) {
    if (lista[1] === "peliculas") {
      if (!lista[2]) return { list: "peliculas" };
      return { list: lista[2] === "release" ? "peliculas-release" : lista[2] };
    }
    if (!lista[2]) return { list: "series" };
    return { list: `series-${lista[2]}` };
  }
  const genero = /^\/genero\/([a-z0-9-]+)/.exec(s);
  if (genero) return { genero: genero[1] };
  return null;
}

/** Las filas de la portada, leídas del HTML de la home. */
function homeRows(html) {
  const rows = [];
  const ids = new Set();
  const sections = String(html || "").split('<section class="row">').slice(1);
  for (const piece of sections) {
    const section = piece.split("</section>")[0];
    const titleM = /<h2 class="row-t">([\s\S]*?)<\/h2>/.exec(section);
    const title = titleM ? textOf(titleM[1]) : "";
    if (!title) continue;
    const items = parseCards(section, 60);
    if (!items.length) continue;

    let id = slugify(title);
    for (let n = 2; ids.has(id); n++) id = `${slugify(title)}-${n}`;
    ids.add(id);

    const row = { id, title, items };
    // El enlace del sitio manda: es la misma página a la que lleva "Explorar todo".
    const moreM = /<a class="more" href="([^"]+)"/.exec(section);
    const ref = moreM ? refFromMore(moreM[1]) : ROW_REFS[id];
    if (ref) row.ref = encodeRef(ref);
    if (ROW_GENRES[id]) row.genre = ROW_GENRES[id];
    rows.push(row);
    if (rows.length >= 20) break;
  }
  return rows;
}

export async function home() {
  await null;
  const html = await getText(`${BASE}/`);
  if (!html) throw kino.error("unavailable", "portada no disponible", { userMessage: "No se pudo cargar la portada. Inténtalo de nuevo." });

  const rows = homeRows(html);
  if (!rows.length) throw kino.error("unavailable", "portada sin filas", { userMessage: "No se pudo cargar la portada. Inténtalo de nuevo." });
  return rows;
}

// ──────────────────────────────────────────────────────────────
// SECTION – la sección propia de Kino (pestañas)
// ──────────────────────────────────────────────────────────────

const TABS = [
  { id: "inicio", label: "Inicio" },
  { id: "peliculas", label: "Películas" },
  { id: "series", label: "Series" },
];

// Las filas de las pestañas de lista: cada una es una página real del sitio (Ver más → browse).
// Las de series usan sus propias listas: "rating" a secas es la de películas.
const TAB_ROWS = {
  peliculas: [
    { id: "nuevas", title: "Recién añadidas", ref: { list: "peliculas" } },
    { id: "tendencia", title: "En tendencia", ref: { list: "trending" } },
    { id: "populares", title: "Populares", ref: { list: "popular" } },
    { id: "valoradas", title: "Mejor valoradas", ref: { list: "rating" } },
    { id: "estrenos", title: "Estrenos", ref: { list: "peliculas-release" } },
  ],
  series: [
    { id: "nuevas", title: "Recién añadidas", ref: { list: "series" } },
    { id: "tendencia", title: "En tendencia", ref: { list: "series-trending" } },
    { id: "populares", title: "Populares", ref: { list: "series-popular" } },
    { id: "valoradas", title: "Mejor valoradas", ref: { list: "series-rating" } },
    { id: "estrenos", title: "Estrenos", ref: { list: "series-release" } },
  ],
};

export async function section({ tab } = {}) {
  await null;
  const modo = String(kino.config.get("pestanas") || "ambas");
  const ids = ["inicio", ...(modo === "peliculas" ? ["peliculas"] : modo === "series" ? ["series"] : ["peliculas", "series"])];
  const tabs = ids.map((id) => ({ id, label: (TABS.find((t) => t.id === id) || {}).label || id }));
  const chosen = ids.indexOf(tab) >= 0 ? tab : ids[0];

  if (chosen === "inicio") {
    const html = await getText(`${BASE}/`);
    if (!html) throw kino.error("unavailable", "portada no disponible", { userMessage: "No se pudo cargar esta sección. Inténtalo de nuevo." });
    const rows = homeRows(html);
    if (!rows.length) throw kino.error("unavailable", "portada sin filas", { userMessage: "No se pudo cargar esta sección. Inténtalo de nuevo." });
    const first = rows[0].items[0];
    return {
      tabs,
      tab: chosen,
      hero: { title: first.title, text: "Lo más visto hoy en CineHax+", image: first.poster || first.backdrop },
      rows,
    };
  }

  const defs = TAB_ROWS[chosen] || [];
  const pages = await Promise.all(defs.map((d) => getText(listUrl(d.ref, 1))));
  const rows = [];
  defs.forEach((d, i) => {
    const items = pages[i] ? parseCards(pages[i], 24) : [];
    if (!items.length) return;
    rows.push({ id: `${chosen}-${d.id}`, title: d.title, ref: encodeRef(d.ref), items });
  });
  if (!rows.length) throw kino.error("unavailable", "sección sin filas", { userMessage: "No se pudo cargar esta sección. Inténtalo de nuevo." });
  return { tabs, tab: chosen, hero: null, rows };
}

// ──────────────────────────────────────────────────────────────
// CATEGORIES – los tiles de la página Categorías de Kino
// ──────────────────────────────────────────────────────────────

// Respaldo si /generos no contesta: los 26 géneros del sitio, en su orden (por número de títulos).
const GENRES = [
  ["drama", "Drama"], ["comedia", "Comedia"], ["suspense", "Suspense"], ["accion", "Acción"],
  ["terror", "Terror"], ["animacion", "Animación"], ["crimen", "Crimen"], ["romance", "Romance"],
  ["aventura", "Aventura"], ["misterio", "Misterio"], ["familia", "Familia"], ["ciencia-ficcion", "Ciencia ficción"],
  ["fantasia", "Fantasía"], ["ciencia-ficcion-y-fantasia", "Ciencia ficción y fantasía"],
  ["accion-y-aventura", "Acción y aventura"], ["documental", "Documental"], ["pelicula-de-tv", "Película de TV"],
  ["historia", "Historia"], ["musica", "Música"], ["belica", "Bélica"], ["western", "Western"],
  ["infantil", "Infantil"], ["belica-y-politica", "Bélica y política"], ["reality", "Reality"],
  ["telenovela", "Telenovela"], ["talk-show", "Talk show"],
];

/** Los géneros del sitio, leídos de su página /generos (JSON-LD ItemList, ordenados por tamaño). */
async function listaGeneros() {
  const html = await getText(`${BASE}/generos`);
  const list = ldOf(html, ["ItemList"]);
  const out = [];
  for (const x of list && Array.isArray(list.itemListElement) ? list.itemListElement : []) {
    const m = x && x.url && /\/genero\/([a-z0-9-]+)$/.exec(String(x.url));
    if (m && x.name) out.push([m[1], String(x.name)]);
  }
  return out.length ? out : GENRES;
}

export async function categories() {
  await null;
  const modo = String(kino.config.get("pestanas") || "ambas");
  const out = [];
  if (modo !== "series") {
    out.push({ id: "lista-nuevas", title: "Películas recién añadidas", ref: encodeRef({ list: "peliculas" }) });
    out.push({ id: "lista-trending", title: "Películas en tendencia", ref: encodeRef({ list: "trending" }) });
    out.push({ id: "lista-popular", title: "Películas populares", ref: encodeRef({ list: "popular" }) });
    out.push({ id: "lista-valoradas", title: "Películas mejor valoradas", ref: encodeRef({ list: "rating" }) });
  }
  if (modo !== "peliculas") {
    out.push({ id: "lista-series-nuevas", title: "Series recién añadidas", ref: encodeRef({ list: "series" }) });
    out.push({ id: "lista-series-trending", title: "Series en tendencia", ref: encodeRef({ list: "series-trending" }) });
    out.push({ id: "lista-series-popular", title: "Series populares", ref: encodeRef({ list: "series-popular" }) });
    out.push({ id: "lista-series-valoradas", title: "Series mejor valoradas", ref: encodeRef({ list: "series-rating" }) });
  }
  // Kino admite 24 tiles: los géneros del sitio (todos los que quepan) van después de las listas.
  for (const g of await listaGeneros()) out.push({ id: `genero-${g[0]}`, title: g[1], ref: encodeRef({ genero: g[0] }) });
  return out.slice(0, 24);
}

// ──────────────────────────────────────────────────────────────
// BROWSE – paginación de listas
// ──────────────────────────────────────────────────────────────

/** La URL de una lista: el sitio pagina en /page/N, nunca en ?page=N (ese parámetro se ignora). */
function listUrl(data, page) {
  const path = (base, query) => (page > 1 ? `${base}/page/${page}${query || ""}` : `${base}${query || ""}`);
  if (data.genero) return path(`${BASE}/genero/${encodeURIComponent(data.genero)}`);
  switch (data.list) {
    case "home": return page > 1 ? `${BASE}/page/${page}` : `${BASE}/`;
    case "trending": return path(`${BASE}/peliculas`, "?sort=trending");
    case "popular": return path(`${BASE}/peliculas`, "?sort=popular");
    case "rating": return path(`${BASE}/peliculas`, "?sort=rating");
    case "peliculas-release": return path(`${BASE}/peliculas`, "?sort=release");
    case "peliculas": return path(`${BASE}/peliculas`);
    case "series-release": return path(`${BASE}/series`, "?sort=release");
    case "series-popular": return path(`${BASE}/series`, "?sort=popular");
    case "series-rating": return path(`${BASE}/series`, "?sort=rating");
    case "series-trending": return path(`${BASE}/series`, "?sort=trending");
    case "series": return path(`${BASE}/series`);
    default: return null;
  }
}

export async function browse(ref, cursor) {
  await null;
  const data = decodeRef(ref);
  if (!data) throw kino.error("not_found", "ref inválido");

  const page = Math.max(1, parseInt(String(cursor || "1"), 10) || 1);
  const url = listUrl(data, page);
  if (!url) throw kino.error("not_found", "ref de lista desconocido", { userMessage: "Esta sección ya no existe." });

  const html = await getText(url);
  if (!html) {
    if (page > 1) return { items: [] }; // la lista se acabó: se responde vacía, sin "Ver más"
    throw kino.error("unavailable", `lista no disponible, página ${page}`, { userMessage: "No se pudo cargar esta sección. Inténtalo de nuevo." });
  }

  const items = parseCards(html, 100);
  if (!items.length && page === 1) throw kino.error("not_found", "lista vacía", { userMessage: "Esta sección no tiene títulos ahora." });

  return {
    items,
    next: /<link rel="next"/.test(html) ? String(page + 1) : undefined,
  };
}

// ──────────────────────────────────────────────────────────────
// EPISODES – temporadas y episodios de una serie
// ──────────────────────────────────────────────────────────────

/** Las temporadas de la página de la serie: JSON-LD `containsSeason`, y si no, los enlaces. */
function seasonNumbers(html) {
  const found = new Set();
  const series = ldOf(html, ["TVSeries"]);
  for (const s of series && Array.isArray(series.containsSeason) ? series.containsSeason : []) {
    const n = s && Number(s.seasonNumber);
    if (Number.isInteger(n) && n >= 1 && n <= 999) found.add(n);
  }
  const re = /\/serie\/[^"'?]+\/temporada\/(\d+)/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 999) found.add(n);
  }
  return [...found].sort((a, b) => a - b).slice(0, 50);
}

/** "30/09/2008" → "2008-09-30"; lo que no sea esa forma se deja caer. */
function isoDate(value) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(String(value || ""));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
}

/** Los episodios de la página de una temporada, desde el marcado real de cada tarjeta. */
function parseEpisodes(html, slug) {
  const out = [];
  const re = /<a class="ep" href="([^"]+)">([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(String(html || ""))) !== null) {
    const where = /\/temporada\/(\d+)\/episodio\/(\d+)/.exec(m[1]);
    if (!where) continue;
    const season = parseInt(where[1], 10);
    const number = parseInt(where[2], 10);
    if (!(season >= 1 && number >= 1)) continue;
    const block = m[2];

    const titleM = /<span class="ep-t">([\s\S]*?)<\/span>/.exec(block);
    const dateM = /<span class="ep-s">([\s\S]*?)<\/span>/.exec(block);
    const overviewM = /<span class="ep-o">([\s\S]*?)<\/span>/.exec(block);
    const durationM = /<span class="ep-d">(\d+)\s*min/.exec(block);
    const stillM = /<img src="(https:\/\/image\.tmdb\.org\/[^"]+)"/.exec(block);

    const episode = {
      season,
      number,
      ref: encodeRef({ type: "episodio", slug, season, episode: number }),
      title: (titleM ? textOf(titleM[1]).replace(/^\d+\.\s*/, "") : "") || `Capítulo ${number}`,
    };
    const overview = overviewM ? textOf(overviewM[1]) : "";
    if (overview) episode.overview = overview;
    const airDate = isoDate(dateM && dateM[1]);
    if (airDate) episode.airDate = airDate;
    if (durationM) episode.runtimeMinutes = parseInt(durationM[1], 10);
    if (stillM) episode.still = stillM[1].replace(/\/t\/p\/[a-z0-9]+\//, "/t/p/w500/");
    out.push(episode);
  }

  // Respaldo: el JSON-LD de la temporada, si el marcado cambia algún día.
  if (!out.length) {
    const season = ldOf(html, ["TVSeason"]);
    for (const e of season && Array.isArray(season.episode) ? season.episode : []) {
      const number = e && Number(e.episodeNumber);
      if (!Number.isInteger(number) || number < 1) continue;
      const s = Number(season.seasonNumber) || 1;
      const episode = {
        season: s,
        number,
        ref: encodeRef({ type: "episodio", slug, season: s, episode: number }),
        title: (typeof e.name === "string" && e.name) || `Capítulo ${number}`,
      };
      if (typeof e.datePublished === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.datePublished)) episode.airDate = e.datePublished;
      out.push(episode);
    }
  }
  return out;
}

/** Lo que Kino muestra junto a los episodios: del JSON-LD de la serie. */
function seriesInfo(html, slug) {
  const series = ldOf(html, ["TVSeries"]);
  const images = series && series.image ? (Array.isArray(series.image) ? series.image : [series.image]) : [];
  const info = { title: (series && series.name) || slug.replace(/-/g, " ") };
  if (images[0]) info.poster = images[0];
  if (images[1]) info.backdrop = images[1];
  if (series && typeof series.description === "string" && series.description) info.overview = series.description;
  if (series && Array.isArray(series.genre) && series.genre.length) info.genres = series.genre.slice(0, 5);
  const year = (series && typeof series.startDate === "string" && series.startDate.slice(0, 4)) || yearFromSlug(slug);
  if (year) info.year = year;
  return info;
}

export async function episodes(ref) {
  await null;
  const data = decodeRef(ref);
  if (!data || data.type !== "serie") throw kino.error("not_found", "ref no es una serie");
  const { slug } = data;
  if (!slug) throw kino.error("not_found", "ref sin slug");

  // Cada temporada se guarda por separado: una serie de 100 capítulos no cabe en una sola entrada de
  // caché, y volver a abrirla solo pide las temporadas que aún no están guardadas.
  const serieHtml = await getText(`${BASE}/serie/${slug}`);
  if (!serieHtml) throw kino.error("unavailable", "serie no disponible", { userMessage: "Esta serie no está disponible ahora." });

  const seasons = seasonNumbers(serieHtml);
  if (!seasons.length) throw kino.error("not_found", "sin temporadas", { userMessage: "Esta serie no tiene episodios disponibles." });

  const all = [];
  let missing = 0;
  for (let i = 0; i < seasons.length; i += 6) { // 6 peticiones a la vez, el máximo de Kino
    const trozo = seasons.slice(i, i + 6);
    const porPedir = [];
    for (const n of trozo) {
      const guardada = cacheGet(`temporada:${slug}:${n}`);
      // Una lista vacía guardada también cuenta: es una temporada que el sitio no tiene.
      if (Array.isArray(guardada)) { all.push(...guardada); continue; }
      porPedir.push(n);
    }
    if (!porPedir.length) continue;
    const pages = await Promise.all(porPedir.map((n) => getText(`${BASE}/serie/${slug}/temporada/${n}`)));
    for (let j = 0; j < porPedir.length; j++) {
      if (!pages[j]) {
        missing++;
        // Una temporada sin página se recuerda una hora: no se vuelve a pedir en cada apertura de la serie.
        cacheSet(`temporada:${slug}:${porPedir[j]}`, [], 3600 * 1000);
        continue;
      }
      const eps = parseEpisodes(pages[j], slug);
      cacheSet(`temporada:${slug}:${porPedir[j]}`, eps);
      all.push(...eps);
    }
    if (all.length >= 5000) break;
  }
  // Una temporada que no contesta se deja fuera: el resultado sirve, pero no está completo.
  if (missing) kino.log.report(`temporadas: ${missing} sin página`);

  if (!all.length) throw kino.error("not_found", "sin episodios", { userMessage: "Esta serie no tiene episodios disponibles." });

  return { series: seriesInfo(serieHtml, slug), episodes: all.slice(0, 5000) };
}

/**
 * Kino 0.9.88 llama a prepare(ref) mientras la persona lee la ficha, para calentar resolve(). Aquí se
 * deja el enlace bueno en la caché. Es una llamada de fondo (sin navegador) y nunca puede lanzar.
 */
export async function prepare(ref) {
  await null;
  try {
    const data = decodeRef(ref);
    if (!data || data.alt || data.type === "serie" || !data.slug) return;
    const clave = `ok:${data.type}:${data.slug}:${data.season || ""}:${data.episode || ""}`;
    if (leerBueno(clave)) return;
    // Sin navegador: preparar es una llamada de fondo y no puede abrir el reproductor oculto.
    await resuelve(ref, false, 9000); // un tope propio: preparar es opcional y no debe tardar como una reproducción
  } catch (_) { /* preparar nunca puede estorbar una reproducción */ }
}

// ──────────────────────────────────────────────────────────────
// RESOLVE – el enlace del vídeo: pass del sitio + API del reproductor incrustado
// ──────────────────────────────────────────────────────────────

/** El iframe del reproductor que la página de visionado deja en su fachada: dónde incrusta y con qué pass. */
function embedTag(html) {
  const m = /data-embed="([^"]+)"/.exec(String(html || ""));
  if (!m) return null;
  const tag = decodeEntities(m[1]);
  const src = (/\ssrc="([^"]+)"/.exec(tag) || [])[1];
  const pass = (/\sdata-pass="([^"]+)"/.exec(tag) || [])[1];
  // CineHax deja dm-api.invalid en el HTML y su JavaScript lo sustituye antes de cargar el iframe.
  // Kino no ejecuta ese JavaScript al leer la fachada, así que se normaliza al origen real permitido.
  const playerSrc = String(src || "").replace(/https?:\/\/dm-api\.invalid\b/i, "https://api-encrypted.moviemaster.lat");
  return playerSrc && pass ? { src: siteUrl(playerSrc), pass: siteUrl(pass) } : null;
}

/** El host de una URL (el reproductor está en otro dominio que el sitio). */
function originOf(url) {
  const m = /^https?:\/\/[^/]+/.exec(String(url || ""));
  return m ? m[0] : null;
}

/** Los parámetros que la API del reproductor entiende: tmdb, tipo y, en series, temporada y episodio. */
function embParams(emb) {
  let qs = `tmdb=${emb.tmdb}&type=${emb.type}`;
  if (emb.type === "tv") qs += `&season=${emb.season || 1}&episode=${emb.episode || 1}`;
  return qs;
}

/** Reserva si la página del reproductor no trae su PM_EMBED: los números salen de la propia dirección del embed. */
function embFromSrc(src) {
  const m = /\/embed\/(movie|tv)\/(\d+)(?:\/(\d+)\/(\d+))?/.exec(String(src || ""));
  if (!m) return null;
  const emb = { type: m[1], tmdb: parseInt(m[2], 10) };
  if (m[1] === "tv") {
    emb.season = parseInt(m[3] || "1", 10) || 1;
    emb.episode = parseInt(m[4] || "1", 10) || 1;
  }
  const lang = (/[?&]lang=([A-Za-z]{3})/.exec(src) || [])[1];
  if (lang) emb.lang = lang;
  return emb;
}

/** Los servidores en el mismo orden en que el reproductor los arranca: el idioma pedido primero, luego directos antes que proxys. */
function ordenaServidores(lista, lang, prefiere) {
  const peso = (s) => {
    const propio = String(s.lang || "").toUpperCase();
    if (prefiere && propio.includes(prefiere)) return 0;
    if (lang && s.lang === lang) return 1;
    return 2;
  };
  return lista.slice().sort((a, b) =>
    peso(a) - peso(b) ||
    ((a.mode === "proxy") - (b.mode === "proxy")) ||
    ((a.detras ? 1 : 0) - (b.detras ? 1 : 0)) ||
    ((a.src || 9) - (b.src || 9)));
}

/** fetch que no lanza y devuelve JSON ya parseado. */
async function getJson(url, options) {
  try {
    const opts = { timeoutMs: 6000, ...(options || {}) };
    const r = await kino.fetch(url, opts);
    return r.ok ? JSON.parse(await r.text()) : null;
  } catch { return null; }
}

/** True si todas las direcciones de la lista son de anuncios (el CDN de anuncios del sitio). */
function soloAnuncios(direcciones) {
  if (!direcciones.length) return false;
  for (const d of direcciones) if (!/tiktokcdn|ad-site|\/ad\//i.test(d)) return false;
  return true;
}

// Señales frecuentes de manifiestos de pre-roll/mid-roll. Se descartan aunque
// el anuncio se sirva desde el mismo CDN del contenido, sin depender del host.
function manifiestoConPublicidad(lista) {
  const txt = String(lista || "");
  return /#EXT-X-DATERANGE:[^\n]*(CLASS|SCTE35|ad-|advert|preroll|midroll)|#EXT-X-CUE-(OUT|IN)|#EXT-OATCLS-SCTE35|#EXT-X-SPLICEPOINT-SCTE35/i.test(txt);
}

// Los anuncios VOD de los servidores de CineHax son listas terminadas de segundos/minutos,
// mientras que películas y episodios superan ampliamente ese total. No se aplica a listas en vivo
// ni a manifiestos sin ENDLIST para evitar descartar contenido cuya duración se desconoce.
function duracionPublicidad(lista) {
  if (lista.indexOf("#EXT-X-ENDLIST") < 0) return false;
  let total = 0;
  let tramos = 0;
  const re = /#EXTINF:([\d.]+)/g;
  let m;
  while ((m = re.exec(lista)) !== null) {
    total += Number(m[1]) || 0;
    tramos += 1;
  }
  return tramos >= 2 && total > 0 && total <= 180;
}

/**
 * ¿La lista HLS trae vídeo de verdad? Se descartan listas que solo apuntan a anuncios y VODs muy
 * cortos ya terminados (publicidad). Los servidores siguientes se prueban antes de devolver un
 * stream a Kino. Sin respuesta se confía en la fuente, para no romper una reproducción por red lenta.
 */
async function listaSana(url, opciones) {
  try {
    const r = await kino.fetch(url, opciones);
    if (!r.ok) return true;
    const txt = await r.text();
    if (txt.indexOf("#EXTM3U") < 0) return false;
    const urls = txt.split("\n").filter((l) => l && l.charAt(0) !== "#");
    if (txt.indexOf("#EXTINF") >= 0) {
      return !soloAnuncios(urls) && !duracionPublicidad(txt) && !manifiestoConPublicidad(txt);
    }
    if (!urls[0]) return false;
    const v = await kino.fetch(new URL(urls[0], url).href, opciones);
    if (!v.ok) return false;
    const vt = await v.text();
    if (vt.indexOf("#EXTM3U") < 0) return false;
    return !soloAnuncios(vt.split("\n").filter((l) => l && l.charAt(0) !== "#")) &&
      !duracionPublicidad(vt) && !manifiestoConPublicidad(vt);
  } catch { return true; }
}

// Los enlaces del reproductor van atados al User-Agent que los pidió: el mismo abre el stream
// y lo reproduce, o el servidor responde 403.
const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Safari/537.36";

// ── Kino Resolver: el motor compartido de hosters (xuper-plugin/kino-plugin-kino-resolver) ──
// El plugin deja de adivinar cada hoster: le pasa el embed a la puerta de Kino y traduce la respuesta.
// La puerta es una llamada en segundo plano y NO puede abrir el navegador oculto: un hoster con puerta
// JavaScript vuelve como `needs_browser` y lo captura este plugin, que sí puede.
const RESOLVER_ALIAS = "resolver";

function puertaDisponible() {
  try { return !!(kino && kino.plugins && typeof kino.plugins.call === "function"); } catch (_) { return false; }
}

/** Una respuesta de la puerta, sin lanzar: `{ res }` o `{ code, missing }`. */
async function puertaResolve(url, referer) {
  if (!puertaDisponible()) return { code: "provider_missing", missing: true };
  try {
    return { res: (await kino.plugins.call(RESOLVER_ALIAS, "resolve", { url, referer })) || null };
  } catch (e) {
    const code = (e && e.code) || "call_failed";
    kino.log("resolver: " + code);
    return { code, missing: code === "provider_missing" };
  }
}

/** Los servidores ordenados por cómo reproduce de verdad cada hoster (llamada `rank` del resolver). */
async function ordenaConResolver(lista) {
  if (lista.length < 2 || !puertaDisponible()) return lista;
  try {
    const r = await kino.plugins.call(RESOLVER_ALIAS, "rank", {
      urls: lista.slice(0, 64).map((s) => String(s.url || s.host || s.name || "")),
    });
    const scores = r && Array.isArray(r.scores) ? r.scores : null;
    if (!scores) return lista;
    // -1 significa "no lo ofrezcas": el hoster está muerto o tiene una puerta imposible.
    return lista
      .map((s, i) => ({ s, i, score: typeof scores[i] === "number" ? scores[i] : 0 }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((x) => x.s);
  } catch (_) { return lista; }
}

/** El stream de la puerta en la forma de Kino: kind→mime, headers (lista u objeto) y subtítulos. */
function streamDePuerta(res, referer, nombre) {
  const lista = res && Array.isArray(res.streams) ? res.streams : [];
  const st = lista.find((s) => s && s.url && (s.kind === "hls" || /\.m3u8(\?|$)/i.test(s.url))) ||
    lista.find((s) => s && s.url);
  if (!st) return null;
  const headers = { "User-Agent": UA };
  if (st.referer || referer) headers.Referer = st.referer || referer;
  if (Array.isArray(st.headers)) {
    for (const h of st.headers) if (h && h.name) headers[h.name] = String(h.value);
  } else if (st.headers && typeof st.headers === "object") {
    for (const k of Object.keys(st.headers)) if (st.headers[k] != null) headers[k] = String(st.headers[k]);
  }
  const hls = st.kind === "hls" || /\.m3u8(\?|$)/i.test(st.url);
  const subs = (Array.isArray(res && res.subtitles) ? res.subtitles : [])
    .filter((s) => s && typeof s.url === "string" && s.url)
    .slice(0, 30)
    .map((s) => ({ url: s.url, lang: (typeof s.lang === "string" && s.lang) || "und" }));
  return {
    url: st.url,
    mime: hls ? "application/x-mpegURL" : (st.kind === "mp4" ? "video/mp4" : undefined),
    headers,
    serverName: st.server || nombre,
    ...(subs.length ? { subtitles: subs } : {}),
  };
}

/** Un enlace de un CDN de anuncios (el pre-roll del reproductor). */
function pareceAnuncio(url) {
  return /tiktokcdn|doubleclick|ad-site|\/ad\/|\badvert/i.test(String(url || ""));
}

/**
 * El medio que de verdad es la película: un manifiesto (HLS/DASH) que no sea publicidad, comprobado con
 * listaSana; si ninguno pasa, el primero que no venga de un CDN de anuncios. Nunca `media[0]` a ciegas,
 * que en estos reproductores es el pre-roll.
 */
async function mejorMedia(media) {
  const lista = (Array.isArray(media) ? media : []).filter((m) => m && typeof m.url === "string" && m.url);
  const limpios = lista.filter((m) => !pareceAnuncio(m.url));
  const pool = limpios.length ? limpios : lista;
  const manifiestos = pool.filter((m) =>
    m.mime === "application/x-mpegURL" || m.mime === "application/dash+xml" || /\.(m3u8|mpd)(\?|$)/i.test(m.url));
  for (const m of manifiestos.slice(0, 3)) {
    if (await listaSana(m.url, { headers: m.headers || {} })) return m;
  }
  return manifiestos[0] || pool[0] || null;
}

function formatLang(lang) {
  const l = String(lang || "").toUpperCase();
  if (l.includes("LAT")) return "🇲🇽 Latino";
  if (l.includes("CAST") || l.includes("ESP")) return "🇪🇸 Castellano";
  if (l.includes("SUB")) return "🇺🇸 Subtitulado";
  return lang || "Audio";
}

async function verificaServidor(s, origin, params, ui, pide, hasta) {
  const referer = `${origin}/`;
  // Cada intento tiene su propio reloj: ni una petición puede comerse la llamada entera.
  const peticion = { ...pide, timeoutMs: Math.max(1200, Math.min(6000, restante(hasta || Date.now() + ATTEMPT_MS))) };
  let v = null;
  try {
    v = await getJson(`${origin}/video?${params}&noiframe=1&embed=${encodeURIComponent(s.id)}&r=1&ui=${encodeURIComponent(ui)}`, peticion);
  } catch (_) { v = null; }

  // 1) El reproductor ya da el enlace: es lo más rápido y no pasa por ningún hoster.
  if (v && v.url && v.type !== "iframe") {
    if ((v.type === "hls" || v.type === "dash") && !(await listaSana(v.url, peticion))) {
      kino.log(`flujo: lista sin vídeo en ${s.name || String(s.id).slice(0, 8)}, se salta`);
      return null;
    }
    // Un mp4 no se puede medir sin descargarlo, pero al menos no puede venir de un CDN de anuncios.
    if (v.type === "mp4" && pareceAnuncio(v.url)) return null;
    return {
      url: v.url,
      mime: v.type === "hls" ? "application/x-mpegURL" : (v.type === "dash" ? "application/dash+xml" : (v.type === "mp4" ? "video/mp4" : undefined)),
      headers: { "User-Agent": UA, Referer: referer },
      serverName: s.name || s.host || "Servidor",
      lang: s.lang || "",
    };
  }

  // 2) Hoster o iframe (o /video caído): lo resuelve el motor compartido, no este plugin.
  const embedUrl = (v && v.url) || s.url;
  if (!embedUrl || !/^https?:\/\//i.test(String(embedUrl))) return null;
  const r = await puertaResolve(embedUrl, referer);
  if (r.res) {
    // `dead`: hoster borrado o bloqueado. Ningún navegador lo arregla, así que no se pierde tiempo capturándolo.
    if (r.res.error === "dead") {
      kino.log(`flujo: ${s.name || String(s.id).slice(0, 8)} muerto en el motor`);
      return null;
    }
    const out = streamDePuerta(r.res, referer, s.name || "Kino Resolver");
    if (out) { out.lang = s.lang || ""; return out; }
  }
  // needs_browser / provider_missing: la puerta no puede abrir el navegador; este plugin sí, y lo hace el respaldo.
  return null;
}

// ── El presupuesto de una reproducción ──────────────────────────
// Kino da 20 s a resolve(); con el navegador oculto aprobado, 75 s. Todo se mide contra ese reloj:
// ninguna petición puede comerse la llamada, y lo que no entra en el presupuesto no se intenta.
const RESOLVE_MS = 18000;
const RESOLVE_BROWSER_MS = 56000;
const ATTEMPT_MS = 5200;          // un servidor que no contesta en esto ya no interesa
const MAX_SERVIDORES = 8;         // servidores que se prueban en una reproducción
const MAX_ALTERNATIVAS = 8;       // copias que Kino enseña en "Servidor y calidad"
const MAX_REF = 480;              // Kino descarta una copia cuya ref pase de 512
const CACHE_OK = 30 * 60 * 1000;  // un enlace que funcionó vale media hora

const restante = (hasta) => Math.max(0, hasta - Date.now());

/** Lo que la persona lee cuando el sitio no tiene el título: no es un fallo, es su catálogo. */
function noDisponible(data) {
  const que = data && (data.type === "serie" || data.type === "episodio") ? "Esta serie" : "Este título";
  return kino.error("not_found", "sin servidores en el sitio", {
    userMessage: `${que} no está disponible en CineHax+.`,
  });
}

/** El idioma preferido del ajuste `idioma`, como prefijo de los `lang` del sitio. */
function idiomaPreferido() {
  const v = String(kino.config.get("idioma") || "auto");
  return v === "lat" ? "LAT" : v === "cast" ? "ESP" : v === "sub" ? "SUB" : "";
}

/** La etiqueta de una copia: idioma · servidor. */
function etiqueta(s, lang) {
  const idioma = formatLang(s.lang || lang || "");
  const nombre = s.name || s.host || "Servidor";
  return `${idioma} · ${nombre}`.slice(0, 48);
}

// ── Copias alternativas (la hoja "Servidor y calidad" de Kino) ──
function b64url(texto) {
  const bytes = new TextEncoder().encode(texto);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch (_) { return null; }
}

/**
 * Una copia se guarda como `alt:` + base64url({w,x,n,l}): la dirección de la ficha, el ÍNDICE del servidor
 * en la lista del reproductor (los ids reales son largos y no caben en una ref), su nombre y su idioma.
 */
function refCopia(watchUrl, s, lang, indice) {
  return "alt:" + b64url(JSON.stringify({
    w: watchUrl, x: indice, n: s.name || s.host || "Servidor", l: s.lang || lang || "",
  }));
}

function decodeAlt(ref) {
  if (typeof ref !== "string" || ref.slice(0, 4) !== "alt:") return null;
  const raw = unb64url(ref.slice(4));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d.w === "string" && Number.isInteger(d.x) && d.x >= 0 ? d : null;
  } catch (_) { return null; }
}

/** Las demás copias, como alternativas diferidas: Kino solo las resuelve si la persona las elige. */
function conAlternativas(stream, orden, elegido, watchUrl, lista) {
  const origen = lista || [];
  const alternatives = (orden || [])
    .filter((s) => s !== elegido)
    .map((s) => ({ s, x: origen.indexOf(s) }))
    .filter((c) => c.x >= 0)
    .slice(0, MAX_ALTERNATIVAS)
    .map((c) => ({ label: etiqueta(c.s, ""), ref: refCopia(watchUrl, c.s, "", c.x) }))
    .filter((a) => a.ref.length <= MAX_REF);
  return alternatives.length ? { ...stream, alternatives } : stream;
}

/** El último enlace bueno de un título (30 min), para no repetir cuatro peticiones cada vez. */
function leerBueno(clave) {
  const v = cacheGet(clave);
  return v && typeof v.url === "string" && v.url ? v : null;
}

function guardarBueno(clave, stream) {
  cacheSet(clave, {
    url: stream.url,
    headers: stream.headers || {},
    mime: stream.mime,
    label: stream.label,
    // Las copias viajan con el enlace guardado: la hoja "Servidor y calidad" sigue ahí al repetir.
    alternatives: Array.isArray(stream.alternatives) ? stream.alternatives.slice(0, MAX_ALTERNATIVAS) : undefined,
  }, CACHE_OK);
}

/**
 * Abre el reproductor incrustado: la fachada de la página, el pass del sitio, su PM_UI y la lista de
 * servidores. Devuelve null si el sitio no deja ni eso.
 */
async function abreReproductor(watchUrl) {
  const page = await getText(watchUrl, { timeoutMs: 7000 });
  const embed = embedTag(page);
  if (!embed) return null;

  // El pass dura 10 minutos y va atado al título: se pide siempre fresco, desde el sitio.
  const pass = await getJson(embed.pass, { timeoutMs: 6000 });
  if (!pass || !pass.pass) return null;

  const sep = embed.src.includes("?") ? "&" : "?";
  let embedHtml = null;
  try {
    const r = await kino.fetch(`${embed.src}${sep}pass=${encodeURIComponent(pass.pass)}`, {
      headers: { "User-Agent": UA }, timeoutMs: 8000,
    });
    embedHtml = r.ok ? await r.text() : null;
  } catch (_) { embedHtml = null; }
  if (!embedHtml) return null;

  const ui = (embedHtml.match(/PM_UI="([^"]+)"/) || [])[1];
  let emb = null;
  try { emb = JSON.parse((embedHtml.match(/PM_EMBED=(\{[^}]+\})/) || [])[1] || "null"); } catch (_) { /* vale la dirección del embed */ }
  if (!emb) emb = embFromSrc(embed.src);
  const origin = originOf(embed.src);
  if (!ui || !emb || !emb.tmdb || !origin) return null;

  const params = embParams(emb);
  const pide = { headers: { "User-Agent": UA } };
  const srv = await getJson(`${origin}/servers?${params}&ui=${encodeURIComponent(ui)}`, pide);
  if (!srv) return null;
  const lista = (Array.isArray(srv.servers) ? srv.servers : []).filter((s) => s && s.id);
  return {
    origin, params, ui, pide, lista, lang: emb.lang || "",
    pendiente: srv.pendiente === true,
    embed, watchUrl,
  };
}

/**
 * El vídeo no está en la página: la web solo deja una fachada con espera, y el reproductor incrustado
 * pide el enlace a su propia API con dos credenciales que ella misma sirve (pass del sitio + ui suyo).
 * Así se salta el anuncio del reproductor y el navegador oculto, que a menudo no llega a montar nada.
 * `{ stream, orden, servidor }` cuando hay copia; `{ vacio: true, pendiente }` cuando el sitio no tiene.
 */
async function flujoPlayer(watchUrl, opts = {}) {
  const t0 = Date.now();
  const hasta = opts.hasta || Date.now() + RESOLVE_MS;
  const reproductor = await abreReproductor(watchUrl);
  if (!reproductor) return null;
  if (!reproductor.lista.length) {
    return { vacio: true, pendiente: reproductor.pendiente, reproductor };
  }

  // La copia pedida llega como índice en la lista del reproductor (una ref tiene que ser corta).
  const elegida = Number.isInteger(opts.preferidoIdx) ? reproductor.lista[opts.preferidoIdx] : null;
  let orden = ordenaServidores(reproductor.lista, reproductor.lang, idiomaPreferido());
  if (elegida) {
    const i = orden.indexOf(elegida);
    if (i > 0) orden = [orden[i], ...orden.slice(0, i), ...orden.slice(i + 1)];
  }
  orden = await ordenaConResolver(orden);

  const limite = Math.min(orden.length, MAX_SERVIDORES);
  let pidioMotor = false; // hubo un hoster que solo el motor compartido podía abrir
  for (let i = 0; i < limite; i += 1) {
    if (restante(hasta) < 1200) break; // sin tiempo para otro intento: mejor responder ya
    const s = orden[i];
    const res = await verificaServidor(s, reproductor.origin, reproductor.params, reproductor.ui, reproductor.pide, hasta);
    if (!res) {
      if (s.url && !puertaDisponible()) pidioMotor = true;
      continue;
    }
    kino.log(`flujo: ${res.serverName} en ${Date.now() - t0} ms`);
    return {
      stream: {
        url: res.url,
        headers: res.headers,
        mime: res.mime,
        label: res.subtitles ? `${etiqueta(s, reproductor.lang)} · subtítulos` : etiqueta(s, reproductor.lang),
        ...(res.subtitles ? { subtitles: res.subtitles } : {}),
      },
      orden,
      servidor: s,
      reproductor,
    };
  }
  return { vacio: true, pendiente: reproductor.pendiente, reproductor, orden, pidioMotor };
}

/** El navegador oculto: último recurso, solo si Kino lo permite y queda tiempo. Nunca `media[0]` a ciegas. */
async function capturaDelReproductor(watchUrl, hasta) {
  const page = await getText(watchUrl, { timeoutMs: 6000 });
  const embed = embedTag(page);
  const url = embed ? embed.src : watchUrl;
  const origin = originOf(url);
  const referer = origin ? `${origin}/` : `${BASE}/`;
  let captured = null;

  if (kino.browser && typeof kino.browser.capture === "function") {
    try {
      captured = await kino.browser.capture(url, {
        timeoutMs: Math.min(18000, Math.max(6000, restante(hasta) - 2500)),
        headers: { Referer: referer },
      });
    } catch (_) { captured = null; }
  }
  if ((!captured || !captured.media || !captured.media.length) &&
      kino.browser && typeof kino.browser.page === "function" && restante(hasta) > 8000) {
    try {
      captured = await kino.browser.page(url, { timeoutMs: Math.min(20000, restante(hasta) - 2000), autoplay: true });
    } catch (_) { captured = null; }
  }

  const best = await mejorMedia(captured && captured.media);
  if (!best) return null;
  const subtitles = (Array.isArray(captured && captured.subtitles) ? captured.subtitles : [])
    .filter((s) => s && typeof s.url === "string" && s.url)
    .slice(0, 30)
    .map((s) => ({ url: s.url, lang: (typeof s.lang === "string" && s.lang) || "und" }));
  return {
    url: best.url,
    headers: best.headers || {},
    mime: best.mime || undefined,
    label: "Reproductor",
    ...(subtitles.length ? { subtitles } : {}),
  };
}

/** Una copia elegida en la hoja "Servidor y calidad": se vuelve a abrir el reproductor y se prueba esa. */
async function resuelveAlternativa(alt) {
  const hasta = Date.now() + (kino.browser ? 30000 : 16000);
  const r = await flujoPlayer(alt.w, { hasta, preferidoIdx: alt.x });
  if (!r || !r.stream) {
    throw kino.error("not_found", "la copia no abrió", {
      userMessage: "Esa copia no está disponible ahora. Prueba con otra.",
    });
  }
  return { ...r.stream, label: etiqueta({ name: alt.n, lang: alt.l }, alt.l) };
}

export async function resolve(ref) {
  return resuelve(ref, true);
}

/** El cuerpo de resolve(), con o sin navegador oculto y con un presupuesto propio (`prepare` lo llama sin él). */
async function resuelve(ref, permitirNavegador, limiteMs) {
  await null;
  // Kino espera a los fetches que una llamada deja vivos antes de entregar la respuesta: se le pide
  // que los suelte al responder (Kino 0.9.55+; en versiones anteriores es una propiedad ignorada).
  try { globalThis.__kinoDropPendingFetches = true; } catch (_) {}

  const data = decodeRef(ref);
  if (!data) throw kino.error("not_found", "ref inválido");
  // Una copia de la hoja "Servidor y calidad" trae su propio camino.
  if (data.alt) return resuelveAlternativa(data.alt);
  if (typeof data.slug !== "string" || !data.slug) throw kino.error("not_found", "ref inválido");

  const slug = data.slug;
  const conNavegador = permitirNavegador && !!(kino && kino.browser && (kino.browser.capture || kino.browser.page));
  const limite = limiteMs || (conNavegador ? RESOLVE_BROWSER_MS : RESOLVE_MS);
  const hasta = Date.now() + limite;

  let watchUrl;
  if (data.type === "pelicula") {
    watchUrl = `${BASE}/pelicula/${slug}`;
  } else if (data.type === "episodio") {
    if (!(data.season >= 1 && data.episode >= 1)) throw kino.error("not_found", "ref de episodio inválido");
    watchUrl = `${BASE}/serie/${slug}/temporada/${data.season}/episodio/${data.episode}`;
  } else if (data.type === "serie") {
    // Sin episodio elegido: se abre el primero de la primera temporada.
    const html = await getText(`${BASE}/serie/${slug}/temporada/1`);
    const m = html && /\/temporada\/1\/episodio\/(\d+)/.exec(html);
    watchUrl = `${BASE}/serie/${slug}/temporada/1/episodio/${m ? parseInt(m[1], 10) : 1}`;
  } else {
    throw kino.error("not_found", "tipo de ref desconocido");
  }

  // 1) El enlace que ya funcionó para este título (30 min): una lista que aún responde se usa tal cual.
  const clave = `ok:${data.type}:${slug}:${data.season || ""}:${data.episode || ""}`;
  const bueno = leerBueno(clave);
  if (bueno && restante(hasta) > 4000 && await listaSana(bueno.url, { headers: bueno.headers || {} })) {
    kino.log(`flujo: enlace guardado de ${slug}`);
    return {
      url: bueno.url,
      headers: bueno.headers || {},
      mime: bueno.mime,
      ...(bueno.label ? { label: bueno.label } : {}),
      ...(Array.isArray(bueno.alternatives) && bueno.alternatives.length ? { alternatives: bueno.alternatives } : {}),
    };
  }

  // 2) El reproductor incrustado, con su parte del presupuesto (y el resto para el navegador si hay).
  const fase = conNavegador ? Math.min(10000, hasta - Date.now() - 8000) : limite - 2000;
  const r = await flujoPlayer(watchUrl, { hasta: Math.min(hasta, Date.now() + Math.max(4000, fase)) });
  if (r && r.stream) {
    const salida = conAlternativas(r.stream, r.orden, r.servidor, watchUrl, r.reproductor.lista);
    guardarBueno(clave, salida);
    return salida;
  }

  // 3) El sitio dice que no tiene nada (`pendiente: false`): no tiene sentido gastar 20 s de navegador.
  if (r && r.vacio && !r.pendiente) throw noDisponible(data);

  // 4) El sitio avisa de que aún lo está preparando: el navegador tampoco va a encontrar nada.
  if (r && r.pendiente) {
    throw kino.error("unavailable", "el sitio aún prepara este título", {
      userMessage: "CineHax+ todavía está preparando este título. Inténtalo en unos minutos.",
    });
  }

  // 5) Navegador oculto, solo con tiempo de sobra.
  if (conNavegador && restante(hasta) > 8000) {
    const stream = await capturaDelReproductor(watchUrl, hasta);
    if (stream) return stream;
  }

  throw kino.error("not_found", "sin copia reproducible", {
    userMessage: r && r.pidioMotor
      ? "Instala el motor de reproducción compartido desde el menú de plugins y vuelve a intentar."
      : "No se encontró una copia que se pueda reproducir.",
  });
}

// ──────────────────────────────────────────────────────────────
// SETTINGS – la pestaña Ajustes del plugin
// ──────────────────────────────────────────────────────────────

export async function settingsStatus() {
  await null;
  const chequeo = kino.storage.get("chequeo");
  let guardados = 0;
  try { guardados = kino.storage.keys().filter((k) => k.indexOf("ok:") === 0).length; } catch (_) { guardados = 0; }
  const sitio = chequeo === "ok"
    ? "cinehaxplus.com respondió en la última comprobación"
    : chequeo === "fallo"
      ? "El sitio no respondió en la última comprobación"
      : "Sin comprobación todavía";
  return { estado: `${sitio} · ${guardados} ${guardados === 1 ? "enlace guardado" : "enlaces guardados"}` };
}

export async function action(key) {
  await null;
  if (key === "comprobar") {
    let ok = false;
    try {
      const r = await kino.fetch(`${BASE}/`);
      ok = r.ok;
    } catch { ok = false; }
    try { kino.storage.set("chequeo", ok ? "ok" : "fallo"); } catch { /* sin caché de estado */ }
    return {
      message: ok ? "cinehaxplus.com responde correctamente" : "El sitio no responde ahora",
      refresh: true,
    };
  }
  if (key === "limpiar") {
    cacheDrop("buscar:");
    cacheDrop("serie:");
    cacheDrop("temporada:");
    cacheDrop("ok:");
    return { message: "Caché borrada", refresh: true };
  }
  return null;
}

export async function validateSettings(values) {
  await null;
  const v = values && values.pestanas;
  if (v !== undefined && v !== null && ["ambas", "peliculas", "series"].indexOf(String(v)) < 0) {
    return { pestanas: "Elige una opción de la lista" };
  }
  const idioma = values && values.idioma;
  if (idioma !== undefined && idioma !== null && ["auto", "lat", "cast", "sub"].indexOf(String(idioma)) < 0) {
    return { idioma: "Elige una opción de la lista" };
  }
  return null;
}

// ──────────────────────────────────────────────────────────────
// PANEL — lo que Kino enseña en el reproductor (solo lectura: no toca la reproducción)
// ──────────────────────────────────────────────────────────────

function mmss(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export async function panel(ctx) {
  await null;
  const c = ctx || {};
  const copia = c.playing || {};
  const titulo = String(c.title || "CineHax+");
  const ficha = c.kind === "episode" && c.season
    ? `${titulo} · T${c.season}${c.episode ? ` E${c.episode}` : ""}`
    : titulo;
  const idioma = String(kino.config.get("idioma") || "auto");
  const nombreIdioma = { auto: "Automático", lat: "Latino", cast: "Castellano", sub: "Subtitulado" }[idioma] || "Automático";
  const motor = puertaDisponible() ? "instalado" : "no instalado";
  const tiempo = c.durationMs ? `${mmss(c.positionMs)} de ${mmss(c.durationMs)}` : (c.positionMs ? mmss(c.positionMs) : "en directo");
  const datos = [copia.lang, copia.quality, copia.server].filter((x) => typeof x === "string" && x).join(" · ");

  const tab = c.tab === "ajustes" ? "ajustes" : "copia";
  const cuerpo = tab === "copia"
    ? [
      { type: "text", key: "p-titulo", text: ficha, variant: "title" },
      { type: "text", key: "p-copia", text: copia.label ? `Reproduciendo: ${copia.label}` : "Reproduciendo esta copia" },
      { type: "text", key: "p-datos", text: datos || "El reproductor no informa del servidor", variant: "caption" },
      { type: "text", key: "p-tiempo", text: tiempo, variant: "caption" },
      { type: "text", key: "p-nota", text: "Si esta copia falla, vuelve a la ficha y elige otra en «Servidor y calidad».", variant: "caption" },
    ]
    : [
      { type: "text", key: "p-aj-titulo", text: "Preferencias de CineHax+", variant: "title" },
      { type: "text", key: "p-aj-idioma", text: `Idioma preferido: ${nombreIdioma}` },
      { type: "text", key: "p-aj-motor", text: `Motor de reproducción: ${motor}` },
      { type: "text", key: "p-aj-nota", text: "Se cambian en Ajustes → Plugins → CineHax+.", variant: "caption" },
    ];

  return {
    format: "screen",
    title: "CineHax+",
    tabs: [{ id: "copia", label: "Esta copia" }, { id: "ajustes", label: "Preferencias" }],
    tab,
    root: { type: "col", key: "p-root", gap: 6, children: cuerpo },
  };
}

// ──────────────────────────────────────────────────────────────
// SCREEN — catálogo nativo CineHax+, con la barra de navegación de Xuper
// ──────────────────────────────────────────────────────────────
const SCREEN_PAGE_SIZE = 36;
const HOME_TTL_MS = 5 * 60 * 1000;   // la portada en memoria: cambiar de sección no vuelve a pedirla
const HOME_RAILS = 6;
const RAIL_ITEMS = 18;

// Las cuatro secciones de la barra inferior (Kino dibuja de 2 a 5). En TV no hay barra inferior:
// la navegación va como TabBar en la cabecera, igual que en Xuper.
const NAV = [
  { key: "inicio", icon: "home", es: "Inicio", en: "Home" },
  { key: "peliculas", icon: "movie", es: "Películas", en: "Movies" },
  { key: "series", icon: "tv", es: "Series", en: "Series" },
  { key: "ajustes", icon: "settings", es: "Ajustes", en: "Settings" },
];
const NAV_KEYS = NAV.map((n) => n.key);
const navName = (v) => (NAV_KEYS.indexOf(String(v)) >= 0 ? String(v) : "inicio");
const navOf = (nav) => NAV.find((n) => n.key === nav) || NAV[0];

/** La barra oculta que toda vista lleva: una acción la enseña al instante y la respuesta la esconde. */
const busyBar = () => ({ type: "LinearProgressIndicator", key: "busy", hidden: true });
const busyEvent = (event, arg) => ({ ui: [{ show: "busy" }], event, ...(arg !== undefined ? { arg: String(arg) } : {}) });

const navBar = (active) => ({
  type: "NavigationBar", value: active, onChanged: busyEvent("nav"),
  items: NAV.map((n) => ({ key: n.key, icon: n.icon, label: n.es, labelEn: n.en })),
});
const navTabs = (active) => ({
  type: "TabBar", key: "navTabs", divider: false, value: active, onChanged: busyEvent("nav"),
  tabs: NAV.map((n) => ({ value: n.key, label: n.es, labelEn: n.en })),
});

const brand = () => ({
  type: "Row", key: "brand", gap: 8, crossAxisAlignment: "center",
  children: [
    { type: "Icon", key: "brandIcon", name: "movie", color: "primary", size: 22 },
    { type: "Text", key: "brandText", text: "CineHax+", textEn: "CineHax+", style: "h4" },
  ],
});

// mergeWithKinoBar necesita un `leading` o Kino dibuja dos barras: en una sección vuelve a Inicio,
// en Inicio cierra la pantalla.
const navBack = (nav) => ({
  type: "IconButton", key: "navBack", icon: "arrow_back", labelText: "Atrás", labelTextEn: "Back",
  onPressed: nav && nav !== "inicio" ? busyEvent("nav", "inicio") : { go: { close: true } },
});

function appBarNode(nav, device, actions) {
  const base = { type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false, leading: navBack(nav) };
  const acts = actions && actions.length ? { actions } : {};
  if (device === "tv") {
    return { ...base, ...acts, title: { type: "Row", key: "tvTitle", gap: 16, crossAxisAlignment: "center", children: [brand(), navTabs(nav)] } };
  }
  const title = nav === "inicio"
    ? brand()
    : { type: "Text", key: "scTitle", text: navOf(nav).es, textEn: navOf(nav).en, style: "h4" };
  return { ...base, ...acts, title };
}

/** Sin el motor compartido no hay hosters: Kino no instala los `recommends` solo, así que se ofrece aquí. */
function pantallaInstalar(device) {
  return {
    type: "Scaffold", key: "cinehax-instalar",
    appBar: appBarNode("inicio", device, []),
    body: {
      type: "Column", key: "cinehax-instalar-body", flex: 1,
      mainAxisAlignment: "center", crossAxisAlignment: "center", gap: 16,
      padding: { compact: 24, expanded: 48 },
      children: [
        { type: "Icon", key: "cinehax-instalar-icon", name: "bolt", size: 40, color: "primary" },
        { type: "Text", key: "cinehax-instalar-t", text: "Falta el motor de reproducción", textEn: "The playback engine is missing", style: "h3", textAlign: "center" },
        { type: "Text", key: "cinehax-instalar-p", color: "muted", textAlign: "center", text: "CineHax+ resuelve los reproductores con el motor compartido (Kino Resolver). Instálalo una vez y no hace falta nada más.", textEn: "CineHax+ resolves its players with the shared engine (Kino Resolver). Install it once and that is all." },
        { type: "ElevatedButton", key: "cinehax-instalar-b", icon: "download", labelText: "Instalar Kino Resolver", labelTextEn: "Install Kino Resolver", onPressed: { go: { installPlugin: { repo: "xuper-plugin/kino-plugin-kino-resolver" } } } },
      ],
    },
  };
}

// ── datos de la portada (filas de la home, en memoria 5 min) ──
const HTTPS = /^https:\/\/.+/;
let homeCache = { at: 0, rows: null };
async function filasHome() {
  if (homeCache.rows && Date.now() - homeCache.at < HOME_TTL_MS) return homeCache.rows;
  try {
    const html = await getText(`${BASE}/`);
    const rows = html ? homeRows(html) : [];
    if (rows.length) { homeCache = { at: Date.now(), rows }; return rows; }
  } catch (err) {
    try { kino.log("pantalla inicio: " + ((err && err.message) || err)); } catch (_) { /* sin log */ }
  }
  return homeCache.rows || null;
}

const borde = { compact: { x: 12 }, expanded: { x: 24 } };

/** Un heroCard con el primer título de la portada y un botón que lo reproduce. */
function heroNode(item) {
  if (!item || !item.ref) return null;
  const image = HTTPS.test(String(item.poster || "")) ? item.poster : null;
  return {
    type: "heroCard", key: "hero", h: { compact: 200, expanded: 240 },
    title: String(item.title || "CineHax+").slice(0, 120),
    text: "Lo más visto hoy en CineHax+", textEn: "The most watched on CineHax+ today",
    ...(image ? { image } : {}),
    buttons: [{
      type: "ElevatedButton", key: "heroPlay", icon: "play",
      labelText: "Reproducir", labelTextEn: "Play",
      onPressed: { go: { play: { ref: item.ref, kind: item.kind, id: item.id, title: item.title } } },
    }],
  };
}

const railNode = (row, i) => ({
  type: "titleRail", key: `rail-${i}`, title: String(row.title || "").slice(0, 80),
  items: (Array.isArray(row.items) ? row.items : []).slice(0, RAIL_ITEMS),
  ...(row.ref ? { ref: row.ref } : {}),
  margin: borde,
});

const bannerError = (texto, textoEn) => ({
  type: "MaterialBanner", key: "error", role: "error", margin: borde,
  text: texto, textEn: textoEn,
  action: { label: "Reintentar", labelEn: "Retry", onTap: busyEvent("reload") },
});

async function inicioNodes() {
  const rows = (await filasHome()) || [];
  if (!rows.length) return [bannerError("No se pudo cargar el catálogo. Revisa la conexión.", "Could not load. Check your connection.")];
  const hero = heroNode(rows[0].items && rows[0].items[0]);
  const rails = rows.slice(0, HOME_RAILS).map(railNode);
  return [...(hero ? [hero] : []), ...rails];
}

// ── Películas / Series ──
const listaRef = (nav) => encodeRef({ list: nav === "series" ? "series" : "peliculas" });

async function listaNodes(nav, page, device) {
  let items = [];
  let next = null;
  try {
    const r = await browse(listaRef(nav), String(page));
    items = (r && r.items) || [];
    next = r && r.next;
  } catch (err) {
    try { kino.log("pantalla lista: " + ((err && err.message) || err)); } catch (_) { /* sin log */ }
    return [bannerError("No se pudo cargar el catálogo. Inténtalo de nuevo.", "Could not load the catalog. Try again.")];
  }

  const visible = items.slice(0, SCREEN_PAGE_SIZE);
  if (!visible.length) {
    return [{ type: "EmptyState", key: "vacio", icon: "movie", title: "Sin títulos", titleEn: "No titles", text: "No hay títulos disponibles ahora.", textEn: "No titles right now." }];
  }

  const nodes = [{ type: "titleGrid", key: `grid-${nav}-${page}`, columns: { compact: 3, expanded: device === "tv" ? 6 : 5 }, items: visible }];
  const fila = [{ type: "Text", key: "pagina", text: `Página ${page}`, textEn: `Page ${page}`, style: "caption", color: "muted", align: "center", flex: 1 }];
  if (page > 1) fila.unshift({ type: "TextButton", key: "anteriores", labelText: "« Anteriores", labelTextEn: "« Previous", onPressed: busyEvent("setPage", page - 1) });
  if (next) fila.push({ type: "TextButton", key: "siguientes", labelText: "Siguientes »", labelTextEn: "Next »", onPressed: busyEvent("setPage", page + 1) });
  nodes.push({ type: "Row", key: "paginacion", gap: 12, justify: "center", crossAxisAlignment: "center", margin: { top: 8, bottom: 8 }, children: fila });
  return nodes;
}

// ── Búsqueda ──
async function busquedaNodes(query) {
  let items = [];
  try { items = (await search({ q: query })) || []; } catch (err) {
    try { kino.log("pantalla búsqueda: " + ((err && err.message) || err)); } catch (_) { /* sin log */ }
  }
  const head = {
    type: "Row", key: "q-head", gap: 12, crossAxisAlignment: "center", margin: borde,
    children: [
      { type: "Text", key: "q-t", text: `Resultados para “${query}”`, textEn: `Results for “${query}”`, style: "h4", flex: 1, maxLines: 2 },
      { type: "TextButton", key: "q-clear", labelText: "Quitar", labelTextEn: "Clear", onPressed: busyEvent("clearSearch") },
    ],
  };
  if (!items.length) {
    return [head, { type: "EmptyState", key: "q-vacio", icon: "search", title: "Sin resultados", titleEn: "No results", text: `No hay títulos para “${query}”.`, textEn: `Nothing for “${query}”.` }];
  }
  return [head, { type: "titleGrid", key: "q-grid", columns: { compact: 3, expanded: 5 }, items: items.slice(0, 60) }];
}

// ── Ajustes dentro del plugin ──
async function ajustesNodes(state) {
  let estado = "Sin comprobación todavía";
  try { const st = await settingsStatus(); estado = String((st && st.estado) || estado); } catch (_) { /* sin estado */ }
  const idioma = String(kino.config.get("idioma") || "auto");
  const nombre = { auto: "Automático", lat: "Latino", cast: "Castellano", sub: "Subtitulado" }[idioma] || "Automático";
  const motor = puertaDisponible() ? "Instalado" : "No instalado";
  const out = [];
  if (state && state.aviso) {
    out.push({ type: "MaterialBanner", key: "aviso", role: "info", margin: borde, text: String(state.aviso), textEn: String(state.aviso) });
  }
  out.push({
    type: "Card", key: "aj-card", margin: borde, padding: 16, gap: 12,
    children: [
      { type: "Text", key: "aj-t", text: "CineHax+", style: "h4" },
      { type: "Text", key: "aj-estado", text: estado, textEn: estado, color: "muted" },
      { type: "Row", key: "aj-row-idioma", gap: 8, crossAxisAlignment: "center", children: [
        { type: "Icon", key: "aj-i-idioma", name: "language", size: 20, color: "primary" },
        { type: "Text", key: "aj-idioma", text: `Idioma preferido: ${nombre}`, textEn: `Preferred language: ${nombre}`, flex: 1 },
      ] },
      { type: "Row", key: "aj-row-motor", gap: 8, crossAxisAlignment: "center", children: [
        { type: "Icon", key: "aj-i-motor", name: "bolt", size: 20, color: "primary" },
        { type: "Text", key: "aj-motor", text: `Motor de reproducción: ${motor}`, textEn: `Playback engine: ${motor}`, flex: 1 },
      ] },
    ],
  });
  out.push({
    type: "Row", key: "aj-acciones", gap: 12, wrap: true, margin: borde,
    children: [
      { type: "TextButton", key: "aj-comprobar", icon: "refresh", labelText: "Comprobar el sitio", labelTextEn: "Check the site", onPressed: busyEvent("comprobar") },
      { type: "TextButton", key: "aj-limpiar", icon: "delete", labelText: "Borrar la caché", labelTextEn: "Clear cache", onPressed: busyEvent("limpiar") },
    ],
  });
  out.push({ type: "Text", key: "aj-nota", color: "muted", style: "caption", margin: borde, text: "Los demás ajustes están en Ajustes ▸ Plugins ▸ CineHax+.", textEn: "The other settings are in Settings ▸ Plugins ▸ CineHax+." });
  return out;
}

// La hoja de búsqueda: declarada en el árbol y abierta con `ui: [{ open: "buscar" }]`.
const searchSheet = (query) => ({
  type: "BottomSheet", key: "buscar", title: "Buscar", titleEn: "Search",
  children: [
    { type: "TextField", key: "sq", kind: "search", maxLength: 120, labelText: "Películas y series", labelTextEn: "Movies and series", trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onSubmitted: { event: "search" }, onTrailingTap: { event: "search" } },
    ...(query ? [{ type: "TextButton", key: "sq-clear", labelText: "Quitar la búsqueda", labelTextEn: "Clear search", onPressed: busyEvent("clearSearch") }] : []),
  ],
});

export async function screen(arg) {
  const state = (arg && arg.state) || {};
  const device = (arg && arg.device) || "phone";
  // El motor compartido resuelve los hosters: si falta, se ofrece instalarlo antes que enseñar el catálogo.
  const instalados = arg && arg.installed;
  if (instalados && !instalados["xuper-plugin/kino-plugin-kino-resolver"]) return pantallaInstalar(device);

  const nav = navName(state.nav);
  const page = Math.max(1, Number(state.page) || 1);
  const query = typeof state.query === "string" ? state.query.trim().slice(0, 120) : "";

  let nodes;
  if (query) nodes = await busquedaNodes(query);
  else if (nav === "inicio") nodes = await inicioNodes();
  else if (nav === "ajustes") nodes = await ajustesNodes(state);
  else nodes = await listaNodes(nav, page, device);
  if (!Array.isArray(nodes) || !nodes.length) nodes = [bannerError("No se pudo cargar el catálogo.", "Could not load the catalog.")];

  const actions = [{ type: "IconButton", key: "abrir-buscar", icon: "search", labelText: "Buscar", labelTextEn: "Search", onPressed: { ui: [{ open: "buscar" }] } }];

  const out = {
    type: "Scaffold", key: "cinehax-screen",
    appBar: appBarNode(nav, device, actions),
    body: {
      type: "Column", key: "cinehax-page", flex: 1,
      children: [
        busyBar(),
        { type: "ListView", key: `cinehax-${nav}${query ? "-buscar" : ""}`, flex: 1, padding: { compact: { bottom: 16 }, expanded: { bottom: 24 } }, gap: 12, items: nodes },
        searchSheet(query),
      ],
    },
  };
  if (device !== "tv") out.bottomNavigationBar = navBar(nav);
  return out;
}

export async function screenEvent(ev) {
  const event = ev || {};
  const state = Object.assign({ nav: "inicio", page: 1, query: "", aviso: "" }, event.state || {});
  state.nav = navName(state.nav);
  const ui = [{ hide: "busy" }];
  const name = String(event.name || "");

  if (name === "nav") {
    state.nav = navName(event.value !== undefined ? event.value : event.arg);
    state.page = 1;
    state.query = "";
    state.aviso = "";
  } else if (name === "search") {
    const dicho = event.value !== undefined ? event.value
      : (event.inputs && event.inputs.sq !== undefined ? event.inputs.sq : event.arg);
    state.query = String(dicho == null ? "" : dicho).trim().slice(0, 120);
    state.page = 1;
    return { ui: [{ hide: "busy" }, { close: "buscar" }], state };   // la hoja se cierra al buscar
  } else if (name === "clearSearch") {
    state.query = "";
    state.page = 1;
  } else if (name === "setPage") {
    const n = Number(event.arg !== undefined ? event.arg : event.value);
    if (Number.isInteger(n) && n >= 1) state.page = n;
  } else if (name === "comprobar" || name === "limpiar") {
    try { const r = await action(name); state.aviso = (r && r.message) || ""; } catch (_) { state.aviso = ""; }
  } else if (name === "reload") {
    homeCache = { at: 0, rows: null };   // vuelve a pedir la portada
  }
  return { ui, state };
}
