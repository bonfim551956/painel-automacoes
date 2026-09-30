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
