# Pendências da migração RD Station → Pipefy

Inventário de toda função que fala com o RD Station, pra acompanhar o que já
funciona com `CRM_PROVIDER=pipefy`, o que está bloqueado de propósito (nunca
grava no RD nesse modo) e o que ainda depende de uma decisão de negócio
antes de implementar. Ver `guia_bmax_pipefy.md` (local, não versionado) e o
plano da migração pro contexto completo.

## Status: Pipefy ATIVO em produção desde 23/11/2026

`CRM_PROVIDER=pipefy` está ligado em produção (Vercel). O cache por pipe
(`bmax_pipefy_cache_cards`/`bmax_pipefy_cache_estado`) já foi criado e
pré-aquecido (`scripts/create-pipefy-cache-tables.js` +
`scripts/pre-aquecer-cache-pipefy.js`, 23/11/2026) pra evitar o timeout de
cold-start (~94-139s numa leitura completa do CRM BOXER SOLDAS, 7.640+
cards, contra `maxDuration: 60` da Vercel) — ver histórico abaixo. As
tabelas `bmax_rd_pipefy_map`/`bmax_pipefy_transferencias` (usadas por
`resolverCardId`/`getDealById` pra traduzir um ID antigo do RD pro card
certo do Pipefy — sem try/catch, uma consulta num ID do RD lançaria erro se
faltassem) também já foram criadas em produção em 24/11/2026
(`scripts/create-rd-pipefy-map-table.js`/
`scripts/create-pipefy-transferencias-table.js`). O que ainda falta ou fica
permanentemente fora do escopo Pipefy está listado nas seções "Pendente de
decisão" e "Fica sempre no RD" abaixo.

## Incidente de ativação (19-23/11/2026): timeout de cold-start, resolvido com pré-aquecimento

Primeira tentativa de ligar `CRM_PROVIDER=pipefy` em produção (19/11/2026)
resultou em "0 leads" pro Admin e revendas, sem erro visível. Causa raiz
confirmada com teste local sem limite de tempo: uma leitura COMPLETA de
cache frio do CRM BOXER SOLDAS (7.640 cards) levava ~94-139s — a função da
Vercel é matada por `maxDuration: 60` (`vercel.json`) antes de responder, o
cliente nunca recebe nada, e o painel mostra 0 leads em silêncio.
`CRM_PROVIDER` foi revertido pra `rd` no mesmo dia como mitigação imediata.

Resolvido definitivamente em 23/11/2026: as tabelas de cache persistente
foram criadas em produção (`node scripts/create-pipefy-cache-tables.js`) e
o cache foi pré-aquecido rodando `node scripts/pre-aquecer-cache-pipefy.js`
localmente (sem limite de tempo), que faz a leitura completa dos 4 pipes
ativos uma única vez e grava o resultado em
`bmax_pipefy_cache_cards`/`bmax_pipefy_cache_estado`. Com isso, a primeira
requisição real na Vercel encontra o cache já quente
(`carregarCacheDoBanco`) e só faz leituras incrementais (rápidas, segundos).
`CRM_PROVIDER=pipefy` foi religado em produção no mesmo dia e confirmado
funcionando. **Esse pré-aquecimento precisa ser repetido manualmente se o
cache do banco for perdido/limpo** (ex.: nova instância de banco, reset
manual) — não há automação pra isso ainda.

## Migrada (funciona com `CRM_PROVIDER=pipefy`)

| Função | Arquivo | Observação |
|---|---|---|
| `fetchAllDealsFromRD` | `rd.leads.service.js` | Lista cards dos pipes de `PIPEFY_PIPES_PORTAL` (`fetchAllDealsPipefy`, padrão `CRM BOXER SOLDAS` desde a Fase 5, 18/11/2026 — era `INDÚSTRIA - INTERNO` até então) |
| `createLead` | `rd.leads.service.js` | Cria negociação em `CRM BOXER SOLDAS` ou `BMAX` (mesma regra de funil do RD) — liga Empresa pelo CNPJ (acha/cria, 26/10/2026); sem contato vinculado se o formulário não tiver e-mail |
| `updateLead` | `rd.leads.service.js` | Grava etapa/campos/valor/responsável (`updateLeadPipefy`); caminho "BOX+REV>IND" (etapa só existe no CRM BOXER SOLDAS) transfere o card do BMAX pra lá (`transferirCardParaIndustria`, Tarefa B1, 26/10/2026; destino atualizado na Fase 5) |
| `getLeadByCnpj` | `rd.leads.service.js` | Checagem de duplicata (`getLeadByCnpjPipefy`) — nos pipes de `PIPEFY_PIPES_PORTAL` + `BMAX` sempre |
| `getDealById` | `rd.leads.service.js` | Resolve ID do RD ou do Pipefy (`resolverCardId` + `getDealByIdPipefy`) |
| `createTask` | `rd.leads.service.js` | Vira comentário + campos "Próxima ação"/"Data da próxima ação" |
| `createNote` | `rd.leads.service.js` | Vira comentário |
| `updateTask` | `rd.leads.service.js` | Atualiza campos "Próxima ação"/"Data da próxima ação" |
| `getLeadNotes` | `rd.leads.service.js` | Lê comentários do card |
| `renomearRepresentanteNoRD` | `rd.leads.service.js` | Varre o pipe BMAX, acrescenta a opção nova no campo "Representante" e atualiza os cards em lote (Tarefa 9, 19/10/2026) |
| `renomearRevendaNoRD` | `rd.leads.service.js` | Idem, varre BMAX e REVENDA - INTERNO, campo "Revenda/Loja" |
| `reatribuirRepresentanteDaRevendaNoRD` | `rd.leads.service.js` | Idem, busca por "Revenda/Loja" mas grava em "Representante" |
| `syncRevendasToRD` | `rd.leads.service.js` | Une a lista do Supabase com as opções atuais do campo "Revenda/Loja" em BMAX, REVENDA - INTERNO e CRM BOXER SOLDAS (Fase 6, 19/11/2026) — `revendaParaPipefy` traduz a grafia de "Sem Revenda" só no CRM BOXER SOLDAS |
| `syncRepresentantesToRD` | `rd.leads.service.js` | Idem, campo "Representante" em BMAX e CRM BOXER SOLDAS |
| `getContatoPrincipal` | `rd.leads.service.js` | Nome/telefone do contato principal pro e-mail de PCI12A (`getContatoPrincipalPipefy`, Fase 6, 19/11/2026) — lê o registro conectado ao campo "Contato" do card, na database certa pro pipe (`tabelaContatoDoPipe`); "Contatos (RD)" (CRM BOXER SOLDAS) não tem campo de telefone no mapa, então pra esse pipe só o nome vem preenchido |
| `buscarLead` / `buildConsultaLeadIndex` | `rd.leads.service.js` | Consulta de Lead do Motor (Fase 7, 19/11/2026) — `fetchAllCardsConsultaLeadPipefy` (`pipefyLeads.service.js`) varre `CRM BOXER SOLDAS`, `BMAX`, `REVENDA - INTERNO` e `FUNIL SDR` (não `INDÚSTRIA - INTERNO`, decisão do usuário); reaproveita `dealParaResultado`/`dealBloqueiaDuplicata` sem mudar nenhuma delas. **Limitação de propósito**: busca por e-mail/telefone não encontra nada vindo do Pipefy — ler o Contato conectado custaria 1 chamada extra (`getTableRecord`) por card, caro demais só pra montar o índice; busca por CNPJ/nome/empresa funciona normalmente |

Consumidores indiretos (chamam `getLeads`/`getCustomField`/`mapDealToCard`,
não precisam de nenhuma mudança própria — já funcionam através do despacho
acima): `leads.controller.js`, `negociacao.service.js`,
`caminhoVenda.service.js`, `saldo.service.js`, `whatsappResumo.service.js`,
`export.routes.js`.

## Bloqueada (lança erro explícito com `CRM_PROVIDER=pipefy`, nunca grava no RD)

| Função | Arquivo | Por quê não foi migrada |
|---|---|---|
| `createOrg` | `rd.leads.service.js` | Só chamada internamente por `createLead` (RD) — nunca alcançada em modo pipefy na prática, guard mantido por defesa |

As renomeações em massa (rename de representante/revenda, reatribuição) e o
sincronismo de picklist (`syncRevendasToRD`/`syncRepresentantesToRD`) já
migraram — ver "Migrada" acima.

## Fica sempre no RD, sem bloqueio explícito (leitura, sem risco de gravar errado)

| Função | Arquivo | Observação |
|---|---|---|
| `getRdUsuariosAtivos` | `rd.leads.service.js` | Lista de usuários ativos do RD (dropdown "Responsável" na Nova Negociação) |
| `getOpcoesRevendaRD` / `getOpcoesRepresentanteRD` | `rd.leads.service.js` | Leitura de picklist, usada como blindagem antes de rename |
| `getOrg` / `getOrgByCNPJ` | `rd.leads.service.js` | `getOrg` parece sem chamador fora do próprio arquivo; `getOrgByCNPJ` só é usada internamente por `createLead` (RD) |
| `fetchAllDealsAllPipelines` | `rd.leads.service.js` | Continua existindo só pro cron `/api/cron/status-x-etapa` (`app.js:518-565`) — `buscarLead`/`buildConsultaLeadIndex` (as outras 2 chamadoras) já migraram (ver "Migrada" acima) sem tocar nesta função |

## Resolvido no adendo de 19/10/2026 (bmax_pipefy_correcoes_adendo.md)

- **Pipes que o Portal lê** (`PIPEFY_PIPES_PORTAL`): decidido — padrão
  `INDÚSTRIA - INTERNO` até a Fase 5 (18/11/2026), o mesmo (único) funil que
  o painel RD lia (`fetchAllDealsFromRD`/`RD_PIPELINE_INDUSTRIA`). **Substituído
  por `CRM BOXER SOLDAS` na Fase 5** — ver seção própria abaixo. Continua
  configurável, não hardcoded. Cada pipe adicionado precisa da sua própria
  tabela fase→etapa RD em `PIPEFY_FASE_PARA_ETAPA_RD` (`pipefyConstants.js`)
  — hoje cobertos: `BMAX`, `INDÚSTRIA - INTERNO` (mantido como referência
  histórica, fora de uso por padrão) e `CRM BOXER SOLDAS`.
- **Histórico de vendas desde 01/05/2026**: resolvido — o escopo da migração
  cresceu pra incluir as negociações **ganhas e perdidas** desde essa data
  (não só as abertas/pausadas), então saldo/comissão/cashback vão ler isso
  direto do Pipefy, sem cópia local. Pendência nova decorrente disso: os
  campos "Data de fechamento no RD" e "Motivo de perda" (citados no adendo)
  **ainda não existem** no `mapa_pipefy.json` atual — quando forem
  adicionados, só precisam entrar em `ROTULO_RD_POR_CAMPO_PIPEFY`
  (`pipefyLeads.service.js`) pra `cardParaDealFake` passar a lê-los.

## Pendente de decisão (registrado aqui, não implementado)

- **Estender as 3 rotinas de rename/reatribuição pro CRM BOXER SOLDAS**
  (`renomearRepresentanteNoPipefy`/`renomearRevendaNoPipefy`/
  `reatribuirRepresentanteDaRevendaNoPipefy`, Fase 6, 19/11/2026): hoje só
  varrem BMAX/REVENDA - INTERNO (escopo original, Tarefa 9). O sincronismo
  de picklist (`syncRevendasToRD`/`syncRepresentantesToRD`) já escreve as
  opções também no CRM BOXER SOLDAS — mas corrigir o VALOR em cards já
  existentes desse pipe (rename de verdade) é uma operação independente,
  ainda não estendida pra lá. Decisão em aberto, não assumida.
- **`getOrgByCNPJ`/`createOrg` no sentido Pipefy**: ainda sem decisão/
  implementação (ex.: sincronizar dados da Org/Empresa além do vínculo
  básico). **Resolvido em 26/10/2026**: `createLeadPipefy` passou a
  achar/criar e ligar o registro de Empresa (database Empresas Comercial)
  pelo CNPJ — mesmo padrão do Contato (achado real: um card sem Empresa não
  tinha o que `transferirCardParaIndustria`/Tarefa B1 copiar nesse campo,
  deixando o card novo sem Empresa depois da transferência). **Ajustado em
  26/10/2026**: confirmado na conta real que o database Empresas Comercial
  grava CNPJ só com números — o CNPJ do formulário é normalizado
  (`normalizeCnpj`) antes de buscar/gravar, pra um CNPJ pontuado não deixar
  de achar o registro existente e criar outro duplicado. Achar/criar a
  Empresa agora também é protegido por try/catch: se falhar, o card é criado
  do mesmo jeito (só sem Empresa vinculada), com aviso em log.
- **Consulta de Lead do Motor** (`buscarLead`/`buildConsultaLeadIndex`):
  equivalente sugerido — ler os pipes configurados em `PIPEFY_PIPES_PORTAL`
  usando o cache de `fetchAllDealsPipefy` (Tarefa 4), em vez de uma
  varredura própria.
- ~~Corte de data (`DATA_CORTE_PORTAL`) em `getLeads` pode excluir vendas
  antigas do Pipefy~~ — **resolvido em 24/11/2026.** Achado no merge com
  `upstream/main` (19/11/2026): o upstream passou a filtrar `getLeads` por
  `cutoffDate` (01/05/2026), deixando passar um card criado ANTES disso só
  se a venda foi FECHADA depois de `DATA_CORTE_VENDAS_ANTIGAS` (checagem usa
  `d.win === true && d.closed_at`). `cardParaDealFake`
  (`pipefyLeads.service.js`) não preenchia `closed_at` em nenhum card
  traduzido do Pipefy. Isso deixou de ser hipotético em 23/11/2026, quando
  `CRM_PROVIDER=pipefy` foi ativado em produção de verdade — qualquer card
  do CRM BOXER SOLDAS criado antes de 01/05/2026 (a maioria dos 7.640 cards
  migrados do RD) estava ficando fora do painel/saldo/comissão/cashback pra
  sempre, mesmo vendido depois do corte. Corrigido: `cardParaDealFake` passou
  a ler o campo "Data de fechamento no RD" (já existente no
  `mapa_pipefy.json` real, apelido do campo "Data de fechamento") e
  preencher `closed_at` com o mesmo tratamento de formato (`paraDataIso`) já
  usado pra `created_at`. "Motivo de perda" segue sem uso no Portal (nenhum
  código lê perda por motivo hoje) — fica registrado aqui só como campo já
  disponível no mapa, se algum dia for preciso.

## Confirmado na conta real em 20/10/2026 (bmax_pipefy_correcoes_adendo.md, atualização)

- **Filtro incremental de `allCards`** (`allCardsAtualizadosDesde`,
  `pipefy.service.js`, Tarefa 4): **testado e funciona** —
  `filter: { field: "updated_at", operator: gt, value: "<ISO 8601 com fuso>" }`
  devolve só os cards alterados depois da referência. A referência usada é o
  maior `updated_at` já visto no cache (não o relógio local do BMAX, pra não
  perder alterações por diferença de fuso/relógio entre os dois servidores).
  Também confirmado: os campos certos são `created_at`/`updated_at` (não
  `createdAt`, como o documento original dizia — já corrigido no código);
  `allCards` só filtra por data, nenhum campo personalizado (por isso
  `findCards` continua sendo o caminho pra achar cards por valor de campo,
  usado em `resolverCardId`/Tarefa 9); e um comentário no card também muda o
  `updated_at` (card comentado reaparece na leitura incremental — inofensivo).
- **`options` em `updatePhaseField`** (`pipefy.service.js`, Tarefa 9): o
  `uuid` obrigatório foi confirmado na conta real (achado do usuário), mas
  alterar a lista de opções de um campo de seleção via `options` não está
  documentado oficialmente — testar `renomearRepresentanteNoRD`/
  `renomearRevendaNoRD`/`reatribuirRepresentanteDaRevendaNoRD` num pipe de
  teste antes de confiar em produção.
- **`findCardsByFieldValue`/`allCardsInPipe` com paginação** (`first`/
  `after`): já eram "(conferir)" desde a Fase 1/2 — desde o 2º adendo
  (23/10/2026, Tarefa B2), `findCardsByFieldValue` já tem um caminho
  alternativo sem paginação, usado automaticamente se o Pipefy recusar
  `first`/`after` (ver item abaixo).

## 2º adendo de revisão de código (23/10/2026, bmax_pipefy_correcoes_adendo2.md)

Revisão do código das Fases 1-3 encontrou várias funções que ainda só
pensavam no pipe BMAX, ou que recebiam IDs do RD onde o Pipefy espera IDs de
card — corrigido:

- **Tradução de ID do RD** passou a acontecer em TODAS as operações
  (`updateLeadPipefy`, `createTaskPipefy`, `updateTaskPipefy`,
  `createNotePipefy`, `getLeadNotesPipefy`), não só em `getDealById` —
  `resolverCardId` também passou a procurar em todos os pipes de
  `pipesParaChecarDuplicata()` (antes só no BMAX).
- **`getDealByIdPipefy`** traduz pela tabela do pipe DO CARD
  (`nomeDoPipePorId`), não sempre BMAX — um card do INDÚSTRIA - INTERNO
  agora volta com etapa/`win` certos.
- **`updateLeadPipefy`/`createTaskPipefy`/`updateTaskPipefy`** descobrem o
  pipe do card (`nomePipeDoCard`) e usam a fase/campos DESSE pipe — com
  tradução reversa etapa do RD → fase, por pipe (`faseParaEtapaRdReversa`).
  Mudança de comportamento: uma etapa sem fase correspondente no pipe do
  card agora **lança erro e não grava nada** (antes só avisava em log e
  seguia gravando o resto).
- **`scripts/gerar-pipefy-mapa-env.js`** passou a incluir sempre BMAX e
  REVENDA - INTERNO no `PIPEFY_MAPA_JSON` gerado, além dos pipes do painel
  (`PIPEFY_PIPES_PORTAL`, lido de `pipefyConstants.js`, não mais um default
  próprio dessincronizado) — sem isso, o mapa reduzido de produção quebraria
  criação de negociação de revenda e as 3 rotinas de renomear.
  `validateEnv.js` agora avisa (sem bloquear) se REVENDA - INTERNO faltar.
- **Checagem de duplicidade de CNPJ** (`getLeadByCnpjPipefy`) não força mais
  leitura COMPLETA quando não acha no cache — força só uma leitura
  INCREMENTAL (`forcarIncremental`), reduzindo de ~18 pra ~2 chamadas por
  negociação nova checada.
- **Cache também persiste no banco** (`bmax_pipefy_cache_cards`/
  `bmax_pipefy_cache_estado`, script `scripts/create-pipefy-cache-tables.js`)
  — uma instância nova da Vercel carrega do banco antes de chamar o Pipefy,
  em vez de sempre começar com leitura completa. Best-effort: falha no banco
  nunca derruba o painel, só cai pra memória.
- **`updateFieldEmVariosCards`** divide em lotes de 30 cards por chamada.
- **`findCardsByFieldValue`** cai pra uma única chamada sem paginação se o
  Pipefy recusar `first`/`after`.
- **`paraDataIso`** (`cardParaDealFake`) trata os 2 formatos possíveis do
  campo "Data de criação no RD" (`AAAA-MM-DD` e `DD/MM/AAAA`, com ou sem
  hora) — formato desconhecido vira `null` com aviso, em vez de uma data
  errada silenciosa.

**Testado na conta real em 26/10/2026 (ver seção do 3º adendo abaixo):**
`updatePhaseField` com `options` **substitui a lista inteira** de opções do
campo — mandar a lista completa (antigas + nova) mantém todas e não muda o
campo de obrigatório↔opcional. Confirmado: as renomeações já podem ser
usadas em produção.

## 3º adendo de revisão de código (23/10/2026, bmax_pipefy_correcoes_adendo3.md)

Revisão das correções do 2º adendo (A1-A6, B1, B2, B4, C1, C2 — todas
implementadas e testadas, 109/109 à época) encontrou mais 2 itens a corrigir
antes da virada, 1 decisão de negócio pendente, e 3 pontos pra testar na
conta real:

- **`salvarCardsNoBanco`** (cache no banco, A6 do 2º adendo) gravava **um
  card por consulta** — numa leitura completa do INDÚSTRIA - INTERNO
  (~850 cards), isso é ~850 consultas seguidas dentro da própria requisição
  do painel, risco real de estourar o tempo-limite da função na Vercel.
  Corrigido: grava em lotes de 100, um único `INSERT ... VALUES (...），(...)...`
  por lote (3 consultas pra 250 cards, por exemplo), sempre com os
  parâmetros via replacements nomeados (nunca concatenando o conteúdo do
  card no texto da consulta).
- **Dois ajustes de consistência no cache** (`atualizarPipeNoCache`/
  `atualizarCardNoCache`): (1) quando a leitura incremental falha e cai pra
  uma leitura completa de reserva, o resultado agora **substitui** o mapa em
  memória (e o que sobrou é passado pro `removerCardsApagadosDoBanco`), em
  vez de só somar — antes, um card apagado/movido pra outro pipe nesse
  cenário ficava preso no cache até a próxima leitura diária; (2) quando
  `atualizarCardNoCache` descobre que um card sumiu (`getCard` devolve
  vazio), a linha correspondente também é apagada de
  `bmax_pipefy_cache_cards` — antes só saía da memória e voltava sozinha na
  próxima instância nova da Vercel. O comportamento de **não** avançar
  `maiorUpdatedAt` na gravação do próprio card foi revisado e mantido de
  propósito (avançar perderia alterações de outras pessoas feitas no
  intervalo) — só ganhou um comentário no código explicando a decisão.

**Decisão tomada e implementada em 26/10/2026 — Tarefa B1 do 3º adendo:** o
caminho de venda "BOX+REV>IND" (`aplicarCaminhoVenda`,
`caminhoVenda.service.js`) pede a etapa "Negociação" pra um card do BMAX —
que não tem essa fase (só existe no INDÚSTRIA - INTERNO, como "NEGOCIAÇÃO").
Como o Pipefy não move card entre pipes, `updateLeadPipefy`
(`pipefyLeads.service.js`, `transferirCardParaIndustria`) agora, nesse caso
específico:
1. lê o card de origem;
2. cria um card NOVO no INDÚSTRIA - INTERNO, direto na fase "NEGOCIAÇÃO",
   copiando os campos que existirem nos dois pipes (Contato, Empresa, CNPJ,
   Cidade, Estado, Representante, Revenda/Loja, Máquina de interesse,
   Oportunidade de venda, Frente de trabalho, Segmento de produto, Classe de
   preço, Fonte, Campanha, ID no RD CRM), sempre com PCI (`"Sem PCI"` se a
   origem não tiver — obrigatório nesse pipe) e com "Valor total"/"Data de
   criação no RD" convertidos do formato BR do Pipefy (`1.234,56`/
   `12/05/2026`, confirmado na conta real) pro formato interno
   (`1234.56`/`AAAA-MM-DD`) — sem "Data de criação no RD" na origem, usa o
   `created_at` do próprio card. **Correção testada na conta real,
   26/10/2026**: "Contato"/"Empresa" são campos de CONEXÃO — o `value` do
   card de origem traz os TÍTULOS dos registros ligados, não os IDs
   (gravar isso de volta faz o Pipefy ignorar a conexão em silêncio, sem
   erro); os IDs de verdade vêm de `array_value`/`connectedRepoItems[].id`
   (`getCard` agora pede os dois — `pipefy.service.js`), confirmados iguais
   entre si na conta real. Sem ID conectado, o campo não é copiado e um
   aviso é logado com os dois IDs de card;
3. comenta a ligação nos dois cards;
4. copia o responsável (assignees) do card de origem pro novo (sobrescrito
   depois se o `body` da chamada trouxer outro `owner_id`);
5. move o card de origem pra uma fase final própria do BMAX, "Transferido
   para a Indústria" (mapeada em `PIPEFY_FASE_PARA_ETAPA_RD.BMAX` pra ficar
   fora do painel e da checagem de duplicidade);
6. grava a ligação em `bmax_pipefy_transferencias` (script
   `scripts/create-pipefy-transferencias-table.js`).

Se a criação do card novo falhar, nada mais acontece (nem o de origem é
movido, nem a ligação é gravada) e o erro sobe. As etapas seguintes (3-6)
falhando só registram o erro em log com os dois IDs, pra correção à mão — o
card novo já existe, que é a parte que importa. `resolverCardId` passa a
seguir a ligação em `bmax_pipefy_transferencias` (até o card vivo, inclusive
em cadeia) depois de resolver um ID do RD, então as tabelas do BMAX que
guardam o ID antigo continuam funcionando sem nenhuma migração.

**Testado na conta real em 26/10/2026 (todos os 4 pontos da seção 3 do 3º
adendo) — resultado de cada um:**

- [x] **Formato de data e valor que o Pipefy devolve de verdade**: datas
  vêm como `DD/MM/AAAA` (ex.: `12/05/2026`) e valores em formato BR
  (ex.: `1.234,56`), **mesmo quando gravados como `2026-05-12` e `1234.56`**
  — o Pipefy normaliza na leitura. `paraDataIso` já cobre `DD/MM/AAAA`; via
  este adendo, `parseValorMonetario` foi corrigido (ver abaixo) pra também
  cobrir o padrão de milhar BR sem vírgula (ex.: `1.000`).
- [x] **Troca do responsável** (`updateCardAssignees`, `updateCard` com
  `assignee_ids`): funciona.
- [x] **Troca das opções de um campo** (`updatePhaseField` com `options`):
  **substitui a lista inteira** de opções — mandar a lista completa
  (antigas + nova) mantém todas as antigas e não muda o campo de
  obrigatório↔opcional. As 3 rotinas de renomear já mandam a lista
  completa (leem via `getStartFormFields`, acrescentam a opção nova,
  mandam tudo de volta) — nenhuma mudança de código necessária aqui, só a
  confirmação. **Renomeações liberadas pra uso em produção.**
- [x] **Paginação do `findCards`**: o Pipefy aceita `first`/`after`
  normalmente — o caminho sem paginação (`findCardsByFieldValueSemPaginacao`,
  Tarefa B2 do 2º adendo) é só um fallback defensivo, não entra em uso na
  prática.

**Dois ajustes feitos a partir desses testes (3º adendo, seção 3, itens 1 e
2 — cada um com teste novo):**

- **`parseValorMonetario`** não tratava corretamente o padrão de milhar BR
  SEM vírgula (ex.: `"1.000"` virava `1`, não `1000` — o `.` era lido como
  ponto decimal). Corrigido: sem vírgula, um valor no formato
  `\d{1,3}(\.\d{3})+` (ex.: `1.000`, `1.234.567`) tem os pontos removidos
  antes de converter. Casos confirmados com teste:
  `"1.234,56"` → `1234.56`, `"1.234.567,89"` → `1234567.89`,
  `"0,50"` → `0.5`, `"1.000"` → `1000`.
- **Rotinas de renomear** (`renomearRepresentanteNoPipefy`/
  `renomearRevendaNoPipefy`/`reatribuirRepresentanteDaRevendaNoPipefy`, via
  `acrescentarOpcaoSeFaltar`) já liam a lista ATUAL do campo
  (`getStartFormFields`) e mandavam a lista completa de volta — confirmado
  com um teste novo (campo com 3 opções, renomeia 1, as outras 2 continuam
  na lista enviada ao `updatePhaseField`).

## Fase 5 — troca de pipe do painel: INDÚSTRIA - INTERNO → CRM BOXER SOLDAS (18/11/2026)

O pipe `[Dev.Stegia] CRM` (id `307242360`) foi renomeado pra **"CRM BOXER
SOLDAS"** e ganhou os campos que faltavam (Representante, Revenda/Loja,
Frente de trabalho, Segmento de produto, Classe de preço, Oportunidade de
venda, Empresa, Contatos, Motivo de perda). **Decidido com o usuário: esse
pipe substitui `INDÚSTRIA - INTERNO`** como fonte do painel
(`PIPEFY_PIPES_PORTAL`), destino de criação de negociação "indústria"
(`escolherPipeDaNegociacao`) e destino da transferência BOX+REV>IND
(`DESTINO_TRANSFERENCIA_POR_ETAPA`). `INDÚSTRIA - INTERNO` continua mapeado
em `mapa_pipefy.json`/`PIPEFY_FASE_PARA_ETAPA_RD` só como referência
histórica/rollback, fora de uso por padrão.

Esse pipe tem rótulos de campo diferentes dos outros 4 — resolvido com
apelidos no `mapa_pipefy.json` (chave do nosso `campos{}` não precisa bater
com o rótulo literal do Pipefy): `"ID no RD"` → `ID no RD CRM`,
`"Contatos"` (plural) → `Contato`, `"Data de criação (RD)"` → `Data de
criação no RD`, `"Data de fechamento"` → `Data de fechamento no RD`. O campo
`"Título"` não existe nesse pipe — `createLeadPipefy`/
`transferirCardParaIndustria` tratam esse campo como opcional agora (antes
exigiam sempre).

**Pendências enviadas ao Comercial (o usuário decidiu seguir com uma solução
provisória no código enquanto aguarda a decisão deles):**

- **Grafia/opções do campo PCI — resolvido/fechado em 19/11/2026**: o campo
  equivalente nesse pipe é `"Perfil PCI 🤖"` (apelidado de `PCI`). Tinha 20
  opções (`PCI 1`…`PCI 18`, `PCI 12A`, `PCI 12B` maiúsculo), sem a opção
  `Sem PCI`, diferente do PCI formal de 21 opções (`PIPEFY_PCI_OPCOES`, que
  usa `12a`/`12b` minúsculo). O Comercial adicionou a opção `"Sem PCI"` ao
  campo — confirmado ao vivo na conta real (grafia idêntica à do padrão
  formal, campo continua opcional) — e a tradução `"Sem PCI"` ↔ campo vazio
  (que antes fazia esse valor ser omitido na gravação) foi removida: agora é
  enviado/lido como qualquer outro valor, sem alias. Quanto a `12a`/`12b`
  minúsculo (padrão formal) vs. `12A`/`12B` maiúsculo (esse pipe): **decisão
  do usuário, 19/11/2026 — manter a tradução automática permanentemente**,
  em vez de pedir ao Comercial pra padronizar a caixa das opções no Pipefy.
  `pciParaPipefy`/`pciDoPipefy` (`pipefyConstants.js`) continuam traduzindo
  só essa parte, nos dois sentidos, como solução definitiva — não como algo
  provisório aguardando decisão. Pendência encerrada.

**Resolvido em 19/11/2026 — fase `"Timming "`:** o Comercial confirmou que
essa fase (com espaço no final, nome exato) fica de propósito **fora do
fluxo do BMAX**. Mapeada em `PIPEFY_FASE_PARA_ETAPA_RD["CRM BOXER SOLDAS"]`
com `{ etapa: RD_STAGE_EXCLUIDO, win: false }` — mesmo tratamento já usado em
`BMAX["Transferido para a Indústria"]`: tira o card do painel (`getLeads`
exclui `RD_STAGE_EXCLUIDO`) e da checagem de duplicidade
(`dealBloqueiaDuplicata` só bloqueia quando `win` é `null`). Não precisou de
nenhum mecanismo novo de filtro — só reaproveitou o que já existia.

## Teste real na conta (18/11/2026) — 3 achados confirmados, 2 corrigidos, 1 em aberto

Testado de verdade contra a conta (`createLeadPipefy` direto no CRM BOXER
SOLDAS, e a transferência BOX+REV>IND de um card do BMAX pra lá), com
limpeza de tudo que foi criado (cards e registros de Contato/Empresa) ao
final de cada rodada.

- **[CORRIGIDO] Campo "Nome Fantasia" obrigatório, sem apelido nenhum**:
  o pipe exige esse campo (`required: true`) pra criar qualquer card — sem
  um apelido `"Título" → "nome_fantasia"` em `mapa_pipefy.json`, **toda**
  criação de negociação nesse pipe falhava com `"O campo Nome Fantasia é
  obrigatório"`. A suposição inicial (Fase 5) de que "esse pipe não tem
  campo de Título, trata como opcional" estava incompleta — o pipe tem um
  campo equivalente, só que obrigatório e com outro nome. Corrigido:
  `mapa_pipefy.json` ganhou esse apelido; o tratamento "opcional" no código
  (`createLeadPipefy`/`transferirCardParaIndustria`) continua existindo
  como rede de segurança (não quebra se um pipe futuro genuinamente não
  tiver equivalente).
- **[CORRIGIDO] Opção "Sem Revenda" do campo Revenda/Loja com grafia
  diferente**: a opção real desse pipe é `"Sem revenda"` (minúsculo) — o
  resto do sistema usa `"Sem Revenda"` (maiúsculo, `matchRevendaRD` em
  `rd.leads.service.js`, usado em toda a lógica de comissão/saldo/painel).
  Sem a correção, **toda negociação sem revenda** criada nesse pipe seria
  recusada pelo Pipefy. As ~100 revendas nomeadas parecem idênticas nos dois
  pipes (checado por amostragem, não por diff completo). Corrigido com o
  mesmo padrão do PCI: `revendaParaPipefy`/`revendaDoPipefy`
  (`pipefyConstants.js`), aplicado na criação, na transferência BOX+REV>IND
  e na leitura (`cardParaDealFake`).
- **[CORRIGIDO] Campos conectores `Empresa`/`Contatos` ligados a databases
  DIFERENTES**: confirmado por introspecção do schema do Pipefy
  (`connectedRepo` de `PhaseField`, via query direta — o usuário também
  mandou um print da tela confirmando empresas que não existem em
  `Empresas Comercial`) que os campos "Empresa"/"Contatos" do CRM BOXER
  SOLDAS estão ligados a **"Empresas (RD)"** (`UE06vL-p`) e **"Contatos
  (RD)"** (`-_tk5FcR`) — bases diferentes de `Empresas Comercial`/`Contatos
  Comercial` usadas pelos outros 3 pipes, com ~2.500 registros reais cada
  (prováveis da migração de marketing). Sem essa descoberta, o campo era
  gravado com o ID de um registro de `Empresas Comercial`, que o Pipefy
  **ignorava em silêncio** (card criado normalmente, campo de conexão
  ficava vazio — nenhum erro).
  Corrigido: `mapa_pipefy.json` ganhou as entradas `empresasRD`/`contatosRD`
  (id + campos "Nome"/"CNPJ"/"E-mail" dessas duas tabelas);
  `tabelaEmpresaDoPipe`/`tabelaContatoDoPipe` (`pipefyConstants.js`)
  resolvem qual database usar por pipe (CRM BOXER SOLDAS → RD; qualquer
  outro pipe → Comercial, como antes); `createLeadPipefy` passou a achar/
  criar o registro na tabela certa pro pipe de destino. **Testado de
  verdade**: criação direta no CRM BOXER SOLDAS agora liga Empresa e
  Contato corretamente (confirmado lendo o card de volta,
  `connectedRepoItems` preenchido).
  **[CORRIGIDO] Transferência BOX+REV>IND também ajustada**: a cópia direta
  de ID (`idsConectadosPorCampoId`) só funciona quando origem e destino
  usam a MESMA database — entre BMAX (`Empresas Comercial`/`Contatos
  Comercial`) e CRM BOXER SOLDAS (`Empresas (RD)`/`Contatos (RD)`) não é o
  caso. Nova função `idsConectorNaBaseDoDestino`
  (`pipefyLeads.service.js`): quando origem e destino divergem de
  database, lê o registro de origem por inteiro (`getTableRecord`, novo em
  `pipefy.service.js` — `table_record(id)` do schema do Pipefy, confirmado
  ao vivo) pra extrair o e-mail (Contato) ou CNPJ (Empresa), e então
  acha/cria o equivalente na database do destino (mesmo padrão de
  `createLeadPipefy`). Quando origem e destino usam a mesma database (ex.:
  entre pipes que ainda compartilham Comercial), a cópia direta de ID
  continua sem nenhuma chamada extra. **Testado de verdade**: card criado
  pela transferência agora sai com Empresa e Contato linkados nas tabelas
  RD certas (confirmado lendo o card de volta).
- **Confirmado, não é bug**: o campo "CNPJ" do CRM BOXER SOLDAS valida o
  formato/dígito verificador de verdade (recusou um CNPJ inventado no
  teste) — diferente do BMAX/INDÚSTRIA, que aceitam qualquer string. Não
  deve afetar CNPJs reais de empresas de verdade, só registrado aqui pra não
  surpreender em outro teste.

## Fase 7 — Consulta de Lead do Motor no Pipefy (19/11/2026)

`buscarLead`/`buildConsultaLeadIndex` migrados — ver "Migrada" acima.
Decidido com o usuário: cobre os 4 pipes ativos (`CRM BOXER SOLDAS`,
`BMAX`, `REVENDA - INTERNO`, `FUNIL SDR`; `INDÚSTRIA - INTERNO` fica de
fora) e **não busca por e-mail/telefone** (custo de 1 chamada extra por
card, inviável pro orçamento mensal da empresa) — só CNPJ/nome/empresa.

`PIPEFY_FASE_PARA_ETAPA_RD["REVENDA - INTERNO"]`/`["FUNIL SDR"]`
(`pipefyConstants.js`) ganharam entradas VAZIAS (`{}`, não ausentes) só pra
silenciar o aviso de "pipe sem tabela configurada" durante a varredura
desses 2 pipes — não é uma tradução fase→etapa real (o "estagio" exibido
ao usuário já vem do nome bruto da fase, não dessa tabela). Efeito
colateral aceito: sem um `win` conhecido pra esses 2 pipes,
`dealBloqueiaDuplicata` sempre trata um resultado deles como "bloqueia
nova negociação" — o lado seguro, não uma tradução de verdade. Se um dia
precisar escrever etapa nesses pipes, mapear de verdade então.

`scripts/gerar-pipefy-mapa-env.js` passou a incluir `FUNIL SDR` sempre
(junto de BMAX/REVENDA - INTERNO, Tarefa A4) — sem isso, a Consulta de
Lead quebraria em produção assim que o `PIPEFY_MAPA_JSON` fosse
regenerado/subido. `pipefy-mapa-env.txt` (local) já foi regenerado com
`FUNIL SDR` incluído.

**Resolvido por desenho, não precisa de equivalente (19/11/2026)**: o cron
`/api/cron/status-x-etapa` (`app.js:518-565`) existe pra corrigir deals do
RD onde `win` (ganha/perdida) e `deal_stage` divergem — possível lá porque,
no RD, `win` é um campo INDEPENDENTE da etapa (pode ser gravado numa
chamada separada, e os dois podem ficar incoerentes). No Pipefy, `win`
nunca é um campo próprio do card — é sempre DERIVADO da fase atual, via
`PIPEFY_FASE_PARA_ETAPA_RD` (`cardParaDealFake`, `pipefyLeads.service.js`).
Como `win` é só uma função da fase, os dois nunca podem divergir entre si
por construção — a classe de bug que esse cron corrige simplesmente não
ocorre no desenho atual da integração. `fetchAllDealsAllPipelines`
continua RD-only (ver "Fica sempre no RD" acima) só porque esse cron
continua sendo RD-only — não é mais uma pendência em aberto.

## Atualização 25/11/2026

- Pipefy é o CRM em produção; só o pipe **CRM BOXER SOLDAS** é usado. O id do RD fica em "ID no RD CRM" (`deal.rd_deal_id`).
- Campo "Revenda/Loja" unificado com os nomes únicos (75 opções). Representante: limpeza parcial, ver `Documentação/Registro_Mudancas_Portal_BMax_23-25-11-2026.md`.
- **Pendente:** o `PIPEFY_TOKEN` da Vercel é de usuário "member" (sem permissão para editar opções de campo): tornar administrador ou trocar por token de administrador/usuário de serviço.
- **Pendente:** conectar o "Motivo de perda" do Portal ao campo "Motivo de perda" do Pipefy.
- **Pendente:** juntar/encerrar cards duplicados de verdade no CRM (mesma venda em 2 cards, herdados do RD).
