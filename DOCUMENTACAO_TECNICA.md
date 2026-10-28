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

**Revenda + login juntos e nome único (28/10/2026):** em Gestão → Revendas BMax → Nova Revenda, a caixa "Criar também o login" (marcada por padrão) cria no mesmo passo: cadastro (`comercial_revendas_bmax`, com `nome_rd` sempre preenchido), login (`Users` role revenda, usuário = e-mail em minúsculas, senha inicial = parte antes do @), `Revendas` (name = nome no RD) + filial principal, vínculo `user_id` no cadastro, acesso ao Motor (Supabase Auth) e sincronização do picklist REVENDA/LOJA do RD (`services/revendaLogin.service.js`, `POST /admin/revendas-bmax` com `criar_login`). Valida tudo antes de gravar (e-mail, CNPJ 14 dígitos, CEP 8, cidade/UF, e-mail e CNPJ ainda sem login). Credenciais por e-mail só se marcado. **Nome no RD único:** POST/PATCH recusam nome (nome_rd, senão nome) já usado por outra revenda ATIVA. Limitação conhecida: `Revendas.cnpj` é UNIQUE no Postgres, então um 2º login para a mesma revenda ainda não é possível (modelo de revenda com código único, em planejamento). `GET /admin/revendas-rd?simples=1` devolve só a lista do RD (o modal Editar Revenda não varre mais todos os leads).

**Lead com revenda sem login (28/10/2026, caso Heitor/Suprimig):** `revendaVinculo.service.js` decide se um nome de REVENDA/LOJA do RD é "vinculado" (algum login do Portal o enxerga via `Revendas.name` ou `bmax_grupos`). (1) `pci12-followup`: se o nome do card não tem login, o prazo de 24h/48h NÃO conta (`detectado_em` é zerado a cada rodada) e o card sai em `resultado.semVinculo`; (2) `sync-revenda-rep-rd`: varre leads em aberto sem login e envia e-mail 1x por lead ao admin (`EMAIL_FALLBACK` ou André; snapshot `leads_sem_login_avisados`); (3) painel admin: alerta "Revenda sem login" (`revendaSemLogin` em cada card; `leads.js`) e o alerta "Sem revenda" agora inclui o valor literal "Sem Revenda". Causa raiz: o RD tem nomes duplicados da mesma revenda (nome do ZEN × nome curto); a consolidação de nomes (planilha de agrupamento) elimina a duplicidade.

**"Esqueci minha senha" (tela de login, 27/10/2026):** link abaixo do formulário abre caixa para usuário/e-mail e chama `POST /api/auth/forgot-password` (rate limit próprio); o endpoint avisa por e-mail todos os admins e responde sempre a mesma mensagem genérica (não revela se o usuário existe). O texto digitado agora é escapado no HTML do e-mail (antes entrava cru) e o assunto não aceita quebra de linha.

**Ícone "Regras e cashback" (barra do topo, 27/10/2026):** botão ⓘ ao lado de "Gestão/Sair", visível após login para todos os perfis; abre modal estático (`#regrasOverlay` em `index.html`, lógica em `app.js`) com % de cashback por PCI (lead da revenda: PCI13 1,5–4,0%, PCI14 1,7–4,0%, PCI15 3,0–5,0%; lead da Boxer: PCI6 1,5%, PCI9/12B 2,0%), regras essenciais (60 dias, 48h úteis, 30 dias, cashback após faturamento), decisão do PCI12 e passos da revenda. Valores digitados no HTML (vêm dos slides da Imersão BMAX) — se a tabela `comissao_tabela` mudar, atualizar o modal.

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

## 7. Cashback e comissão

- **Cálculo:** PCI + classe de preço → percentual em `comercial_bmax_config` (chave `comissao_tabela`, mesma fonte do Motor) → multiplica pelo `amount_total` do deal. Só calcula pra deals em "Venda Efetivada". PCIs 13/14/15 variam por classe (`por_classe`); os demais são percentual fixo.
- **Três tipos de agente creditado por venda:** `revenda`, `representante`, `vendedor_interno` — cada um com seu próprio saldo em `bmax_saldo`/`bmax_transacoes` (`tipo_agente`).
- **Cron `recalcular-comissoes`** (4x/dia): reconcilia o saldo real contra o que a regra de comissão diz que deveria estar creditado agora, pra toda venda efetivada — idempotente, só lança a diferença. Endpoint manual equivalente: `POST /api/cashback/creditar-retroativo`.
- **"Sem Revenda" nunca recebe crédito de revenda** (fix 21/09/2026) — é um valor legítimo pra dado (venda direta, sem parceira), mas não é uma conta que existe pra receber comissão. Constante `REVENDA_SEM_CREDITO` (`constants.js`) usada nos pontos de crédito/agregação — nunca na validação de dado, onde "Sem Revenda" continua opção normal.
- **Cards de venda mostram valor histórico**, não recalculam com a comissão atual — usam `creditosMap` (valores reais de `bmax_transacoes`) quando o lead já foi creditado. Só recalcula ao vivo quando não há crédito ainda. **Essa regra só se aplica ao papel `revenda`/`adm` em `mapDealToCard`** — o card do `representante` sempre recalcula ao vivo, nunca usa `creditosMap`. Ou seja, a "Comissão Total" que o representante vê no dashboard é uma ESTIMATIVA ao vivo dos leads visíveis na tela, não o saldo realmente creditado. O saldo real do representante existe (`tipo_agente='representante'`, alimentado pelo mesmo cron) mas **não há tela nenhuma que mostre esse número** — só existe "Saldo Revendas" (saldo real, mas das revendas parceiras que ele acompanha, não dele).
- **Créditos expiram em 6 meses**, cheques (saque aprovado) em 30 dias. Cron `expirar-cashback` diário processa expirados e avisa 30/15 dias antes.
- **Sem proteção de dedup por `lead_id`** em `creditarCashback` — mesmo lead marcado vendido duas vezes gera crédito duplo (pendência conhecida, não corrigida).

## 8. Bugs de infraestrutura já encontrados e corrigidos (histórico útil pra não repetir)

- **Tabela `RevendaFiliais` nunca existia** em produção (21/09/2026) — bloqueava a criação de qualquer revenda nova (não só filiais), porque toda revenda nova cria uma "filial principal" dentro da mesma transação Sequelize. Se aparecer `relation "X" does not exist` em produção, checar se a tabela foi realmente criada — não existe pipeline de migration automática nesse projeto (sem sequelize-cli, sem pasta `migrations/`); tabelas novas em `src/models/` precisam de `CREATE TABLE` manual em produção.
- **`public/js/*.js` são referenciados com `?v=N`** em `index.html` — editar o JS sem subir o `N` faz o navegador continuar servindo a versão cacheada antiga, mesmo com o arquivo novo já publicado (já causou "corrigi mas não aparece" 2x). Sempre bumpar no mesmo commit.
- **`git push origin main` dispara deploy automático em produção** (integração GitHub↔Vercel) — não existe "só commitar local com segurança"; qualquer push posterior leva junto todo commit ainda não enviado, mesmo commits que não deveriam ir ao ar ainda.
- **Filtro de revenda multi-loja no frontend** (`leads.js`) chegou a refiltrar `API_LEADS` por igualdade exata de nome, duplicando (mal) o que o backend já faz certo via `bmax_grupos` — só "funcionava" pra Luitex por um hack de substring hardcoded. Removido; o backend já entrega a lista certa pro papel `revenda`, o front não deveria refiltrar de novo.
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
| `/api/cron/sync-revenda-rep-rd` | 10:00, 13:00, 17:00, 20:00 (= 07h, 10h, 14h, 17h Brasília, desde 14/10/2026) | Sincroniza picklists RD, detecta PCI12 novo (troca responsável p/ André, avisa + inicia tracking 48h úteis) |
| `/api/cron/sync-consulta-lead` | 12:00, 17:00, 21:00 | Pré-computa índice de "Consulta de Lead" (evita timeout de 60s calculando na hora) |
| `/api/cron/recalcular-comissoes` | 12:00, 15:00, 18:00, 21:00 | Reconcilia saldo real vs regra de comissão atual |
| `/api/cron/pci12-followup` | 10:00, 13:00, 17:00, 20:00 (= 07h, 10h, 14h, 17h Brasília, desde 14/10/2026) | Lembrete 24h úteis + 12b automático 48h úteis dos PCI12 pendentes |

**Prazos sem fim de semana (14/10/2026):** os prazos de 24h/48h do PCI12 pendente contam só segunda a sexta (horário de Brasília), via `src/services/prazoUtil.service.js` (`horasUteisEntre`). Sábado e domingo não contam; **feriados não são descontados**. O prazo de 60 dias do PCI12a **continua em dias corridos**. `detectado_em`/`assumido_em` são `timestamp without time zone` gravados em UTC pelo `now()` do Postgres e lidos em UTC pela Vercel — ao rodar scripts locais em UTC-3 o valor lido aparece 3h adiantado (só leitura local; use `TZ=UTC`).

Todas autenticadas via header `Authorization: Bearer <CRON_SECRET>`. Vercel Hobby só permite 1 `schedule` por entrada rodando 1x/dia — múltiplos horários no mesmo cron = múltiplas entradas em `vercel.json`, não uma única com "várias vezes ao dia".

## 10. Papel no ecossistema BMax

- **RD Station CRM V1** — fonte de verdade dos deals/leads.
- **BMax Motor** (`bmax-motor`, ver `DOCUMENTACAO_TECNICA.md` de lá) — classifica leads nos 16 PCIs, calcula a tabela de comissão que o Portal lê via `comercial_bmax_config`. Compartilha o Supabase `boxer-sistemas` com o Portal, mas é um app separado (Supabase Auth, hospedagem própria).
- **Política Comercial / Bíblia Mestra** — definem as regras de negócio que o código aqui implementa.
