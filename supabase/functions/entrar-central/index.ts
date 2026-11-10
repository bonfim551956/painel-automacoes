import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Entrada pelo Central Idealize (login único) no Painel de Automações (o painel não tem mais login próprio).
// Quem chama manda o token da sessão do Central (projeto do RH). Aqui:
//  1) o próprio RH confirma o token e diz com qual e-mail a pessoa entra no painel (central_meu_acesso);
//  2) se a pessoa ainda não tem cadastro no painel, ele é criado agora com o e-mail do Central
//     (quem libera ou retira o acesso é a Gestão de acessos do Central);
//  3) devolvemos um código de uso único para a tela abrir a sessão (verifyOtp). Nenhum e-mail é enviado.
// Sem segredo compartilhado: só a chave pública (anon) do RH é usada.
const RH_URL = 'https://ifqaukdkurkirmahpuky.supabase.co'
const RH_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmcWF1a2RrdXJraXJtYWhwdWt5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NjE2MTgsImV4cCI6MjEwODMzNzYxOH0.sXkJMAybOKW93n2v7_vKtiY3oOmkXQdU4EFrp-8xaQE'
const ORIGENS = ['https://painel-automacoes-pi.vercel.app']
const SISTEMA = 'automacoes'

const cors = (req: Request) => {
  const o = req.headers.get('origin') ?? ''
  return {
    'Access-Control-Allow-Origin': ORIGENS.includes(o) ? o : ORIGENS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

Deno.serve(async (req) => {
  const resp = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return resp({ erro: 'Método não permitido' }, 405)

  let corpo: { sistema?: string; token?: string }
  try { corpo = await req.json() } catch { return resp({ erro: 'Pedido inválido' }, 400) }
  const token = (corpo.token ?? '').trim()
  if (corpo.sistema !== SISTEMA || token.split('.').length !== 3) return resp({ erro: 'Pedido inválido' }, 400)

  // 1) o RH valida o token e devolve o e-mail liberado para o painel
  let conta = ''
  let nomeCentral = ''
  try {
    const r = await fetch(`${RH_URL}/rest/v1/rpc/central_meu_acesso`, {
      method: 'POST',
      headers: { apikey: RH_ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_sistema: SISTEMA }),
    })
    if (r.status === 401 || r.status === 403) return resp({ erro: 'Sessão do Central expirada. Entre novamente.' }, 401)
    if (!r.ok) return resp({ erro: 'Não foi possível confirmar o acesso agora.' }, 502)
    const linhas = (await r.json()) as { conta: string; nome: string }[]
    conta = (linhas?.[0]?.conta ?? '').trim().toLowerCase()
    nomeCentral = linhas?.[0]?.nome ?? ''
  } catch {
    return resp({ erro: 'Não foi possível confirmar o acesso agora.' }, 502)
  }
  if (!conta) return resp({ erro: 'Você não tem acesso liberado a este painel no Central.' }, 403)
  const literal = conta.replace(/[\\%_]/g, (c) => '\\' + c)

  // 2) cadastro no painel: usa o que existe ou cria agora (liberado no Central = administrador do painel)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const { data: adm } = await admin.from('painel_admins').select('user_id').ilike('email', literal).limit(2)
  if (adm && adm.length > 1) return resp({ erro: 'Há mais de um cadastro com este e-mail no painel.' }, 409)
  let userId = adm?.[0]?.user_id as string | undefined
  if (!userId) {
    const senha = crypto.randomUUID() + crypto.randomUUID()
    const { data: novo, error: eNovo } = await admin.auth.admin.createUser({ email: conta, password: senha, email_confirm: true })
    if (novo?.user) userId = novo.user.id
    else if (/already|registered|exists/i.test(eNovo?.message ?? '')) {
      // já existe login com este e-mail neste projeto: procura e reaproveita
      for (let page = 1; page <= 10 && !userId; page++) {
        const { data: lista } = await admin.auth.admin.listUsers({ page, perPage: 200 })
        userId = lista?.users.find((x) => (x.email ?? '').toLowerCase() === conta)?.id
        if (!lista || lista.users.length < 200) break
      }
    }
    if (!userId) {
      console.error('entrar_central_criar', { conta, erro: eNovo?.message })
      return resp({ erro: 'Não foi possível criar o seu acesso ao painel agora.' }, 500)
    }
    const { error: eAdm } = await admin.from('painel_admins').insert({ user_id: userId, email: conta })
    if (eAdm) {
      console.error('entrar_central_admin', { conta, erro: eAdm.message })
      return resp({ erro: 'Não foi possível criar o seu acesso ao painel agora.' }, 500)
    }
    console.log('entrar_central_cadastro_criado', { conta, nomeCentral })
  }
  const { data: au, error: eAu } = await admin.auth.admin.getUserById(userId)
  if (eAu || !au?.user?.email) return resp({ erro: 'Usuário não encontrado neste painel.' }, 404)

  // 3) código de uso único para abrir a sessão (não envia e-mail)
  const { data: link, error: eLink } = await admin.auth.admin.generateLink({ type: 'magiclink', email: au.user.email })
  const tokenHash = link?.properties?.hashed_token
  if (eLink || !tokenHash) {
    console.error('entrar_central_link', { erro: eLink?.message })
    return resp({ erro: 'Não foi possível abrir a sessão agora.' }, 500)
  }
  console.log('entrar_central_ok', { conta, nomeCentral })
  return resp({ token_hash: tokenHash })
})
