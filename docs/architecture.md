# Architecture

LifeCards is intentionally platform-independent and self-hostable.

## MVP runtime
Node.js 22 serves the web client and JSON API. SQLite via node:sqlite provides a zero-dependency local persistence layer. The production target is PostgreSQL; a reference schema is in db/schema.sql.

All pack RNG, serial allocation, supply transitions, market settlement and LUCA issuance occur server-side. The browser never decides ownership.

## Atomicity
Pack opening executes in an immediate transaction. Serial allocation is unique per definition + edition + serial. LUCA additionally has a global one-of-one supply rule. Production PostgreSQL should retain equivalent unique constraints and transactional locking.

## Main modules
- src/catalog.mjs — prototype definitions and tree relationships.
- src/game-engine.mjs — rarity, selection, Holo, Origin roll and pack accrual.
- src/database.mjs — ownership, editions, serials, market and transactions.
- src/media.mjs — Wikimedia Commons lookup with attribution metadata.
- public/ — browser UI.
- scripts/simulate.mjs — economy/RNG simulation.

## Production roadmap
Move auth to passkeys/OAuth, SQLite to PostgreSQL, add Redis for rate limits/caches, ingest versioned taxonomy datasets, implement immutable provenance/audit records, anti-bot/device-risk controls, auctions/offers/guilds and scientific editorial tooling.


## Scientific provider layer

`src/science.mjs` combines:
- Wikipedia: human-readable overview;
- NCBI Taxonomy: stable taxonomic identifier/rank;
- Lifemap: external tree deep-link generated from the NCBI taxid.

`src/media.mjs` selects licensed Wikimedia Commons imagery and persists creator/license attribution. External API responses are cached in SQLite through `external_cache`; the PostgreSQL production schema contains an equivalent table.

The external providers enrich cards but do not control ownership, RNG, serial allocation or card supply.
