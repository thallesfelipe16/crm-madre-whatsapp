# Setup — crm-madre-whatsapp

## 1. Banco de dados (EasyPanel)

Criar novo serviço Postgres no EasyPanel:
- **Nome do serviço**: `crm-madre-whatsapp_db`
- **Banco**: `crm-whatsapp`
- **Usuário**: `wa_app`
- **Senha**: gerar uma senha forte (não reutilizar a senha do CRM)

Após criar, rodar a migration inicial:
```bash
psql $DATABASE_URL -f migrations/001_initial.sql
```

## 2. Variáveis de ambiente (EasyPanel → Environment)

Copiar `.env.example` e preencher:

```
DATABASE_URL=postgres://wa_app:SENHA@crm-madre-whatsapp_db:5432/crm-whatsapp?sslmode=disable
EVOLUTION_URL=https://[sua-evolution]
EVOLUTION_API_KEY=[api-key-global-da-evolution]
APP_URL=https://[dominio-deste-servico]

# Gerar cada secret com:
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
WEBHOOK_SECRET_C1_BOA_VIAGEM=...
WEBHOOK_SECRET_C2_BOA_VIAGEM=...
WEBHOOK_SECRET_C3_TAMARINEIRA=...
WEBHOOK_SECRET_C4_TAMARINEIRA=...
```

## 3. Deploy no EasyPanel

- Criar novo serviço "App" apontando para este repositório
- Selecionar Dockerfile builder
- Porta: `3002`
- Configurar domínio (ex: `whatsapp-api.arcorastudio.com.br`)

## 4. Criar instâncias na Evolution

Após o serviço estar no ar, chamar para cada campus:

```bash
curl -X POST https://[seu-dominio]/admin/instances/madre_c1_boa_viagem/create
curl -X POST https://[seu-dominio]/admin/instances/madre_c2_boa_viagem/create
curl -X POST https://[seu-dominio]/admin/instances/madre_c3_tamarineira/create
curl -X POST https://[seu-dominio]/admin/instances/madre_c4_tamarineira/create
```

## 5. Conectar cada instância (QR Code)

```bash
curl https://[seu-dominio]/admin/instances/madre_c1_boa_viagem/qr
```

Abre o QR code no WhatsApp do aparelho responsável por cada campus.

## 6. Verificar status

```bash
curl https://[seu-dominio]/admin/instances
curl https://[seu-dominio]/health/ready
```

## Adicionar campus novo (2027)

1. Adicionar entrada em `src/config/instances.js`
2. Adicionar variável `WEBHOOK_SECRET_CNovo_...` no EasyPanel
3. Chamar `POST /admin/instances/:ref/create`
4. Escanear QR code
