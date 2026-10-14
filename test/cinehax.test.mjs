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
  "/serie/el-mentalista/temporada/2": read("temporada-2-el-mentalista.html"),
  "/peliculas?sort=release": read("peliculas-release.html"),
  "/peliculas/page/2?sort=release": read("peliculas-release-p2.html"),
  "/peliculas?sort=trending": read("peliculas-release.html"),
  "/peliculas?sort=rating": read("peliculas-release.html"),
  "/series": read("series-release.html"),
  "/series?sort=release": read("series-release.html"),
  "/series?sort=popular": read("series-release.html"),
  "/series?sort=rating": read("series-release.html"),
  "/genero/suspense": read("genero-suspense.html"),
};

let fetched = [];
let config = { pestanas: "ambas" };
const store = new Map();

globalThis.kino = {
  fetch: async (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, "");
    fetched.push(path);
    if (Object.prototype.hasOwnProperty.call(PAGES, path)) return { ok: true, status: 200, text: async () => PAGES[path] };
    // Cualquier género sirve la misma rejilla: lo que se prueba es la estructura, no el catálogo.
    const genre = /^\/genero\/[a-z-]+$/.exec(path);
    if (genre) return { ok: true, status: 200, text: async () => PAGES["/genero/suspense"] };
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
    capture: async () => { throw kinoError("browser_unavailable", "sin navegador en el kit"); },
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
  assert.deepEqual(JSON.parse(nuevas.ref), { list: "peliculas-release" });

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

test("resolve: la ref mala es not_found y el navegador se pide a kino.browser", async () => {
  await assert.rejects(plugin.resolve("no es json"), (e) => e.code === "not_found");
  await assert.rejects(plugin.resolve(JSON.stringify({ type: "pelicula", slug: "madre-siniestra-2026" })), (e) => e.code === "browser_unavailable");
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
  assert.equal(peliculas.rows.length, 3);
  for (const row of peliculas.rows) {
    assert.equal(row.items.length, 24);
    assert.ok(row.ref.includes("list") || row.ref.includes("genero"));
    assert.ok(ID.test(row.id));
  }

  const series = await plugin.section({ tab: "series" });
  assert.equal(series.rows.length, 3);
  assert.ok(series.rows.every((r) => r.items.length === 24));
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
  assert.equal(cats.length, 22);
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
