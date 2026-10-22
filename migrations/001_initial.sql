-- Migração 001 — Schema inicial do módulo WhatsApp
-- Banco: crm-whatsapp (SEPARADO do crm-madre)
-- Executar apenas uma vez no banco de staging/produção do módulo WA

-- Extensão para gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Contas Evolution (uma por instância/campus)
CREATE TABLE IF NOT EXISTS wa_accounts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_ref    VARCHAR(100) NOT NULL UNIQUE,
  label           VARCHAR(100) NOT NULL,
  connection_state VARCHAR(50) NOT NULL DEFAULT 'close',
  enabled         BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Contatos (número de telefone por instância)
CREATE TABLE IF NOT EXISTS wa_contacts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_ref VARCHAR(100) NOT NULL,
  phone_e164   VARCHAR(20)  NOT NULL,
  display_name VARCHAR(255),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instance_ref, phone_e164)
);

CREATE INDEX IF NOT EXISTS wa_contacts_instance_idx ON wa_contacts (instance_ref);

-- Conversas
CREATE TABLE IF NOT EXISTS wa_conversations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_ref   VARCHAR(100) NOT NULL,
  contact_id     UUID        NOT NULL REFERENCES wa_contacts(id),
  state          VARCHAR(20) NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'pending', 'resolved', 'archived')),
  assigned_user_ref TEXT,
  last_message_at TIMESTAMPTZ,
  unread_count   INTEGER     NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (instance_ref, contact_id)
);

CREATE INDEX IF NOT EXISTS wa_conversations_inbox_idx
  ON wa_conversations (instance_ref, state, last_message_at DESC);

-- Mensagens
CREATE TABLE IF NOT EXISTS wa_messages (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     UUID        NOT NULL REFERENCES wa_conversations(id),
  instance_ref        VARCHAR(100) NOT NULL,
  provider_message_id VARCHAR(255),
  direction           VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type        VARCHAR(50) NOT NULL DEFAULT 'text',
  body                TEXT,
  provider_timestamp  TIMESTAMPTZ,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status              VARCHAR(20) NOT NULL DEFAULT 'received',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotência: mesma mensagem não entra duas vezes
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_provider_unique
  ON wa_messages (instance_ref, provider_message_id, direction)
  WHERE provider_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS wa_messages_conv_idx
  ON wa_messages (conversation_id, received_at DESC, id DESC);

-- Eventos recebidos do webhook (inbox durável + idempotência)
CREATE TABLE IF NOT EXISTS wa_webhook_events (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_ref     VARCHAR(100) NOT NULL,
  event_name       VARCHAR(100) NOT NULL,
  event_key        VARCHAR(500) NOT NULL UNIQUE,
  payload          JSONB,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at     TIMESTAMPTZ,
  processing_state VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (processing_state IN ('pending', 'done', 'error')),
  attempt_count    INTEGER     NOT NULL DEFAULT 0,
  last_error       TEXT
);

CREATE INDEX IF NOT EXISTS wa_webhook_events_state_idx
  ON wa_webhook_events (processing_state, received_at)
  WHERE processing_state != 'done';
