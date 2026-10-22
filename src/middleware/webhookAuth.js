const { getInstance } = require('../config/instances');

// Valida que o webhook veio de uma instância conhecida com o secret correto.
// A Evolution envia o secret no header `apikey` (padrão Evolution v2).
function webhookAuth(req, res, next) {
  const instanceRef = req.params.instanceRef;
  const instance = getInstance(instanceRef);

  if (!instance) {
    return res.status(404).json({ erro: 'Instância não encontrada.' });
  }

  const apiKey = req.headers['apikey'];
  if (!apiKey || apiKey !== instance.webhookSecret) {
    console.warn(`[WA] Webhook recusado para instância ${instanceRef} — apikey inválida`);
    return res.status(401).json({ erro: 'Não autorizado.' });
  }

  req.instanceRef = instanceRef;
  req.instanceLabel = instance.label;
  next();
}

module.exports = webhookAuth;
