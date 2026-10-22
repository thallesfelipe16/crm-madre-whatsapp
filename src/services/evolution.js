// Adapter para a Evolution API
// Documentação: https://github.com/evolution-foundation/evolution-api
// Confirmar versão instalada antes de usar (rotas mudam entre v1 e v2)

const EVOLUTION_URL = process.env.EVOLUTION_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;

function _headers() {
  return {
    'Content-Type': 'application/json',
    'apikey': EVOLUTION_API_KEY,
  };
}

async function criarInstancia(instanceName, webhookUrl, webhookSecret) {
  const res = await fetch(`${EVOLUTION_URL}/instance/create`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({
      instanceName,
      webhook: {
        enabled: true,
        url: webhookUrl,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE'],
        webhook_by_events: false,
        webhook_base64: false,
        headers: { apikey: webhookSecret },
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution criarInstancia falhou (${res.status}): ${err}`);
  }

  return res.json();
}

async function obterQRCode(instanceName) {
  const res = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
    headers: _headers(),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution obterQRCode falhou (${res.status}): ${err}`);
  }

  return res.json();
}

async function statusConexao(instanceName) {
  const res = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
    headers: _headers(),
  });

  if (!res.ok) return { state: 'unknown' };
  return res.json();
}

async function enviarTexto(instanceName, to, text) {
  const res = await fetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ number: to, text }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution enviarTexto falhou (${res.status}): ${err}`);
  }

  return res.json();
}

module.exports = { criarInstancia, obterQRCode, statusConexao, enviarTexto };
