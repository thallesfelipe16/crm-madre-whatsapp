-- Migração 002 — adiciona nome do atendente atribuído
ALTER TABLE wa_conversations ADD COLUMN IF NOT EXISTS assigned_user_name VARCHAR(255);
