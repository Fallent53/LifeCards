# Data and image licensing

LifeCards source code is proprietary. Third-party scientific data and media keep their own licenses.

Lifemap is a design inspiration for map-like navigation only. Do not copy Lifemap code or non-commercial imagery into the proprietary product.

The MVP media provider searches Wikimedia Commons and only accepts metadata containing CC BY/CC-BY, CC0 or public-domain style markers. Each production media record should persist source URL, original URL, creator, license, license URL, attribution and retrieval date.

Scientific facts must be imported into LifeCards with source/version provenance. Population snapshots must preserve their original date and denominator rather than silently changing already-issued serialized editions.

Before commercial launch, every upstream dataset/API must be reviewed for commercial reuse and attribution requirements.


## Wikipedia, Wikidata and Lifemap integration

LifeCards resolves descriptive card metadata through Wikipedia and Wikidata. Wikimedia Commons is used for card imagery only when the returned file metadata indicates an accepted reusable license; author, license and source URL are retained.

Wikidata is used as the bridge to NCBI Taxonomy identifiers (property P685). LifeCards then creates an external deep-link to the corresponding node in Lifemap NCBI using the taxid query parameter.

LifeCards does **not** embed, copy or redistribute Lifemap's application code or map assets. The integration is an outbound link to the Lifemap service. This keeps the proprietary application independent while still giving players direct access to the scientific explorer.

Run `npm run sync:knowledge` to generate a timestamped local metadata snapshot. Treat that snapshot as third-party data: it must retain source provenance and should be reviewed before a commercial release.
