// node --test test/cinehax.test.mjs   (Node 18+)
// El plugin contra HTML real de cinehaxplus.com, guardado en test/fixtures: sin red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { filterRelevant, shortQuery, sortBySimilarity } from "../sdk/kino-rank.mjs";

const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const fixtures = join(here, "fixtures");
const read = (name) => readFileSync(join(fixtures, name), "utf8");

const kinoError = (code, message, extra) => Object.assign(new Error(message), { code }, extra || {});

// Lo que el sitio contesta de verdad, servido del disco: cada URL conocida a su archivo.
const PAGES = {
  "/": read("home.html"),
  "/page/2": read("home.html"),
  "/search?q=avatar": read("search-avatar.html"),
  "/api/suggest?q=avatar": read("suggest-avatar.json"),
  "/pelicula/madre-siniestra-2026": read("pelicula-madre-siniestra.html"),
  "/serie/el-mentalista": read("serie-el-mentalista.html"),
  "/serie/el-mentalista/temporada/1": read("temporada-1-el-mentalista.html"),
  "/serie/el-mentalista/temporada/1/episodio/1": read("episodio-el-mentalista.html"),
  "/serie/el-mentalista/temporada/2": read("temporada-2-el-mentalista.html"),
  "/peliculas?sort=release": read("peliculas-release.html"),
  "/peliculas/page/2?sort=release": read("peliculas-release-p2.html"),
  "/peliculas?sort=trending": read("peliculas-release.html"),
  "/peliculas?sort=rating": read("peliculas-release.html"),
  "/peliculas?sort=popular": read("peliculas-release.html"),
  "/peliculas": read("peliculas-nuevas.html"),
  "/peliculas/page/2": read("peliculas-nuevas.html"),
  "/generos": read("generos.html"),
  "/series": read("series-release.html"),
  "/series?sort=release": read("series-release.html"),
  "/series?sort=popular": read("series-popular.html"),
  "/series?sort=rating": read("series-release.html"),
  "/series?sort=trending": read("series-release.html"),
  "/genero/suspense": read("genero-suspense.html"),
};

let fetched = [];
let config = { pestanas: "ambas" };
let browserCalls = 0;
let videoUa = null;
const store = new Map();

const asJson = (body) => ({ ok: true, status: 200, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });

globalThis.kino = {
  fetch: async (url, options) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    fetched.push(path);
    if (Object.prototype.hasOwnProperty.call(PAGES, path)) return { ok: true, status: 200, text: async () => PAGES[path] };
    // Cualquier género sirve la misma rejilla: lo que se prueba es la estructura, no el catálogo.
    const genre = /^\/genero\/[a-z-]+$/.exec(path);
    if (genre) return { ok: true, status: 200, text: async () => PAGES["/genero/suspense"] };
    // El reproductor incrustado: el pass del sitio, su página y su API (otro host, mismo camino).
    if (path.startsWith("/api/player-pass")) return asJson({ ok: true, pass: "v1.test-pass", ttl: 600 });
    if (path.startsWith("/embed/movie/1400837")) return asJson(read("embed-movie.html"));
    if (path.startsWith("/embed/tv/5920")) return asJson(read("embed-tv.html"));
    if (path.startsWith("/servers?")) return asJson(read("servers.json"));
    if (path.startsWith("/video?")) {
      videoUa = options && options.headers && options.headers["User-Agent"];
      const embed = /embed=([^&]+)/.exec(path);
      const id = embed ? decodeURIComponent(embed[1]) : "";
      if (id === "s-iframe-1") return asJson({ type: "iframe", url: "https://embed-b.example/e/xyz" });
      if (id === "s-direct-1") return asJson({ type: "hls", url: "https://api-encrypted.moviemaster.lat/p/ad-hls" });
      return asJson({ type: "hls", url: "https://api-encrypted.moviemaster.lat/p/test-hls" });
    }
    if (path === "/p/ad-hls") return asJson("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:15,\nad-a.ts\n#EXTINF:15,\nad-b.ts\n#EXT-X-ENDLIST\n");
    if (path === "/p/test-hls") return asJson("#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nvideo-a.ts\n#EXTINF:10,\nvideo-b.ts\n#EXTINF:10,\nvideo-c.ts\n#EXTINF:10,\nvideo-d.ts\n#EXTINF:10,\nvideo-e.ts\n#EXTINF:10,\nvideo-f.ts\n#EXTINF:10,\nvideo-g.ts\n#EXTINF:10,\nvideo-h.ts\n#EXTINF:10,\nvideo-i.ts\n#EXTINF:10,\nvideo-j.ts\n#EXTINF:10,\nvideo-k.ts\n#EXTINF:10,\nvideo-l.ts\n#EXTINF:10,\nvideo-m.ts\n#EXTINF:10,\nvideo-n.ts\n#EXTINF:10,\nvideo-o.ts\n#EXTINF:10,\nvideo-p.ts\n#EXTINF:10,\nvideo-q.ts\n#EXTINF:10,\nvideo-r.ts\n#EXTINF:10,\nvideo-s.ts\n#EXT-X-ENDLIST\n");
    return { ok: false, status: 404, text: async () => "" };
  },
  error: kinoError,
  log: Object.assign(() => {}, { report: () => {} }),
  rank: Object.freeze({ sortBySimilarity, filterRelevant, shortQuery }),
  config: Object.freeze({ get: (key) => config[key], all: () => ({ ...config }) }),
  storage: Object.freeze({
    get: (key) => (store.has(key) ? store.get(key) : null),
    set: (key, value) => { store.set(key, String(value)); },
    remove: (key) => { store.delete(key); },
    keys: () => [...store.keys()],
  }),
  browser: Object.freeze({
    capture: async () => { browserCalls += 1; throw kinoError("browser_unavailable", "sin navegador en el kit"); },
  }),
};

const plugin = await import(pathToFileURL(join(here, "..", "plugin.js")).href);

const ID = /^[A-Za-z0-9._~-]{1,128}$/;
const itemQuery = (type) => ({ q: "", type, season: 0, episode: 0, tmdbId: 0, year: 0, originalTitle: "", altTitles: [], cursor: null });

test("search: los enlaces relativos del sitio se leen, y lo pedido queda primero", async () => {
  const items = await plugin.search({ ...itemQuery(), q: "avatar" });
  assert.ok(items.length > 0 && items.length <= 100);
  assert.ok(items.every((i) => ID.test(i.id) && i.ref && i.title));
  assert.ok(items.every((i) => i.kind === "movie" || i.kind === "series"));
  assert.equal(items[0].id, "serie.avatar-los-siete-refugios");
  assert.match(items[0].poster, /^https:\/\/image\.tmdb\.org\/t\/p\/w185\//); // el póster vertical del buscador
  assert.equal(items[0].rating, 8.8);
});

test("search: la pista de tipo no filtra, solo ordena", async () => {
  const items = await plugin.search({ ...itemQuery(), q: "avatar", type: "movie" });
  assert.ok(items.length > 1);
  assert.equal(items[0].kind, "movie");
  assert.ok(items.some((i) => i.kind === "series"), "las series siguen en la lista");
});

test("search: sin resultados responde lista vacía", async () => {
  const items = await plugin.search({ ...itemQuery(), q: "zzzqqqxywv" });
  assert.deepEqual(items, []);
});

test("search: el título original de TMDB es un respaldo, no un filtro", async () => {
  const items = await plugin.search({ ...itemQuery(), q: "zzzqqqxywv", originalTitle: "avatar" });
  assert.ok(items.length > 0);
});

test("home: las filas traen sus tarjetas, con id propio y Ver más donde hay lista", async () => {
  const rows = await plugin.home();
  assert.equal(rows.length, 9);
  assert.ok(rows.every((r) => ID.test(r.id) && r.title && r.items.length > 0));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "los ids no se repiten");

  const nuevas = rows.find((r) => r.id === "peliculas-nuevas");
  assert.ok(nuevas, "existe la fila de películas nuevas");
  assert.equal(nuevas.genre, "peliculas");
  assert.deepEqual(JSON.parse(nuevas.ref), { list: "peliculas" });

  const top10 = rows.find((r) => r.id === "top-10-de-hoy");
  assert.equal(top10.items.length, 10);
  assert.equal(top10.ref, undefined, "el Top 10 no tiene lista propia detrás");

  for (const row of rows) for (const item of row.items) assert.ok(ID.test(item.id) && item.ref && item.title);
});

test("browse: pagina en /page/N y sigue con el que anuncia el sitio", async () => {
  const p1 = await plugin.browse(JSON.stringify({ list: "peliculas-release" }), null);
  assert.equal(p1.items.length, 24);
  assert.equal(p1.next, "2");
  assert.equal(p1.items[0].title, "रामायण");

  const p2 = await plugin.browse(JSON.stringify({ list: "peliculas-release" }), p1.next);
  assert.equal(p2.items.length, 24);
  assert.equal(p2.next, "3");
  assert.notEqual(p2.items[0].id, p1.items[0].id);
});

test("browse: géneros y ref malos", async () => {
  const genero = await plugin.browse(JSON.stringify({ genero: "suspense" }), null);
  assert.equal(genero.items.length, 24);
  assert.equal(genero.next, "2");

  await assert.rejects(plugin.browse(JSON.stringify({ list: "no-existe" }), null), (e) => e.code === "not_found");
  await assert.rejects(plugin.browse("texto que no es JSON", null), (e) => e.code === "not_found");
});

test("episodes: temporadas y episodios desde el JSON-LD y el marcado real", async () => {
  const out = await plugin.episodes(JSON.stringify({ type: "serie", slug: "el-mentalista" }));
  assert.equal(out.series.title, "El Mentalista");
  assert.match(out.series.poster, /^https:\/\/image\.tmdb\.org\//);
  assert.match(out.series.backdrop, /w1280/);
  assert.equal(out.series.year, "2008");
  assert.ok(out.series.genres.includes("Crimen"));

  // El sitio anuncia 7 temporadas; aquí solo hay guardadas la 1 y la 2: las que no contestan se saltan.
  assert.equal(out.episodes.length, 46);
  assert.equal(out.episodes.filter((e) => e.season === 1).length, 23);
  assert.equal(out.episodes.filter((e) => e.season === 2).length, 23);

  const first = out.episodes[0];
  assert.deepEqual([first.season, first.number, first.title, first.airDate, first.runtimeMinutes], [1, 1, "Piloto", "2008-09-23", 45]);
  assert.match(first.still, /w500/);

  const second = out.episodes.find((e) => e.season === 2 && e.number === 1);
  assert.ok(second, "empieza la temporada 2");
  assert.match(second.ref, /"season":2,"episode":1/);
  assert.ok(second.title && second.airDate);

  for (const e of out.episodes) {
    assert.ok(Number.isInteger(e.season) && e.season >= 1 && Number.isInteger(e.number) && e.number >= 1);
    assert.match(e.ref, /"type":"episodio"/);
    if (e.airDate) assert.match(e.airDate, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("episodes: ref que no es serie", async () => {
  await assert.rejects(plugin.episodes(JSON.stringify({ type: "pelicula", slug: "x" })), (e) => e.code === "not_found");
  await assert.rejects(plugin.episodes("no es json"), (e) => e.code === "not_found");
});

test("resolve: el enlace sale de la API del reproductor, sin browser ni anuncios", async () => {
  store.clear();
  fetched.length = 0;
  browserCalls = 0;
  const out = await plugin.resolve(JSON.stringify({ type: "pelicula", slug: "madre-siniestra-2026" }));
  assert.equal(out.url, "https://api-encrypted.moviemaster.lat/p/test-hls");
  assert.equal(out.mime, "application/x-mpegURL");
  assert.equal(out.headers.Referer, "https://api-encrypted.moviemaster.lat/");
  // el enlace del reproductor va atado al User-Agent que lo pidió: el stream lo lleva igual
  assert.ok(out.headers["User-Agent"], "el stream declara User-Agent");
  assert.equal(videoUa, out.headers["User-Agent"], "el mismo UA pide el vídeo y lo reproduce");
  assert.equal(browserCalls, 0, "no se abre el browser");
  // el pass lo sirve el sitio y el embed lo recibe con su credencial
  assert.ok(fetched.some((p) => p.startsWith("/api/player-pass?t=movie:1400837")), "pide el pass al sitio");
  assert.ok(fetched.some((p) => p.startsWith("/embed/movie/1400837") && p.includes("pass=v1.test-pass")), "el embed recibe el pass");
  // El iframe se salta y el primer HLS es una publicidad VOD de 30 s: se prueba el proxy.
  const videos = fetched.filter((p) => p.startsWith("/video?"));
  assert.equal(videos.length, 3, "salta iframe y publicidad antes de usar el siguiente servidor");
  assert.ok(videos[0].includes("embed=s-iframe-1"));
  assert.ok(videos[1].includes("embed=s-direct-1"));
  assert.ok(videos[2].includes("embed=s-proxy-1"));
  assert.ok(fetched.includes("/p/ad-hls"), "analiza la duración de la lista publicitaria");
});

test("resolve: una ref de serie abre el primer episodio de la temporada 1", async () => {
  store.clear();
  fetched.length = 0;
  browserCalls = 0;
  const out = await plugin.resolve(JSON.stringify({ type: "serie", slug: "el-mentalista" }));
  assert.equal(out.url, "https://api-encrypted.moviemaster.lat/p/test-hls");
  assert.equal(browserCalls, 0);
  assert.ok(fetched.includes("/serie/el-mentalista/temporada/1/episodio/1"), "abre el episodio 1");
  assert.ok(fetched.some((p) => p.startsWith("/embed/tv/5920/1/1")), "por el reproductor de series");
});

test("resolve: la ref mala es not_found y una página sin reproductor cae al browser", async () => {
  browserCalls = 0;
  await assert.rejects(plugin.resolve("no es json"), (e) => e.code === "not_found");
  await assert.rejects(plugin.resolve(JSON.stringify({ type: "pelicula", slug: "no-existe-2020" })), (e) => e.code === "browser_unavailable");
  assert.ok(browserCalls >= 1, "sin enlace directo se intenta kino.browser");
});

test("search: lo que no se parece al título se queda fuera (filterRelevant)", async () => {
  store.clear();
  const items = await plugin.search({ ...itemQuery(), q: "avatar" });
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => /avatar/i.test(i.title)), "solo títulos que llevan avatar");
});

test("search: el buscador del sitio se guarda en caché", async () => {
  store.clear();
  fetched.length = 0;
  await plugin.search({ ...itemQuery(), q: "avatar" });
  const first = fetched.filter((p) => p.startsWith("/api/suggest")).length;
  fetched.length = 0;
  await plugin.search({ ...itemQuery(), q: "avatar" });
  const second = fetched.filter((p) => p.startsWith("/api/suggest")).length;
  assert.equal(first, 1);
  assert.equal(second, 0, "la segunda búsqueda sirve de la caché");
});

test("episodes: la serie abierta se guarda entera en caché", async () => {
  store.clear();
  const first = await plugin.episodes(JSON.stringify({ type: "serie", slug: "el-mentalista" }));
  assert.equal(first.episodes.length, 46);

  fetched.length = 0;
  const again = await plugin.episodes(JSON.stringify({ type: "serie", slug: "el-mentalista" }));
  assert.equal(fetched.filter((p) => p.includes("/temporada/")).length, 0, "no se vuelven a pedir las temporadas");
  assert.equal(again.episodes.length, 46);
});

test("section: la portada con sus pestañas y su destacado", async () => {
  store.clear();
  config = { pestanas: "ambas" };
  const s = await plugin.section({ tab: null });
  assert.deepEqual(s.tabs.map((t) => t.id), ["inicio", "peliculas", "series"]);
  assert.equal(s.tab, "inicio");
  assert.equal(s.rows.length, 9);
  assert.ok(s.hero && s.hero.title && /^https:\/\//.test(s.hero.image));
  assert.ok(s.rows.every((r) => ID.test(r.id) && r.title && r.items.length > 0));

  const peliculas = await plugin.section({ tab: "peliculas" });
  assert.equal(peliculas.tab, "peliculas");
  assert.equal(peliculas.rows.length, 5);
  for (const row of peliculas.rows) {
    assert.equal(row.items.length, 24);
    assert.ok(row.ref.includes("list") || row.ref.includes("genero"));
    assert.ok(ID.test(row.id));
  }
  assert.deepEqual(JSON.parse(peliculas.rows[0].ref), { list: "peliculas" });

  const series = await plugin.section({ tab: "series" });
  assert.equal(series.rows.length, 5);
  assert.ok(series.rows.every((r) => r.items.length === 24));
  assert.ok(series.rows.every((r) => JSON.parse(r.ref).list.startsWith("series")), "las filas de series usan listas de series");
});

test("section: el ajuste de pestañas quita las que no tocan", async () => {
  store.clear();
  config = { pestanas: "series" };
  const s = await plugin.section({ tab: null });
  assert.deepEqual(s.tabs.map((t) => t.id), ["inicio", "series"]);
  assert.equal(s.tab, "inicio");

  config = { pestanas: "peliculas" };
  const cats = await plugin.categories();
  assert.ok(cats.every((c) => !c.id.startsWith("lista-series")), "sin tiles de series");
  assert.ok(cats.some((c) => c.id === "lista-trending"));
  config = { pestanas: "ambas" };
});

test("categories: tiles con ref válida, y un tile abre browse", async () => {
  const cats = await plugin.categories();
  assert.equal(cats.length, 24);
  assert.ok(cats.filter((c) => c.id.startsWith("lista-")).length >= 8, "las listas de películas y series van delante");
  assert.ok(cats.some((c) => c.id === "genero-drama") && cats.some((c) => c.id === "genero-terror"), "los géneros del sitio se leen de /generos");
  assert.equal(new Set(cats.map((c) => c.id)).size, cats.length);
  for (const c of cats) {
    assert.ok(ID.test(c.id) && c.title.length <= 40 && c.ref);
    const data = JSON.parse(c.ref);
    assert.ok(data.list || data.genero, "cada tile apunta a una lista o a un género");
  }

  const genero = cats.find((c) => c.id === "genero-terror");
  const page = await plugin.browse(genero.ref, null);
  assert.equal(page.items.length, 24);
  assert.equal(page.next, "2");
});

test("settings: el estado, la comprobación y la caché", async () => {
  store.clear();
  config = { pestanas: "ambas" };
  assert.deepEqual(await plugin.settingsStatus(), { estado: "Sin comprobación todavía" });

  const checked = await plugin.action("comprobar");
  assert.equal(checked.refresh, true);
  assert.match(checked.message, /responde/);
  assert.equal((await plugin.settingsStatus()).estado, "cinehaxplus.com respondió en la última comprobación");

  await plugin.search({ ...itemQuery(), q: "avatar" });
  assert.ok(store.has("buscar:avatar"), "quedó la caché de la búsqueda");
  assert.deepEqual(await plugin.action("limpiar"), { message: "Caché borrada", refresh: true });
  assert.ok(!store.has("buscar:avatar"), "la caché se borró");

  assert.equal(await plugin.action("otra"), null);
});

test("validateSettings: el ajuste de pestañas solo admite sus opciones", async () => {
  assert.equal(await plugin.validateSettings({ pestanas: "series" }), null);
  assert.equal(await plugin.validateSettings({}), null);
  assert.deepEqual(await plugin.validateSettings({ pestanas: "x" }), { pestanas: "Elige una opción de la lista" });
});
