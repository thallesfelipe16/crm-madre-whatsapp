// Health check periódico: detecta instâncias em zombie state e reinicia automaticamente.
// Zombie state = instância mostra "open" na Evolution mas parou de receber mensagens.
// Roda a cada INTERVALO_MIN minutos; reinicia se não houver mensagem inbound em SILENCE_HOURS horas.

const INTERVALO_MIN  = 30;   // verificação a cada 30 min
const SILENCE_HOURS  = 1;    // sem mensagem inbound por 1h = suspeito
const HORA_INICIO    = 6;    // não reinicia antes das 06h (horário do servidor = UTC-3)
const HORA_FIM       = 22;   // não reinicia depois das 22h

let _timer = null;

async function verificar() {
  const db      = require('../config/db');
  const { listInstances } = require('../config/instances');
  const { statusConexao, reiniciarInstancia, atualizarWebhook } = require('./evolution');
  const { getInstance } = require('../config/instances');

  const horaLocal = new Date().getHours() - 3; // UTC → BRT (ajustar se servidor já estiver em BRT)
  const horaAjustada = ((horaLocal % 24) + 24) % 24;

  if (horaAjustada < HORA_INICIO || horaAjustada >= HORA_FIM) {
    console.log('[healthcheck] Fora do horário comercial, pulando verificação.');
    return;
  }

  const instancias = listInstances();
  const limite = new Date(Date.now() - SILENCE_HOURS * 60 * 60 * 1000).toISOString();

  for (const { ref } of instancias) {
    try {
      // Verifica estado na Evolution
      const status = await statusConexao(ref).catch(() => ({ state: 'unknown' }));
      const state = status?.instance?.state || status?.state || 'unknown';

      if (state !== 'open') {
        console.log(`[healthcheck] ${ref}: estado ${state}, pulando (não é open).`);
        continue;
      }

      // Conta mensagens inbound recentes no banco
      const { rows } = await db.query(
        `SELECT MAX(received_at) AS ultima
         FROM wa_messages
         WHERE instance_ref = $1 AND direction = 'inbound'`,
        [ref]
      );

      const ultima = rows[0]?.ultima;

      // Se nunca recebeu mensagem, não há baseline — pula
      if (!ultima) continue;

      if (ultima < limite) {
        const horas = ((Date.now() - new Date(ultima).getTime()) / 36e5).toFixed(1);
        console.warn(`[healthcheck] ⚠️  ${ref}: última mensagem há ${horas}h — zombie state detectado. Reiniciando...`);

        await reiniciarInstancia(ref);
        console.log(`[healthcheck] ✓ ${ref}: restart enviado.`);

        // Re-registra webhook após 5s
        setTimeout(async () => {
          try {
            const cfg = getInstance(ref);
            const baseUrl = process.env.INTERNAL_APP_URL || process.env.APP_URL;
            const webhookUrl = `${baseUrl}/webhooks/${ref}`;
            await atualizarWebhook(ref, webhookUrl, cfg.webhookSecret);
            console.log(`[healthcheck] ✓ ${ref}: webhook re-registrado após restart.`);
          } catch (err) {
            console.error(`[healthcheck] Falha ao re-registrar webhook de ${ref}: ${err.message}`);
          }
        }, 5000);
      } else {
        console.log(`[healthcheck] ✓ ${ref}: OK (última mensagem: ${new Date(ultima).toLocaleTimeString('pt-BR')})`);
      }
    } catch (err) {
      console.error(`[healthcheck] Erro ao verificar ${ref}: ${err.message}`);
    }
  }
}

function iniciar() {
  if (_timer) return;
  console.log(`[healthcheck] Iniciado — verificação a cada ${INTERVALO_MIN}min, silêncio tolerado: ${SILENCE_HOURS}h`);
  // Primeira verificação 2 minutos após o boot (deixa as instâncias conectarem primeiro)
  setTimeout(() => {
    verificar().catch(e => console.error('[healthcheck] Erro na primeira verificação:', e.message));
    _timer = setInterval(() => {
      verificar().catch(e => console.error('[healthcheck] Erro periódico:', e.message));
    }, INTERVALO_MIN * 60 * 1000);
  }, 2 * 60 * 1000);
}

function parar() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { iniciar, parar, verificar };
