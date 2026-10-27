ALTER TABLE wa_messages
  ADD COLUMN IF NOT EXISTS media_mime_type VARCHAR(100),
  ADD COLUMN IF NOT EXISTS media_caption   TEXT,
  ADD COLUMN IF NOT EXISTS media_key       JSONB;
