# Data and image licensing

LifeCards source code is proprietary. Third-party scientific data and media keep their own licenses and attribution requirements.

## Lifemap

Lifemap is used as an **external scientific navigation destination**, not as embedded code or copied artwork.

- Current public service: https://lifemap.cnrs.fr
- LifeCards resolves an NCBI Taxonomy ID and deep-links to the corresponding Lifemap tree location.
- Lifemap's published repository is GPL-licensed and its website/images/logos are described by the project as CC BY-NC 4.0, so LifeCards does not copy or bundle those assets into the proprietary codebase.

## NCBI Taxonomy

NCBI Taxonomy is used for taxonomic identifiers and rank metadata through NCBI E-Utilities. The NCBI taxid is also the bridge used to open the same taxon in Lifemap.

The runtime caches taxonomic lookups. Bulk enrichment should use an NCBI API key when appropriate and conservative request pacing.

## Wikipedia

Wikipedia is used as an encyclopedia overview source in the card detail view. The app stores source language, title, canonical URL and the retrieved introductory extract in a time-limited cache.

Wikipedia text is **not treated as the authoritative source for finite Wild Census denominators or conservation assessments**. Those require a separate curated scientific data workflow.

## Wikimedia Commons

Card photography is retrieved from Wikimedia Commons. The media provider:
- requests machine-readable `extmetadata`;
- accepts only configured reusable license families (for example CC BY/CC BY-SA, CC0 or public-domain markers);
- stores creator, license, source URL, license URL and attribution;
- prefers high-resolution bitmap photography and penalizes maps, logos and diagrams for species cards.

Any production export or offline media cache must retain attribution metadata next to the asset record.

## Scientific snapshots

Population estimates, conservation status, geography and other changeable facts must be versioned with source, date and uncertainty. Already-issued serialized editions must never have their historical denominator silently rewritten.
