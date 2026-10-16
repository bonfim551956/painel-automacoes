// ===========================================================================
// Encaminhador: mensagem que chega num número dedicado vai para um grupo.
//
// A Z-API chama este endereço a cada mensagem recebida. Aqui a gente:
//   1. confere o segredo que vem na URL;
//   2. repassa o payload para o webhook antigo, se havia um (a instância tem
//      um campo só para "ao receber mensagem" -- sem isso, o que já estava
//      apontado ali pararia de funcionar);
//   3. ignora o que não interessa: mensagem enviada pelo próprio número,
//      mensagem de grupo (senão o que a gente posta no grupo volta e
//      realimenta) e mensagem sem texto;
//   4. grava a mensagem com o id dela como chave -- se a Z-API reenviar o
//      mesmo webhook, a segunda gravação não passa e o grupo não recebe
//      duas vezes;
//   5. manda o texto no grupo, exatamente como o cliente escreveu;
//   6. anota o resultado.
//
// Devolve 200 quase sempre, de propósito: a Z-API reenvia o webhook quando
// não recebe 200, e reenvio só geraria repetição. O que deu errado fica
// registrado na tabela, não no código de resposta.
//
// Variáveis de ambiente:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   banco (papel central_api)
//   ZAPI_ENC_URL                         https://api.z-api.io/instances/XXX/token/YYY
//   ZAPI_ENC_CLIENT_TOKEN                Client-Token da conta
//   ENC_NUMERO_ORIGEM                    só este número é encaminhado
//   ENC_GRUPO_DESTINO                    id do grupo que recebe
//   ENC_SEGREDO                          o que vem no fim da URL
//   ENC_REPASSE_URL                      webhook antigo, se existia (opcional)
//
// Sem ENC_NUMERO_ORIGEM ou sem ENC_GRUPO_DESTINO o endpoint entra em MODO
// ESCUTA: não encaminha nada, só grava o que chega. É assim que a gente
// descobre o telefone no formato exato da Z-API e o id do grupo, sem
// digitar à mão.
// ===========================================================================

const SB_URL  = process.env.SUPABASE_URL;
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY;
const SB_ANON = process.env.SUPABASE_ANON_KEY || SB_KEY;
const Z_URL   = process.env.ZAPI_ENC_URL;
const Z_TOKEN = process.env.ZAPI_ENC_CLIENT_TOKEN;
const ORIGEM  = so_numeros(process.env.ENC_NUMERO_ORIGEM);
const GRUPO   = String(process.env.ENC_GRUPO_DESTINO || '').trim();
const SEGREDO = process.env.ENC_SEGREDO;
const REPASSE = String(process.env.ENC_REPASSE_URL || '').trim();

const ESCUTA = !ORIGEM || !GRUPO;

function so_numeros(v) {
  return String(v || '').replace(/\D/g, '');
}

// (13) 99117-8198 -> 5513991178198. Compara pelos últimos 11 dígitos para
// não tropeçar no 9 extra nem na falta do 55.
function mesmo_numero(a, b) {
  const x = so_numeros(a), y = so_numeros(b);
  if (!x || !y) return false;
  const fim = s => s.slice(-11);
  return x === y || fim(x) === fim(y);
}

async function sb(caminho, opcoes = {}) {
  const r = await fetch(SB_URL + '/rest/v1/' + caminho, {
    ...opcoes,
    headers: {
      apikey: SB_ANON,
      Authorization: 'Bearer ' + SB_KEY,
      'Content-Type': 'application/json',
      'Accept-Profile': 'central',
      'Content-Profile': 'central',
      ...(opcoes.headers || {})
    }
  });
  const corpo = await r.text();
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + corpo.slice(0, 300));
  return corpo ? JSON.parse(corpo) : null;
}

// Grava a mensagem. Volta null quando o id já existia -- ou seja, repetida.
async function registrar(linha) {
  const gravadas = await sb('encaminhamentos', {
    method: 'POST',
    body: JSON.stringify(linha),
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }
  });
  return (Array.isArray(gravadas) && gravadas.length) ? gravadas[0] : null;
}

async function anotar(msg_id, campos) {
  try {
    await sb('encaminhamentos?msg_id=eq.' + encodeURIComponent(msg_id), {
      method: 'PATCH', body: JSON.stringify(campos)
    });
  } catch (e) { /* o encaminhamento já aconteceu; a anotação é secundária */ }
}

async function mandarNoGrupo(texto) {
  const r = await fetch(Z_URL + '/send-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': Z_TOKEN },
    body: JSON.stringify({ phone: GRUPO, message: texto })
  });
  const corpo = await r.text();
  if (!r.ok) throw new Error('z-api ' + r.status + ' ' + corpo.slice(0, 300));
  return corpo;
}

// A instância tem um campo só para "ao receber mensagem". Se já havia alguém
// ali, continua recebendo: a gente repassa o payload inteiro, sem esperar
// resposta e sem deixar uma falha dele atrapalhar o encaminhamento.
function repassar(corpo) {
  if (!REPASSE) return;
  try {
    fetch(REPASSE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo)
    }).catch(() => {});
  } catch (e) { /* idem */ }
}

module.exports = async function handler(req, res) {
  if (!SEGREDO || String(req.query.t || '') !== SEGREDO) {
    return res.status(404).json({ erro: 'não encontrado' });
  }
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, modo: ESCUTA ? 'escuta' : 'encaminhando' });
  }
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  p = p || {};

  repassar(p);

  const msg_id = String(p.messageId || p.id || '').trim();
  const de     = String(p.phone || '').trim();
  const nome   = p.senderName || p.chatName || null;
  const texto  = (p.text && typeof p.text.message === 'string') ? p.text.message : null;
  const ehGrupo = !!(p.isGroup || p.isNewsletter);
  const meu     = !!p.fromMe;

  const tipo = texto ? 'texto'
    : p.image ? 'imagem' : p.audio ? 'audio' : p.video ? 'video'
    : p.document ? 'documento' : p.sticker ? 'figurinha'
    : p.contact ? 'contato' : p.location ? 'localizacao' : 'outro';

  if (!msg_id) return res.status(200).json({ ok: true, ignorado: 'sem id de mensagem' });

  const base = {
    msg_id, de: de || '(sem telefone)', nome, tipo, texto,
    destino: GRUPO || null, bruto: p
  };

  // MODO ESCUTA: grava tudo e não encaminha. Serve para descobrir o telefone
  // e o id do grupo no formato que a Z-API usa de verdade.
  if (ESCUTA) {
    try {
      await registrar({ ...base, status: 'escuta',
        motivo: 'modo escuta' + (ehGrupo ? ' · grupo: ' + (p.phone || '') : '') +
                (meu ? ' · enviada pelo próprio número' : '') });
    } catch (e) {
      return res.status(200).json({ ok: true, erro: e.message });
    }
    return res.status(200).json({ ok: true, modo: 'escuta' });
  }

  let motivo = null;
  if (meu) motivo = 'enviada pelo próprio número';
  else if (ehGrupo) motivo = 'mensagem de grupo';
  else if (!mesmo_numero(de, ORIGEM)) motivo = 'outro remetente';
  else if (!texto) motivo = 'mensagem sem texto (' + tipo + ')';

  if (motivo) {
    try { await registrar({ ...base, status: 'ignorado', motivo }); } catch (e) {}
    return res.status(200).json({ ok: true, ignorado: motivo });
  }

  let linha;
  try {
    linha = await registrar(base);
  } catch (e) {
    // o banco falhou: sem a trava de duplicidade é melhor não encaminhar,
    // senão um reenvio da Z-API repete a mensagem no grupo
    return res.status(200).json({ ok: false, erro: 'banco: ' + e.message });
  }
  if (!linha) return res.status(200).json({ ok: true, ignorado: 'mensagem repetida' });

  try {
    await mandarNoGrupo(texto);
    await anotar(msg_id, { status: 'enviado', enviado_em: new Date().toISOString() });
    return res.status(200).json({ ok: true, enviado: true });
  } catch (e) {
    await anotar(msg_id, { status: 'erro', motivo: String(e.message).slice(0, 400) });
    return res.status(200).json({ ok: false, erro: e.message });
  }
};
