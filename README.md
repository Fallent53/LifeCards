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
