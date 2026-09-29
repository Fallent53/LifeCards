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
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_provenance jsonb NOT NULL DEFAULT '[]'::jsonb,
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
  card_id uuid NOT NULL REFERENCES cards(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  buyer_id uuid REFERENCES users(id),
  price bigint NOT NULL CHECK(price > 0),
  status listing_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  sold_at timestamptz
);

CREATE TABLE external_cache (
  provider text NOT NULL,
  cache_key text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(provider, cache_key)
);
CREATE INDEX external_cache_expiry_idx ON external_cache(expires_at);

CREATE UNIQUE INDEX listings_one_active_per_card
  ON listings(card_id) WHERE status = 'ACTIVE';

CREATE TABLE auctions (
  id uuid PRIMARY KEY,
  card_id uuid NOT NULL REFERENCES cards(id),
  seller_id uuid NOT NULL REFERENCES users(id),
  starting_price bigint NOT NULL CHECK(starting_price > 0),
  highest_bid bigint,
  highest_bidder_id uuid REFERENCES users(id),
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE UNIQUE INDEX auctions_one_active_per_card
  ON auctions(card_id) WHERE status = 'ACTIVE';
CREATE INDEX auctions_status_end_idx ON auctions(status, ends_at);

CREATE TABLE auction_bids (
  id uuid PRIMARY KEY,
  auction_id uuid NOT NULL REFERENCES auctions(id),
  bidder_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL CHECK(amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_stats (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  points bigint NOT NULL DEFAULT 0,
  correct_answers bigint NOT NULL DEFAULT 0,
  total_answers bigint NOT NULL DEFAULT 0,
  streak integer NOT NULL DEFAULT 0,
  best_streak integer NOT NULL DEFAULT 0
);

CREATE TABLE quiz_questions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  prompt text NOT NULL,
  options jsonb NOT NULL,
  correct_option text NOT NULL,
  explanation text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE TABLE pack_audit (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL,
  prev_hash text,
  audit_hash text NOT NULL UNIQUE
);
CREATE INDEX pack_audit_opened_idx ON pack_audit(opened_at DESC);
