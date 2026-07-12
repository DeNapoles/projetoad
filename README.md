# Dashboard das Lojas

## Como pôr a funcionar

1. **Cria o repositório no GitHub** e faz upload de todos estes ficheiros (mantém a estrutura de pastas, incluindo `.github/workflows/`).

2. **Adiciona os secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `SHOPIFY_CLIENT_ID_ARANY_LUNA` → o Client ID da tua app no Dev Dashboard da Shopify
   - `SHOPIFY_CLIENT_SECRET_ARANY_LUNA` → o Client secret dessa mesma app
   - `FLYWEEL_KEY_ARANY_LUNA` → o teu token `fwl_...` (gera em app.flyweel.co → Settings → API Tokens)

   *(A Arany Luna já usa o sistema novo da Shopify — Client Credentials Grant. O script troca automaticamente estas credenciais por um token válido a cada corrida, já que o token antigo expirava a cada 24h.)*

3. **⚠️ Dá permissões de escrita ao Action** (Settings → Actions → General → Workflow permissions) → escolhe **"Read and write permissions"** e grava. Sem isto, o passo de commit do `data.json` falha silenciosamente.

4. **Ativa o GitHub Pages** (Settings → Pages → Source: branch `main`, pasta `/ (root)`).

5. **Corre o Action pela primeira vez**: separador *Actions* → "Atualizar Dashboard" → botão *Run workflow*.
   Depois disso corre sozinho de hora a hora.

6. O site fica disponível em `https://<o-teu-user>.github.io/<nome-do-repo>/`.

## Como adicionar uma loja nova

1. Acrescenta uma entrada no `stores.json` com os dados dela (`shopify_domain`, `flyweel_ad_account_id`, `profit_margin_pct`, `"active": true`).
2. Adiciona os dois secrets correspondentes, com o mesmo `id` em maiúsculas:
   - `SHOPIFY_TOKEN_<ID>`
   - `FLYWEEL_KEY_<ID>`
3. Acrescenta essas duas linhas no `env:` do ficheiro `.github/workflows/update-dashboard.yml`.
4. Corre o Action manualmente uma vez para confirmar.

## Sobre privacidade

Se o repositório for público, o `data.json` (com números de receita) fica visível no histórico de commits, mesmo que o site em si não seja fácil de encontrar. Se isso te incomoda, cria o repositório como **privado** — confirma se a tua conta permite GitHub Pages privado (pode exigir GitHub Pro).

## Registo de Campanhas (nova aba "Registo")

Esta aba grava as tuas anotações (escaladas, criativos, pausas, etc.) diretamente como um ficheiro `log.json` no próprio repositório — cada registo fica também no histórico de commits.

**Setup (só precisas de fazer uma vez, no site):**
1. Cria um token em GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. Restringe o token a **este repositório apenas**, e dá-lhe permissão **Contents: Read and write** (nada mais).
3. No site, clica no ⚙ (canto superior direito) e preenche: o teu utilizador GitHub, o nome do repositório, e o token.
4. Fica guardado no browser (localStorage) — só precisas de repetir isto se mudares de browser/dispositivo.

⚠️ **Nota de segurança:** este token fica guardado no browser em texto simples. Por isso é importante restringi-lo só a este repositório e só a "Contents" — assim, mesmo que seja exposto, o pior que alguém consegue fazer é editar ficheiros deste repo, não a tua conta toda.

As campanhas sugeridas no formulário vêm do `data.json` (as mesmas que aparecem na aba Loja). Se a campanha que alteraste não aparecer lá (ex: já não está ativa), usa a opção "Outra / escrever manualmente".

## Limitações desta primeira versão

- **Margem de profit**: por agora escreve-se manualmente em `profit_margin_pct` no `stores.json` (a leitura automática da Profit Sheet do Drive fica para uma fase seguinte).
- **Funil de conversão (sessões/ATC/checkout)**: não incluído nesta versão — precisa de acesso à Shopify Analytics API, que pode exigir aprovação extra de scope da Shopify. Podemos tentar adicionar depois.
- **Flyweel**: o formato exato da resposta da API não está confirmado. Se o Action falhar a ir buscar campanhas, corre `node scripts/fetch-data.js` localmente com Node 20, adiciona um `console.log(data)` a seguir ao `fetch` da Flyweel no ficheiro `scripts/fetch-data.js`, e manda-me o resultado para eu ajustar o código.
