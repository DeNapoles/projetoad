# Revisão Completa — Dashboard das Lojas (para retomar)

*Gerado a 12 de julho de 2026, no fim da sessão de construção do dashboard standalone (GitHub Pages).*

---

## 1. O que existe neste momento

**No `dashboard.zip`:**
- `index.html` — site estático, lê `data.json`, mostra Visão Geral (todas as lojas) + vista por loja
- `stores.json` — o "menu" de configuração das lojas (editável por ti)
- `scripts/fetch-data.js` — corre no GitHub Action, vai buscar dados reais e escreve `data.json`
- `.github/workflows/update-dashboard.yml` — corre de hora a hora + botão manual
- `README.md` — passo-a-passo de setup

**Também existe (versão paralela, dentro do Claude):**
- O artifact original do dashboard, que corre 100% dentro de uma conversa do Claude, com dados ao vivo via Shopify MCP + Flyweel MCP + Drive MCP — inclui coisas que a versão standalone **ainda não tem**: funil de conversão (sessões/ATC/checkout, filtrado a sessões da Hungria) e a aba de Planeamento (Product Launch Sheet). Achei importante deixar isto escrito porque são duas versões distintas a evoluir em paralelo — vale a pena decidirmos se queremos as duas a longo prazo, ou concentrar tudo numa só.

---

## 2. Correções feitas nesta sessão (já aplicadas no ficheiro)

1. **Versão da API do Shopify estava errada.** Tinha posto `2024-10`, que já não é suportada em julho de 2026 (o Shopify retira versões ao fim de ~12 meses). Corrigido para `2026-07` (a atual).
2. **Cálculo de "hoje"/"ontem" estava a usar fronteiras UTC**, não o fuso horário real da loja (Europe/Budapest). Isto podia desviar os números em 1-2h nas transições de dia. Corrigido para calcular por data local da loja.
3. **Pedido de encomendas sem filtro de data nem paginação** — ia buscar até 250 encomendas sem limitar por período, arriscando não apanhar as mais recentes se a loja tiver muito volume. Corrigido para pedir só os últimos 8 dias, ordenados por mais recente.
4. Adicionei `timezone` ao `stores.json` (Budapest para a Arany Luna, Berlim para a Monika München, já preparado).

---

## 3. Descoberta importante — Shopify vai mudar como se criam apps

Pesquisei e confirmei: **desde 1 de janeiro de 2026, já não é possível criar novas "custom apps" a partir do admin da Shopify** (o método que usaste para gerar o token da Arany Luna). As apps já existentes continuam a funcionar sem problema — a tua da Arany Luna está safe.

**Mas isto afeta diretamente a Monika München.** Quando essa loja Shopify for criada, para gerares um novo Admin API token vais ter de usar o **Dev Dashboard** em vez do fluxo antigo — e o processo é mais complexo: em vez de um token permanente, o novo método (OAuth Client Credentials Grant) gera tokens que expiram a cada 24h, o que significa que o script vai precisar de um passo extra para renovar o token automaticamente antes de cada corrida.

👉 **Não implementei isto ainda** porque não é urgente (a loja nem existe), mas fica anotado: quando chegarmos a essa fase, o `fetch-data.js` precisa de um bloco adicional só para a Monika München.

---

## 4. Coisas por confirmar/testar amanhã (por ordem de prioridade)

### 🔴 Bloqueantes — sem isto o Action não corre
1. **Permissões de escrita do GitHub Action.** Por definição, muitos repositórios têm as Actions em modo só-leitura. Vai a Settings → Actions → General → Workflow permissions e escolhe **"Read and write permissions"** — sem isto, o passo de commit do `data.json` falha. *(Isto não estava no README que te dei — vou corrigir.)*
2. **Confirmar que os secrets têm exatamente estes nomes:** `SHOPIFY_TOKEN_ARANY_LUNA` e `FLYWEEL_KEY_ARANY_LUNA` (maiúsculas, underscore, sem espaços).

### 🟡 Incertezas técnicas reais — testar e ver o que acontece
3. **Formato da resposta da Flyweel.** Não tenho documentação pública fiável do formato exato de resposta ao `query_metrics`. Se a aba de campanhas vier vazia, corre o script localmente e manda-me o `console.log(data)` — é provavelmente um ajuste pequeno no parsing.
4. **Limite de 250 encomendas / 8 dias.** Deve ser suficiente para já, mas se a loja crescer muito, um dia vamos precisar de paginação.

### 🟢 Decisões de produto — para conversarmos
5. **Repositório público ou privado?** Se for público, os números de receita ficam visíveis no histórico de commits do `data.json`, mesmo que o site em si "ninguém encontre". Se te importa, mete o repositório como privado (a Pages ainda funciona, mas pode exigir plano GitHub Pro para ficar realmente privada — vale a pena confirmares isso ao ativar).
6. **Cadência de atualização.** Está de hora a hora — fazia sentido teres mais frequência em horas de maior movimento, ou está bem assim?
7. **As duas versões do dashboard (Claude vs. standalone) — mantemos as duas, ou focamos numa?** A do Claude tem funil e planeamento; a standalone é acessível de qualquer lado sem abrir uma conversa.

---

## 5. O que falta construir (ordem sugerida)

| # | O quê | Porquê agora/depois |
|---|---|---|
| 1 | Testar o setup atual (secrets, permissões, primeira corrida do Action) | Só depois disto sabemos se a base funciona |
| 2 | Corrigir o parsing da Flyweel consoante a resposta real | Bloqueia a aba de Campanhas |
| 3 | Automatizar a margem de profit (ler da Profit Sheet no Drive) em vez de valor fixo no `stores.json` | Tu disseste que muda diariamente — o valor fixo vai ficar desatualizado rápido |
| 4 | Funil de conversão (sessões/ATC/checkout, Hungria) na versão standalone | Precisa de confirmar se o token de Admin API dá acesso à Shopify Analytics/ShopifyQL, ou se essa parte fica exclusiva da versão Claude |
| 5 | Aba de Planeamento (Product Launch Sheet) na versão standalone | Precisa de credenciais Google (Service Account) — o passo mais técnico de todos |
| 6 | Preparar o fluxo Dev Dashboard/token renovável para a Monika München | Só quando a loja existir |

---

## 6. Perguntas diretas para ti

1. Repositório do GitHub vai ser **público ou privado**?
2. Queres que eu **já corrija o README** com o passo das permissões (ponto 3.1)?
3. Quando testares o Action, se a Flyweel falhar, consegues correr o script localmente (precisas de Node instalado) e mandar-me o output? Ou preferes que eu prepare uma forma mais simples de testares isso sem instalar nada?
4. Confirmas que aceitas ficar sem funil de conversão e sem planeamento na versão standalone por agora (fica só na versão Claude), ou isso é importante ter já nas duas?
5. Sobre a margem de profit fixa no `stores.json` — queres que já prepare a leitura automática da sheet (envolve criar uma Service Account no Google Cloud, é o passo mais chato tecnicamente), ou fica bem só atualizares esse número à mão por agora?

---

*Ficheiro para retomares amanhã — dá-me só um "continua" ou responde às perguntas acima e sigo a partir daqui.*
