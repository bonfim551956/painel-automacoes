# Painel de Automações do WhatsApp — Óticas Idealize

Site estático (um único `index.html`) para ligar, desligar, editar e testar os fluxos automáticos do WhatsApp.

## Publicar na Vercel
1. Crie um repositório no GitHub (ex.: `painel-automacoes`) e envie esta pasta.
2. Na Vercel: **Add New → Project**, importe o repositório e clique em **Deploy** (sem configuração extra).

## Liberar um usuário
1. Supabase (Sistema ADM) → **Authentication → Users → Add user → Create new user**, com e-mail e senha
   (marque **Auto Confirm User**).
2. No SQL Editor, dê acesso ao painel:
   ```sql
   insert into painel_admins (user_id, email)
   select id, email from auth.users where email = 'email@dapessoa.com';
   ```
Para remover o acesso: `delete from painel_admins where email = 'email@dapessoa.com';`

## Segurança
- A chave no código é a chave **pública** do Supabase. Ela sozinha não dá acesso a nada do painel.
- Todas as ações passam por funções do banco (`painel_*`) que conferem se o usuário logado está em `painel_admins`.

---

## Encaminhador de mensagens (`/api/webhook`)

Recebe o webhook "ao receber mensagem" de uma instância dedicada da Z-API e
encaminha para um grupo o texto que chega de **um** número determinado.
Nada a ver com as lojas: instância própria, número próprio, grupo próprio.

**Webhook a colar na Z-API:** `/api/webhook/<ENC_SEGREDO>`

Regras: encaminha só texto, exatamente como veio; ignora mensagem enviada pelo
próprio número, mensagem de grupo e mensagem sem texto; grava cada mensagem com
o id dela como chave única, então reenvio do webhook não repete no grupo; se o
banco não responder, não encaminha (um reenvio depois repetiria a mensagem).
Responde 200 em quase tudo de propósito — a Z-API reenvia quando não recebe 200.

**Consulta de apoio:** `GET /api/grupos/<ENC_SEGREDO>` lista os grupos (id e
nome) e as conversas recentes da instância, para achar o id do grupo e o número
sem digitar à mão. Aceita `?meta=0` (não busca o nome dos grupos, é mais
rápido), `?tamanho=` e `?grupos=`. Só leitura.

### Variáveis
| Nome | Para quê |
|---|---|
| `SUPABASE_URL` | banco do Sistema ADM |
| `SUPABASE_ANON_KEY` | chave pública; sozinha não lê nem escreve na tabela |
| `ENC_DB_SEGREDO` | senha das funções `enc_registrar` / `enc_anotar` |
| `ZAPI_ENC_URL` | `https://api.z-api.io/instances/<id>/token/<token>` |
| `ZAPI_ENC_CLIENT_TOKEN` | Client-Token da conta |
| `ENC_NUMERO_ORIGEM` | único número encaminhado |
| `ENC_GRUPO_DESTINO` | id do grupo que recebe |
| `ENC_SEGREDO` | o que vai no fim da URL do webhook |
| `ENC_REPASSE_URL` | opcional: webhook antigo, que continua recebendo |

Sem `ENC_NUMERO_ORIGEM` ou sem `ENC_GRUPO_DESTINO` o endpoint entra em **modo
escuta**: grava o que chega e não encaminha nada. É assim que se descobre o
telefone e o id do grupo no formato real da Z-API.

### Onde os dados ficam
Tabela `central.encaminhamentos` (esquema `central`, sem acesso para a chave
pública). A gravação passa pelas funções `public.enc_registrar` e
`public.enc_anotar`, que rodam como donas da tabela e exigem a senha guardada em
`central.enc_segredo` — por isso nenhuma credencial privilegiada do banco mora
neste projeto.

Conferir o que chegou:
```sql
select recebido_em, de, nome, status, motivo, texto
from central.encaminhamentos order by recebido_em desc limit 20;
```

---

## Alerta da Agenda no grupo do Marketing (`/api/alerta`)

Quando o sistema da Clínica Visão Ideal acha no ADM uma venda que precisa de
conferência manual (paciente fica **Pendente**), o banco da clínica (Supabase
PDV) chama `POST /api/alerta/<ALERTA_SEGREDO>` e este endpoint posta um aviso no
grupo do Marketing, pelo mesmo número do encaminhador.

- O texto é montado aqui a partir dos campos (paciente, unidade, OS, tipo, data,
  motivo). Quem chama não manda texto livre. **Valor da venda não vai.**
- `tipo: "novo"` → "⚠️ VENDA PARA CONFERIR — AGENDA".
  `tipo: "lembrete"` → "⏰ VENDA AINDA CONTINUA PENDENTE — AGENDA" (a cada 24 h
  enquanto continuar pendente).
- Quem decide quando mandar é o banco da clínica: função
  `public.agenda_alertar_pendentes()` + cron `agenda-alerta-pendentes`
  (só entre 8h e 20h). Histórico em `public.vendas_alertas`.

Variável nova: `ALERTA_SEGREDO` (a mesma fica guardada no Vault do banco da
clínica como `alerta_marketing_segredo`). Usa também `ZAPI_ENC_URL`,
`ZAPI_ENC_CLIENT_TOKEN` e `ENC_GRUPO_DESTINO`.
