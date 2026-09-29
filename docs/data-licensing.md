# Data and image licensing

LifeCards source code is proprietary. Third-party scientific data and media keep their own licenses.

Lifemap is a design inspiration for map-like navigation only. Do not copy Lifemap code or non-commercial imagery into the proprietary product.

The media resolver uses Wikipedia/Wikidata to identify candidate files and Wikimedia Commons to verify file metadata. It accepts reusable CC BY / CC BY-SA, CC0 and public-domain style media while explicitly rejecting NonCommercial and NoDerivatives variants in the automated path. Each production media record should persist source URL, original URL, creator, license, license URL, attribution and retrieval date.

Scientific facts must be imported into LifeCards with source/version provenance. Population snapshots must preserve their original date and denominator rather than silently changing already-issued serialized editions.

Before commercial launch, every upstream dataset/API must be reviewed for commercial reuse and attribution requirements.


## Wikipedia, Wikidata and Lifemap integration

LifeCards resolves descriptive card metadata through Wikipedia and Wikidata. Wikimedia Commons is used for card imagery only when the returned file metadata indicates an accepted reusable license; author, license and source URL are retained.

Wikidata is used as the bridge to NCBI Taxonomy identifiers (property P685). LifeCards then creates an external deep-link to the corresponding node in Lifemap NCBI using the taxid query parameter.

LifeCards does **not** embed, copy or redistribute Lifemap's application code or map assets. The integration is an outbound link to the Lifemap service. This keeps the proprietary application independent while still giving players direct access to the scientific explorer.

Run `npm run sync:knowledge` to generate a timestamped local metadata snapshot. Treat that snapshot as third-party data: it must retain source provenance and should be reviewed before a commercial release.


## Catalogue of Life backbone

Catalogue of Life / ChecklistBank is the primary taxonomic backbone for the large-scale animal catalogue and radial Tree of Life. LifeCards supports two modes:

- **Live mode** queries the public ChecklistBank API for search and tree navigation.
- **Snapshot mode** imports a pinned DwCA release into a local SQLite database with `npm run sync:col`.

A snapshot records its dataset key, import date, scope, source URL and counts in the database metadata table. Moving to a newer COL release must be an explicit migration rather than silently rewriting already-issued card provenance.

Catalogue of Life releases aggregate many contributing datasets. Before a commercial launch, release-level terms, required citation and contributing-source requirements must be reviewed and preserved. The product should expose the COL taxon identifier/source link on taxon detail pages wherever possible.

The Extended Release maximizes coverage; a stricter production track may choose the Base Release for particular scientific features when expert-vetted coverage is preferable to completeness.

## Source roles

- **Catalogue of Life / ChecklistBank:** accepted names, hierarchy, taxonomic identifiers, vernacular names when present.
- **Wikipedia:** human-readable introductory description and a lead-image candidate.
- **Wikidata:** structured cross-identifiers, especially NCBI Taxonomy ID and Commons media candidates.
- **Wikimedia Commons:** image bytes plus machine-readable author/license/attribution metadata.
- **NCBI Taxonomy:** external molecular/taxonomic identifier used for cross-linking.
- **Lifemap NCBI:** outbound visualization/deep-link target; no Lifemap code or assets are embedded.
