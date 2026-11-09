-- Suporte a mensagens editadas (WhatsApp message edit feature)
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
