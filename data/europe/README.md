This folder can host region-specific datasets for Europe.

By default, the app fetches a city list from a URL you configure at runtime via `window.EU_CITY_DATA_URL`.

If you prefer a local file, you can provide `data/europe/eu_cities_30k.js` that defines a global `EU_CITY_DATA_30K = [...]` array with objects in the form:

- { name: string, state: ISO-2 country code, lat: number, lon: number, pop: number }

Only cities with `pop >= 30000` are recommended for performance and consistency.

