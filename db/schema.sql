-- PostgreSQL production target for LifeCards.
CREATE TYPE card_kind AS ENUM ('species','taxon','origin');
CREATE TYPE card_finish AS ENUM ('STANDARD','HOLO','ORIGIN');
CREATE TYPE listing_status AS ENUM ('ACTIVE','SOLD','CANCELLED');

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  coins bigint NOT NULL DEFAULT 10000 CHECK (coins >= 0),
  pack_balance smallint NOT NULL DEFAULT 1 CHECK (pack_balance BETWEEN 0 AND 8),
  pack_anchor_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE card_definitions (
  id text PRIMARY KEY,
  kind card_kind NOT NULL,
  scientific_name text NOT NULL,
  common_name text NOT NULL,
  parent_id text REFERENCES card_definitions(id),
  rarity text NOT NULL,
  rank text,
  temporal_status text,
  edition_cap bigint,
  media_query text,
  scientific_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE supplies (
  definition_id text NOT NULL REFERENCES card_definitions(id),
  edition_key text NOT NULL,
  issued_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(definition_id,edition_key)
);
CREATE TABLE cards (
  id uuid PRIMARY KEY,
  definition_id text NOT NULL REFERENCES card_definitions(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  edition_key text NOT NULL,
  serial_number bigint NOT NULL,
  serial_cap bigint,
  finish card_finish NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(definition_id,edition_key,serial_number)
);
CREATE UNIQUE INDEX unique_luca ON cards(definition_id) WHERE definition_id='luca';
CREATE TABLE listings (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL UNIQUE REFERENCES cards(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  buyer_id uuid REFERENCES users(id),
  price bigint NOT NULL CHECK(price > 0),
  status listing_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  sold_at timestamptz
);
