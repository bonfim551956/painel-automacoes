// ===========================================================================
// Alerta da Agenda (sistema da Clínica Visão Ideal) no grupo do Marketing.
//
// Quando o sistema da clínica acha no ADM uma venda que precisa de conferência
// manual (paciente fica "Pendente"), o banco da clínica chama este endereço e
// a gente posta um aviso no grupo, pelo mesmo número do encaminhador.
//
//   POST /api/alerta/<ALERTA_SEGREDO>
//   { "tipo": "novo" | "lembrete", "paciente", "unidade", "os_numero",
//     "os_tipo", "dt_venda" (AAAA-MM-DD), "motivo", "dias" }
//
// O texto é montado AQUI, a partir dos campos -- quem chama não manda texto
// livre. Assim, mesmo que o segredo vaze, só dá para postar um aviso no
// formato da Agenda, nunca uma mensagem qualquer no grupo.
// Valor da venda não vai na mensagem (decisão do Diego, 28/10/2026).
//
// Variáveis: ZAPI_ENC_URL, ZAPI_ENC_CLIENT_TOKEN, ENC_GRUPO_DESTINO (as mesmas
// do encaminhador) e ALERTA_SEGREDO.
// ===========================================================================

const Z_URL   = process.env.ZAPI_ENC_URL;
const Z_TOKEN = process.env.ZAPI_ENC_CLIENT_TOKEN;
const GRUPO   = String(process.env.ENC_GRUPO_DESTINO || '').trim();
const SEGREDO = process.env.ALERTA_SEGREDO;

// Só letras, números e pontuação comum; corta tamanho. Tira * _ ~ ` para o
// conteúdo não mexer na formatação do WhatsApp.
function limpo(v, max) {
  return String(v == null ? '' : v)
    .replace(/[*_~`]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 80);
}

function dataBR(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : limpo(v, 10);
}

function montar(p) {
  const lembrete = p.tipo === 'lembrete';
  const dias = Math.max(1, Math.min(60, parseInt(p.dias, 10) || 1));
  const os = [limpo(p.os_numero, 20) && 'OS ' + limpo(p.os_numero, 20),
              limpo(p.os_tipo, 30) && '(' + limpo(p.os_tipo, 30) + ')'].filter(Boolean).join(' ');
  const linhas = [
    lembrete ? '⏰ *VENDA AINDA CONTINUA PENDENTE — AGENDA*' : '⚠️ *VENDA PARA CONFERIR — AGENDA*',
    ''
  ];
  if (lembrete) {
    linhas.push('Aguardando conferência há ' + dias + (dias === 1 ? ' dia.' : ' dias.'), '');
  }
  linhas.push('👤 Paciente: ' + (limpo(p.paciente) || '—'));
  linhas.push('🏬 Unidade: ' + (limpo(p.unidade, 30) || '—'));
  const venda = [os, p.dt_venda ? dataBR(p.dt_venda) : ''].filter(Boolean).join(' · ');
  if (venda) linhas.push('🧾 ' + venda);
  if (limpo(p.motivo, 120)) linhas.push('❓ Motivo: ' + limpo(p.motivo, 120));
  linhas.push('', 'Confirme ou descarte no sistema:', 'agenda.clinicavisaoideal.com → Agenda / Pendente');
  return linhas.join('\n');
}

module.exports = async function handler(req, res) {
  if (!SEGREDO || String(req.query.t || '') !== SEGREDO) {
    return res.status(404).json({ erro: 'não encontrado' });
  }
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });
  if (!Z_URL || !Z_TOKEN || !GRUPO) {
    return res.status(500).json({ erro: 'faltam variáveis da Z-API ou do grupo' });
  }

  let p = req.body;
  if (typeof p === 'string') { try { p = JSON.parse(p); } catch (e) { p = {}; } }
  p = p || {};
  if (!limpo(p.paciente)) return res.status(400).json({ erro: 'sem paciente' });

  const texto = montar(p);
  try {
    const r = await fetch(Z_URL + '/send-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Client-Token': Z_TOKEN },
      body: JSON.stringify({ phone: GRUPO, message: texto })
    });
    const corpo = await r.text();
    if (!r.ok) return res.status(502).json({ erro: 'z-api ' + r.status, detalhe: corpo.slice(0, 300) });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ erro: String(e.message).slice(0, 300) });
  }
};
