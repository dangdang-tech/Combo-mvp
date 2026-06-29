-- 0006 · 工作台/主页/社交域（60）。creator_profiles / follows / likes / creator_capability_cooccur。

CREATE TABLE creator_profiles (
  user_id         uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug            text        NOT NULL UNIQUE,
  display_name    text        NOT NULL,
  avatar_url      text,
  identity_tags   text[]      NOT NULL DEFAULT '{}',
  bio             text        NOT NULL DEFAULT '',
  heatmap_enabled boolean     NOT NULL DEFAULT true,
  followers_count integer     NOT NULL DEFAULT 0 CHECK (followers_count >= 0),
  following_count integer     NOT NULL DEFAULT 0 CHECK (following_count >= 0),
  likes_count     integer     NOT NULL DEFAULT 0 CHECK (likes_count >= 0),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_creator_profiles_slug ON creator_profiles (slug);

CREATE TABLE follows (
  follower_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id  uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows (followee_id);
CREATE INDEX idx_follows_follower ON follows (follower_id);

CREATE TABLE likes (
  user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id  uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, capability_id)
);
CREATE INDEX idx_likes_capability ON likes (capability_id);
CREATE INDEX idx_likes_user       ON likes (user_id);

CREATE TABLE creator_capability_cooccur (
  creator_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_a   uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  capability_b   uuid        NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
  basis          text        NOT NULL,
  weight         integer     NOT NULL DEFAULT 1 CHECK (weight > 0),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, capability_a, capability_b, basis),
  CHECK (capability_a < capability_b)
);
CREATE INDEX idx_cooccur_creator ON creator_capability_cooccur (creator_id, weight DESC);
