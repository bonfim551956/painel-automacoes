// ===========================================================================
// Consulta de apoio: pergunta à própria instância quais conversas e grupos
// ela tem, para a gente escolher o id do grupo e o número de origem sem
// digitar nada à mão.
//
//   GET /api/grupos/<ENC_SEGREDO>
//
// A Z-API devolve, para cada conversa, o telefone e se é grupo. Para grupo,
// o campo de nome vem com o id, então a gente pergunta o nome de cada um
// separadamente (group-metadata) -- só dos 25 primeiros, para não abusar.
//
// Só leitura. Não manda mensagem nenhuma.
// ===========================================================================

const Z_URL   = process.env.ZAPI_ENC_URL;
const Z_TOKEN = process.env.ZAPI_ENC_CLIENT_TOKEN;
const SEGREDO = process.env.ENC_SEGREDO;

async function zapi(caminho) {
  const r = await fetch(Z_URL + caminho, {
    headers: { 'Client-Token': Z_TOKEN, 'Content-Type': 'application/json' }
  });
  const corpo = await r.text();
  if (!r.ok) throw new Error('z-api ' + r.status + ' ' + corpo.slice(0, 300));
  try { return JSON.parse(corpo); } catch (e) { return corpo; }
}

module.exports = async function handler(req, res) {
  if (!SEGREDO || String(req.query.t || '') !== SEGREDO) {
    return res.status(404).json({ erro: 'não encontrado' });
  }
  if (!Z_URL || !Z_TOKEN) {
    return res.status(200).json({
      erro: 'faltam as variáveis ZAPI_ENC_URL e ZAPI_ENC_CLIENT_TOKEN'
    });
  }

  const pagina = Math.max(1, Number(req.query.pagina || 1));
  const tamanho = Math.min(200, Math.max(1, Number(req.query.tamanho || 100)));

  let chats;
  try {
    chats = await zapi('/chats?page=' + pagina + '&pageSize=' + tamanho);
  } catch (e) {
    return res.status(200).json({ erro: e.message });
  }
  if (!Array.isArray(chats)) {
    return res.status(200).json({ erro: 'resposta inesperada', recebido: chats });
  }

  const hora = t => {
    const n = Number(t);
    if (!n) return null;
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  };

  const grupos = chats.filter(c => c.isGroup);
  const pessoas = chats.filter(c => !c.isGroup);

  // O nome do grupo não vem na lista de conversas; vem de uma consulta por
  // grupo. São feitas todas de uma vez (e no máximo 12) porque em sequência
  // isso estourava o tempo da função. Com ?meta=0 nem pergunta o nome.
  const semNome = String(req.query.meta || '1') === '0';
  const alvos = grupos
    .sort((a, b) => Number(b.lastMessageTime || 0) - Number(a.lastMessageTime || 0))
    .slice(0, Math.min(12, Number(req.query.grupos || 12)));

  const comNome = semNome
    ? alvos.map(g => ({ id: g.phone, nome: null, ultima_em: hora(g.lastMessageTime) }))
    : await Promise.all(alvos.map(async g => {
        let nome = null;
        try {
          const m = await zapi('/group-metadata/' + encodeURIComponent(g.phone));
          nome = (m && (m.subject || m.name)) || null;
        } catch (e) { nome = '(não deu para ler: ' + String(e.message).slice(0, 60) + ')'; }
        return { id: g.phone, nome, ultima_em: hora(g.lastMessageTime) };
      }));

  return res.status(200).json({
    total_de_conversas: chats.length,
    grupos: comNome,
    grupos_a_mais: Math.max(0, grupos.length - comNome.length),
    conversas: pessoas
      .sort((a, b) => Number(b.lastMessageTime || 0) - Number(a.lastMessageTime || 0))
      .slice(0, 40)
      .map(c => ({ telefone: c.phone, nome: c.name || null, ultima_em: hora(c.lastMessageTime) }))
  });
};
