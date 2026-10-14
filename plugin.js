/// <reference path="./kino.d.ts" />

// language: JavaScript ES module · file: plugin.js · target: Kino (QuickJS, apiVersion 6)
// fuente: cinehaxplus.com – SSR, sin login. Player cargado con JS → browser.capture en resolve.

const BASE = "https://cinehaxplus.com";

// ──────────────────────────────────────────────────────────────
// HELPERS – URL y slugs
// ──────────────────────────────────────────────────────────────

/** Extrae type+slug de un href como /pelicula/spider-man-2026 */
function parseHref(href) {
  const m = href && href.match(/\/(pelicula|serie)\/([^/#?]+)/);
  if (!m) return null;
  return { type: m[1], slug: m[2] };
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

/** URL de la página de detalle de un título */
function detailUrl(type, slug) {
  return `${BASE}/${type}/${slug}`;
}

/** Extrae el año del slug (termina en -YYYY) */
function yearFromSlug(slug) {
  const m = slug.match(/-(\d{4})$/);
  return m ? parseInt(m[1], 10) : undefined;
}

// ──────────────────────────────────────────────────────────────
// HELPERS – parseo HTML con regex (funciona en kit y en app)
// ──────────────────────────────────────────────────────────────

/**
 * Extrae links únicos a /pelicula/ y /serie/ (sin temporada/episodio).
 * Devuelve array de { href, type, slug }
 */
function extractTitleLinks(html) {
  const seen = new Set();
  const result = [];
  const re = /href="(https?:\/\/cinehaxplus\.com\/(pelicula|serie)\/([^"#?/]+))"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    const type = m[2];
    const slug = m[3];
    const key = `${type}/${slug}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ href, type, slug });
    }
  }
  return result;
}

/**
 * Extrae texto limpio entre dos tags (simple, sin anidamiento).
 * Usado para sacar sinopsis, título, etc.
 */
function innerText(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extrae la primera imagen de image.tmdb.org con tamaño w500 de un HTML.
 * Las páginas de detalle incluyen posters de TMDB.
 */
function extractPoster(html) {
  const m = html.match(/https:\/\/image\.tmdb\.org\/t\/p\/w500\/([^"']+)/);
  return m ? `https://image.tmdb.org/t/p/w500/${m[1]}` : undefined;
}

/**
 * Extrae el backdrop (w1280) de un HTML.
 */
function extractBackdrop(html) {
  const m = html.match(/https:\/\/image\.tmdb\.org\/t\/p\/w1280\/([^"']+)/);
  return m ? `https://image.tmdb.org/t/p/w1280/${m[1]}` : undefined;
}

/**
 * Extrae géneros de links /genero/slug de un HTML.
 * Devuelve array de ids de género compatibles con Kino.
 */
const GENRE_MAP = {
  "accion": "accion", "aventura": "aventura", "animacion": "animacion",
  "terror": "terror", "comedia": "comedia", "drama": "drama",
  "romance": "romance", "ciencia-ficcion": "ciencia-ficcion",
  "crimen": "crimen", "misterio": "misterio", "fantasia": "fantasia",
  "suspenso": "suspenso", "documental": "documentales", "familia": "familia",
  "infantil": "infantil", "anime": "anime",
};
function extractGenres(html) {
  const re = /\/genero\/([^"#?/]+)/g;
  const genres = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const g = GENRE_MAP[m[1]] || m[1];
    if (!genres.includes(g)) genres.push(g);
  }
  return genres.length ? genres : undefined;
}

/** Extrae año de un link /ano/YYYY */
function extractYear(html) {
  const m = html.match(/\/ano\/(\d{4})/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Construye un item de Kino a partir del slug y el HTML de la página de listado.
 * El título se extrae del textContent si está disponible, si no se infiere del slug.
 */
function buildItem(type, slug, title) {
  return {
    id: buildId(type, slug),
    ref: encodeRef({ type, slug }),
    title: title || slug.replace(/-/g, " "),
    kind: type === "pelicula" ? "movie" : "series",
    year: yearFromSlug(slug),
  };
}

// ──────────────────────────────────────────────────────────────
// HELPERS – página de detalle
// ──────────────────────────────────────────────────────────────

/**
 * Hace fetch de la página de detalle de un título y devuelve un item enriquecido.
 * Incluye poster, backdrop, géneros, año, descripción.
 */
async function fetchDetail(type, slug) {
  const r = await kino.fetch(detailUrl(type, slug));
  if (!r.ok) return buildItem(type, slug, null);
  const html = await r.text();

  // Título desde <title>
  const titleMatch = html.match(/<title>Ver\s+([^(|]+?)(?:\s+\(|\s+\|)/i);
  const title = titleMatch
    ? titleMatch[1].trim()
    : slug.replace(/-/g, " ");

  // Descripción: primer <p> largo con texto
  const descMatch = html.match(/<p[^>]*>([^<]{60,})<\/p>/);
  const description = descMatch ? innerText(descMatch[1]) : undefined;

  return {
    id: buildId(type, slug),
    ref: encodeRef({ type, slug }),
    title,
    kind: type === "pelicula" ? "movie" : "series",
    year: extractYear(html),
    description,
    poster: extractPoster(html),
    backdrop: extractBackdrop(html),
    genres: extractGenres(html),
  };
}

// ──────────────────────────────────────────────────────────────
// SEARCH
// ──────────────────────────────────────────────────────────────

export async function search(query) {
  await null; // evita rejection trap en Kino ≤ 0.9.49
  const url = `${BASE}/search?q=${encodeURIComponent(query.q)}`;
  const r = await kino.fetch(url);
  if (!r.ok) throw kino.error("unavailable", `search HTTP ${r.status}`);
  const html = await r.text();

  const links = extractTitleLinks(html);

  // Extraer títulos del HTML de la página de resultados.
  // El bloque de resultados tiene: título, rating, año, duración/temporadas.
  // Usamos kino.html.select si está disponible (app), sino regex.
  const items = [];

  if (typeof kino.html !== "undefined" && kino.html.select) {
    // En la app: usar kino.html.select para obtener texto preciso por elemento
    const els = kino.html.select(html, 'a[href*="/pelicula/"], a[href*="/serie/"]');
    const seen = new Set();

    for (const el of els) {
      const parsed = parseHref(el.href || "");
      if (!parsed) continue;
      const { type, slug } = parsed;
      if (slug.includes("/")) continue; // saltar sub-rutas

      const id = buildId(type, slug);
      if (seen.has(id)) continue;
      seen.add(id);

      // textContent incluye título + rating + año
      const raw = (el.textContent || "").trim().replace(/\s+/g, " ");
      // El título está antes del % de rating
      const titlePart = raw.split(/\d+%/)[0].replace(/^Serie\s*/i, "").trim();
      const title = titlePart || slug.replace(/-/g, " ");

      // Año: buscar 4 dígitos en el texto
      const yearM = raw.match(/\b(19|20)\d{2}\b/);
      const year = yearM ? parseInt(yearM[0], 10) : yearFromSlug(slug);

      items.push({
        id,
        ref: encodeRef({ type, slug }),
        title,
        kind: type === "pelicula" ? "movie" : "series",
        year,
      });

      if (items.length >= 40) break;
    }
  } else {
    // Fallback (kit de Node): usar solo los links extraídos con regex
    const seen = new Set();
    for (const { type, slug } of links) {
      const id = buildId(type, slug);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push(buildItem(type, slug, null));
      if (items.length >= 40) break;
    }
  }

  return items;
}

// ──────────────────────────────────────────────────────────────
// HOME
// ──────────────────────────────────────────────────────────────

export async function home() {
  await null;
  const [htmlMain, htmlTrending, htmlSeries] = await Promise.all([
    kino.fetch(`${BASE}/`).then(r => r.ok ? r.text() : ""),
    kino.fetch(`${BASE}/peliculas?sort=trending`).then(r => r.ok ? r.text() : ""),
    kino.fetch(`${BASE}/series?sort=release`).then(r => r.ok ? r.text() : ""),
  ]);

  const rows = [];

  // Fila 1: Estrenos recientes (de la portada)
  const homeLinks = extractTitleLinks(htmlMain).slice(0, 20);
  if (homeLinks.length) {
    rows.push({
      title: "Recién añadidos",
      ref: encodeRef({ list: "home" }),
      genre: "peliculas",
      items: homeLinks.map(({ type, slug }) => buildItem(type, slug, null)),
    });
  }

  // Fila 2: Películas en tendencia
  const trendLinks = extractTitleLinks(htmlTrending)
    .filter(l => l.type === "pelicula")
    .slice(0, 20);
  if (trendLinks.length) {
    rows.push({
      title: "Películas en tendencia",
      ref: encodeRef({ list: "trending" }),
      genre: "peliculas",
      items: trendLinks.map(({ type, slug }) => buildItem(type, slug, null)),
    });
  }

  // Fila 3: Series recientes
  const seriesLinks = extractTitleLinks(htmlSeries)
    .filter(l => l.type === "serie")
    .slice(0, 20);
  if (seriesLinks.length) {
    rows.push({
      title: "Series recientes",
      ref: encodeRef({ list: "series-release" }),
      genre: "series",
      items: seriesLinks.map(({ type, slug }) => buildItem(type, slug, null)),
    });
  }

  return rows;
}

// ──────────────────────────────────────────────────────────────
// BROWSE – paginación de listas
// ──────────────────────────────────────────────────────────────

export async function browse(ref, cursor) {
  await null;
  const data = decodeRef(ref);
  if (!data) throw kino.error("not_found", "ref inválido");

  const page = parseInt(cursor || "1", 10);

  let url;
  if (data.list === "home") {
    url = `${BASE}/page/${page}`;
  } else if (data.list === "trending") {
    url = `${BASE}/peliculas?sort=trending&page=${page}`;
  } else if (data.list === "series-release") {
    url = `${BASE}/series?sort=release&page=${page}`;
  } else if (data.list === "peliculas") {
    url = `${BASE}/peliculas/page/${page}`;
  } else if (data.list === "series") {
    url = `${BASE}/series/page/${page}`;
  } else if (data.genero) {
    url = `${BASE}/genero/${data.genero}/page/${page}`;
  } else {
    throw kino.error("not_found", `browse ref desconocido: ${ref}`);
  }

  const r = await kino.fetch(url);
  if (!r.ok) throw kino.error("unavailable", `browse HTTP ${r.status}`);
  const html = await r.text();

  const links = extractTitleLinks(html).slice(0, 30);
  const items = links.map(({ type, slug }) => buildItem(type, slug, null));

  // ¿hay página siguiente? Si hay items, hay más.
  const hasNext = items.length >= 20;

  return {
    items,
    next: hasNext ? String(page + 1) : undefined,
  };
}

// ──────────────────────────────────────────────────────────────
// EPISODES – temporadas y episodios de una serie
// ──────────────────────────────────────────────────────────────

export async function episodes(ref) {
  await null;
  const data = decodeRef(ref);
  if (!data || data.type !== "serie") throw kino.error("not_found", "ref no es una serie");

  const { slug } = data;

  // Fetch de la página principal de la serie para obtener temporadas disponibles
  const r = await kino.fetch(`${BASE}/serie/${slug}`);
  if (!r.ok) throw kino.error("unavailable", `HTTP ${r.status}`);
  const html = await r.text();

  // Extraer números de temporada de links /temporada/N
  const seasonNums = new Set();
  const reTemporada = /\/serie\/[^"]+\/temporada\/(\d+)(?:\/episodio\/|")/g;
  let m;
  while ((m = reTemporada.exec(html)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > 0) seasonNums.add(n);
  }

  const seasons = [...seasonNums].sort((a, b) => a - b);
  if (!seasons.length) throw kino.error("not_found", "no se encontraron temporadas");

  // Fetch paralelo de todas las temporadas (máx 6 simultáneos, límite Kino)
  const BATCH = 6;
  const allEpisodes = [];
  const allSeasons = [];

  for (let i = 0; i < seasons.length; i += BATCH) {
    const chunk = seasons.slice(i, i + BATCH);
    const pages = await Promise.all(
      chunk.map(n =>
        kino.fetch(`${BASE}/serie/${slug}/temporada/${n}`)
          .then(r => r.ok ? r.text() : "")
      )
    );

    for (let j = 0; j < chunk.length; j++) {
      const seasonNum = chunk[j];
      const seasonHtml = pages[j];
      if (!seasonHtml) continue;

      // Parsear episodios de esta temporada
      // HTML de episodio: <li>43 min 1. Título30/11/2014 Descripción</li>
      // Links: /serie/{slug}/temporada/{n}/episodio/{e}
      const epLinks = [];
      const reEp = /href="[^"]*\/temporada\/(\d+)\/episodio\/(\d+)"/g;
      let em;
      while ((em = reEp.exec(seasonHtml)) !== null) {
        const s = parseInt(em[1], 10);
        const e = parseInt(em[2], 10);
        if (s === seasonNum && !epLinks.find(x => x.episode === e)) {
          epLinks.push({ season: s, episode: e });
        }
      }

      if (!epLinks.length) continue;

      allSeasons.push({ number: seasonNum, title: `Temporada ${seasonNum}` });

      // Parsear títulos de episodios del HTML (dentro de <li>)
      // Formato: "43 min N. Título DD/MM/YYYY Descripción"
      const liRe = /<li>([^<]*)<\/li>/gs;
      const liContents = [];
      let li;
      while ((li = liRe.exec(seasonHtml)) !== null) {
        const text = innerText(li[1]).trim();
        if (text.match(/^\d+ min \d+\./)) liContents.push(text);
      }

      for (const ep of epLinks) {
        // Buscar el li correspondiente al episodio
        const epText = liContents.find(t => {
          const numMatch = t.match(/^(?:\d+ min )(\d+)\./);
          return numMatch && parseInt(numMatch[1], 10) === ep.episode;
        });

        let title = `Capítulo ${ep.episode}`;
        let description;
        let durationMs;

        if (epText) {
          // "43 min 1. Título30/11/2014 Descripción"
          const durMatch = epText.match(/^(\d+) min/);
          if (durMatch) durationMs = parseInt(durMatch[1], 10) * 60 * 1000;

          const rest = epText.replace(/^\d+ min \d+\.\s*/, "");
          // El título está antes de la fecha DD/MM/YYYY
          const titleDateMatch = rest.match(/^(.+?)\s*\d{2}\/\d{2}\/\d{4}\s*(.*)/s);
          if (titleDateMatch) {
            title = titleDateMatch[1].trim() || title;
            description = titleDateMatch[2].trim() || undefined;
          } else {
            title = rest.trim() || title;
          }
        }

        allEpisodes.push({
          id: `${buildId("serie", slug)}.s${ep.season}e${ep.episode}`,
          ref: encodeRef({ type: "episodio", slug, season: ep.season, episode: ep.episode }),
          title,
          description,
          season: ep.season,
          number: ep.episode,
          durationMs,
        });
      }
    }
  }

  if (!allEpisodes.length) throw kino.error("not_found", "no se encontraron episodios");

  return {
    episodes: allEpisodes,
    seasons: allSeasons,
  };
}

// ──────────────────────────────────────────────────────────────
// RESOLVE – obtener stream de video con el browser oculto
// ──────────────────────────────────────────────────────────────

export async function resolve(ref) {
  await null;
  const data = decodeRef(ref);
  if (!data) throw kino.error("not_found", "ref inválido");

  let watchUrl;

  if (data.type === "pelicula") {
    watchUrl = `${BASE}/pelicula/${data.slug}#watch`;
  } else if (data.type === "episodio") {
    watchUrl = `${BASE}/serie/${data.slug}/temporada/${data.season}/episodio/${data.episode}#watch`;
  } else if (data.type === "serie") {
    // Si se llama resolve sobre una serie directamente (sin episodios),
    // redirigir al primer episodio de la primera temporada
    const r = await kino.fetch(`${BASE}/serie/${data.slug}/temporada/1`);
    if (!r.ok) throw kino.error("not_found", "temporada 1 no encontrada");
    const html = await r.text();
    const m = html.match(/\/temporada\/1\/episodio\/(\d+)/);
    const ep = m ? parseInt(m[1], 10) : 1;
    watchUrl = `${BASE}/serie/${data.slug}/temporada/1/episodio/${ep}#watch`;
  } else {
    throw kino.error("not_found", "tipo de ref desconocido");
  }

  // Usar el browser oculto para capturar el stream de video
  const captured = await kino.browser.capture(watchUrl, {
    timeoutMs: 20000,
    autoplay: true,
  });

  if (!captured.media || !captured.media.length) {
    throw kino.error("not_found", "no se encontró video en la página");
  }

  const best = captured.media[0];

  // Devolver el stream con streamHosts: any (el CDN es desconocido)
  return {
    url: best.url,
    headers: best.headers || {},
    mime: best.mime || undefined,
  };
}
