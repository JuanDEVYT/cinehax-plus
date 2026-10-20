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
  try { return JSON.parse(ref); } catch { return null; }
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
async function getText(path) {
  try {
    const r = await kino.fetch(siteUrl(path));
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

function cacheSet(key, value) {
  try {
    const raw = JSON.stringify(value);
    // La caché del plugin pesa 256 KB en total: una serie grande entra, una lista de series no.
    if (raw && raw.length < 60000) kino.storage.set(key, raw, { ttlMs: CACHE_MS });
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

  // Reabrir una serie cuesta tantas peticiones como temporadas tenga: se guarda la respuesta entera.
  const cached = cacheGet(`serie:${slug}`);
  if (cached && Array.isArray(cached.episodes) && cached.episodes.length) return cached;

  const serieHtml = await getText(`${BASE}/serie/${slug}`);
  if (!serieHtml) throw kino.error("unavailable", "serie no disponible", { userMessage: "Esta serie no está disponible ahora." });

  let seasons = seasonNumbers(serieHtml);
  if (!seasons.length) throw kino.error("not_found", "sin temporadas", { userMessage: "Esta serie no tiene episodios disponibles." });

  const all = [];
  let missing = 0;
  for (let i = 0; i < seasons.length; i += 6) { // 6 peticiones a la vez, el máximo de Kino
    const chunk = seasons.slice(i, i + 6);
    const pages = await Promise.all(chunk.map((n) => getText(`${BASE}/serie/${slug}/temporada/${n}`)));
    for (let j = 0; j < chunk.length; j++) {
      if (!pages[j]) { missing++; continue; }
      all.push(...parseEpisodes(pages[j], slug));
    }
    if (all.length >= 5000) break;
  }
  // Una temporada que no contesta se deja fuera: el resultado sirve, pero no está completo.
  if (missing) kino.log.report(`temporadas: ${missing} sin página`);

  if (!all.length) throw kino.error("not_found", "sin episodios", { userMessage: "Esta serie no tiene episodios disponibles." });

  const out = { series: seriesInfo(serieHtml, slug), episodes: all.slice(0, 5000) };
  cacheSet(`serie:${slug}`, out);
  return out;
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
  return src && pass ? { src: siteUrl(src), pass: siteUrl(pass) } : null;
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

/** Los servidores en el mismo orden en que el reproductor los arranca: directos antes que proxys, buen idioma primero. */
function ordenaServidores(lista, lang) {
  const peso = (s) => (lang && s.lang === lang ? 0 : 1);
  return lista.slice().sort((a, b) =>
    peso(a) - peso(b) ||
    ((a.mode === "proxy") - (b.mode === "proxy")) ||
    ((a.detras ? 1 : 0) - (b.detras ? 1 : 0)) ||
    ((a.src || 9) - (b.src || 9)));
}

/** fetch que no lanza y devuelve JSON ya parseado. */
async function getJson(url, options) {
  try {
    const r = await kino.fetch(url, options);
    return r.ok ? JSON.parse(await r.text()) : null;
  } catch { return null; }
}

/** True si todas las direcciones de la lista son de anuncios (el CDN de anuncios del sitio). */
function soloAnuncios(direcciones) {
  if (!direcciones.length) return false;
  for (const d of direcciones) if (!/tiktokcdn|ad-site|\/ad\//i.test(d)) return false;
  return true;
}

/**
 * ¿La lista HLS trae vídeo de verdad? Hoy los servidores "directo" devuelven manifiestos cuyos
 * fragmentos son imágenes de anuncios (tiktokcdn) y los "proxy" traen el vídeo: el reproductor del
 * sitio lo comprueba al reproducir y salta al siguiente servidor. Aquí se mira antes de devolver
 * el enlace. Sin respuesta (fuera del kit o red caída) se confía y Kino lo intenta reproducir.
 */
async function listaSana(url, opciones) {
  try {
    const r = await kino.fetch(url, opciones);
    if (!r.ok) return true;
    const txt = await r.text();
    if (txt.indexOf("#EXTM3U") < 0) return false;
    const urls = txt.split("\n").filter((l) => l && l.charAt(0) !== "#");
    if (txt.indexOf("#EXTINF") >= 0) return !soloAnuncios(urls); // ya es la de medios
    if (!urls[0]) return false;
    const v = await kino.fetch(new URL(urls[0], url).href, opciones);
    if (!v.ok) return false;
    const vt = await v.text();
    if (vt.indexOf("#EXTM3U") < 0) return false;
    return !soloAnuncios(vt.split("\n").filter((l) => l && l.charAt(0) !== "#"));
  } catch { return true; }
}

// Los enlaces del reproductor van atados al User-Agent que los pidió: el mismo abre el stream
// y lo reproduce, o el servidor responde 403.
const UA = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Safari/537.36";

/**
 * El vídeo no está en la página: la web solo deja una fachada con espera, y el reproductor incrustado
 * pide el enlace a su propia API con dos credenciales que ella misma sirve (pass del sitio + ui suyo).
 * Así se salta el anuncio del reproductor y el browser oculto, que a menudo no llega a montar nada.
 */
async function flujoPlayer(watchUrl) {
  const t0 = Date.now();
  const page = await getText(watchUrl);
  const embed = embedTag(page);
  if (!embed) return null;

  // El pass dura 10 minutos y va atado al título: se pide siempre fresco, desde el sitio.
  const pass = await getJson(embed.pass);
  if (!pass || !pass.pass) return null;

  const sep = embed.src.includes("?") ? "&" : "?";
  const embedRes = await kino.fetch(`${embed.src}${sep}pass=${encodeURIComponent(pass.pass)}`, { headers: { "User-Agent": UA } });
  const embedHtml = embedRes.ok ? await embedRes.text() : null;
  if (!embedHtml) return null;

  const ui = (embedHtml.match(/PM_UI="([^"]+)"/) || [])[1];
  let emb = null;
  try { emb = JSON.parse((embedHtml.match(/PM_EMBED=(\{[^}]+\})/) || [])[1] || "null"); } catch { /* vale la dirección del embed */ }
  if (!emb) emb = embFromSrc(embed.src);
  const origin = originOf(embed.src);
  if (!ui || !emb || !emb.tmdb || !origin) return null;

  const params = embParams(emb);
  const pide = { headers: { "User-Agent": UA } };
  const srv = await getJson(`${origin}/servers?${params}&ui=${encodeURIComponent(ui)}`, pide);
  const lista = srv && Array.isArray(srv.servers) ? srv.servers : [];
  if (!lista.length) return null;

  const orden = ordenaServidores(lista, emb.lang);
  for (let i = 0; i < orden.length && i < 10; i += 1) {
    const s = orden[i];
    const v = await getJson(`${origin}/video?${params}&noiframe=1&embed=${encodeURIComponent(s.id)}&r=1&ui=${encodeURIComponent(ui)}`, pide);
    // type "iframe" es un servidor que solo sabe abrirse en su propia página: Kino no puede reproducirlo.
    if (!v || !v.url || v.type === "iframe") continue;
    // Un manifiesto que solo trae anuncios no sirve: se pasa al siguiente servidor, como hace el sitio.
    if ((v.type === "hls" || v.type === "dash") && !(await listaSana(v.url, pide))) {
      kino.log(`flujo: lista sin vídeo en ${s.name || s.id.slice(0, 8)}, se salta`);
      continue;
    }
    kino.log(`flujo: ${v.type} vía ${s.name || s.host || "servidor"} en ${Date.now() - t0} ms`);
    return {
      url: v.url,
      // El reproductor de Kino manda estas cabeceras en el manifiest y en cada fragmento.
      headers: { "User-Agent": UA, Referer: `${origin}/` },
      mime: v.type === "hls" ? "application/x-mpegURL" : v.type === "dash" ? "application/dash+xml" : v.type === "mp4" ? "video/mp4" : undefined,
    };
  }
  return null;
}

export async function resolve(ref) {
  await null;
  const data = decodeRef(ref);
  if (!data || typeof data.slug !== "string" || !data.slug) throw kino.error("not_found", "ref inválido");

  const slug = data.slug;
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
    const ep = m ? parseInt(m[1], 10) : 1;
    watchUrl = `${BASE}/serie/${slug}/temporada/1/episodio/${ep}`;
  } else {
    throw kino.error("not_found", "tipo de ref desconocido");
  }

  // Primero el enlace directo que sirve el reproductor incrustado: rápido y sin anuncios.
  const stream = await flujoPlayer(watchUrl);
  if (stream) return stream;

  // Último recurso: el browser oculto de Kino monta la página y captura el vídeo que pide.
  kino.log.report("resolve_fallback", "sin enlace directo del reproductor, se usa el browser");
  const captured = await kino.browser.capture(watchUrl, { timeoutMs: 20000, autoplay: true });

  if (!captured.media || !captured.media.length) {
    throw kino.error("not_found", "no se encontró video en la página", { userMessage: "No se encontró el video de este título." });
  }

  // La primera entrada es siempre el manifiesto (HLS/DASH), que es lo que se quiere reproducir.
  const best = captured.media[0];
  const subtitles = (Array.isArray(captured.subtitles) ? captured.subtitles : [])
    .filter((s) => s && typeof s.url === "string" && s.url)
    .slice(0, 30)
    .map((s) => ({ url: s.url, lang: (typeof s.lang === "string" && s.lang) || "und" }));

  return {
    url: best.url,
    headers: best.headers || {},
    mime: best.mime || undefined,
    ...(subtitles.length ? { subtitles } : {}),
  };
}

// ──────────────────────────────────────────────────────────────
// SETTINGS – la pestaña Ajustes del plugin
// ──────────────────────────────────────────────────────────────

export async function settingsStatus() {
  await null;
  const chequeo = kino.storage.get("chequeo");
  return {
    estado: chequeo === "ok"
      ? "cinehaxplus.com respondió en la última comprobación"
      : chequeo === "fallo"
        ? "El sitio no respondió en la última comprobación"
        : "Sin comprobación todavía",
  };
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
  return null;
}
