# CineHax+

Plugin de Kino para [CineHax+](https://cinehaxplus.com) — películas y series en español latino.

**Creado por JuandreXter**

## Instalar en Kino

En Kino, Ajustes → Plugins → Agregar → escribe `JuanDEVYT/cinehax-plus` → Instalar.

## Características

- Búsqueda de películas y series
- Página de inicio con recién añadidos, tendencias y series recientes
- Temporadas y episodios completos
- Descargas offline (donde el source lo permite)
- Firmado por el autor

## Para desarrolladores

Requiere Node 18+ y el `sdk/` de una plantilla de Kino.

```bash
node sdk/validate.mjs .
node sdk/run.mjs . search "avatar"
node sdk/run.mjs . home
node sdk/run.mjs . episodes '{"type":"serie","slug":"el-mentalista"}'
```

> `resolve` usa `kino.browser.capture` — solo funciona en la app, no en el kit de Node.
