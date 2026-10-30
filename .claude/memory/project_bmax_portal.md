---
name: project-bmax-portal
description: "Portal BMax — gestão de leads via RD Station CRM V1, hospedado na Vercel (serverless), stack Node.js/Express/Supabase(Postgres)"
metadata: 
  node_type: memory
  type: project
  atualizado: 02/10/2026
  originSessionId: 87fa48d5-0558-4034-9609-8fbcde3f3b32
  modified: 2026-10-28T21:02:16.962Z
---

## Portal BMax — Estado (24/08/2026)

### O que é
Portal web para gestão de leads comerciais do programa BMax. Intermediário entre revendas e o RD Station CRM.

### Localização
- **Hospedagem:** Vercel (serverless, **auto-deploy em produção a cada `git push origin main`** — não existe "só commitar local com segurança": qualquer push posterior leva junto todo commit local anterior ainda não enviado, mesmo que combinado com André não subir ainda. Confirmar com André ANTES de commitar algo que não deve ir pro ar ainda, não confiar em "vou segurar o push").
- **URL:** `https://bmax.boxersoldas.com.br` (DNS resolvido e em uso — não é mais pendente)
- **Código local:** `C:\Users\andre.coelho.BXSD\BOXER\Dados - Documentos\Comercial\Geral\Estrategia\2026\Projeto BMax\boxer-portal-bmax\`
- **GitHub:** `Tekweld/boxer-portal-bmax` (privado)
- **Entry point Vercel:** `api/app.js` (Express serverless, maxDuration 60s)
- **Cache-buster obrigatório:** todo `public/js/*.js` é referenciado em `index.html` com `?v=N` — editar o JS sem subir o `N` faz o navegador continuar servindo a versão antiga em cache (já causou "corrigi mas não aparece" pro usuário real 2x). Sempre bumpar a versão do arquivo editado no mesmo commit.

### Stack

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express 4.21.0 (serverless) |
| ORM | Sequelize + pg (PostgreSQL via Supabase) |
| Auth | JWT (bcryptjs), expira 1 dia |
| CRM | RD Station CRM **API V1** (token simples, sem OAuth) |
| Email | nodemailer (SMTP via env vars) |
| Excel | exceljs (lê planilhas em runtime) |
| Segurança | helmet (CSP configurado), cors |
| Frontend | SPA HTML + CSS/JS separados (`public/index.html` + `css/style.css` + `js/*.js`) |

### Migração TurboCloud → Vercel+Supabase (concluída 12/08/2026)
- **Banco:** MySQL TurboCloud → PostgreSQL Supabase (projeto `boxer-bmax`, sa-east-1)
- **API RD Station:** V2 OAuth → **V1 token simples** (`RD_CRM_TOKEN` env var na Vercel)
- **Hosting:** cPanel/FTP → Vercel serverless (auto-deploy via GitHub push)
- **OAuth removido:** endpoint `/api/rd/callback` removido, tabela `RdTokens` não é mais usada
- **TurboCloud:** não dependemos mais — decisão explícita de André

### RD Station CRM V1
- **Base URL:** `https://crm.rdstation.com/api/v1`
- **Auth:** query param `?token=RD_CRM_TOKEN`
- **Token:** armazenado como env var `RD_CRM_TOKEN` na Vercel (valor: `687698905e9077001ea6c575`)
- **Pipeline principal:** `66151c1470449b000d54e914` (Indústria Interno)
- **Paginação:** busca todas as páginas (200 por página, loop `has_more`)
- **Filtro temporal:** `created_at_start=2026-05-01`
- **Custom fields inline:** `deal.deal_custom_fields[].custom_field.label` + `.value`
- **IDs custom fields:** CNPJ=66549f56, ESTADO=67407ad5, CIDADE=69de7c5f, REPRESENTANTE=687562da, REVENDA/LOJA=69a19ce3, MÁQUINA=69a1eaa6, PERFIL PCI=6a3ae566, NOTAS=661405c2

### Visibilidade por Role
| Role | Vê | Ações |
|---|---|---|
| **adm** | Leads com revenda válida (exclui vazios/?????) | Criar contas, filtrar por revenda, ver cashback |
| **representante** | Leads onde é responsável | Visualizar, criar negociação |
| **revenda** | Leads da sua revenda (ou grupo Luitex) | Criar negociação, escolher caminho PCI, marcar vendido/perdido |

### Funcionalidades implementadas
- **Helmet CSP:** `connectSrc: 'self'`, fonts Google, inline styles/scripts
- **ADM cashback:** calcula usando lógica revenda (linha 18 planilha), ajusta por filtro revenda
- **ADM filtro revenda:** oculta leads sem revenda válida, banner amarelo com contagem de pendências
- **Luitex multi-store:** backend filtra por `includes("Luitex")`, frontend agrupa todas as lojas
- **Mock removido:** sem MOCK_LEADS fallback, dados sempre reais da API
- **8 correções V1 (10/08/2026):** PCI 12a/12b, stop/alert crashes, pipeline, email routing, cashback, paginação, JWT, rep typos
- **11 correções política (20/08/2026):** análise cruzada política comercial × portal — cashback expiration, cheques, alertas, classe de preço
- **4 correções UX (20/08/2026):** select option legível dark theme, overflow body/dash→auto, cache-buster, `updateDashCashback` só para revenda
- **Integração Motor PCI (24/08/2026):** comissões lidas do boxer-sistemas, cards com valor real, botão recalcular admin, cheque PDF dark theme, cache RD leads 5min, stats auto-fit 5 cards (v19)

### Cashback Total — lógica por role
- **Admin/Rep:** soma dos `card.cashback` dos leads visíveis (calculado em `leads.js:200`), nunca sobrescrito pelo endpoint `/cashback/saldo`
- **Revenda:** endpoint `/cashback/saldo` prevalece quando há saldo real no Supabase; enquanto tabelas vazias, mostra soma dos leads

### Sistema de Cashback (implementado 20/08/2026)
- **Tabelas Supabase:** `bmax_saldo`, `bmax_transacoes`, `bmax_saques`
- **Créditos expiram em 6 meses** — coluna `expira_em` em `bmax_transacoes`
- **Cheques expiram em 30 dias** — após aprovação do saque pelo representante
- **Saque:** revenda solicita → representante aprova/recusa → código de cheque gerado
- **Tipo de uso:** Desconto (max 5% do pedido) ou Bonificação (max 10% do pedido) — informacional
- **Cron job:** `/api/cron/expirar-cashback` roda diariamente 10:00 UTC (07:00 BRT) via Vercel Crons
  - Processa créditos expirados (debita automaticamente)
  - Envia emails de aviso 30 e 15 dias antes do vencimento
  - Autenticado via `CRON_SECRET` env var (configurada 20/08/2026)
- **Frontend:** painel "créditos expirando" na tela de extrato, badges urgente ≤15 dias
- **Percentuais:** lidos diretamente do Motor PCI via Supabase `boxer-sistemas` (tabela `comercial_bmax_config`, chave `comissao_tabela`). Cache 10min. Arquivo estático `bmax_criterios.json` e Excel removidos (24/08/2026).
- **Cards mostram valor real:** leads já creditados usam valor de `bmax_transacoes` (histórico imutável). Leads sem crédito usam cálculo teórico com comissão atual.
- **Botão admin "Recalcular Comissões":** na tela de extrato, recalcula todos os créditos com porcentagens atuais do Motor PCI e cria transações de ajuste (diff).
- **PCIs por classe (13, 14, 15):** cashback varia por classe de preço do produto
- **Alerta ADM:** leads com PCI 13/14/15 sem classe de preço definida no RD Station
- **Campo `classePreco`:** mapeado do RD Station (custom field "CLASSE DE PREÇO")

### Reestruturação (13/08/2026)
- **12 arquivos mortos removidos** (OAuth V2, .htaccess com credenciais, duplicatas)
- **Backend limpo:** ~40 console.logs removidos, Excel cached em memória, rota `/leads/resultado` corrigida
- **`src/config/constants.js`:** fonte única de todos os IDs RD Station (stages, custom fields, owners, aliases, representantes)
- **Frontend separado:** index.html de 1759→~230 linhas (markup-only), CSS e JS em 6 arquivos:
  - `public/css/style.css`, `public/js/utils.js`, `public/js/leads.js`, `public/js/negociacoes.js`, `public/js/cadastro.js`, `public/js/app.js`
- **Branch `legacy/turbocloud`:** código TurboCloud/MySQL/OAuth V2 preservado

### Login Page — redesign (14/08/2026)
- Layout stacked: imagem banner → texto descritivo → form row (4 colunas: tipo, usuario, senha, botão)
- Banner: `public/img/bmax-logo-banner.jpg` (logo BMax branco sobre fundo azul escuro), `object-fit:contain`, `max-height:55vh`, `background:#102050`
- CSS: `.login-stack` (flex column, `height:calc(100vh - 62px)`), `.login-form-row` (grid 4 colunas)
- Commits: `444db29`→`68ad983`→`96d2035`→`a61d328`→`3e67c60`→`d249eeb` (série de iterações com feedback do André)
### Fixes criação de negociação (24/08/2026)
- **Duplicidade por CNPJ:** busca agora usa CNPJ exato normalizado (sem pontuação) em vez de nome parcial via `q=`. Só busca no pipeline Indústria. Exclui estágios Perdido, Excluído e Venda Efetivada.
- **Normalização CNPJ/CEP:** setters no model Sequelize strip pontuação antes de validar
- **Erro RD 422 — Organization:** RD exige CNPJ, CIDADE e CEP obrigatórios na Organization. IDs dos custom fields da org: CNPJ=`661582f3c3b2c90015345101`, CIDADE=`661582fab845080022ccef54`, CEP=`685ade2fb62e040017a2c8dd`
- **Fallback org existente:** se `createOrg` falha com "já cadastrada", busca org pelo nome e reusa
- **Match fuzzy revenda:** campo REVENDA/LOJA no RD é tipo `option` com `allow_new:false`. Nomes no Portal (Supabase) divergem dos nomes no RD (acentos, caixa, prefixos numéricos). `matchRevendaRD()` normaliza (NFD, lowercase, trim) e faz match exato→parcial→"Sem Revenda". Lista `RD_REVENDA_OPTS` em `constants.js`.
- **Ordem de criação:** RD primeiro, Supabase depois — evita registros órfãos quando RD falha
- **Dropdown revenda:** campo revenda no formulário agora é `<select>` populado via `/api/config` (que busca de `comercial_revendas_bmax` no boxer-sistemas com cache 30min)
- **Debug errors:** `rdFetch` agora retorna detalhes completos do erro RD no throw (JSON dos errors)

### Fonte única de revendas/representantes (implementado 24/08/2026)
- **Portal BMax** é a fonte da verdade para revendas e representantes
- **Supabase boxer-sistemas** (`comercial_revendas_bmax` e `comercial_bmax_config` chave `representantes_bmax`) é o banco compartilhado
- **Sync automático Portal → RD:** ao criar/editar/ativar/desativar revenda, o Portal faz `PUT /custom_fields/{id}` no RD Station para atualizar opções do dropdown REVENDA/LOJA
- **Motor PCI:** aba de revendas agora é somente leitura (lê do Supabase, sem edição)
- **`/api/config`:** representantes lidos do Supabase com fallback para array hardcoded (`constants.js`)
- **`RD_REVENDA_OPTS` removido:** fuzzy match substituído por envio direto do nome (nomes iguais após sync)
- Admin: novas abas "Revendas BMax" (CRUD) e "Representantes" no painel de gestão

### Campos revenda expandidos (08/09/2026, commit `9f2e2c4`)
- Modal edição de revenda agora tem: **email, telefone, CNPJ, CEP** (além de nome/cidade/estado/classe/grupo/rep)
- Backend: GET select e PATCH allowed keys atualizados em `admin.routes.js`
- Supabase: colunas `telefone`, `email`, `cnpj` adicionadas via migration (cep já existia)
- Criação de usuário unificada: botão único `openCriarUsuarioModal`

### Auditoria de comissões e rastreabilidade (14/09/2026, commit `d8c2bd5`)
- **Gatilho:** André notou cards de venda mostrando cashback mesmo com PCI/Classe de Preço vazios no RD — investigação mostrou que o cálculo sempre exigiu PCI+Classe válidos no momento do crédito (`calcularComissoes` retorna `faltando:true` e não credita), mas o campo pode ser apagado/trocado no RD **depois** do crédito sem deixar rastro algum na tela.
- **Migration aplicada em produção (boxer-bmax):** colunas `pci`, `classe_preco`, `comissao_pct` em `bmax_transacoes` — antes só existia embutido em texto livre em `descricao` (e nos ajustes de recálculo, nem isso).
- **`creditarCashback()`** (`saldo.service.js`) agora recebe um 6º parâmetro opcional `detalhes:{pci,classePreco,comissaoPct}` e grava nas colunas novas. Os 3 pontos que chamam (venda original em `cashback.routes.js`, ajuste de recálculo em `comissao.service.js`) foram atualizados.
- **Nova tela "Auditoria de Comissões"** (Extrato → botão, admin, só leitura): `GET /api/cashback/auditoria` → `auditarComissoes()` em `comissao.service.js`. Compara PCI/Classe gravados no crédito (coluna nova; cai para regex em `descricao` nos créditos antigos pré-migration) contra o que está no RD **hoje**, e sinaliza `sem_pci_no_rd`/`sem_classe_no_rd`/`pci_divergente`/`classe_divergente`.
- **Auditoria manual dos 49 créditos existentes (19 vendas) feita ao vivo, antes da migration:** só 3 tinham Classe vazia hoje, e nos 3 casos o % de Revenda pra aquele PCI é fixo (não varia por classe) — então nenhum crédito existente estava financeiramente errado. Mas a Classe **varia** por classe pra Vendedor Interno/Técnico e pra Representante-Exceção na maioria dos PCIs, e pra Revenda em PCI9/12B/13/14/15 — então o risco era real, só não se materializou nos casos auditados.
- **Pendência real (não é bug de código):** revenda **Rosman Comercio e Servicos** ainda sem Classe de Preço no RD hoje — aparece na Auditoria até alguém preencher lá. FT Serviços foi corrigida no RD durante a própria sessão.

### Matriz de Comissão — Segmento e Origem do Lead por PCI (14/09/2026, commit `d8c2bd5`)
- Duas colunas novas na Matriz de Comissão (Gestão → Comissão/Classificação): **Segmento** (Robô/Laser/Máquina) e **Origem do Lead** (Lead Boxer/Lead Revenda), um dropdown por PCI (não repete nas 4 linhas de agente)
- Vive em `pciMeta` dentro do mesmo JSON `comissao_tabela` (chave `comercial_bmax_config` no boxer-sistemas) — não precisou mudar nada no backend, que já salva/lê a chave como string opaca
- Só classificação/documentação — não entra em nenhum cálculo
- Pré-populado pra todos os 17 PCIs com base no agrupamento já usado no BMax Motor (`index.html:2832-2837`): PCI1-3 Robô/Boxer, PCI4-6 Laser/Boxer, PCI7-12B Máquina/Boxer, PCI13-16 Máquina/Revenda

### Export de leads — 504 em produção (14/09/2026, causa identificada, sem fix ainda)
- `GET /api/export/leads` calcula tudo na hora (varre RD + resolve comissão de cada lead) quando o cache expirou — passa dos 60s do `vercel.json` e a function é matada pela Vercel
- Fix real seria pré-computar via cron (mesmo padrão já usado pra "Consulta de Lead", que tinha o mesmo problema e foi resolvido assim — ver commits `3bde7ca`/`a333604`)

### Export de comissões (Excel) — data e colunas corrigidas (14/09/2026, commit `18c4d29`)
- **Bug:** "Data Fechamento" usava `x.criado_em` (data em que o crédito foi lançado/recalculado no banco), não a data real de fechamento da venda no RD.
- **Fix:** usa `deal?.closed_at || x.criado_em` (fallback só quando o deal não é encontrado no RD). `closed_at` é o campo correto do RD Station V1 para data de fechamento — ver [[project_bmax_api_fields]].
- **Colunas novas:** "Valor Total da Venda (R$)" (`deal.amount_total`), "PCI" (da coluna estruturada nova, com fallback via `extrairPciDoTexto()` pra créditos antigos), "Revenda" (`getCustomField(deal, "REVENDA/LOJA")`).
- **Renomeado:** "Valor" → "Cashback Creditado (R$)" (ambíguo antes — não dava pra saber se era cashback ou valor da venda).
- Precisou estender as SELECTs de `getExtratoTipoAgente()`/`getExtratoPorAgente()` em `saldo.service.js` pra trazer `pci, classe_preco, comissao_pct` (a export lê essas colunas).
- **Verificado ao vivo:** export real chamado, xlsx baixado e parseado — confirmado "04/09/2026" (data real, não a de hoje), Cashback 627.45 vs Valor Total 41830 (distintos), PCI "PCI6"/"PCI9" corretos, Revenda "Comercial Soldas" correta.
- **Pendente:** o mesmo fix NÃO foi aplicado na tela on-screen de Extrato (`getExtrato`/`getExtratoGrupo`) — só no export Excel. Se o André notar a mesma ambiguidade de data na tela, replicar lá.

### PCI12 — seletor de caminho liberado pra representante/admin + troca automática de responsável 48h (14/09/2026, commits `8b993da`/`9205d9c`/`ad423a0`)
- **Seletor de caminho (BOX>REV / BOX+REV>IND):** antes só `role==="revenda"` podia escolher (rota `POST /api/leads/pci` restrita no middleware `authorize()` da rota + checagem redundante no controller + gate no front `leads.js`). Agora `revenda`, `representante` e `adm` podem. `aplicarCaminhoVenda()` já era agnóstico de role (não mudou). Auditoria (`AuditLog`) já registra `req.user.role`, então dá pra saber depois quem selecionou em nome da revenda.
- **RD Station não distingue quem fez a chamada** — todas as escritas do Portal usam o mesmo `RD_CRM_TOKEN` (integração única, não OAuth por usuário), então liberar outros roles não tem risco de "travar" nada no RD.
- **Troca automática de responsável durante PCI12 pendente (regra definida por André, 14/09/2026):** ao detectar um PCI12 novo (no cron diário `sync-revenda-rep-rd`), o responsável no RD passa a ser o André (`RD_OWNERS["Revenda"]` = seu próprio ID no RD, `67efe9d367f94d002a8c4929` — já usado assim desde 11/09/2026) até a revenda escolher o caminho, ou até **48h** sem resposta (nesse caso volta pro responsável original).
  - Tabela nova `bmax_pci12_tracking` (Postgres boxer-bmax): guarda `deal_id`, `owner_original_id/nome`, `detectado_em`, `email_24h_enviado_em`, `revertido_em`, `resolvido_em`.
  - Roda pra **todo** PCI12 pendente, inclusive os que já estavam parados antes dessa feature existir — não depende do snapshot `pci12_leads_avisados` (que só controla o e-mail, não mais a troca de owner).
  - Novo cron `pci12-followup` (4x/dia: 09/13/17/21h UTC — Vercel Hobby só roda 1x/dia por schedule, daí múltiplas entradas, mesmo padrão de `recalcular-comissoes`): manda lembrete por e-mail às 24h (revenda **e** representante, mesma lógica do aviso imediato) e reverte o `owner_id` às 48h se ainda não resolvido.
  - `aplicarCaminhoVenda()` marca o tracking como resolvido assim que a revenda/rep/admin escolhe — não precisa reverter nada ali, o `updateLead` já atribui o responsável certo via `lerPlanilhaResponsavel`.
  - **Escopo é o mesmo do que aparece pro Portal:** só pega leads que `getLeads("admin","adm")` retorna — pipeline Indústria Interno, criados a partir de 01/05/2026, excluindo Perdido/Excluído. **Decisão confirmada por André (14/09/2026): correto ficar assim** — não faz sentido trocar responsável de um lead que a revenda nem consegue ver/agir no Portal. Isso explica por que só 3 dos ~20 PCI12 "esquecidos" (achados na investigação do fluxo) entraram no tracking na primeira rodada — os outros estão fora desse recorte (funil diferente ou mais antigos) e continuam fora de escopo por design, não é bug.
  - Disparado manualmente uma vez (14/09/2026, via `vercel crons run`) pra aplicar a leads já pendentes — confirmado ao vivo: Fabio Alessandro, Ezequiel (ESM) e Huoli tiveram responsável trocado pra André no RD.
- **Fix de normalização de PCI (defensivo, não era a causa raiz do caso investigado):** `pci` em `rd.leads.service.js` agora sempre `.toUpperCase()` na origem; front usa `normalizePci()` também no gate do seletor PCI12 (antes comparava string crua, um dos dois pontos não normalizava). Não era o bug do card do Fabio Alessandro — a causa real era o André estar logado como **representante**, que na época não tinha permissão de ver o seletor (ver acima).

### PCI12 — regra de caminho corrigida (16-17/09/2026, commits `718ea1a`/`eecd26e`)
- **Regra de negócio corrigida por André:** quando a revenda escolhe "eu assumo a venda" (BOX>REV/PCI12A), o lead **NÃO muda de funil** — antes ia pro pipeline "BMAX" (stage "Leads Revenda"), o que fazia o card **desaparecer pra sempre do painel da revenda** (o dashboard só busca leads do pipeline "INDÚSTRIA - INTERNO", nunca do "BMAX" — bug estrutural pré-existente, só exposto agora). Agora fica em Indústria Interno, vai pra etapa "Negociação" (mesma etapa do caminho Boxer-vende, só não muda de pipeline), responsável continua André, PCI vira 12a, e cria uma **tarefa** no RD documentando "revenda seguirá o atendimento" (API V1 do RD não tem endpoint de escrita pra anotação real — nem de LEITURA, `GET /annotations` também dá 404 — tarefa é o mecanismo real).
- **E-mail que nunca existiu pro caminho revenda-assume:** só o Boxer-vende tinha notificação. Agora avisa revenda **e** representante, incluindo nome/telefone do contato do cliente.
- **Nome/telefone do contato só aparece no drawer do card (e no e-mail) quando `pci==="PCI12A"`** — regra de privacidade que não pode ser esquecida, nunca em outro cenário. Contato vem de `GET /organizations/:id` (não vem no deal, precisa chamada extra) — `getContatoPrincipal()` em `rd.leads.service.js`.
- **Botão Vendido/Perdido da revenda:** gate mudou de `tag==="Assumido"` (nunca mais alcançado, já que o funil não muda) pra `pci==="PCI12A"`.
- **Bug mais amplo achado e corrigido nas notificações por e-mail de representante** (afetava também o caminho Boxer-vende, que já existia): `getAliasMaps().rdToUsername` devolve o **nome canônico** do representante (ex: "Victor VLM"), não o username de login — que hoje é o e-mail (convenção 11/09/2026). `getRepresentativeEmailByName` busca por username exato e sempre falhava pra quem já migrou. Fix: novo `rdToEmail` em `getAliasMaps()` (e-mail direto do Supabase `comercial_representantes_bmax.email`, sem depender de bater nome com username) — usado nos 3 lugares que notificam representante.
- **RD exige "Segmento de Produto" preenchido pra aceitar a etapa Negociação** — travava com 422 em qualquer lead sem esse campo (ex: Fibertechnic). Fix: `aplicarCaminhoVenda()` já manda `"Máquinas"` automaticamente — PCI12 (12a e 12b) é sempre esse segmento pela Política Comercial, nunca Robô/Laser. Novo `RD_CUSTOM_FIELDS.SEGMENTO_PRODUTO`/slug `seguimento-do-produto` em `constants.js`.
- **`getRevendaEmailByName()` só achava por nome EXATO** — grupos com várias lojas no RD (Luitex Sumaré/Americana/Mogi Guaçu/etc; "42863 Alphabras Poços de Caldas 1"/etc) só têm 1 cadastro no Portal por grupo, então o e-mail nunca era achado pra loja que não fosse a cadastrada literalmente. Fix: casa por `Revenda.grupo` ou substring do `Revenda.name` dentro do nome do RD (ignorando prefixo numérico de filial). **A Luitex sempre teve e-mail cadastrado** (`marcio@luitex.com.br`, no login da revenda) — um diagnóstico anterior (mesma sessão) de "sem e-mail" estava errado, checou a coluna errada (`Revenda.email`, vazia) em vez do e-mail de login real que a função usa.
- **Faltava São Paulo (capital) em `ibge_responsaveis.json`** (10.740 municípios, agora 10.741) — qualquer lead nessa cidade falharia "Responsável não encontrado" ao escolher Boxer-vende. Adicionado: São Paulo/SP → Carlos (território dele por `vendedores-boxer.md`).
- **Auditoria feita em todos os deals PCI12/12a/12b (~4.467 deals, 2 pipelines) achou e corrigiu 3 leads presos na regra antiga:** Fabio Alessandro, Fibertechnic LTDA, Danielle Silva-ECOPRIMOS (Boxer-vende, responsável correto já era Max por região). Achados sem ação necessária: leads de teste (`TESTE_*_APAGAR`) e 3 leads já avançados/perdidos por outro caminho (não estavam "presos").
- **Verificado ao vivo, ponta a ponta**, resetando e reaplicando o caminho real no deal "Alpha Industrial Solutions" (Luitex Sumaré) múltiplas vezes até confirmar: RD em Negociação/Indústria Interno/André/PCI12a, e-mail entregue de verdade pra revenda e representante.

### Bug de representantes duplicados na listagem (14/09/2026, commit não registrado no texto — ver `admin.routes.js`)
- **Causa raiz:** `GET /users` cruzava `Users.username` (Postgres, é o email desde a convenção 11/09/2026) contra `comercial_representantes_bmax.nome` (Supabase, nome de exibição mutável) — sem chave estável em comum, o mesmo representante aparecia duas vezes (uma via login/email, outra via nome cadastrado).
- **Fix:** adicionado `canonRepsByEmail` (map por email) e lookup passa a ser `canonRepsMap[u.username] || canonRepsByEmail[u.username.toLowerCase()]`; `nomesComLogin.add()` agora usa o nome canônico do representante, não o username bruto.
- **Regra geral daqui pra frente:** nunca casar registros entre Postgres (boxer-bmax) e Supabase (boxer-sistemas) por nome/username — sempre por email, que é estável. Não há FK real entre os dois bancos (projetos Supabase separados).
- **Por que revenda/admin não têm esse bug:** usam vínculo por chave estável (FK real ou email), não por nome de exibição. Só representante usava `nome` como chave de cruzamento.
- **RD Station "rd_alias":** mecanismo intencional (não um bug) em `comercial_representantes_bmax.rd_alias` — reconcilia o nome canônico com o nome que está de fato vivo no picklist do RD (ex: ledger mostra "Caio Tito" mas o canônico é "Caio P Mancini"). Não precisa de ação.

### Erro "CNPJ já existe" em Nova Negociação — visibilidade (14/09/2026)
- Toast de erro era sutil demais — André digitou um CNPJ duplicado, o toast passou despercebido e ele pensou que o cadastro tinha sido salvo.
- **Fix:** banner fixo vermelho (`#negFormError` em `index.html`, `.form-error-banner` em `style.css`) acima do form, com texto "Cadastro NÃO foi salvo: [motivo]" — substitui o toast em qualquer erro (400 ou outro) no save de negociação. `negociacoes.js`: `showNegFormError()`/`hideNegFormError()`.

### Fix `/rep-bmax-list` (upsert) — 23505 duplicate key (14/09/2026)
- Mesma classe de bug já vista e corrigida em `/comissao-config` em sessão anterior: `Prefer: resolution=merge-duplicates` no PostgREST **não é suficiente** por si só — sem `?on_conflict=<coluna>` na URL, o Supabase tenta um INSERT puro e falha com `23505` em chave existente.
- **Fix:** adicionado `?on_conflict=chave` na URL do PUT de `/rep-bmax-list`. Isso corrigia o erro 500 ao cadastrar novo representante.
- **Regra geral:** qualquer novo endpoint que faça upsert no Supabase via REST precisa sempre de `?on_conflict=<coluna-chave>` junto com o header `Prefer`. Bug já apareceu 2x no mesmo padrão — checar todos os upserts existentes se aparecer um 23505 de novo.

### Pendências
- **Unificação de login:** Portal usa JWT local (bcrypt+Sequelize), Motor usa Supabase Auth — migrar para auth único (decisão pendente)
- **Cashback duplicado:** sem proteção de dedup por `lead_id` em `creditarCashback` — mesmo lead marcado vendido duas vezes = crédito duplo
- **Tela admin de estorno:** sem forma de corrigir erros manualmente (estorno/ajuste) — feito ad-hoc via `debitarCashback()` direto quando precisou (ver 21/09)
- **Confirmação email de saque:** aguardando Victor validar recebimento
- **Circular dep:** mover getRepresentativeEmailByName de leads.controller para user.service.js
- **Painel ADM gerencial:** substituir extrato cashback por tela com: cashback por revenda, métricas vendas por revenda/rep/mês/acumulado
- **Rosman Comercio e Servicos:** sem Classe de Preço no RD — Auditoria de Comissões vai continuar apontando até corrigir lá
- **Export 504 (`GET /api/export/leads`):** ainda sem fix — mesma causa raiz do 504 de varredura resolvido 02/10 (ver seção abaixo), mas esse endpoint calcula comissão de cada lead na hora em vez de varrer deals do RD; precisaria do mesmo padrão de chunking ou pré-computar via cron.
- **Tela de Extrato (on-screen):** não recebeu o fix de data de fechamento/colunas aplicado no export Excel (14/09/2026) — replicar se o André notar a mesma ambiguidade lá
- **`representante_id` em `Revenda.create()`** (dropdown "Representante" no modal Novo Usuário/revenda) **não é uma coluna real do model Sequelize** — a seleção é descartada silenciosamente, não faz nada. Achado 21/09/2026, não corrigido — decidir se vale wire up de verdade ou remover o campo da tela.
- **Grupo 3 da auditoria 24/09 (17 revendas sem match no ZEN)** — nunca retomado com termos de busca melhores.
- **3 deals da AlugaaSolda travados** com "Classe de Preço"/"Segmento de Produto" vazios no RD (obrigatórios) — nunca corrigidos.
- **~77-78 "leads sem representante"** — investigação parcial (só distribuição por data), nunca concluída.

### Resolvidos 02/10/2026 (não são mais pendência)
- Dedupe-por-CNPJ ao criar usuário, antes só no branch `revenda` — agora também `representante`/`funcionario`/`adm` (`upsertCadastroCanonico()`).
- Campo morto "Classe de Preço" na criação de usuário ADM — removido (nunca era lido pelo backend).
- Sync inicial RD — já populado; picklist tem 100+ opções ativas.

### Sessão 24/09→02/10/2026 — arquitetura login↔cadastro↔RD, bug sistêmico de sync, 504 em massa, vários logins por revenda

Disparada por reclamação real (leads "duplicados" AlugaaSolda/União Soldas, Victor/Caio trocados) — virou auditoria ampla de como login (Postgres `Revendas.name`), cadastro (Supabase `comercial_revendas_bmax`) e RD (picklist `REVENDA/LOJA`) podiam divergir entre si, já que são **3 cópias independentes do mesmo nome**, sem FK entre elas.

- **Schema novo:** `comercial_revendas_bmax.user_id` (int, FK pro login Postgres) e `.nome_rd` (texto, nome exato do RD quando diverge do `nome` de cadastro) — aplicados em produção.
- **UI nova de vínculo:** Gestão → Revendas e Novo Usuário ganharam um `<select>` alimentado pelo picklist ao vivo do RD (em vez de texto livre), com opção "+ Revenda nova"; rename de login só acontece se o nome bate de verdade com uma opção viva do RD (evita quebrar visibilidade de um login que já funciona).
- **Bug sistêmico achado e corrigido:** RD valida duplicata de picklist de forma case/espaço-insensível, nosso dedupe não era — rejeitava o `PUT` inteiro (422) silenciosamente, represando sync de revenda/representante por tempo indeterminado (ver detalhe em [[feedback_portal_bmax_logica]]).
- **504 em edição de revenda/representante com muitos leads** — rotinas de renomear/reatribuir no RD viram varredura paginada e retomável (`maxMs`+`cursor`), não mais síncrona de ponta a ponta numa request só (ver [[feedback_portal_bmax_logica]]).
- **401 intermitente em rotas de gestão** — `admin.routes.js` usava chave `anon` do Supabase (GRANT/RLS instável) em rotas já protegidas por auth própria; trocado pra `service_role` (ver [[feedback_portal_bmax_logica]]).
- **Vários logins por revenda:** visibilidade de leads sempre foi many-to-one via `Revendas.name` — só faltava UI. Novo: criar login escolhendo nome já cadastrado não duplica cadastro Supabase; `PATCH /admin/users/:id/revenda` troca/limpa o nome que um login enxerga; `GET /admin/revendas-bmax/:id/usuarios-vinculados` lista todos os logins com aquele nome (distinto do "Usuário Vinculado" 1:1 do cadastro).
- **~41 revendas vinculadas** (login↔cadastro) em múltiplas passadas: 19 por CNPJ exato via ZEN, 11 por nome normalizado, 5 por substring+cidade, 3 por caso especial (WST/LUMAQ/Cascavel), VR, Via Soldas.
- **Via Soldas onboardada do zero** (não existia no RD) — login, cadastro e opção no picklist do RD, testado ponta a ponta.
- **AlugaaSolda corrigida** (`nome_rd` setado, era a causa raiz do bug Victor/Caio) — login criado pro e-mail real (`atilio@alugaasolda.com.br`, achado no ZEN, zen_id 25932).

**Why:** o padrão repetido era sempre o mesmo — um nome de revenda que divergia entre Postgres/Supabase/RD, sem nenhum dos três ser fonte de verdade clara sobre os outros.

**How to apply:** ver [[feedback_portal_bmax_logica]] pros detalhes técnicos de cada fix. Pra cadastrar/classificar revenda nova, sempre checar `BMAX CRITERIOS.xlsx` primeiro (ver [[project_bmax_docs]]).

### Auditoria ampla de vínculos e bugs de produção (21/09/2026, commits `97201f3`→`ce259a1`)

Sessão iniciada por reclamação real: leads PCI12 atribuídos a revenda não apareciam nem pro login da revenda nem do representante, e e-mails nunca chegavam. Virou uma varredura grande, achando e corrigindo vários bugs reais em produção:

- **Card de revenda multi-loja sumia do painel:** `leads.js` refiltrava `API_LEADS` no front por igualdade EXATA de nome contra `session.name`, duplicando (mal) o que o backend já fazia certo via `bmax_grupos`. Só "funcionava" pra Luitex por um hack de substring hardcoded (`includes("luitex")`) — qualquer outro grupo multi-loja (Alphabras etc.) ia a zero cards. Fix: removido o refiltro do front — o backend já entrega a lista certa.
- **Aviso por e-mail de PCI12 pendente nunca "lembrava" quem já avisou:** `saveSnapshot()` (cron `sync-revenda-rep-rd`) fazia PATCH filtrado por chave e só caía no fallback POST via `.catch()` — mas PATCH sem match não lança erro (PostgREST devolve 200 com array vazio), então a linha de controle nunca era criada e o fallback nunca disparava. **Mesma classe de bug achada e corrigida em mais 2 lugares:** criar representante novo (`PUT /admin/representantes-bmax`) e o espelhamento pra chave legada do Motor — ambos "diziam sucesso" sem gravar nada em alguns casos. Ver [[feedback-portal-bmax-logica]] — generaliza a regra de `?on_conflict=` já documentada: o perigo não é só 23505, é PATCH silencioso.
- **Comissão de revenda vazava pra conta fantasma "Sem Revenda"** e contaminava o "Saldo Revendas" de QUALQUER representante que também tivesse lead sem revenda (achado: venda de R$39mil do Caio Tito gerou R$587,48 que apareceram no painel do Francisco Campopiano, outro rep, sem relação nenhuma). Causa: dois lugares só excluíam o placeholder `"?????"`, nunca o valor legítimo `"Sem Revenda"`. Nova constante `REVENDA_SEM_CREDITO` em `constants.js`, usada nos 3 pontos de crédito/agregação (nunca na validação de dado — lá "Sem Revenda" continua opção válida). Saldo fantasma estornado via débito registrado.
- **Tabela `RevendaFiliais` nunca existia em produção** — bloqueava a criação de QUALQUER revenda nova (não só filiais), porque toda revenda nova cria uma "filial principal" dentro da mesma transação. Erro real: `relation "RevendaFiliais" does not exist`, 500 puro. Criada manualmente com o schema exato do model Sequelize; testado ponta a ponta contra a API real.
- **Dropdown "Representante" (modal Novo Usuário) mostrava e-mail de login em vez do nome** — usava `ADMIN_USERS` (username=e-mail desde 11/09) como rótulo; corrigido pra usar `ADMIN_REPS_BMAX` (nome canônico).
- **Cadastro "Chapefer" na aba Revendas** estava grafado "Chapfer" (typo) e inativo — por isso não aparecia (a aba só mostra ativas por padrão). Renomeado e reativado.
- **Feature nova:** botão "Gerar senha automática" (Gestão → Senha) — gera senha aleatória, sobrescreve o hash na hora, mostra só uma vez. `PATCH /admin/users/:id/reset-password` aceita `{gerar:true}`.
- **Feature nova:** `alertarAdminErro()` (`email.service.js`) — e-mail pro `EMAIL_FALLBACK` quando uma rota de gestão falha de verdade no servidor (fire-and-forget). Ligado no `errorMiddleware` global + `POST /admin/grupos` como primeiro caso de uso; não estendido pros outros endpoints de gestão ainda.
- **Redesign visual aplicado** (paleta oficial Boxer, logo BMAX, tipografia Inter) via patch pré-aprovado — foi parar em produção sem confirmação final por causa do auto-deploy (ver nota em Localização acima). André decidiu manter no ar.

**Why:** um problema pontual reportado (leads sumidos) só foi resolvido de verdade auditando a classe inteira do bug, não só o caso relatado — o mesmo padrão de PATCH-silencioso e de filtro incompleto de "Sem Revenda"/"?????" apareceu em múltiplos lugares independentes.

**How to apply:** qualquer upsert novo via Supabase REST — sempre `?on_conflict=` + `merge-duplicates`, nunca PATCH-then-catch(POST). Qualquer lugar que exclui `"?????"` de um cálculo de crédito/saldo também precisa excluir `"Sem Revenda"` (ver `REVENDA_SEM_CREDITO`). Qualquer alteração em `public/js/*.js` precisa bump de versão no `index.html` no mesmo commit.

### Sessão 22/09/2026 — role funcionario, estágio novo do RD, RLS Supabase (commits `47b24da`→`49d72f2` + 2 migrations diretas em produção)

- **Estágio novo "Entrega Técnica" no RD** (`6aa05557a4f8c10025433f09`, pipeline Indústria Interno) não existia em `RD_STAGES` — causava tag "??????" no card, E fazia o cron `recalcularComissoes`/`cashback.routes.js`/`mapDealToCard` tratar a venda como "não vendida" (parava de contar cashback) assim que o card avançava pra esse estágio pós-venda. Fix: mapeado + incluído em todos os 4 `vendaStages`/checagens de "é venda efetivada" junto com Venda Efetivada/Vendido. **Se o RD criar mais estágios novos no futuro, o mesmo sintoma (tag "??????" e comissão sumindo) vai se repetir** — checar `RD_STAGES` em `constants.js` contra `GET /deal_pipelines` real quando aparecer.
- **Ordem dos cards no painel:** Venda Efetivada > Negociação > Em Contato > Demonstração > Lead, mais antigo primeiro dentro do grupo (`ordenarCards()` em `leads.js`, novo campo `criadoemRaw` no card pro sort).
- **Sessão expirada (JWT 1 dia) não fazia logout automático na tela de Gestão** — admin ficava reenviando token morto vendo erro genérico. Novo helper `adminFetch()` em `admin.js` força logout+aviso claro em qualquer 401.
- **Revenda duplicada ao criar usuário/login:** `POST /users` pra role=revenda sempre fazia `POST` novo em `comercial_revendas_bmax`, mesmo quando a revenda já tinha cadastro lá (achado ao vivo: 2 linhas "LUMAQ", uma com CNPJ formatado/antiga e outra sem pontuação/nova, 3min de diferença). Fix: busca por CNPJ antes de escrever, reaproveita linha existente (PATCH) em vez de duplicar. **Mesmo risco existe pra representante/funcionario/adm** (`sbSistemas POST` sem checar duplicata) — só o caminho revenda foi corrigido, os outros 3 ainda podem duplicar se o mesmo cenário (login criado depois de já existir um cadastro manual em Gestão) se repetir.
- **Enum `user_role` do Postgres em produção não tinha o valor `"funcionario"`** — mesma classe de bug do `RevendaFiliais` faltante (21/09): o model Sequelize já tinha o valor novo, mas nunca existe migration automática nesse projeto (sem sequelize-cli, sem pasta `migrations/`), então o enum real do banco ficou desatualizado. Erro em produção: `invalid input value for enum user_role: "funcionario"`. Fix: `ALTER TYPE user_role ADD VALUE 'funcionario'` aplicado direto via MCP Supabase (`apply_migration`). **Regra geral agora em [[feedback_portal_bmax_logica]].**
- **Role "funcionario" não tinha case em `setDashHeader()` (app.js)** — depois de logar, título/nome do painel ficavam em branco (caía no `default`, que existe só pro estado sem sessão). Adicionado case próprio: mesma visibilidade de leads do adm (não filtrado em `getLeads()`), sem botão "Nova Negociação".
- **Restrição de permissão pedida por André (22/09):** Funcionário Boxer só pode **visualizar** o painel geral — nunca Gestão, nunca criar negociação. Duas brechas fechadas: (1) `show("gestao")` não checava role — dava pra forçar `#gestao` na URL mesmo escondendo o botão (tela abria vazia, mas abria); (2) `POST /negociacoes` só exigia `authenticate`, sem `authorize()` — qualquer role logado podia chamar a API direto, ignorando o botão escondido no front. Ambos corrigidos (`authorize(["adm","representante","revenda"])` na rota + guard em `show()`).
- **RLS desligado em 10 tabelas do Postgres `boxer-bmax`** (alerta real recebido por email do Supabase, 19/09/2026): `Users` (com hash de senha), `Representantes`, `Revendas`, `Negociacoes`, `rd_tokens` (tokens OAuth mortos da integração V2 antiga — ainda tinha token salvo lá), `leads_cache`, `bmax_grupos`, `RateLimitHits`, `bmax_pci12_tracking`, `RevendaFiliais`. Qualquer um com a anon key conseguia ler/escrever tudo via API REST do Supabase, sem passar pelo Portal. **Confirmado seguro habilitar RLS sem nenhuma política** (= bloqueio total via REST) porque o Portal nunca usa a API REST desse projeto — só conexão direta Postgres via Sequelize (`DATABASE_URL`, role `postgres.*`, que ignora RLS por ser dono da tabela). Aplicado via `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` nas 10, verificado no Advisor do Supabase que o alerta crítico sumiu, e que os dados continuam acessíveis pelo Portal. `bmax_saldo`/`bmax_transacoes`/`bmax_saques` já tinham RLS antes, não precisou mexer.

**Why:** cada achado veio de um reporte real do André (email chegando, dropdown de rep, login não funcionando, cadastro não aparecendo) — nenhum foi auditoria proativa dessa vez, mas seguiu o mesmo padrão de "investigar a causa raiz até o fim, corrigir a classe inteira do bug, não só o sintoma pontual".

**How to apply:** ver regra nova em [[feedback_portal_bmax_logica]] sobre enum/schema drift. Se o representante/funcionario/adm apresentar duplicata igual à LUMAQ, replicar o fix de dedupe-por-CNPJ pros outros 3 branches de `createUser` em `users.controller.js`.

### Papel no ecossistema BMax
- **Motor PCI** ([[project-bmax-motor]]): classifica leads nos 16 PCIs
- **Política V5** ([[project-bmax-docs]]): define regras comerciais
- **RD Station CRM V1**: fonte de verdade dos deals

**Why:** André quer autonomia total — codificar, commitar, deploy automático sem dependência de TurboCloud.

**How to apply:** Push em main = deploy Vercel automático. RD Station via V1 token simples.

### Sessão 27–28/10/2026 — Nova Negociação por produto/atendimento, nome único, travas de duplicidade
Resumo (detalhes em DOCUMENTACAO_TECNICA.md seções 11–14 do Portal e em [[project-bmax-pendencias]]): Nova Negociação com PCI 13/14/15 pelo produto e perguntas Caminho + Quem atende (também para representante/admin, sem campo Funil); representante preenchido pelo cadastro; travas de CNPJ inválido/nome+cidade e aviso de filial; cadastro de revenda + login juntos com nome único; robô de 48h e alerta admin para revenda sem login; contato do cliente PCI12A sem organização; "Esqueci minha senha"; botão "Regras e cashback"; GitHub com escrita (push = deploy). Arquitetura-alvo: [[project-bmax-modelo-revenda-grupo]].

**30/10/2026 — contato do cliente obrigatório na Nova Negociação:** cards do Portal nasciam sem contato no RD. Agora nome + telefone (DDD) obrigatórios, e-mail opcional, para todos os perfis; `validarContatoLead` (servidor, antes do card) + `criarContatoDoLead` (POST /contacts com deal_ids, igual GVX). Testado no card testeSC (contato de teste ficou lá). Cards antigos NÃO corrigidos (decisão do André). Commit 3952d25. Falta conferir o 1º card real criado com contato.
