# Documento Técnico — Portal BMax

> Referência técnica para quem for manter ou estender o Portal BMax. Descreve o que o código faz hoje (21/09/2026), não o que deveria fazer. Complementa a Bíblia Mestra e a Política Comercial (regras de negócio, público leigo) — este documento é para desenvolvedores.

## 1. O que é

Portal web para gestão de leads comerciais do programa BMax — o intermediário entre revendas parceiras, representantes comerciais e o RD Station CRM. Três papéis de login: **revenda**, **representante**, **adm**. Também gerencia cashback (crédito comercial que revendas acumulam por venda) e comissão de representantes.

## 2. Arquitetura

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express 4, serverless na Vercel (`api/app.js`, maxDuration 60s) |
| ORM | Sequelize + `pg`, Postgres hospedado no Supabase (projeto **boxer-bmax**, `sa-east-1`) |
| Auth | JWT local (bcryptjs), expira em 1 dia. Não usa Supabase Auth. |
| CRM | RD Station CRM **API V1** (`https://crm.rdstation.com/api/v1`, token simples via query `?token=`) |
| Config compartilhada | Supabase **boxer-sistemas** (projeto separado do boxer-bmax!) — tabelas `comercial_*`, lidas via REST (`sbSistemasAnon`/`sbSistemasService`) |
| Email | Resend API (`RESEND_API_KEY`) |
| Frontend | SPA estática: `public/index.html` (markup) + `public/css/style.css` + `public/js/*.js` (sem bundler, sem framework) |
| Deploy | Vercel — **auto-deploy em produção a cada `git push origin main`**, sem etapa de aprovação intermediária |

**Dois bancos Postgres/Supabase diferentes, sem FK entre eles:**
- **`boxer-bmax`** (Postgres via Sequelize) — `Users`, `Revendas`, `RevendaFiliais`, `Representantes`, `Negociacoes`, `AuditLogs`, `RateLimitHits`, `bmax_saldo`, `bmax_transacoes`, `bmax_saques`, `bmax_pci12_tracking`, `bmax_grupos`. Acesso via Sequelize/`DATABASE_URL`.
- **`boxer-sistemas`** (Supabase, REST) — `comercial_revendas_bmax`, `comercial_representantes_bmax`, `comercial_bmax_config`, `comercial_bmax_admins`. Esse projeto é **compartilhado com o BMax Motor** (ver `bmax-motor/DOCUMENTACAO_TECNICA.md`) — é de lá que vem a tabela de comissão (`comercial_bmax_config`, chave `comissao_tabela`) que o Portal lê pra calcular cashback.

**Regra crítica de integridade:** nunca cruzar um registro do Postgres (`boxer-bmax`) com um do Supabase (`boxer-sistemas`) por nome/username — não existe FK real, e nomes de exibição mudam. Sempre por e-mail (ou outra chave estável explícita). Username do Postgres é o e-mail de login desde 11/09/2026 (antes era nome de exibição) — qualquer lookup antigo por nome quebra silenciosamente pra quem já migrou.

## 3. Modelo de dados (boxer-bmax, via Sequelize)

| Tabela | Propósito | Pontos de atenção |
|---|---|---|
| `Users` | Login (id, username=e-mail, password bcrypt, role) | role ENUM: adm/representante/revenda/funcionario |
| `Revendas` | 1:1 com User (PK = `user_id`). name, email, telefone, **grupo**, cnpj (unique), cep, cidade, estado | `grupo` agrupa lojas multi-filial do RD (ex: Luitex Sumaré/Americana/... todas sob grupo "Luitex") via tabela `bmax_grupos` |
| `RevendaFiliais` | Filiais de uma revenda (sede + adicionais) | **Criada manualmente em produção em 21/09/2026** — o `CREATE TABLE` nunca tinha rodado apesar do model/controller existir há tempo; toda criação de revenda nova quebrava com 500 até então. Ver seção 8. |
| `Representantes` | 1:1 com User. email | nome de exibição de verdade fica em `comercial_representantes_bmax` (Supabase), não aqui |
| `Negociacoes` | "Reserva" local de uma negociação nova criada pelo Portal (CNPJ, revenda, representante, `expires_at` = +60 dias) | é o registro do formulário "Nova Negociação", não reflete status do RD depois de criado |
| `AuditLogs` | Log de ações sensíveis (login, reset senha, etc) | escrita via `AuditLog(req, {...})` em `audit.service.js`; degrada graciosamente se a tabela não existir (`isAuditTableAvailable()`) |
| `RateLimitHits` | Rate limiting próprio (não usa lib externa) | `rateLimit.js` |
| `bmax_grupos` | Mapeia nome de loja no RD (`REVENDA/LOJA`) → `grupo` da revenda no Portal + `email_responsavel` | raw SQL via `sequelize.query`, não é model Sequelize |
| `bmax_saldo` | Saldo atual por `(tipo_agente, revenda)` — `revenda` aqui é "nome do agente" (revenda, representante ou vendedor_interno), coluna renomeável só no nome, não na função | `tipo_agente`: `revenda` \| `representante` \| `vendedor_interno` |
| `bmax_transacoes` | Histórico de crédito/débito, com `pci`, `classe_preco`, `comissao_pct` (colunas adicionadas 14/09/2026 — créditos antigos só têm isso embutido em texto livre na `descricao`) | `lead_id` referencia o deal no RD |
| `bmax_saques` | Pedido de saque de cashback (revenda solicita, representante aprova/recusa, gera código de cheque `BMAX-<ano>-<5 dígitos>`) | |
| `bmax_pci12_tracking` | Rastreia troca automática de responsável (48h úteis) enquanto um PCI12 está pendente | `deal_id`, `owner_original_id/nome`, `detectado_em`, `email_24h_enviado_em`, `revertido_em`, `resolvido_em`, `auto_12b_em` |
| `bmax_pci12a_prazo` | Início do prazo de 60 dias corridos do PCI12a (`assumido_em`, `arquivado_em`) | DDL em `scripts/create-pci-prazos-tables.js` |
| `bmax_orcamentos` | Orçamentos anexados à Nova Negociação (token do link fixo, caminho no Storage, `deal_id`, `nota_rd_em`, `revogado_em`, `aberturas`) | ver seção 8b; DDL em `scripts/create-orcamentos.js` |

## 4. Modelo de dados (boxer-sistemas, via REST — compartilhado com o Motor)

| Tabela | Propósito |
|---|---|
| `comercial_revendas_bmax` | Cadastro-mestre de revendas, **importado do ZEN** (`zen_id`, `rep`, lat/lng, `classe` Ouro/Prata/Diamante). Não é 1:1 com login do Portal — é normal ter cadastro sem login (revendas pequenas/inativas) e vice-versa. Editável via Gestão → Revendas (campo `ativo` controla se aparece na listagem por padrão). |
| `comercial_representantes_bmax` | Nome canônico, e-mail, `rd_alias` (reconcilia nome canônico com o nome vivo no picklist do RD, quando divergem), `ativo`, `tem_login` |
| `comercial_bmax_config` | Key-value genérico. Chaves conhecidas: `comissao_tabela` (tabela de comissão do Motor, lida pelo cashback do Portal), `representantes_bmax` (espelho legado que o Motor lê direto), `revenda_rd_snapshot`/`pci12_leads_avisados` (snapshots de controle dos crons do Portal) |
| `comercial_bmax_admins` | Quem tem acesso ao Motor (Supabase Auth, sistema separado do login do Portal) |

**Duas chaves de acesso:** `sbSistemasAnon` (anon key, maioria das leituras/escritas) e `sbSistemasService` (service_role, exigido só por `comercial_revendas_bmax`/`comercial_bmax_config`/`comercial_bmax_cobertura`/`comercial_bmax_vendedores` desde a "Lote 7" de centralização).

**Espelhamento Portal → Motor (lat/lng):** o Motor lê só `comercial_revendas_bmax` e só considera revenda `ativo` **com `lat`/`lng`** no cálculo de raio — sem coordenada a revenda existe no Portal mas "some" do mapa/raio do Motor. Toda escrita nessa tabela deve passar por `geocodeCep(cep, {cidade, estado})` (`src/services/geocode.service.js`: BrasilAPI → Nominatim por cidade/UF). Caminhos que gravam e já geocodificam: `POST/PATCH /admin/revendas-bmax` (Gestão) e criação de usuário revenda (`users.controller.js`). Caso MAQSOLDAS (07/10/2026): o fluxo de criar usuário gravava CEP mas não coordenada. Conferência: `GET /admin/revendas-bmax/espelhamento` (sem coordenada, sem CEP, sem CNPJ) e `POST /admin/revendas-bmax/geocodificar-pendentes` (lote de 15), ambos acionados pelo botão **Verificar Motor** em Gestão → Revendas.

**Upsert via REST — armadilha recorrente:** `Prefer: resolution=merge-duplicates` sozinho não basta, precisa de `?on_conflict=<coluna>` na URL. Pior: um `PATCH` filtrado por chave que não acha nenhuma linha devolve `200 OK` com array vazio — **não lança erro**. Um padrão comum no código antigo era `PATCH(...).catch(() => POST(...))` pra "criar se não existir" — isso nunca funcionava pra registro genuinamente novo, porque o `.catch()` nunca disparava. Já corrigido em `saveSnapshot` (app.js), criação de representante (`admin.routes.js`) e no espelho legado — mas **auditar qualquer upsert novo antes de copiar o padrão antigo de algum lugar não revisado**.

## 5. RD Station CRM V1 — integração

- Todas as escritas do Portal usam **um único token de integração** (`RD_CRM_TOKEN`), não OAuth por usuário — o RD não distingue quem no Portal disparou a chamada.
- Pipeline principal: **Indústria Interno** (`66151c1470449b000d54e914`). Existe também o pipeline **BMax** (`6a2bff35a294cf00226dd600`) — usado só no fechamento final (Vendido/Perdido). **Nunca mover um lead pendente pra esse pipeline por engano**: o dashboard do Portal só busca deals do pipeline Indústria Interno, então mover pra qualquer outro faz o card desaparecer do painel pra sempre, mesmo que o RD continue "correto" por fora. Isso já aconteceu e foi corrigido em 16-17/09/2026.
- **Anotações do RD não funcionam** — nem leitura (`GET /annotations?deal_id=`) nem escrita (`POST /deals/:id/annotations`, `/annotations`, `/deals/:id/notes`, `/notes` — todos 404). O mecanismo real pra "deixar um registro" num deal é **Tarefa** (`createTask()`), que funciona normalmente.
- Campo `REVENDA/LOJA` e `REPRESENTANTE` são picklists estritos (`allow_new:false`) — o RD aceita a chamada mas descarta silenciosamente qualquer valor fora da lista de opções. Por isso o picklist precisa ser sincronizado (`syncRevendasToRD`/`syncRepresentantesToRD`) **antes** de tentar gravar um nome novo em qualquer deal, ou a escrita simplesmente não persiste.
- IDs de custom field principais: `CNPJ=66549f56`, `ESTADO=67407ad5`, `CIDADE=69de7c5f`, `REPRESENTANTE=687562da` (label real tem espaço no fim: `"REPRESENTANTE "`), `REVENDA/LOJA=69a19ce3`, `MÁQUINA=69a1eaa6`, `PERFIL PCI=6a3ae566`, `SEGMENTO DE PRODUTO=6aa346e64ea34c002966dda8` (obrigatório pra aceitar a etapa Negociação — sempre "Máquinas" pra PCI12).

## 6. PCI12 — fluxo de caminho duplo

O caso mais complexo do sistema. PCI12 genérico vira um de dois caminhos quando a revenda/representante/adm escolhe no card:

- **PCI 12a = BOX>REV** — revenda atende o cliente diretamente. Responsável continua André (pseudo-dono fixo `RD_OWNERS["Revenda"]`).
- **PCI 12b = BOX+REV>IND** — Boxer assume a venda. Responsável = `lerPlanilhaResponsavel(cidade,estado)` (lookup em `src/data/ibge_responsaveis.json`, 10.741 municípios) ou o dono original pré-troca se a cidade não for encontrada.

**Nunca inverter esse mapeamento** (já aconteceu uma vez, 10/08/2026). Os dois caminhos **ficam no mesmo pipeline** (Indústria Interno), só mudam de etapa pra "Negociação" — nunca mudam de funil (ver seção 5).

**Troca automática de responsável (regra de 48 horas úteis):** ao detectar um PCI12 pendente (cron `sync-revenda-rep-rd`, 07h/10h/14h/17h de Brasília desde 14/10/2026), o responsável no RD vira André até a revenda escolher o caminho, ou até 48 **horas úteis** sem resposta (**sábado e domingo não contam**, feriados contam — `src/services/prazoUtil.service.js`). Tracking em `bmax_pci12_tracking`. Cron `pci12-followup` roda nos mesmos 4 horários (uma entrada por horário em `vercel.json`) e manda lembrete às 24h úteis + aplica o 12b às 48h úteis. **Escopo intencional:** só entram no tracking os leads que `getLeads("admin","adm")` retorna (pipeline Indústria Interno, criados a partir de 01/05/2026, excluindo Perdido/Excluído) — o mesmo recorte que aparece pro Portal. Não é bug trocar responsável só desses; leads fora desse recorte não são visíveis/acionáveis pela revenda de qualquer forma.

**Prazos automáticos do PCI12 (regra do André, 08/10/2026):**
- **PCI12 pendente → 48 horas úteis (seg-sex, desde 14/10/2026).** Todo PCI12 de revenda real vira responsável André e entra em `bmax_pci12_tracking` (inclusive o que já nasce com o André como dono: `owner_original_id = ''`). Sem escolha em 48h úteis (cron `pci12-followup`, 4x/dia), `aplicarCaminhoVenda(..., {automatico:true})` aplica o **PCI 12b**: etapa Negociação, responsável = dono anterior ao André (ou planilha por região), tarefa "Prazo de 48h expirou". Lead já vendido/perdido só é "resolvido" (a API recusa caminho em lead finalizado). O card continua visível, sem seletor, com o aviso discreto "Prazo de 48h expirou" (`prazo48hExpirou`) e o cashback segue o 12b. `?dry=1` lista sem escrever. Leads antigos: prazo contado da data de criação (`scripts/backfill-pci12-prazos.js`).
- **PCI12a → 60 dias corridos (fim de semana conta; decisão do André 14/10/2026).** Contados desde que a revenda assumiu (`bmax_pci12a_prazo.assumido_em`; leads antigos: data do log `SELECT_CAMINHO_VENDA`, senão hoje). O 12a **continua no funil Indústria**. Vencido sem venda/perda (cron `pci12a-prazo`, 1x/dia 11h UTC), o lead vai pro **funil BMAX, etapa "Prazo Vencido"** (`RD_STAGE_PERDIDO`), confirmado por leitura do deal. Lead vendido/perdido antes nunca é arquivado. Em Prazo Vencido ele sai do painel e **não bloqueia** nova negociação com o mesmo CNPJ (`dealBloqueiaDuplicata`). `?dry=1` lista sem escrever.
- DDL (aditivo, já aplicado em produção): `scripts/create-pci-prazos-tables.js`.
- **Status x etapa (09/10/2026):** nenhum lead com status final no RD (`win` true/false) pode ficar em etapa de andamento. Causa dos 15 casos achados: a revenda escolhia o caminho (12a/12b) num lead JÁ GANHO e `aplicarCaminhoVenda` o puxava de volta pra Negociação (tarefa "Revenda Autorizou"). Prevenção: a API recusa caminho em lead com `win` final e o card (`fechado`) não mostra seletor nem Vendido/Perdido. Garantia: cron diário `status-x-etapa` (`?dry=1` lista) move ganha → Venda Efetivada (Indústria) / Vendido (BMAX) e perdida → Perdidos|Sem Perfil (Indústria) / Prazo Vencido (BMAX); mover etapa preserva `win`, data de fechamento e valor. Auditoria: `node scripts/auditoria_status_x_etapa.js`.
- **Carteira do representante** é sempre pelo nome do RD (alias): `calcularComissoes` canoniza via `nomeCarteiraRepresentante`. Unificação de carteiras duplicadas: `scripts/unificar-carteira-representante.js <de> <para> --aplicar` (transacional, recalcula `saldo_apos`, faz backup em `scripts/backups/`, não versionado).

**Privacidade do contato do cliente:** nome/telefone só aparecem no drawer do card (e no e-mail) quando `pci === "PCI12A"` — regra que não pode ser esquecida, nunca em outro cenário/PCI. Fonte (`getContatoPrincipal(orgId, dealId, deal)`, corrigido 27/10/2026): 1) `deal.contacts` da listagem; 2) `GET /deals/:id/contacts` (o GET `/deals/:id` e o retorno do PUT NÃO trazem contatos); 3) `GET /organizations/:id` → `contacts`. Deals sem organização vinculada (caso "Departamento Compras") só têm contato nas fontes 1/2 — antes só a org era consultada e o contato sumia do drawer e do e-mail. Telefone formatado `(DD) 9XXXX-XXXX`.

## 6b. Escopo do Portal (o que aparece e o que gera cashback)

**Regra-mãe (André, 08/10/2026): só se calcula cashback de card/lead que é visível no Portal.** Por isso o filtro de escopo mora em `getLeads()` (`rd.leads.service.js`), a fonte única de cards, export, `recalcularComissoes`, `creditar-retroativo` e `getRepRevendas`. Sai do Portal (e não gera cashback) o lead cuja "Máquina de interesse" (a) contém o texto **"consum"** ou (b) cita produto conhecido fora da Tabela de Preços BMax (boxer-sistemas, tabela id=2 "Automação") sem citar nenhuma família BMax. Texto vazio/genérico nunca é escondido. As duas listas (famílias BMax / fora da tabela) ficam em `src/services/escopoBmax.service.js` — único lugar a editar. Créditos já lançados antes da regra **não são estornados** automaticamente. Auditoria: `node scripts/auditoria_escopo_bmax.js`.

**Caminho de venda:** lead em Venda Efetivada, Vendido, Entrega Técnica ou Perdido nunca mostra o seletor "Como deseja atender" (`leads.js`) e `aplicarCaminhoVenda` recusa (400) a definição de caminho nessas etapas.

## 6c. Avisos por WhatsApp (canal só de comunicação — EM PREPARAÇÃO, ainda sem envio)

Decisão do André (14/10/2026): o WhatsApp **não executa nada**; só avisa a revenda e manda o link do Portal. Provedor previsto: **Twilio** (mesma conta do PMA, com número novo exclusivo do BMAX; o número ainda está sendo obtido). Já construído, sem enviar nada:
- `telefone.service.js` (`normalizarCelularBR`): só celular BR (DDD + 9 dígitos) vira E.164.
- Coluna `Revendas.whatsapp_aceite_em` (aceite da revenda, exigência da Meta/LGPD) e tabela `bmax_whatsapp_envios` (dedupe: `UNIQUE(user_id,tipo,chave)`), DDL em `scripts/create-whatsapp-tables.js`.
- `PATCH /admin/users/:id/whatsapp` (celular + aceite, validado, com log) e botão **WhatsApp** na tela Usuários.
- `whatsappResumo.service.js` + `GET /admin/whatsapp/previa` + aba **WhatsApp** em Gestão: prévia do que seria enviado hoje.
Regras da prévia: sem nada a comunicar não sai mensagem; só login de revenda ativa, com celular válido e aceite; texto sem nome de cliente nem % de comissão. Avisos: PCI12 pendente (imediato), resumo diário (leads novos, cashback expirando em 30/15/7 dias, saldo disponível nos dias 1 e 15, lead 12a sem resultado aos 15/30/50 dias, incentivo a nova negociação às segundas se 30 dias sem negociação). **Falta**: provedor de envio (Twilio + modelos aprovados pela Meta), cron de envio com dedupe e preencher/validar os celulares (hoje 3 de 63 logins têm celular válido).

## 6d. Migração RD Station → Pipefy (ATIVA em produção desde 23/11/2026)

Decisão: o Portal fala com o **Pipefy** em vez do RD Station CRM, atrás de
`CRM_PROVIDER` (`pipefy` em produção desde 23/11/2026; `rd` continua sendo o
caminho de código original, religável a qualquer momento sem novo deploy,
se precisar reverter — já foi usado como mitigação de incidente uma vez,
ver abaixo). Guia completo (API, autenticação, limites, exemplos):
`guia_bmax_pipefy.md` (raiz do repo, **não versionado** — `.gitignore`, tem
e-mail de funcionário). Pendências e decisões em aberto:
`PIPEFY_PENDENCIAS.md`.

**Incidente de ativação e cache obrigatório (19-23/11/2026):** a primeira
tentativa de ligar a flag resultou em "0 leads" sem erro visível — causa:
leitura completa de cache frio do pipe principal (CRM BOXER SOLDAS, 7.640+
cards) levava ~94-139s, excedendo `maxDuration: 60` da Vercel (função morta
antes de responder). Resolvido persistindo o cache no banco
(`bmax_pipefy_cache_cards`/`bmax_pipefy_cache_estado`,
`scripts/create-pipefy-cache-tables.js`) e pré-aquecendo-o uma vez, local,
sem limite de tempo (`scripts/pre-aquecer-cache-pipefy.js`, chama
`fetchAllCardsConsultaLeadPipefy()` pros 4 pipes ativos) — a partir daí, a
Vercel sempre encontra o cache já quente e só faz leituras incrementais.
Esse pré-aquecimento **precisa ser repetido manualmente** se o cache do
banco for perdido (nova instância de banco, reset manual) — sem automação
hoje. Detalhes completos em `PIPEFY_PENDENCIAS.md`.

- **Variáveis:** `CRM_PROVIDER` (`rd`|`pipefy`), `PIPEFY_TOKEN` (conta de
  serviço), `PIPEFY_MAPA_JSON` (IDs de pipes/fases/campos/databases, num
  JSON só — gerado por `node scripts/gerar-pipefy-mapa-env.js` a partir de
  um `mapa_pipefy.json` local; em produção é a única fonte, já que o
  arquivo não versiona), `PIPEFY_CACHE_MIN` (padrão 30), `PIPEFY_PIPES_PORTAL`
  (padrão `INDÚSTRIA - INTERNO` — quais pipes alimentam `getLeads`; é o
  único funil que o painel RD lê hoje, `fetchAllDealsFromRD`/
  `RD_PIPELINE_INDUSTRIA`).
- **Escopo migrado** (funciona com a flag ligada): listar leads, criar
  negociação (em `INDÚSTRIA - INTERNO` ou `BMAX`, mesma regra de funil do
  RD), gravar etapa/campos/valor/responsável, checar duplicata por CNPJ (nos
  2 pipes onde a criação pode cair), tarefa/nota (viram comentário no
  card), `getDealById` (com resolução de ID do RD ↔ card do Pipefy),
  renomear/reatribuir representante e revenda (`findCardsByFieldValue` +
  `updatePhaseField` + `updateFieldEmVariosCards`, pipes BMAX e, pras de
  revenda, também `REVENDA - INTERNO`).
- **Tradução card→deal:** `pipefyLeads.service.js` (`cardParaDealFake`)
  traduz cada card do Pipefy pro mesmo formato de objeto que
  `getCustomField`/`mapDealToCard`/cálculo de cashback já leem — nenhuma
  dessas funções precisa saber que existe Pipefy. Nome da fase → etapa do
  RD e `win` vêm de uma tabela explícita por pipe
  (`PIPEFY_FASE_PARA_ETAPA_RD`, `pipefyConstants.js`), confirmada direto no
  código pros pipes `BMAX` e `INDÚSTRIA - INTERNO` (ver comentário lá); pipe
  adicionado via `PIPEFY_PIPES_PORTAL` sem entrada nessa tabela fica com
  `deal_stage.id = null` (avisado em log, não quebra).
- **Cache e limite de chamadas:** Pipefy Enterprise tem **10 mil
  chamadas/mês pra empresa inteira** (compartilhado com migração e
  integração n8n). Com o painel lendo `INDÚSTRIA - INTERNO` (~850 cards),
  uma releitura completa a cada `PIPEFY_CACHE_MIN` estouraria o limite
  sozinha — por isso o cache por pipe (`pipefyLeads.service.js`) só faz
  **leitura completa** no primeiro uso e 1x/dia; entre uma e outra, faz
  **leitura incremental** (`allCardsAtualizadosDesde`, filtro
  `updated_at gt <referência>` — **testado e confirmado na conta real,
  20/10/2026**; cai pra completa sozinha se falhar mesmo assim). A
  referência é o maior `updated_at` já visto no cache (não o relógio local,
  pra não perder alterações por diferença de fuso/relógio com o Pipefy).
  Gravação do próprio BMAX atualiza só o card alterado
  (`atualizarCardNoCache`), sem forçar releitura do pipe inteiro. A checagem
  de duplicidade por CNPJ, quando não acha no cache, força uma releitura
  INCREMENTAL (não completa — 23/10/2026, 2º adendo) antes de concluir que
  não há duplicata. `pipefyFetch` conta chamadas por dia em log
  (`logger.debug`, só a 1ª do dia e a cada 50 sobem pra `info`) — o limite
  real precisa ser acompanhado no painel do Pipefy. O cache também persiste
  em `bmax_pipefy_cache_cards`/`bmax_pipefy_cache_estado` (DDL:
  `scripts/create-pipefy-cache-tables.js`, 2º adendo): uma instância nova da
  Vercel carrega do banco antes de chamar o Pipefy, em vez de sempre começar
  com leitura completa — best-effort, nunca derruba o painel se o banco
  falhar. Gravação em lotes de 100 cards por consulta (3º adendo,
  23/10/2026 — uma consulta por card arriscava estourar o tempo-limite da
  função na Vercel numa leitura completa de ~850 cards). Uma leitura
  completa de RESERVA (quando a incremental falha) substitui a lista em
  cache, não soma a ela, e um card apagado some tanto da memória quanto do
  banco (mesmo adendo).
- **`bmax_rd_pipefy_map`** (DDL: `scripts/create-rd-pipefy-map-table.js`):
  correspondência `rd_deal_id ↔ pipefy_card_id`, usada por `resolverCardId`
  (que busca em todos os pipes do painel + BMAX, não só BMAX — 2º adendo) e
  `getDealById` (traduz pela tabela do pipe DO CARD, não sempre BMAX) —
  importada em massa depois da carga real via
  `scripts/importar-mapa-rd-pipefy.js <csv>`, ou preenchida sob demanda (1
  busca por negociação, `findCardByRdId`).
- **Bloqueado de propósito:** toda escrita no RD ainda não migrada (sync de
  picklist revenda/representante — `syncRevendasToRD`/
  `syncRepresentantesToRD` —, `createOrg`) lança erro explícito com a flag
  ligada, em vez de gravar em silêncio — ver `exigirProviderRd`
  (`rd.leads.service.js`) e a tabela completa em `PIPEFY_PENDENCIAS.md`.
- **Transferência BOX+REV>IND entre pipes** (Tarefa B1, 3º adendo, decisão
  tomada 26/10/2026): o caminho de venda "BOX+REV>IND" (`aplicarCaminhoVenda`,
  `caminhoVenda.service.js`) pede a etapa "Negociação" pra um card do
  BMAX — que não existe nesse pipe (só no INDÚSTRIA - INTERNO, "NEGOCIAÇÃO").
  Como o Pipefy não move card entre pipes, `updateLeadPipefy`
  (`transferirCardParaIndustria`, `pipefyLeads.service.js`) cria um card NOVO
  lá (copiando os campos comuns, PCI sempre preenchido, valor/data
  convertidos do formato BR do Pipefy), comenta a ligação nos dois cards,
  copia o responsável, move o de origem pra uma fase final própria do BMAX
  ("Transferido para a Indústria", fora do painel e da checagem de
  duplicidade) e grava a ligação em `bmax_pipefy_transferencias` (DDL:
  `scripts/create-pipefy-transferencias-table.js`). `resolverCardId` segue
  essa ligação (até o card vivo, em cadeia se precisar) depois de resolver um
  ID do RD — tabelas do BMAX que guardam o ID antigo continuam funcionando
  sem migração. Falha na criação do card novo aborta tudo (erro sobe); falha
  nas etapas seguintes só loga com os dois IDs, pra correção à mão.
- **Script de conferência** (`scripts/conferir-pipefy.js <id-do-card>`, 3º
  adendo): só leitura (1 chamada), imprime pipe/fase, o valor BRUTO das
  datas/valores que o Pipefy devolve e o resultado de
  `paraDataIso`/`parseValorMonetario`/`cardParaDealFake` — pra confirmar o
  formato real num card migrado antes da virada.
- **Confirmado na conta real em 26/10/2026** (3º adendo, seção 3): campos de
  data voltam como `DD/MM/AAAA` (ex.: `12/05/2026`) e os de moeda em formato
  BR (ex.: `1.234,56`), mesmo quando gravados como `2026-05-12`/`1234.56` —
  `paraDataIso`/`parseValorMonetario` já cobrem isso; troca de responsável
  (`updateCardAssignees`, `updateCard` com `assignee_ids`) funciona;
  `updatePhaseField` com `options` **substitui a lista inteira** de opções do
  campo (mandar a lista completa — antigas + nova — mantém todas e não muda
  o campo de obrigatório↔opcional; as 3 rotinas de renomear já fazem isso);
  `findCards` aceita a paginação (`first`/`after`) normalmente. Também
  confirmado (correção na transferência BOX+REV>IND, mesma data): um campo
  de CONEXÃO (ex.: "Contato", "Empresa") devolve em `value` os TÍTULOS dos
  registros ligados, não os IDs — os IDs de verdade vêm de
  `array_value`/`connectedRepoItems[].id` (ver `getCard`, `pipefy.service.js`).
- **Em produção desde 23-24/11/2026**: `PIPEFY_MAPA_JSON`/token de serviço,
  tabelas do cache (`scripts/create-pipefy-cache-tables.js`, já
  pré-aquecidas), `bmax_rd_pipefy_map`/`bmax_pipefy_transferencias`
  (`scripts/create-rd-pipefy-map-table.js`/
  `scripts/create-pipefy-transferencias-table.js`) e `CRM_PROVIDER=pipefy`
  ativo. Sincronismo de revenda/representante e Consulta de Lead do Motor
  também migrados (Fases 6 e 7, 19/11/2026 — ver "Migrada" em
  `PIPEFY_PENDENCIAS.md`). Campos "Data de fechamento no RD"/"Motivo de
  perda" já existem no mapa; `closed_at` já é lido a partir do primeiro
  (23/11/2026 — ver "Corte de data" em `PIPEFY_PENDENCIAS.md`); "Motivo de
  perda" ainda sem nenhum consumidor no código. **Ainda em aberto**
  (registrado em `PIPEFY_PENDENCIAS.md`): estender as 3 rotinas de renomear
  pro CRM BOXER SOLDAS.

## 7. Cashback e comissão

- **Cálculo:** PCI + classe de preço + tipo de agente → percentual em `comercial_bmax_config` (chave `comissao_tabela`, mesma fonte do Motor; linhas `{pci, agente, valores[classe 1..6]}`, agentes `Revenda`, `Rep`, `RepExcecao`, `VI/VT`) → multiplica pelo `amount_total` do deal. O robô considera deals em Venda Efetivada, Vendido ou Entrega Técnica com valor > 0. **A revenda só recebe nos PCI 6, 9, 12b, 13, 14 e 15** (`REVENDA_RECEBE_COMISSAO`, `visibilidadePci.service.js`); PCI12A, PCI16 e PCI X nunca geram comissão (`PCI_SEM_COMISSAO`). Para a revenda o percentual varia por classe só nos PCI 13/14/15; o Vendedor Interno/Técnico varia por classe em todos os PCIs com comissão. Não existe campo `por_classe`: a própria matriz guarda o valor de cada classe. Falta PCI ou Classe de Preço = não credita (`faltando`). *(Revisado contra o código em 25/11/2026.)*
- **Três tipos de agente creditado por venda:** `revenda`, `representante`, `vendedor_interno` — cada um com seu próprio saldo em `bmax_saldo`/`bmax_transacoes` (`tipo_agente`). A carteira é sempre pelo nome único (`nomeUnico`): loja de grupo credita na carteira do grupo.
- **Cron `recalcular-comissoes`** (4x/dia): reconcilia o saldo real contra o que a regra de comissão diz que deveria estar creditado agora, pra toda venda efetivada — idempotente, só lança a diferença; a rotina aceita `{ dryRun: true }` (simulação). Endpoints manuais (admin): `POST /api/cashback/recalcular` e `POST /api/cashback/creditar-retroativo`.
- **"Sem Revenda" nunca recebe crédito de revenda** (fix 21/09/2026) — é um valor legítimo pra dado (venda direta, sem parceira), mas não é uma conta que existe pra receber comissão. Constante `REVENDA_SEM_CREDITO` (`constants.js`) usada nos pontos de crédito/agregação — nunca na validação de dado, onde "Sem Revenda" continua opção normal.
- **O card nunca mostra estimativa (regra do André, 25/11/2026).** Revenda, admin e representante veem no card só o que já foi creditado no razão (`creditosMap` para a revenda, `creditosRepMap` para o representante). Venda concluída e ainda não creditada mostra "a creditar" (`cashbackPendente`); falta PCI/Classe mostra dados pendentes (`cashbackFaltando`). O "Cashback Total" do admin é o saldo do razão, igual ao extrato e à tela da revenda (fonte única, ver "Coerência de números" no Registro de 23–25/11). O saldo real do representante existe (`tipo_agente='representante'`, alimentado pelo mesmo robô) e aparece no Extrato de Comissões do admin; *não reconferido em 25/11 se alguma tela do próprio representante mostra o saldo dele.*
- **Créditos da revenda expiram em 180 dias**; comissão de representante e vendedor interno não expira. Cheques (saque aprovado) valem 30 dias. Cron `expirar-cashback` diário processa expirados e avisa 30/15 dias antes (só créditos de revenda).
- **A proteção contra crédito duplicado está no robô, não em `creditarCashback`:** `recalcularComissoes` soma, por lead+agente, os créditos já lançados sob o id do Pipefy E sob o `rd_deal_id` e só lança a diferença (a falta dessa regra gerou os R$ 114.616,97 duplicados de 24/11). `creditarCashback` em si continua sem dedup: quem o chamar direto pode duplicar.

## 8. Bugs de infraestrutura já encontrados e corrigidos (histórico útil pra não repetir)

- **Tabela `RevendaFiliais` nunca existia** em produção (21/09/2026) — bloqueava a criação de qualquer revenda nova (não só filiais), porque toda revenda nova cria uma "filial principal" dentro da mesma transação Sequelize. Se aparecer `relation "X" does not exist` em produção, checar se a tabela foi realmente criada — não existe pipeline de migration automática nesse projeto (sem sequelize-cli, sem pasta `migrations/`); tabelas novas em `src/models/` precisam de `CREATE TABLE` manual em produção.
- **`public/js/*.js` são referenciados com `?v=N`** em `index.html` — editar o JS sem subir o `N` faz o navegador continuar servindo a versão cacheada antiga, mesmo com o arquivo novo já publicado (já causou "corrigi mas não aparece" 2x). Sempre bumpar no mesmo commit.
- **`git push origin main` dispara deploy automático em produção** (integração GitHub↔Vercel) — não existe "só commitar local com segurança"; qualquer push posterior leva junto todo commit ainda não enviado, mesmo commits que não deveriam ir ao ar ainda.
- **Filtro de revenda multi-loja no frontend** (`leads.js`) chegou a refiltrar `API_LEADS` por igualdade exata de nome, duplicando (mal) o que o backend já faz certo via `bmax_grupos` — só "funcionava" pra Luitex por um hack de substring hardcoded. Removido; o backend já entrega a lista certa pro papel `revenda`, o front não deveria refiltrar de novo.
- **Cache do Pipefy no banco e a leitura completa de ~139 s (25/11/2026)** — a leitura completa do pipe CRM BOXER SOLDAS (~7.700 cards) leva ~139 s e a Vercel mata a função em 60 s. Quando a consulta ao Pipefy ganhou o campo de etiquetas e o painel passou a filtrar por "RD: Indústria", o cache antigo não tinha etiquetas e o painel ficou com 0 leads por horas, sem erro visível. Regra: ao mudar a consulta (`CAMPOS_CARD_LISTAGEM`) ou filtrar por campo novo, refazer o cache (`bmax_pipefy_cache_cards`/`bmax_pipefy_cache_estado`) localmente com o token de administrador, ANTES de publicar, e depois fazer um deploy para reiniciar as instâncias. Detalhe no `.claude/memory/feedback_bmax_cache_pipefy_preaquecer.md`.
- **`resend.service.js` é código morto** — duplica `email.service.js` quase byte a byte, nunca é importado em lugar nenhum. Candidato a remoção numa limpeza futura.
- **E-mails de "Nova Negociação"** (`negociacao.service.js`) ainda usam `getRepresentativeEmailByName()` puro, sem o fallback `rdToEmail` que foi adicionado em 17/09/2026 pros e-mails de caminho PCI12 — mesma classe de bug (username hoje é e-mail, não nome) pode estar afetando esse fluxo também; não verificado/corrigido ainda.

## 8b. Orçamentos anexados à Nova Negociação (14/10/2026)

De 1 a 3 arquivos por negociação (PDF, PNG/JPG, Word, Excel; 10 MB cada), campo "Orçamento" do formulário — **obrigatório para todos os perfis** (adm, representante, revenda; regra imposta em `createNegociacao`, no servidor, além da tela). **Não usa a API v2 do RD** (anexo na aba "Arquivos" só existe na v2, que exige OAuth com refresh token rotativo — por isso o Portal saiu da v2): o card recebe UMA nota (`POST /activities`, texto sem acento) com links fixos do Portal.

| Peça | Detalhe |
|---|---|
| Tabela `bmax_orcamentos` (Postgres boxer-bmax) | `token` (192 bits, UNIQUE), `user_id`, `nome_arquivo`, `caminho`, `status` (`pendente`→`anexado`), `negociacao_id`, `deal_id`, `nota_rd_em`, `revogado_em`, `aberturas`. DDL: `scripts/create-orcamentos.js` (também cria o bucket) |
| Bucket `bmax-orcamentos` (Storage do Supabase boxer-sistemas) | privado, 10 MB; upload direto do navegador por URL assinada (`POST /api/negociacoes/orcamento-upload-url`) — não passa pelo limite de 4,5 MB da Vercel |
| Link fixo `GET /api/orcamento/:token` | **sem login** (quem abre é o time Boxer no RD), nunca expira, revogável (`revogado_em`), conta aberturas; redireciona para URL temporária (5 min) do Storage; rate limit 60/15 min por IP |
| Falha na nota | negociação não falha: arquivo fica vinculado e o cron `sync-revenda-rep-rd` reenvia (`reenviarNotasPendentes`) |
| Limpeza | uploads `pendente` com mais de 3 dias são apagados de forma preguiçosa ao emitir novo upload (sem cron novo) |

Código: `src/services/orcamento.service.js`; `createNote` em `rd.leads.service.js`; CSP `connectSrc` libera o domínio do Supabase em `src/app.js`.

## 9. Crons (Vercel, `vercel.json`)

| Rota | Horário (UTC) | Faz |
|---|---|---|
| `/api/cron/expirar-cashback` | 10:00 (1x/dia) | Processa créditos/cheques expirados, avisa 30/15 dias antes |
| `/api/cron/sync-revenda-rep-rd` | 10:00, 13:00, 17:00, 20:00 (= 07h, 10h, 14h, 17h Brasília, desde 14/10/2026) | Sincroniza picklists RD, detecta PCI12 novo (troca responsável p/ André, avisa + inicia tracking 48h úteis); varre leads em aberto com revenda sem login e avisa o admin (1x por lead); reenvia notas de orçamento pendentes |
| `/api/cron/sync-consulta-lead` | 12:00, 17:00, 21:00 | Pré-computa índice de "Consulta de Lead" (evita timeout de 60s calculando na hora) |
| `/api/cron/recalcular-comissoes` | 12:00, 15:00, 18:00, 21:00 | Reconcilia saldo real vs regra de comissão atual |
| `/api/cron/pci12-followup` | 10:00, 13:00, 17:00, 20:00 (= 07h, 10h, 14h, 17h Brasília, desde 14/10/2026) | Lembrete 24h úteis + 12b automático 48h úteis dos PCI12 pendentes — NÃO conta prazo de card cuja revenda não tem login (zera o relógio) |
| `/api/cron/auditor?rodada=manha` | 09:00 (= 06h Brasília, desde 25/11/2026) | Auditor diário: roda as checagens, grava achados e avisa o André por e-mail só quando há achado novo. NUNCA corrige nada (ver seção "Auditor diário") |
| `/api/cron/auditor?rodada=tarde` | 16:00 (= 13h Brasília, desde 25/11/2026) | Segunda rodada do auditor diário |

**Prazos sem fim de semana (14/10/2026):** os prazos de 24h/48h do PCI12 pendente contam só segunda a sexta (horário de Brasília), via `src/services/prazoUtil.service.js` (`horasUteisEntre`). Sábado e domingo não contam; **feriados não são descontados**. O prazo de 60 dias do PCI12a **continua em dias corridos**. `detectado_em`/`assumido_em` são `timestamp without time zone` gravados em UTC pelo `now()` do Postgres e lidos em UTC pela Vercel — ao rodar scripts locais em UTC-3 o valor lido aparece 3h adiantado (só leitura local; use `TZ=UTC`).

Todas autenticadas via header `Authorization: Bearer <CRON_SECRET>`. Vercel Hobby só permite 1 `schedule` por entrada rodando 1x/dia — múltiplos horários no mesmo cron = múltiplas entradas em `vercel.json`, não uma única com "várias vezes ao dia". **O horário no Hobby é impreciso:** o cron dispara em qualquer momento dentro da hora programada (observado: 11:00 UTC rodando às 11:57) e, em 25/11/2026, algumas chamadas das 11h-13h UTC não aconteceram. Por isso o auditor trata rodada ausente como achado. **Em 26/11/2026 a Vercel pulou também a rodada da manhã do auditor e quase todos os robôs entre 21:30 UTC de 25/11 e 12:28 UTC de 26/11, e o plano foi mudado para Pro** (cron no minuto agendado; `maxDuration` pode subir até 300 s). Falta confirmar a pontualidade dos crons depois da troca; se os crons registrados continuarem atrasados, um deploy (mesmo vazio) registra tudo de novo. Para ver o que a Vercel registrou: `MSYS_NO_PATHCONV=1 vercel api "/v9/projects/boxer-portal-bmax" --raw --scope boxer-soldas1` (campo `crons`).

## 10. Papel no ecossistema BMax

- **RD Station CRM V1** — fonte de verdade dos deals/leads.
- **BMax Motor** (`bmax-motor`, ver `DOCUMENTACAO_TECNICA.md` de lá) — classifica leads nos 16 PCIs, calcula a tabela de comissão que o Portal lê via `comercial_bmax_config`. Compartilha o Supabase `boxer-sistemas` com o Portal, mas é um app separado (Supabase Auth, hospedagem própria).
- **Política Comercial / Bíblia Mestra** — definem as regras de negócio que o código aqui implementa.

## 11. Nova Negociação: PCI, roteamento e travas (27–28/10/2026)

**Nova Negociação da revenda: PCI por produto + quem atende (28/10/2026, caso MAQSOLDAS):** lead TRAZIDO PELA REVENDA tem PCI fixo pela regra do projeto, pelo produto escolhido (`PCI_POR_SEGMENTO` em `constants.js`: Máquinas=PCI 15, Laser=PCI 14, Robô=PCI 13) e esse PCI nunca vira 12a/12b (12a/12b é só lead enviado PELA Boxer à revenda, fluxo "Como deseja atender este lead?"). O formulário pede 3 coisas: **Produto** (grava também o campo SEGMENTO DE PRODUTO no RD), **Caminho de Venda** (BOX>REV revenda vende / BOX+REV>IND Boxer vende e paga comissão) e, quando a Boxer vende, **Quem atende o cliente?** (revenda | vendedor Boxer). Roteamento (`encaminharLeadDaRevenda` em `caminhoVenda.service.js`): atende = revenda → o card fica no funil BMAX (etapa Assumido, dono "Revenda"), NÃO vai para vendedor Boxer, tarefa "Revenda conduz o atendimento"; atende = Boxer → vai para Negociação (Indústria) com o vendedor da região (planilha; confere ANTES de criar o card) e tarefa "Revenda Autorizou". O caminho só decide o destino, nunca o PCI. O representante da revenda é preenchido automaticamente pelo cadastro (`resolverRepresentanteDaRevenda`, nome do RD via alias). Playbook da revenda atualizado (2 páginas). **Representante/Admin (mesmo dia):** o campo "Funil" foi REMOVIDO do formulário e substituído pelas mesmas perguntas (produto, caminho, quem atende), com os mesmos caminhos: revenda atende → card no BMAX com dono "Revenda" (Responsável não é pedido); Boxer atende → vai para Negociação (Indústria) com o Responsável escolhido no formulário. O PCI continua escolhido à mão; 13/14/15 travam o produto (Robô/Laser/Máquinas) e o servidor recusa PCI × produto divergentes. Exceção: PCI 12/12a/12b (lead enviado pela Boxer à revenda) não faz as perguntas e nasce no funil Indústria Interno, seguindo o fluxo do PCI12 (a revenda decide depois). O funil é decidido só no servidor (`createNegociacao`), nunca pelo navegador.

**Contato do cliente obrigatório (30/10/2026):** os cards criados por Nova Negociação nasciam SEM contato no RD (o `createLead` só criava organização + deal e o formulário não pedia nada). Agora, para revenda, representante e admin, o formulário exige **Nome do Contato** e **Telefone com DDD** (10–11 números; E-mail opcional, validado se preenchido). `validarContatoLead` roda no servidor ANTES de criar o card; após o deal, `criarContatoDoLead` faz `POST /contacts` com `deal_ids` (padrão do GVX; fallback `POST /deals/:id/contacts`) — o contato aparece no painel "Contatos" do card e é lido por `getContatoPrincipal`. Se o RD recusar o contato, o card é mantido, os dados vão numa nota (sem acento) e a resposta traz `avisos`. Não há coluna nova no Postgres (o RD é a fonte). Cards antigos não foram corrigidos (decisão do André: só os próximos). Teste: `scripts/teste-contato-lead-30-10-2026.js` (card testeSC, contato de teste ficou lá).

**Trava de duplicidade na Nova Negociação (28/10/2026, caso CARTHOMS):** o mesmo cliente entrou 2x (BMAX por Victor em 13/10 com CNPJ válido; Indústria por Luitex em 14/10 com CNPJ digitado errado, dígitos trocados) porque a trava só comparava o CNPJ como texto exato. Agora, em todos os perfis: (1) `cnpjValido` (dígito verificador) no navegador e no servidor — CNPJ inválido é recusado; (2) `getLeadDuplicadoPorNome`: lead ativo (qualquer funil) com o mesmo nome (ignorando espaço/pontuação, ≥8 caracteres) NA MESMA CIDADE bloqueia o cadastro com a indicação do lead existente. A varredura de 28/10 achou, fora testes, 4 pares de cards com o mesmo CNPJ (Tecnoservice, Gascat, Asmontec/Departamento Compras, Volt Energia) criados antes dessa trava e CNPJs inválidos (Mecalor truncado) — limpeza manual pendente.

**Filiais (mesma empresa) — Portal e Motor (28/10/2026):** `analisarUnidadesDaEmpresa` lista leads ativos com a mesma raiz de CNPJ (8 dígitos) e CNPJ diferente, marcando `mesmaCidade`. Nova Negociação: unidade na mesma cidade NÃO bloqueia (filiais são legítimas), mas grava nota ATENCAO no card e a resposta da criação traz `avisos` (o formulário mostra aviso de 12s). Motor: a consulta por CNPJ devolve `cnpjInvalido`, `unidades` e `cidadeConsultada` (BrasilAPI, 3s, opcional) e o Motor destaca unidade na mesma cidade (ver DOCUMENTACAO_TECNICA do Motor). Filiais em outras cidades aparecem só como informação.

**Decisão do André (28/10/2026) sobre CNPJ repetido:** continua valendo o conceito atual — o Portal BLOQUEIA CNPJ repetido (e CNPJ inválido, e nome igual na mesma cidade). A ideia de "dono do cliente com várias negociações" ficou só como melhoria futura.

**Portal não mostra cards em etapa perdido/excluído:** `getLeads()` exclui `RD_STAGE_EXCLUIDO` (Indústria "PERDIDOS | SEM PERFIL") e `RD_STAGE_PERDIDO` (BMAX, hoje "Prazo Vencido") para todos os perfis. Fechar um duplicado = mover para essas etapas (a API não marca a etiqueta "Perdida" — `win` — e o cron `status-x-etapa` só corrige o sentido ganha/perdida → etapa).

## 12. Revendas, logins e nomes únicos (27–28/10/2026)

**Revenda + login juntos e nome único (28/10/2026):** em Gestão → Revendas BMax → Nova Revenda, a caixa "Criar também o login" (marcada por padrão) cria no mesmo passo: cadastro (`comercial_revendas_bmax`, com `nome_rd` sempre preenchido), login (`Users` role revenda, usuário = e-mail em minúsculas, senha inicial = parte antes do @), `Revendas` (name = nome no RD) + filial principal, vínculo `user_id` no cadastro, acesso ao Motor (Supabase Auth) e sincronização do picklist REVENDA/LOJA do RD (`services/revendaLogin.service.js`, `POST /admin/revendas-bmax` com `criar_login`). Valida tudo antes de gravar (e-mail, CNPJ 14 dígitos, CEP 8, cidade/UF, e-mail e CNPJ ainda sem login). Credenciais por e-mail só se marcado. **Nome no RD único:** POST/PATCH recusam nome (nome_rd, senão nome) já usado por outra revenda ATIVA. Limitação conhecida: `Revendas.cnpj` é UNIQUE no Postgres, então um 2º login para a mesma revenda ainda não é possível (modelo de revenda com código único, em planejamento). `GET /admin/revendas-rd?simples=1` devolve só a lista do RD (o modal Editar Revenda não varre mais todos os leads).

**Lead com revenda sem login (28/10/2026, caso Heitor/Suprimig):** `revendaVinculo.service.js` decide se um nome de REVENDA/LOJA do RD é "vinculado" (algum login do Portal o enxerga via `Revendas.name` ou `bmax_grupos`). (1) `pci12-followup`: se o nome do card não tem login, o prazo de 24h/48h NÃO conta (`detectado_em` é zerado a cada rodada) e o card sai em `resultado.semVinculo`; (2) `sync-revenda-rep-rd`: varre leads em aberto sem login e envia e-mail 1x por lead ao admin (`EMAIL_FALLBACK` ou André; snapshot `leads_sem_login_avisados`); (3) painel admin: alerta "Revenda sem login" (`revendaSemLogin` em cada card; `leads.js`) e o alerta "Sem revenda" agora inclui o valor literal "Sem Revenda". Causa raiz: o RD tem nomes duplicados da mesma revenda (nome do ZEN × nome curto); a consolidação de nomes (planilha de agrupamento) elimina a duplicidade.

**Nome do representante no RD:** o REPRESENTANTE tem dois nomes para o mesmo representante (Victor: "Victor Lantyer" = 212 cards e "Victor VLM" = 175, em 28/10). Os dois aparecem no painel dele (`loginToNomes`), mas carteira/relatórios por nome ficam divididos — consolidar em um nome. Hoje `resolverRepresentanteDaRevenda` grava o ALIAS do cadastro (`rd_alias`).

**Modelo em planejamento (revenda com código único):** revenda/grupo com código único juntando lojas (CNPJs), logins e representantes ligados pelo código — ver `project_bmax_modelo_revenda_grupo` na memória e as planilhas `Documentação/Proposta_agrupamento_revendas*.xlsx`. Ordem: consolidar nomes → login por código (resolve o UNIQUE de `Revendas.cnpj`) → representante com múltipla escolha.

## 13. Telas: login e barra do topo

**"Esqueci minha senha" (tela de login, 27/10/2026):** link abaixo do formulário abre caixa para usuário/e-mail e chama `POST /api/auth/forgot-password` (rate limit próprio); o endpoint avisa por e-mail todos os admins e responde sempre a mesma mensagem genérica (não revela se o usuário existe). O texto digitado agora é escapado no HTML do e-mail (antes entrava cru) e o assunto não aceita quebra de linha.

**Ícone "Regras e cashback" (barra do topo, 27/10/2026):** botão ⓘ ao lado de "Gestão/Sair", visível após login para todos os perfis; abre modal estático (`#regrasOverlay` em `index.html`, lógica em `app.js`) com % de cashback por PCI (lead da revenda: PCI13 1,5–4,0%, PCI14 1,7–4,0%, PCI15 3,0–5,0%; lead da Boxer: PCI6 1,5%, PCI9/12B 2,0%), regras essenciais (60 dias, 48h úteis, 30 dias, cashback após faturamento), decisão do PCI12 e passos da revenda. Valores digitados no HTML (vêm dos slides da Imersão BMAX) — se a tabela `comissao_tabela` mudar, atualizar o modal.

## 14. Auditoria, logs e scripts de manutenção

**Robô de 48h nunca sobrescreve escolha de caminho (3/11/2026, caso Telha Fabrica):** em 08/10 a escolha BOX>REV (12a) foi gravada na auditoria (`SELECT_CAMINHO_VENDA`) e o RD devolveu PCI 12a, mas o PCI do card voltou a "PCI 12" por causa desconhecida (a API do RD não mostra autor de edição; ver Histórico do card no RD). O cron `pci12-followup` só reconhece resposta pelo PCI atual, então às 14:29 aplicou 12b automático por cima. Correções: (1) o cron consulta `buscarEscolhaCaminhoNaAuditoria` antes de aplicar o 12b — se já há escolha com sucesso, NÃO aplica e lista o deal em `escolhaPreservada` (resposta do cron + log warn), mantendo o rastreamento aberto para o admin conferir; (2) em `aplicarCaminhoVenda` o `updateLead` agora roda ANTES de criar a tarefa (RD recusando o update não deixa tarefa "Revenda Assumiu" órfã). Card corrigido por `scripts/corrigir-telha-fabrica-3-11-2026.js` (PCI 12a, dono "Revenda", tarefa de 48h encerrada, prazo 60 dias registrado; backup em scripts/backups). Varredura `scripts/diag-padrao-12a-sobrescrito-30-11.js`: único caso (os 12 outros 12b automáticos não têm escolha na auditoria). Nota: datas gravadas no Postgres (AuditLogs/tracking) estão +3h em relação ao horário real.

- **Quem fez o quê:** tabela `AuditLogs` (usuário, perfil, ação, entidade, IP, metadata) — ex.: `CREATE_NEGOCIACAO`, `SELECT_CAMINHO_VENDA`, `UPDATE_RESULTADO_LEAD`, `VIEW_CONTATO_CLIENTE`, `LOGIN_*` — cruzada com a tabela `Negociacoes` (CNPJ como foi digitado) e com tarefas/notas do RD. Ações feitas direto no RD (ex.: editar campo) NÃO ficam em nenhum log e a API v1 não expõe o histórico de campo.
- **Logs da Vercel** guardam ~1h; o nível "error" no CLI costuma ser ruído (aviso DEP0169 no stderr com status 200). Para saber se um robô rodou, olhe o efeito no banco (`bmax_pci12_tracking`, `bmax_pci12a_prazo`) — as execuções de 16–27/10 confirmaram 07h/10h/14h/17h Brasília (com atraso de minutos, plano Hobby).
- **RD v1:** não apaga deals; recusa (422) alteração se faltar campo obrigatório da etapa (ex.: ESTADO, CLASSE DE PREÇO, SEGMENTO DE PRODUTO em etapas finais) e, por isso, cards perdidos antigos sem esses campos não aceitam edição pela API.
- **Scripts de 27–28/10 (todos com simulação por padrão e `--aplicar`; backups em `scripts/backups/`, não versionado):** `ativar-brasolda-trianorte-27-10-2026.js`, `criar-login-ultra-maquinas-28-10-2026.js`, `corrigir-pci12-sem-vinculo-28-10-2026.js`, `renomear-revenda-cards-28-10-2026.js`, `preencher-representante-cards-28-10-2026.js`, `ajustes-cards-28-10-2026.js`, `gerar-proposta-agrupamento.js` e `-v2.js` (somente leitura, geram planilha), `gerar-playbook-revenda.py` (Playbook da revenda, 2 páginas).
- **Deploy:** `git push origin main` publica sozinho na Vercel (a conta `andreboxer` voltou a ter escrita em 28/10/2026). Alterou `public/js/*.js` ou CSS? Subir o `?v=` em `public/index.html`.

### Extrato de Comissões: colunas NF (ZEN) e % Comissão (05/11/2026)
- Tela Gestão › Extrato de Comissões e o Excel exportado ganharam **NF (ZEN)** e **% Comissão** (com PCI · Classe embaixo). Código: `enriquecerNfEPct` em `src/routes/admin.routes.js`.
- **% Comissão** = `bmax_transacoes.comissao_pct` gravado no crédito (PCI × Classe de Preço × matriz da política). Lançamentos antigos sem ele (54 de 227 em 05/11) são recalculados pela matriz atual e marcados com `*` / "(estimado)".
- **NF** = `src/services/zenNf.service.js` (somente leitura). Fonte principal: NFs de saída com a **tag `bmax`** no ZEN (`GET /fiscal/outgoingInvoice?q=tags==bmax`; `=like=` não funciona em tags; case-insensitive; também existe na venda `/sale/sale`). Casa pelo CNPJ do card, janela −45/+90 dias do fechamento e melhor combinação de até 3 notas contra o valor do card. Sem nota com tag, cai na busca por CNPJ e marca `†`; `~` = não fecha com o valor do card.
- Exige `ZEN_EMAIL` e `ZEN_SENHA` nas variáveis do Portal na Vercel; sem elas a coluna mostra "—" (não quebra). Cache de 15 min.
- Teste: `scripts/teste-extrato-nf-pct-5-11-2026.js <.env do Motor>`.

### Fase 2 do cashback automático — fechamento de venda por NF (SIMULAÇÃO, 05/11/2026)
- `src/services/cashbackNf.service.js` (`simular()`) + rota `GET /api/cron/cashback-nf` (Bearer CRON_SECRET/CRON_TRIGGER_KEY; `?aplicar=1` é recusado — ainda não liberado). Só lê: RD (cards abertos de revenda, PCI 12a/12b/13/14/15, etapas Assumido/Negociação/Lead, criados desde 01/05/2026) × ZEN (NF após a criação do card, pelo CNPJ).
- Decisões: **FECHARIA** (NF com tag `bmax`, PCI e Classe ok), **REVISAR** (NF sem tag, várias notas, sem Classe/regra, CNPJ inválido), **AGUARDAR** (sem NF), **ERRO**.
- Ação planejada ao ligar: `amount_unique` = soma das NFs; mover para Venda Efetivada (funil Indústria Interno) ou Vendido (BMAX) **e marcar win=true** — mover etapa NÃO marca o card como ganho. `updateLead` agora aceita `data.win` (testado no testeSC: `{deal:{win:true}}` → 200, win=true, closed_at preenchido). Depois `recalcularComissoes` credita.
- Planilha: `scripts/simulacao-cashback-nf-5-11-2026.js <.env do Motor>` → `Documentação/Simulacao_fechamento_por_NF_05-11-2026.xlsx`.
- 05/11/2026: 42 candidatos, todos AGUARDAR (nenhum com NF ainda). Teste do card testeSC deixou ele com win=true (etapa inalterada).
- **PENDENTE (05/11/2026, em pausa a pedido do André):** a simulação publicada **soma todas as NFs com tag `bmax`** do CNPJ após a criação do card — incorreto, pois um card é uma negociação e o cliente pode ter várias compras. Antes de ligar o fechamento é preciso definir o vínculo NF↔card: (1) NF única + valor compatível (1%) ou (2) ID do card do RD na observação/campo do pedido no ZEN. Até lá o robô só simula (`?aplicar` recusado). Histórico completo na memória do projeto (`.claude/memory/project_bmax_pendencias.md`).

### Termo de Formalização Digital BPartner — Fase 1 (06/11/2026)
- Especificação: `Documentação/BMax_Portal_Termo_de_Formalizacao_Digital_v2.md` (v2.1). Fluxo: **revenda (grupo) → representante (testemunha) → Boxer (admin em Gestão › Termos BPartner)**; Prata/Ouro só formalizam; **Diamante só vira Diamante após o admin confirmar a compra das 2 máquinas (prazo de 30 dias)**, senão `encerrado_sem_compra` e o grupo segue Ouro. Sem menção a exclusividade e sem percentuais no texto.
- **Banco (boxer-sistemas, schema public, só tabelas novas):** `comercial_bmax_conteudos_programa` (texto versionado; seed v1 por programa), `comercial_bmax_termos`, `comercial_bmax_termo_lojas` (cópia do cadastro + dados informados pela revenda), `comercial_bmax_termo_aprovacoes` (nome, cargo, **CPF obrigatório**, IP, user-agent), `comercial_bmax_termo_auditoria` (**imutável: trigger recusa UPDATE/DELETE**), bucket privado `bmax-termos` (comprovantes PDF). DDL: `scripts/sql/termos-fase1.sql` (aplicado em 06/11/2026). RLS ativo, sem policies (só service_role no backend).
- **Interruptor `termos_ativo`** (`comercial_bmax_config`, nasce `false`): desligado, revenda/representante não veem nada; admin liga/desliga na própria aba. Opção `termos_aprovador_diferente` (true = quem emitiu não aprova).
- **Código:** `src/services/termos.service.js` (validações CNPJ/CPF/CEP, texto + hash SHA-256, elegibilidade, fluxo, `aplicarCadastro`, prazos, e-mails Resend), `src/services/termosPdf.service.js` (pdfkit), `src/routes/termos.routes.js` (`/api/termos`), cron `/api/cron/termos-prazos` (13h UTC; encerra vencidos e avisa 5 dias antes), UI `public/js/termos.js` (admin.js?v=39, termos.js?v=2, app.js?v=29), testes `termos.service.test.js` (14 testes, banco em memória).
- **Preenchimento automático do cadastro (e do Motor):** na etapa da revenda ela informa razão social, **CNPJ, CEP (em destaque, máscara 00000-000, valida UF via BrasilAPI), logradouro, número, bairro, cidade, UF** de TODAS as lojas (e pode acrescentar lojas). Na aprovação da Boxer, `aplicarCadastro` grava em `comercial_revendas_bmax`: `cnpj`/`cep` só com dígitos, `endereco` ("Logradouro, nº - Bairro"), cidade, estado, **lat/lng** (geocodeCep) (sem mesorregião). O Motor lê esse mesmo cadastro, então passa a enxergar os dados certos sem mudança de código. Nunca altera `nome`/`nome_rd`; lojas adicionais NÃO são criadas sozinhas (ficam listadas em `cadastro_atualizado` na auditoria para cadastro manual). Há "Simular atualização do cadastro" (nada gravado) antes de aprovar.
- **Achado (06/11/2026):** `mesorregiao_ibge` estava vazia nas 58 lojas ativas; CEP tinha formato misto (um com hífen). O termo padroniza e preenche, mas só para os grupos que passarem por ele.
- Acesso: admin vê tudo; revenda só os termos do seu grupo (`comercial_revendas_bmax.user_id` → `grupo`); representante só se for a testemunha designada (resolvida pelo alias do RD). Aprovador Boxer = usuário `adm`.
- Fora da Fase 1: convite por token para grupo sem login e criação do login na aprovação (Fase 2); editor de textos e marca d'água configurável (Fase 3).

**Ajustes de 06/11/2026 (decisões do André):**
- **Qualquer grupo pode receber qualquer programa**: sem restrição de estado (Diamante também em SP) nem de classe de origem. O programa do termo define a classe final das lojas incluídas (Prata/Ouro na aprovação; Diamante após a compra das 2 máquinas); diferenças de classe aparecem como aviso na emissão e na simulação.
- **Mesorregião fora do termo**: não é mais preenchida nem exigida. A referência geográfica é o **raio de 50 km** (mesmo critério do PCI). Achado: o Motor (`bmax-motor/index.html`, `checkDiamante`) só considera Diamante que tenha `mesorregiao_ibge`, e o campo está vazio nas 58 lojas ativas — hoje o aviso "Revenda Diamante disponível" nunca dispara. Ajuste do Motor para usar o raio fica pendente de autorização (muda o comportamento para o SDR).
- **Proteção do cadastro** (`planejarCadastro`/`aplicarCadastro`): (1) CNPJ informado que já existe em OUTRA loja do cadastro é recusado já na etapa da revenda e bloqueia a aprovação; (2) **troca de CNPJ de loja existente** só é gravada com confirmação explícita do admin (`confirmarCnpj`), pois pode ser erro de digitação; (3) nunca renomeia e nunca cria loja (lojas adicionais ficam listadas); (4) loja com login no Portal tem o espelho (`Revendas` e filial principal: cep, cidade, estado e CNPJ confirmado) sincronizado, com checagem de CNPJ único; (5) a simulação mostra tudo isso sem gravar.
- Outros consumidores do cadastro `comercial_revendas_bmax`: Motor (lê direto, sem cache próprio), scripts do Motor (`sincronizar_excel_bmax.py` etc.) e o RD (picklist por nome — o termo não muda nomes). `bmax_grupos` (agrupamento do cashback) NÃO é alterado pelo termo.

**Termo BPartner — correções antes do piloto (09/11/2026):** (1) **loja sem grupo vira "grupo de uma loja só"** (chave `loja:<id>` na tela de emissão): 23 das 58 lojas ativas não têm `grupo` e 3 dos 4 pilotos (Technofer, Eletrosolda, Suprimig) estavam nesse caso — antes não dava para emitir; `minhas()` também acha a pendência pelas lojas do termo. (2) **Emissão bloqueada se nenhuma loja do grupo tem login** (a confirmação por convite/token é a Fase 2). (3) **Defeito corrigido na testemunha:** `resolverRepresentanteReal` procurava o usuário pelo nome do representante, mas o login hoje é o e-mail (`getAliasMaps.rdToUsername` devolve o nome, não o login); agora liga nome → alias do RD → e-mail → `User`. Provado com os dados reais (somente leitura): os 4 pilotos emitem e todos os representantes têm login e e-mail. Testes: 44 (inclui loja sem grupo e grupo sem login). Linhas legadas "REP > IND"/"REP+REV > IND" da Tabela de Preços t=2 removidas (60→48 comissões) com backup e `scripts/restaurar-linhas-rep-tabela-precos-t2.js`.

**Portal sem cards / leitura do RD (13/11/2026):** o RD **ignora** `created_at_start` (o filtro não filtrava nada); o Portal baixava o funil Indústria INTEIRO (4.716 cards, 24 páginas de ~2 s = 55–78 s) e a Vercel cancelava a função em 60 s ("Task timed out") → painel vazio para todos. Corrigido em `rd.leads.service.js` (`fetchAllDealsFromRD`): usa os filtros que o RD respeita — `created_at_period=true&start_date=2026-05-01&end_date=` (944 cards) e `win=true&closed_at_period=true&start_date=&end_date=` (158 vendas fechadas desde o corte) — em paralelo: **322 cards em ~11 s**. `getLeads` passa a aceitar também **venda ganha (win) fechada desde 01/05/2026 mesmo em card criado antes** (ciclo longo): +14 vendas, entre elas Mendes, VMF, ENGETECH e BBA (R$ 996,70 de comissão de representante e R$ 1.608,90 de revenda passam a ser creditados no próximo recálculo). Se o RD voltar a limitar (429) ou o funil crescer muito, o próximo passo é cache persistente no Supabase.

## Unificação de nomes de representante e corte de vendas (16/11/2026)
- Mapa: Victor Lantyer→Victor VLM, Caio Tito→Caio P Mancini, Carlos Alberto→Carlos, Patrick Ferreira→Patrick, Weberson Rodrigues→Weberson. Aplicado em todos os funis do RD (461+230 cards), com nota em cada card; nomes antigos removidos da lista do campo REPRESENTANTE; `rd_alias` zerado em `comercial_representantes_bmax`; carteiras `bmax_saldo`/`bmax_transacoes` renomeadas.
- Campos obrigatórios vazios foram preenchidos com valores neutros ("Sem PCI", "Sem Classe", "Sem Revenda", segmento derivado da máquina/produto ou "Não se aplica", opção criada no campo SEGMENTO DE PRODUTO). Histórico/rollback em `Documentação/Backups_Banco/unificacao_reps_13-11-2026_*.json`.
- `getLeads`: card criado desde 01/05/2026 entra; criado antes só entra se ganho e fechado desde 01/09/2026 (`DATA_CORTE_VENDAS_ANTIGAS`).

## Módulo "Performance de Revendas" (16/11/2026)
- Aba **Performance** no admin (somente `adm`). Rota `GET /api/admin/performance-revendas?de=&ate=` (YYYY-MM-DD) → `src/services/performanceRevendas.service.js` (somente leitura); front em `public/js/performance.js`.
- Fontes: cards do RD via `getLeads` (leads por data de criação, vendas por data de fechamento; etapas Vendido/Venda Efetivada/Entrega Técnica com valor > 0), razão `bmax_transacoes`/`bmax_saldo` (tipo_agente='revenda'; cashback gerado = créditos − ajustes de recálculo; resgatado = débitos com saque), PCI12: `bmax_pci12_tracking` (desde 30/07/2026), `bmax_pci12a_prazo` e `AuditLogs` SELECT_CAMINHO_VENDA (desde 10/09/2026).
- PCI12: caminho final = escolha registrada (quem escolheu = revenda ou equipe, pelo role do usuário) > 12b automático (48h) > PCI atual do card. 12a assumidos → vendidos / perdidos (win=false, etapa Perdido ou Excluído) / em aberto; o front exibe % 12a vendidos, em aberto e perdidos.
- O serviço devolve componentes aditivos por loja; o front soma por grupo (cadastro `grupo`), aplica filtros (busca, UF, classe, representante, PCI, com/sem venda), ordenação, colunas ocultáveis (localStorage `perfColsOcultas`), comparação, detalhe de leads e exportação CSV. "Sem Revenda"/vazio ficam fora da tabela (resumo à parte).
- Nomes do campo REVENDA/LOJA do RD sem cadastro em Revendas BMax aparecem com a marca "sem cadastro" (ex.: "31603, C. S. Ferramentas Ltda").

## Funcionário Boxer com o módulo do Representante + ajustes da Performance (16/11/2026)
- Perfil `funcionario`: passa a listar leads (`GET /api/leads`, visibilidade total como antes), definir caminho PCI12 (`POST /api/leads/pci`) e criar Nova Negociação (`POST /api/negociacoes` e `/orcamento-upload-url`), com as mesmas regras do representante/admin (produto, caminho, quem atende, orçamento obrigatório). Na tela: botão Nova Negociação e bloco de representante/PCI/responsável visíveis; card de cashback/comissão escondido (funcionário não tem carteira); Gestão, extrato e cashback continuam bloqueados (403).
- Performance de Revendas: (1) resolvedor de nomes — `comercial_revendas_bmax.nome` (nome longo do ZEN) e `nome_rd` apontam para a mesma linha (ex.: "31023, Heitor… Suprimig…" = Suprimig); nomes só conhecidos em `bmax_grupos` usam a linha do grupo; (2) lê também o funil BMAX Interno (`fetchDealsBmaxInterno`, somente leitura) e busca por id os cards do histórico PCI12 que estejam fora dos funis lidos; (3) etapa "Prazo Vencido" (id RD_STAGE_PERDIDO no funil BMAX) vira situação própria `a12_vencidos`; (4) cards de teste (nome começando com "Teste") ficam fora dos indicadores.
- REGRA (André, 16/11/2026): o Portal principal (`getLeads`) NÃO precisa ler o funil BMAX Interno. Quando a revenda escolhe vender (BOX>REV, PCI 12a), ela deixa de ganhar comissão — por isso o card segue para outro funil/etapa e fica fora do cálculo. Só o módulo Performance lê esse funil, para medir o funil 12a.

- Performance — painel "12a perto do prazo" (16/11/2026): `prazo12a` no retorno do serviço lista todo 12a ainda aberto (independe do filtro de período) com dias desde o aceite (`bmax_pci12a_prazo.assumido_em`, senão data da escolha na auditoria) e dias restantes do prazo de 60; o front mostra card + painel com corte configurável (padrão 45 dias), chips por revenda e destaque para vencidos/≤10 dias.

- Performance — correção "perdido × prazo vencido" (16/11/2026): a etapa RD_STAGE_PERDIDO (funil BMAX; no RD chama-se "Prazo Vencido") recebe tanto o card que a revenda marca como "Perdido" no Portal (`UPDATE_RESULTADO_LEAD`) quanto o que o robô `pci12a-prazo` arquiva aos 60 dias. Só o robô grava `bmax_pci12a_prazo.arquivado_em`; portanto na etapa + arquivado = "prazo vencido", na etapa sem arquivamento = "perdido pela revenda". Os 4 cards 12a nessa etapa em 16/11 foram marcados Perdido pelas revendas (WST 13-14/10, Luitex 09/10); o robô nunca arquivou nenhum (o primeiro a completar 60 dias seria Departamento Compras, em 17/11). O painel 12a mostra "Assumiu em" (data do SELECT_CAMINHO_VENDA) e "Vence em"; 3 dos 34 leads não têm registro de aceite (data = dia em que o robô os viu) e aparecem com asterisco.

## Etapa "Perdido pela Revenda" e data de assumir do PCI12a (16/11/2026)
- Nova etapa do funil BMAX **Perdido pela Revenda** (`RD_STAGE_PERDIDO_REVENDA = 6afb723153734400239f4226`, criada pelo André). É o destino do botão "Perdido" da revenda (`updateLeadResultado`) e do `status-x-etapa` (BMAX). A etapa **Prazo Vencido** (`RD_STAGE_PERDIDO = ...dd603`) fica só para o arquivamento automático de 60 dias do PCI12a. A nova etapa entra em todas as listas de etapas finais/excluídas (getLeads, caminhoVenda, whatsappResumo, cron pci12a-prazo) e conta como "perdido" na Performance.
- Migração feita em 16/11/2026: 5 cards marcados Perdido pela revenda (Vértice, Brasalum e Frazão — WST; Fibertechnic — Luitex; Fabio Alessandro — Eletro Solda) foram movidos de Prazo Vencido para Perdido pela Revenda, cada um com nota explicando a movimentação. Histórico: `Documentação/Backups_Banco/perdido_pela_revenda_movimentacao_16-11-2026.json`. Volt Energia (Technofer, R$ 0) ficou em Prazo Vencido por não ter registro de perda pela revenda.
- Data de assumir (prazo de 60 dias): 1) clique em "Eu assumo a venda" (auditoria SELECT_CAMINHO_VENDA); 2) se não houver, `buscarDataAssumidoNoRD` lê do próprio card no RD a tarefa "Revenda Assumiu o Atendimento" (assunto + campo de anotação "Revenda selecionou o caminho BOX>REV…") ou "Revenda conduz o atendimento", e por fim notas do card. O robô `pci12a-prazo` usa essa ordem ao registrar leads novos; o painel "12a perto do prazo" mostra a fonte (ⓘ = RD, * = estimada). Em 16/11 foram corrigidas no controle 2 datas sem clique (Evergreen, André Troiani/Total Soldas; backup `pci12a_prazo_assumido_em_ANTES_16-11-2026.json`). Fibertechnic diverge (clique 10/09 × tarefa 17/09) — Luitex verifica manualmente.

- Performance — cards clicáveis (17/11/2026): clicar num card filtra a tabela para as revendas que têm leads naquele indicador (colunas "Leads no filtro"/"Valor no filtro") e lista abaixo os leads (revenda, lead, PCI, etapa, situação, valor, caminho, quem decidiu, data de assumir, dias); clicar de novo limpa. O serviço devolve `leads12` por revenda (histórico PCI12 lead a lead). "Decididos 12a" e "12a assumidos" eram o mesmo conjunto — viraram um card só ("12a: revenda assumiu"). "Aguardando decisão" passou a contar só PCI12 sem caminho E ainda aberto (vendas já efetivadas com PCI 12 sem escolha registrada não contam). Datas de assumir ajustadas no controle por orientação do André: Fibertechnic = data da tarefa no RD (17/09/2026), Vértice = 21/09/2026 (anotação da Khymberlee passando para a Indústria); backup em Backups_Banco/pci12a_prazo_fibertechnic_vertice_ANTES_16-11-2026.json.

## Termos BPartner (erro 404), aba Representantes BMax e cadastro Ipanema (17/11/2026)
- **Erro da aba Termos BPartner:** a tela chamava `GET /api/termos/` (com barra no final); em produção a Vercel responde 404 próprio (NOT_FOUND) para o caminho com barra final, enquanto `/api/termos` e `/api/termos/flag` funcionam. Corrigido em `public/js/termos.js` (`tApi("")`). Regra: nunca chamar a API com barra no final.
- **Aba Representantes BMax** virou a gestão completa dos representantes (antes era só a lista de nomes da Cobertura): Editar (nome, e-mail, telefone, senha, convite ao Motor, ativo), Redefinir senha (reaproveita o modal de reset do login), Criar login (quando não há), Ativar/Desativar, Excluir (ou Excluir login), busca e filtro por status, contagem de revendas ativas por representante. Fonte: `comercial_representantes_bmax` + logins (`GET /admin/users`); toda gravação passa pelo `PUT /admin/representantes-bmax`, que espelha a lista legada usada pela Cobertura/Motor. As funções antigas da lista (`rep-bmax-list`) deixaram de ser usadas pela tela.
- **Cadastro da Ipanema** (`comercial_revendas_bmax` id 40eedb81…): `nome_rd = "Ipanema Soldas (LT)"`, `user_id = 23` (login luccas@ipanemasoldas.com.br), e-mail do login e `ativo = true` (classe Ouro, rep Fernando Augusto, Sorocaba/SP). Backup: Backups_Banco/cadastro_ipanema_ANTES_17-11-2026.json.
- **Termo digital:** a aba Termos BPartner é a tela de gestão do mesmo Termo de Formalização Digital. Testes: 44 passam (jest). Prévia de emissão (somente leitura) OK para Suprimig (Prata, completo), Technofer (Ouro, falta endereço) e Ipanema (Ouro, falta CNPJ/CEP/endereço — a revenda preenche no formulário). Recurso segue DESLIGADO até o piloto.

## Integridade e interligação (itens 1, 2 e 3 — 17/11/2026)
**1. Representante deixa de ser texto livre.**
- Banco (boxer-sistemas, migration `fk_representante_cobertura_revendas`): `comercial_bmax_cobertura.rep_bmax` e `comercial_revendas_bmax.rep` viraram chave estrangeira de `comercial_representantes_bmax.nome` (`ON UPDATE CASCADE ON DELETE SET NULL`, `NOT VALID` — vale para gravações novas; Cris/Makoto, antigos e inativos, não bloqueiam). Renomear o representante no cadastro corrige sozinho a Cobertura e as revendas; excluir deixa cidades/revendas sem representante. Testado em transação com rollback.
- API (`admin.routes.js`): `repCanonico()` valida e normaliza o nome em `POST/PATCH /revendas-bmax`, `PATCH/POST /cobertura` e no upload de planilha da Cobertura (a planilha inteira é recusada, sem gravar nada, se houver representante inexistente; a mensagem lista os nomes e as linhas).
**2. Cadastro de revenda incompleto não fica ativo.** `faltaParaAtivar()`: ativa exige classe, cidade e estado (representante continua opcional — há regiões sem representante). Vale ao criar, ao ativar e ao esvaziar esses campos de uma revenda ativa. `vincularLoginSeExistir()`: ao criar/editar, se já existe login do Portal (tabela Revendas) com o mesmo nome e sem vínculo, liga sozinho (`user_id` e e-mail) — caso Ipanema.
**3. Desfecho do 12a no Portal e robôs que avisam.**
- `bmax_pci12a_prazo` ganhou `resultado` (vendido | perdido | vencido | null = aberto), `resultado_em`, `resultado_origem` (portal | robo | rd). Quem grava: botão Vendido/Perdido da revenda (`updateLeadResultado`), robô dos 60 dias e a reconciliação diária com o RD (`pci12Desfecho.service.js`, dentro do robô `pci12a-prazo`; pega também mudança manual no RD). A Performance usa esse desfecho antes de inferir pela etapa.
- `bmax_robo_execucoes` + `roboMonitor.service.js`: middleware em `/api/cron/*` grava cada execução (status, duração, resumo) ANTES de responder e manda e-mail ao admin (`EMAIL_FALLBACK`) na primeira falha (e no máx. 1x por dia enquanto falhar). Ignora `?dry=1` e chamadas sem segredo. Vigia diário `/api/cron/vigia-robos` (22:30 UTC) avisa se algum robô esperado não teve sucesso em 30h (só cobra depois de 30h de histórico do monitor).
- Backfill em 17/11/2026: 4 perdidos pela revenda, 1 vendido (Alpha Industrial) e 1 vencido (Departamento Compras — arquivado pelo robô nesse mesmo dia).

- Robôs — garantia contra 401 silencioso (17/11/2026): o 401 visto no teste do vigia foi só o segredo da máquina local (diferente do de produção); em produção o `CRON_SECRET` existe na Vercel e o robô `recalcular-comissoes` rodou com HTTP 200 às 15:33 UTC. Para nunca passar em silêncio: o monitor agora trata 401/403 recebido do agendador da Vercel (user-agent `vercel-cron`) como FALHA e manda e-mail ("o CRON_SECRET que a Vercel envia não confere com o do servidor"); 401 de outros chamadores segue ignorado. O próprio `vigia-robos` passou a ser registrado e é vigiado: se não rodar com sucesso há mais de 50h, o próximo robô que rodar avisa por e-mail.

## Atualização 23-25/11/2026 — Pipefy em produção, cashback por grupo, PCI X

Detalhe completo em `Documentação/Registro_Mudancas_Portal_BMax_23-25-11-2026.md` (pasta do projeto). Pontos técnicos:

- **Dois ids por lead.** Id do Pipefy (numérico) é o principal; o do RD fica em `deal.rd_deal_id` (campo "ID no RD CRM"). Tabelas antigas (`bmax_transacoes.lead_id`, `bmax_pci12_tracking`, `bmax_pci12a_prazo`, AuditLogs) guardam o id do RD. Todo consumidor deve casar pelos dois (ver `comissao.service.recalcularComissoes`, `performanceRevendas` → `canon()`, `admin.routes` dealMap, `getNomesDeLeads`).
- **Robô de comissões** é idempotente por lead+agente somando créditos sob os dois ids; aceita `{ dryRun: true }`.
- **Cashback por grupo:** `codigoUnico.nomeUnico(nome)` devolve o nome do grupo quando a loja pertence a um; `saldo.service` grava sempre pela carteira do grupo; `debitarCashbackGrupo` reparte o saque.
- **Novas tabelas:** `bmax_lead_andamento` (status/perda/venda; coluna `lead_nome`), `bmax_pcix_prazo`.
- **Novos robôs:** `/api/cron/pcix-prazo` (30 dias, alertas 15/25/30 e semanal). `roboMonitor.verificarCreditosAnormais` roda depois de `recalcular-comissoes`, `cashback-nf` e `vigia-robos` (limite 40 créditos ou R$ 25 mil em 24 h; e-mail só aos administradores).
- **Novos endpoints:** `POST /api/leads/andamento`, `GET /api/leads/andamento/:dealId`, `GET /api/leads/andamento/relatorio/perdas`; `POST /api/leads/resultado` agora exige motivo no "Perdido" e aceita admin só nos PCI X.
- **Cards:** campos novos `andamento`, `pcix`, `quemVende`, `revendaGrupo`, `rdDealId`.
- **Pipefy:** mapeamento Vendido/Perdido da revenda → fases do CRM BOXER SOLDAS em `pipefyConstants.PREFERENCIA_ETAPA_RD_PARA_FASE`; "PCI X" em `PIPEFY_PCI_OPCOES`; `updatePhaseField` com `label: String!`.
- **Token de administrador do Pipefy** (`PIPEFY_TOKEN_ADMIN`) só no `.env` local; scripts em `scripts/codigo-unico/pipefy_*.js`.

## Auditor diário (25/11/2026)

Agente que confere o Portal 2x por dia (06h e 13h Brasília, `/api/cron/auditor?rodada=manha|tarde`) e avisa o André por e-mail. **Só lê e avisa: não corrige nada.** Escreve apenas nas próprias tabelas (`bmax_auditoria_achados`, `bmax_auditoria_execucoes`, `bmax_auditoria_cards_ultimo`, `bmax_auditoria_card_mudancas`; DDL em `scripts/create-auditor-tables.js`).

- **E-mail:** só para `EMAIL_AUDITOR` (variável da Vercel), só com achado novo ou lembrete semanal. Temas em ordem fixa: saldo, créditos anormais, checagens/rodadas do auditor, robôs, vendas com dados faltando, mudanças de PCI/produto/classe, PCI x produto, cobrança do PCI12a por representante e revenda (com link dos cards). Máximo de 12 linhas por tema no e-mail; o resto fica na aba.
- **Aba Gestão > Auditor diário:** achados abertos e resolvidos, últimas execuções e "Rodar simulação agora" (não grava nada e não envia e-mail). Rotas admin: `GET /api/auditor/achados`, `GET /api/auditor/execucoes`, `POST /api/auditor/simular`.
- **Checagens:** saldo x razão; créditos anormais em 24h; robôs sem sucesso ou com última execução falha; venda sem PCI/produto/classe/revenda/representante; PCI incompatível com o produto; mudança de PCI/produto/classe entre rodadas; PCI12a sem resposta da revenda (casa os dois ids, Pipefy e RD); rodada do auditor que não aconteceu. Checagem que falha ao rodar vira achado e nunca resolve os achados dela.
- **Arquivos:** `src/services/auditor.service.js`, `src/services/auditorCards.service.js` (regras puras), `src/routes/auditor.routes.js`, `public/js/auditor.js`.
- **Estado em 26/11:** a primeira rodada real ainda não aconteceu (cron não disparou na manhã; ver nota de crons na seção 9).
- **Pendente:** colocar `auditor` em `ESPERADOS` (`roboMonitor.service.js`) depois da primeira rodada real bem-sucedida; ampliar as checagens (cards duplicados, ids órfãos, status x etapa, etiqueta ausente, prazos parados, cadastro de pessoas).

