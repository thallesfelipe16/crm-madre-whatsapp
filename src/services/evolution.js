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
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        enabled: true,
        url: webhookUrl,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE'],
        webhook_by_events: false,
        webhook_base64: true,
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

async function enviarMidia(instanceName, to, { mediatype, mimetype, media, fileName, caption }) {
  const res = await fetch(`${EVOLUTION_URL}/message/sendMedia/${instanceName}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ number: to, mediatype, mimetype, media, fileName, caption: caption || '' }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution enviarMidia falhou (${res.status}): ${err}`);
  }
  return res.json();
}

// Envia áudio como mensagem de voz (PTT) — Evolution converte para opus automaticamente
async function enviarAudio(instanceName, to, base64Audio) {
  const res = await fetch(`${EVOLUTION_URL}/message/sendWhatsAppAudio/${instanceName}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({ number: to, audio: base64Audio, encoding: true }),
  });
  if (!res.ok) {
    const err = await res.text();
    // Fallback: tenta sendMedia se sendWhatsAppAudio não existir nessa versão
    if (res.status === 404 || res.status === 405) {
      const res2 = await fetch(`${EVOLUTION_URL}/message/sendMedia/${instanceName}`, {
        method: 'POST',
        headers: _headers(),
        body: JSON.stringify({ number: to, mediatype: 'audio', mimetype: 'audio/ogg; codecs=opus', media: base64Audio, fileName: 'audio.ogg', caption: '' }),
      });
      if (!res2.ok) throw new Error(`Evolution enviarAudio (fallback) falhou (${res2.status}): ${await res2.text()}`);
      return res2.json();
    }
    throw new Error(`Evolution enviarAudio falhou (${res.status}): ${err}`);
  }
  return res.json();
}

async function baixarMidia(instanceName, messageKey) {
  // messageKey pode ser { key, message } (inbound salvo pelo webhook)
  // ou { id, fromMe, remoteJid } (outbound legado)
  const body = messageKey.key
    ? { message: messageKey }          // formato completo
    : { message: { key: messageKey } } // formato legado
  const res = await fetch(`${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution baixarMidia falhou (${res.status}): ${err}`);
  }
  return res.json(); // { base64, mimetype }
}

async function atualizarWebhook(instanceName, webhookUrl, webhookSecret) {
  const res = await fetch(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
    method: 'POST',
    headers: _headers(),
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: webhookUrl,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'MESSAGES_DELETE', 'CONNECTION_UPDATE'],
        webhook_by_events: false,
        webhook_base64: true,
      },
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Evolution atualizarWebhook falhou (${res.status}): ${err}`);
  }
  return res.json();
}

module.exports = { criarInstancia, obterQRCode, statusConexao, enviarTexto, enviarMidia, enviarAudio, baixarMidia, atualizarWebhook };
