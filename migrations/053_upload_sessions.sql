-- Large document uploads in pieces (each below the hosting platform's request limit), resumable after a
-- dropped connection. Pieces are private objects; the assembled file goes through the normal document rules.
CREATE TABLE upload_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid NOT NULL REFERENCES staff(id),
  target_kind   text NOT NULL CHECK (target_kind IN ('APPLICATION','STAFF_REQUEST')),
  target_id     uuid NOT NULL,
  category      text NOT NULL,
  filename      text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  chunk_size    int NOT NULL CHECK (chunk_size > 0),
  chunk_count   int NOT NULL CHECK (chunk_count > 0),
  fields        jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETING','COMPLETED','ABORTED','EXPIRED','FAILED')),
  result        jsonb,
  error         text,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL
);
CREATE INDEX upload_sessions_staff_idx ON upload_sessions(staff_id, created_at DESC);
CREATE INDEX upload_sessions_open_idx ON upload_sessions(expires_at) WHERE status IN ('OPEN','COMPLETING');

CREATE TABLE upload_chunks (
  session_id  uuid NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  n           int NOT NULL CHECK (n >= 0),
  size_bytes  int NOT NULL,
  sha256      text NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, n)
);
