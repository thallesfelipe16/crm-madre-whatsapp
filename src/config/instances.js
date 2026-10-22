// Mapa de instâncias Evolution — uma por campus
// Cada instância tem um secret independente para autenticar o webhook
const INSTANCES = {
  madre_c1_boa_viagem: {
    label: 'Campus I — Boa Viagem',
    webhookSecret: process.env.WEBHOOK_SECRET_C1_BOA_VIAGEM,
  },
  madre_c2_boa_viagem: {
    label: 'Campus II — Boa Viagem',
    webhookSecret: process.env.WEBHOOK_SECRET_C2_BOA_VIAGEM,
  },
  madre_c3_tamarineira: {
    label: 'Campus III — Tamarineira',
    webhookSecret: process.env.WEBHOOK_SECRET_C3_TAMARINEIRA,
  },
  madre_c4_tamarineira: {
    label: 'Campus IV — Tamarineira',
    webhookSecret: process.env.WEBHOOK_SECRET_C4_TAMARINEIRA,
  },
};

function getInstance(instanceRef) {
  return INSTANCES[instanceRef] || null;
}

function listInstances() {
  return Object.entries(INSTANCES).map(([ref, data]) => ({ ref, label: data.label }));
}

module.exports = { INSTANCES, getInstance, listInstances };
