import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

// Entrada pelo Central Idealize (login único) no Painel de Automações. Não substitui o login do painel: é uma porta a mais.
// Quem chama manda o token da sessão do Central (projeto do RH). Aqui:
//  1) o próprio RH confirma o token e diz com qual e-mail a pessoa entra no painel (central_meu_acesso);
//  2) o e-mail precisa estar em painel_admins (a mesma regra do login normal);
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

  // 2) precisa ser administrador do painel (mesma regra do login normal)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const { data: adm } = await admin.from('painel_admins').select('user_id').ilike('email', literal).limit(2)
  if (!adm || adm.length !== 1) {
    console.warn('entrar_central_sem_conta', { conta, nomeCentral })
    return resp({ erro: 'O e-mail ligado a você no Central não tem acesso a este painel.' }, 404)
  }
  const { data: au, error: eAu } = await admin.auth.admin.getUserById(adm[0].user_id)
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
