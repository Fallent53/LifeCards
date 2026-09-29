# LifeCards — Game Design

## Core loop
- One free pack accrues every 8 minutes.
- Maximum storage: 8 packs.
- Each pack contains 6 normal cards.
- Every normal slot rolls rarity, then an eligible species/taxon, then finish.
- Holo is independent at 7.5% by default.
- LUCA uses a completely separate Origin roll and never replaces one of the six cards.

## Card families
Species cards represent extant or extinct species. Taxon cards represent collectible phylogenetic nodes such as Bacteria, Archaea, Eukaryota, Animalia, Mollusca, Arthropoda, Chordata, Mammalia, Dinosauria, Felidae and Panthera.

Taxon rarity generally increases toward the root of the tree.

## Editions
Extant species start with WILD CENSUS I, a finite serialized edition. The prototype uses seed caps; production caps must come from versioned, cited scientific snapshots. Once exhausted, the species drops as RESEARCH.

Extinct species start with FOSSIL RECORD I and later PALEO ARCHIVE. Taxon cards start with FOUNDATION I and later ARCHIVE TAXON.

## LUCA
LUCA is not Mega Legendary. Its rarity is UNKNOWN. Only one may ever exist: #1/1. It is eligible from the first pack. The Origin roll is independent, server-side and protected by a unique supply constraint.

## Market
Cards preserve definition, edition, serial and finish through trades. The MVP uses fixed-price listings and a 5% coin sink. Competitive power must never depend on Wild/Holo status.

## Scientific boundary
Conservation status, wild abundance and in-game rarity are separate concepts. Gameplay rarity must never masquerade as scientific rarity.
