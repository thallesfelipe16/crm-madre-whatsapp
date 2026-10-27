// Cliente para a CRM API — gerencia login e cache de token automaticamente
const CRM_URL = process.env.CRM_API_URL || 'https://api-madre.arcorastudio.com.br';

let _token = null;
let _tokenExp = 0; // timestamp ms

async function _login() {
  const email = process.env.CRM_SERVICE_EMAIL;
  const senha = process.env.CRM_SERVICE_PASSWORD;
  if (!email || !senha) throw new Error('CRM_SERVICE_EMAIL / CRM_SERVICE_PASSWORD não configurados.');

  const res = await fetch(`${CRM_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`CRM login falhou (${res.status}): ${err}`);
  }

  const data = await res.json();
  _token = data.token;
  // Cache por 8 h (tokens JWT do CRM costumam durar mais, mas renovamos antes)
  _tokenExp = Date.now() + 8 * 60 * 60 * 1000;
  return _token;
}

async function getToken() {
  if (_token && Date.now() < _tokenExp) return _token;
  return _login();
}

async function criarLead(payload) {
  const token = await getToken();

  const res = await fetch(`${CRM_URL}/api/leads`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  // Token expirou antes do esperado — tenta uma vez com token novo
  if (res.status === 401) {
    _token = null;
    const token2 = await getToken();
    const res2 = await fetch(`${CRM_URL}/api/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token2}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res2.ok) throw new Error(`CRM recusou (${res2.status}): ${await res2.text()}`);
    return res2.json();
  }

  if (!res.ok) throw new Error(`CRM recusou (${res.status}): ${await res.text()}`);
  return res.json();
}

module.exports = { criarLead };
