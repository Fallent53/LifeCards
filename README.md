# LifeCards

**Collect life. Reconstruct its history. Find the origin.**

LifeCards is a proprietary, self-hostable collectible-card game built around the phylogenetic tree of life.

## Current vertical slice

- 1 pack every **8 minutes**
- maximum **8 stored packs**
- **6 normal cards per pack**
- collectible **species and phylogenetic taxa**
- taxon cards become rarer toward the root of the tree
- independent **7.5% Holo** finish roll
- serialized finite editions
  - extant species: **WILD CENSUS I → RESEARCH**
  - extinct species: **FOSSIL RECORD I → PALEO ARCHIVE**
  - taxa: **FOUNDATION I → ARCHIVE TAXON**
- **LUCA — UNKNOWN #1/1**
  - eligible from the first pack
  - independent Origin roll
  - never replaces one of the six normal cards
  - database-enforced one-of-one
- collection
- interactive Tree of Life album
- Codex
- fixed-price market with a 5% coin sink
- Wikimedia Commons image lookup with attribution metadata
- Docker, tests, RNG simulation and GitHub CI

## Run locally

Requires Node.js 22.5+.

```bash
npm start
```

Open http://localhost:3000

For development:

```bash
npm run dev
```

Run tests:

```bash
npm test
npm run check
```

Run an economy/RNG simulation:

```bash
node scripts/simulate.mjs 20000
```

Refresh the scientific metadata snapshot from Wikipedia/Wikidata/NCBI:

```bash
npm run sync:knowledge
```

Card detail views resolve Wikipedia summaries, Wikidata entity IDs and NCBI Taxonomy IDs. When a taxid is available, LifeCards exposes a direct **View in Lifemap** deep-link to the matching node in Lifemap NCBI.

## Full Catalogue of Life taxonomy

LifeCards uses the public Catalogue of Life / ChecklistBank API as a live taxonomy fallback, so Tree search and Codex search can reach the large catalogue without committing millions of records to Git.

For a fast, reproducible and offline scientific snapshot, build the local Animalia database:

```bash
npm install
npm run sync:col
```

This downloads a pinned Catalogue of Life Extended Release from ChecklistBank, keeps accepted **Animalia** taxa, imports the hierarchy into `data/animalia.sqlite`, adds direct-child counts, and imports preferred vernacular names when the DwCA release provides them.

After the import, restart LifeCards:

```bash
npm start
```

The Tree of Life and Codex automatically prefer the local CoL database when present; otherwise they use ChecklistBank live, and only fall back to the tiny seed catalog if the external service is unavailable. The UI never tries to render millions of nodes simultaneously: it loads a bounded radial subtree around the branch being explored.

To make the **Tree of Life** use the complete catalogue while keeping gameplay drops centered on Animalia:

```bash
npm run sync:map
```

This reuses the same cached Catalogue of Life DwCA archive, writes a separate `data/life.sqlite`, and skips drop-pool generation. LifeCards then uses:

- `data/animalia.sqlite` for pack/drop selection;
- `data/life.sqlite` for Tree of Life search and cartography.

If `life.sqlite` is absent, the map transparently falls back to `animalia.sqlite`. This separation prevents a full-life scientific map from flooding normal packs with every microbial species in the catalogue.

You can pin a different ChecklistBank release with `COL_DATASET_KEY` or `--dataset`. The default dataset key is documented in `scripts/sync-col.mjs` and should be updated deliberately when moving to a new scientific snapshot.

### Images

For a taxon opened in the UI, LifeCards resolves imagery lazily in this order:

1. lead image from Wikipedia;
2. Wikidata P18 image;
3. Wikimedia Commons search;
4. LifeCards graphical fallback.

A Commons image is only used when its machine-readable metadata indicates an accepted reusable license. Some described species have no suitable freely licensed image, so a scientifically honest fallback remains necessary.

### Radial Tree

The Tree view is a proprietary radial renderer. It does not copy Lifemap code or assets. It supports zoom, pan, branch drill-down, full-taxonomy search, breadcrumbs, and outbound Lifemap/NCBI links when a Wikidata NCBI taxonomy ID can be resolved.


## LUCA development mode

Production-intent default:

```text
LIFECARDS_LUCA_DENOMINATOR=1000000000
```

To force the Origin roll locally:

```bash
LIFECARDS_LUCA_DENOMINATOR=1 npm start
```

The database still prevents a second LUCA from being issued.

## Docker

```bash
docker compose up --build
```

## Architecture

The MVP deliberately has no required SaaS dependency. Node.js serves both the static application and API. SQLite is used for the zero-dependency vertical slice; `db/schema.sql` defines the PostgreSQL production direction.

Critical game decisions happen server-side:

- pack generation
- rarity selection
- Holo rolls
- LUCA Origin roll
- serial allocation
- edition exhaustion
- ownership
- market settlement

See:

- [Game design](docs/game-design.md)
- [Architecture](docs/architecture.md)
- [Data & licensing](docs/data-licensing.md)
- [Roadmap](docs/roadmap.md)

## Scientific data

The current catalog is a **prototype seed catalog**, not the final scientific database. Production population denominators must come from versioned and cited scientific snapshots. Conservation status, real-world abundance and in-game rarity are intentionally separate concepts.

Lifemap is used only as inspiration for the map-like navigation concept. Its code/assets are not copied into LifeCards.

## License

The LifeCards source code is proprietary. Third-party scientific data and media retain their original licenses. See [LICENSE](LICENSE) and [docs/data-licensing.md](docs/data-licensing.md).


## Large taxonomy & low-cost data strategy

LifeCards does **not** query a remote taxonomy API while the player browses the Tree of Life.

```bash
npm install
npm run sync:col
```

This imports the Catalogue of Life Animalia snapshot into `data/animalia.sqlite`, builds local indexes plus an FTS5 search index, and precomputes direct-child counts. By default it downloads the official **latest Base Release DwCA** once and keeps the archive locally, so rebuilding the SQLite indexes does not repeatedly consume hundreds of MB of bandwidth. Use `npm run sync:col -- --refresh` when you intentionally want a newer upstream snapshot. The radial tree then reads only the visible subtree from SQLite.

After changes to the importer/search schema, rerun `npm run sync:col` to rebuild the local taxonomy database.

External enrichment is deliberately lazy:

- Catalogue of Life taxonomy: local snapshot
- Wikipedia/Wikidata: only when a card/taxon is actually viewed
- Wikimedia Commons image metadata: only when needed
- scientific/image results: persistent `data/knowledge.sqlite` cache
- successful images: cached for up to 90 days by default
- negative/no-image results: retried after at most 24 hours
- owned cards can be warmed ahead of time with `npm run prefetch:cards`
- the small initial curated catalogue can be warmed with `npm run prefetch:catalog`
- public taxonomy/knowledge API responses use browser/CDN cache headers

This is intentional: prefetching media for millions of species would be slow, wasteful and unfriendly to upstream public APIs.


### Separate gameplay and map taxonomies

`LIFECARDS_TAXONOMY_DB` controls the taxonomy used by collectible drop pools. The default is `data/animalia.sqlite`.

`LIFECARDS_MAP_TAXONOMY_DB` controls the optional larger taxonomy used by Tree of Life navigation. The default is `data/life.sqlite`. If that file does not exist or is on an old schema, LifeCards automatically uses the gameplay taxonomy instead.
