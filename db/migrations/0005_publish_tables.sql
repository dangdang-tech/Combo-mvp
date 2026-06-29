-- 0005 · 发布域（50）。capability_tiers / publications / marketplace_listings / publish_batches / publish_batch_items / eval_reports(冻结)。
-- §11.E：publications/listings 复合 FK（固定约束名）。
-- 注：marketplace_listings.slug gin_trgm_ops 索引为 P1（需 pg_trgm），本期改普通 btree 以保证 stock PG 可跑。

CREATE TABLE capability_tiers (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  version_id    uuid        NOT NULL REFERENCES capability_versions(id) ON DELETE CASCADE,
  tier_code     text        NOT NULL,
  price_micros  bigint      NOT NULL CHECK (price_micros >= 0),
  quota         jsonb,
  frozen_at     timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, tier_code)
);
CREATE INDEX idx_tiers_version ON capability_tiers (version_id);

CREATE TABLE publications (
  id                 uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  capability_id      uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  current_version_id uuid        NOT NULL,
  share_token        text        NOT NULL,
  visibility         text        NOT NULL DEFAULT 'public',
  review_status      text        NOT NULL DEFAULT 'alpha_pending',
  reject_reason      text,
  reviewed_at        timestamptz,
  published_at       timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability_id),
  UNIQUE (share_token),
  CHECK (visibility IN ('public','unlisted')),
  CHECK (review_status IN ('alpha_pending','published','review_rejected')),
  CONSTRAINT fk_publications_capability_version
    FOREIGN KEY (capability_id, current_version_id)
    REFERENCES capability_versions (capability_id, id)
);
CREATE INDEX idx_pub_review_status   ON publications (review_status);
CREATE INDEX idx_pub_current_version ON publications (current_version_id);

CREATE TABLE marketplace_listings (
  capability_id  uuid        PRIMARY KEY REFERENCES capabilities(id) ON DELETE CASCADE,
  version_id     uuid        NOT NULL,
  slug           text        NOT NULL,
  card           jsonb       NOT NULL,
  search_tsv     tsvector,
  status         text        NOT NULL DEFAULT 'alpha_pending',
  listed_at      timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (status IN ('alpha_pending','published','unlisted','delisted')),
  CONSTRAINT uq_listings_slug UNIQUE (slug),
  CONSTRAINT fk_listings_capability_version
    FOREIGN KEY (capability_id, version_id)
    REFERENCES capability_versions (capability_id, id)
);
CREATE INDEX idx_listings_search ON marketplace_listings USING GIN (search_tsv);
CREATE INDEX idx_listings_slug   ON marketplace_listings (slug); -- P1 换 gin_trgm_ops（pg_trgm 模糊）
CREATE INDEX idx_listings_status ON marketplace_listings (status) WHERE status IN ('alpha_pending','published');

CREATE OR REPLACE FUNCTION enforce_listing_slug() RETURNS trigger AS $$
BEGIN
  SELECT slug INTO NEW.slug FROM capabilities WHERE id = NEW.capability_id;
  IF NEW.slug IS NULL THEN
    RAISE EXCEPTION 'capability % has no slug', NEW.capability_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_listing_slug
  BEFORE INSERT OR UPDATE OF capability_id ON marketplace_listings
  FOR EACH ROW EXECUTE FUNCTION enforce_listing_slug();

CREATE TABLE publish_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  owner_user_id   uuid        NOT NULL REFERENCES users(id),
  job_id          uuid        NOT NULL REFERENCES jobs(id),
  total           int         NOT NULL,
  published_count int         NOT NULL DEFAULT 0,
  failed_count    int         NOT NULL DEFAULT 0,
  processed_count int         NOT NULL GENERATED ALWAYS AS (published_count + failed_count) STORED,
  status          text        NOT NULL DEFAULT 'queued',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_batches_owner ON publish_batches (owner_user_id, created_at DESC);

CREATE TABLE publish_batch_items (
  id              uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  batch_id        uuid        NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
  candidate_id    uuid        REFERENCES capability_candidates(id),
  version_id      uuid        REFERENCES capability_versions(id),
  capability_id   uuid        REFERENCES capabilities(id),
  idempotency_key text        NOT NULL,
  state           text        NOT NULL DEFAULT 'pending',
  subject         jsonb       NOT NULL,   -- 建批落的逐项发布入参（cover/tiers/visibility…），worker 取它走 publish-one（batch-repo 读写）
  missing_fields  text[],
  error           jsonb,
  attempt_no      int         NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key),
  CHECK (state IN ('pending','structuring','publishing','published','failed')),
  CHECK (candidate_id IS NOT NULL OR version_id IS NOT NULL)
);
CREATE INDEX idx_batch_items_batch  ON publish_batch_items (batch_id, created_at);
CREATE INDEX idx_batch_items_failed ON publish_batch_items (batch_id) WHERE state = 'failed';

-- eval_reports（B-31，冻结：建表不写）
CREATE TABLE eval_reports (
  id            uuid        PRIMARY KEY DEFAULT gen_uuid_v7(),
  version_id    uuid        NOT NULL REFERENCES capability_versions(id) ON DELETE CASCADE,
  manifest_hash text        NOT NULL,
  report        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  passed        boolean,                               -- 评测结论（B-31 契约预留，本期不参与发布门）
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, manifest_hash)
);
