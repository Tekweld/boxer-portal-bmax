---
name: feedback-portal-bmax-logica
description: "Regras de negócio e armadilhas técnicas Portal BMax: PCI 12a/12b, cashback, sync RD (dedupe case-insensitive, 504 em varredura grande), anon vs service_role, vários logins por revenda"
metadata:
  type: feedback
  originSessionId: 87fa48d5-0558-4034-9609-8fbcde3f3b32
  modified: 2026-10-28T21:02:10.911Z
---

## PCI 12a vs 12b — significado correto (planilha BMAX CRITERIOS V2)

- **PCI 12a = BOX>REV** — revenda atende o cliente diretamente
- **PCI 12b = BOX+REV>IND** — Boxer assume a venda comercial, revenda ganha comissão

O portal mostra "PCI 12" para a revenda. Ela escolhe qual caminho seguir. O sistema então marca 12a ou 12b no RD Station. Nunca mostrar 12a/12b diretamente para a revenda.

**Why:** André corrigiu em 10/08/2026 — o código tinha invertido (BOX+REV>IND=12a, BOX>REV=12b).

**How to apply:** qualquer código que mapeia caminho→PCI deve seguir esta definição. Conferir sempre com a planilha BMAX CRITERIOS V2.xlsx.

---

## PCI12a (revenda assume) NUNCA muda de funil/pipeline no RD (17/09/2026)

Corrigido depois de o card sumir pra sempre do painel da revenda: o dashboard do Portal só busca leads do pipeline "INDÚSTRIA - INTERNO" — mover pra qualquer outro pipeline (ex: "BMAX") faz o lead desaparecer do painel, mesmo que ele continue existindo e correto no RD. Isso vale tanto pra revenda-assume quanto pra Boxer-vende: os dois ficam em Indústria Interno, só mudam de **etapa** (pra "Negociação"), nunca de pipeline.

**Why:** André confirmou explicitamente — "não vamos mudar de funil" — depois de eu ter implementado (errado) a troca de pipeline pra revenda-assume.

**How to apply:** qualquer mudança de estágio no RD via `updateLead`/`aplicarCaminhoVenda` deve usar um `stage_id` que pertença ao pipeline "INDÚSTRIA - INTERNO" (`66151c1470449b000d54e914`), nunca do "BMAX" (`6a2bff35a294cf00226dd600`), a menos que seja o fechamento final (Vendido/Perdido), que aí sim sai do funil de propósito.

---

## API V1 do RD Station: anotações/notas não funcionam nem pra leitura nem escrita (17/09/2026)

`GET /annotations?deal_id=` e qualquer tentativa de `POST` (testei `/deals/:id/annotations`, `/annotations`, `/deals/:id/notes`, `/notes`) devolvem 404 (página de erro do RD Marketing, nem chega no CRM). `getLeadNotes()` em `rd.leads.service.js` ainda existe no código mas está quebrado — se chamado sem try/catch, derruba a função inteira que o chama (já aconteceu: travava o e-mail do caminho Boxer-vende).

**Why:** descoberto ao tentar implementar uma "anotação" real no RD pra documentar a escolha de caminho da revenda.

**How to apply:** nunca confiar em `getLeadNotes()`/anotações do RD pra nada crítico — sempre com try/catch, tratando como enriquecimento opcional. Pra "deixar registro" de algo no RD, usar `createTask()` (tarefas funcionam normalmente pra leitura e escrita), não anotação.

---

## `rdToUsername` devolve nome canônico, não username de login — usar `rdToEmail` pra e-mail (17/09/2026)

`getAliasMaps()` em `rd.leads.service.js` tem dois mapas: `rdToUsername[rdName]` devolve o `nome` canônico do Supabase (ex: "Victor VLM"), **não** o username de login do Postgres (que hoje é o e-mail, convenção 11/09/2026 — ver [[feedback-portal-bmax-logica]] sobre nunca cruzar por nome). Chamar `getRepresentativeEmailByName(rdToUsername[...])` falha silenciosamente pra qualquer representante que já migrou pro login por e-mail — bug que já existia há tempo, sem ninguém notar (o email do caminho Boxer-vende nunca saía de verdade, caía no fallback).

**Why:** achado ao investigar por que o e-mail de "revenda assumiu" (Victor Lantyer) não chegava.

**How to apply:** pra mandar e-mail pro representante a partir do nome que vem do RD, usar `rdToEmail[rdNameOriginal]` (novo, adicionado 17/09/2026 — e-mail direto de `comercial_representantes_bmax.email`) como fonte primária, com `getRepresentativeEmailByName()` só como fallback.

---

## `getRevendaEmailByName()` não achava grupos com múltiplas lojas (17/09/2026)

Revendas com várias filiais listadas separadamente no picklist REVENDA/LOJA do RD (Luitex Sumaré/Americana/Mogi Guaçu/Sumaré/etc; "42863 Alphabras Poços de Caldas 1"/"42546 ...2"/etc) têm só **1 cadastro no Portal por grupo** (`Revenda.grupo`). Buscar por nome exato (`Revenda.name === nomeDoRD`) só acha a loja "principal" cadastrada literalmente — todas as outras retornam null, mesmo a revenda tendo e-mail cadastrado de verdade.

**Why:** achado auditando por que "Luitex Sumaré" nunca recebia e-mail — a Luitex sempre teve e-mail cadastrado (`marcio@luitex.com.br`, no login), o problema era só esse casamento de nome.

**How to apply:** `getRevendaEmailByName()` agora cai pra um segundo passo se o match exato falhar: casa por `Revenda.grupo` contido no nome do RD, ou pelo `Revenda.name` cadastrado como substring do nome do RD (ignorando prefixo numérico de filial). Se um novo grupo multi-loja aparecer no futuro e o e-mail continuar não achando, confirmar que o campo `grupo` está preenchido certo pra essa revenda antes de assumir que falta e-mail.

---

## PCI dropdown no portal — vai até 15, correto

PCI 16 NÃO deve aparecer no portal. É classificatório (usado pelo Motor PCI) mas a revenda não ganha cashback por ele. O portal opera até PCI 15.

---

## Pipeline visível — só Indústria Interno

O portal deve mostrar leads apenas do funil **Indústria Interno**. O funil Revenda Direto não deve ser exibido.

**Why:** André definiu em 10/08/2026 — revendas não precisam ver o funil Revenda Direto.

---

## Email de notificação — routing correto

1. **Nova negociação criada** → email para o **Responsável Boxer** (Carlos, Lucas ou Max — campo "Responsável" da negociação)
2. **Revenda escolhe 12b** (BOX+REV>IND, Boxer vende) → email para o **Responsável Boxer**
3. **Revenda escolhe 12a** (BOX>REV, revenda atende) → email para a **revenda**

**Why:** André definiu: quem precisa ser avisado é quem vai atuar na venda.

---

## Canal Não-BMax — sem presença no portal

Revendas Não-BMax não usam o portal e não ganham cashback por ali. Não criar campos, flags ou fluxos para esse canal no portal.

**Why:** André esclareceu em 10/08/2026.

---

## Cashback — lógica de cálculo

Dado o PCI + classe de preço do produto → buscar percentual na tabela `comercial_bmax_config` do Supabase boxer-sistemas (chave `comissao_tabela`, mesma fonte do Motor PCI) → multiplicar pelo valor total vendido (`amount_total` no RD). Cashback só é calculado para deals no stage "Venda Efetivada". Arquivo estático `bmax_criterios.json` removido em 24/08/2026.

PCIs 13, 14, 15 usam cashback `por_classe` — o percentual varia conforme a classe de preço (1-6). Demais PCIs usam percentual fixo.

**Why:** André aprovou integração direta com Motor PCI em 24/08/2026 — qualquer alteração no Motor reflete no Portal automaticamente (cache 10min).

---

## Cashback — cards preservam valor histórico

Cards de leads vendidos mostram o valor real creditado em `bmax_transacoes`, NÃO recalculam com a comissão atual. Mudar comissão no Motor NÃO altera valores já creditados nos cards. Recálculo retroativo só via botão admin "Recalcular Comissões" no extrato.

**Why:** André definiu em 24/08/2026 — comissões antigas devem manter valores da época, a menos que admin ordene recálculo explícito.

**How to apply:** `mapDealToCard` recebe `creditosMap` com valores reais do banco. Só leads sem crédito usam cálculo teórico.

---

## Cashback — regras de expiração e uso (implementado 20/08/2026)

- **Créditos expiram em 6 meses** — contados a partir da data de creditação
- **Cheques (saques aprovados) expiram em 30 dias** — contados a partir da aprovação
- **Desconto:** valor do cheque pode representar no máximo **5%** do total do pedido
- **Bonificação:** valor do cheque pode representar no máximo **10%** do total do pedido
- Limites desconto/bonificação são **informacionais** — o portal orienta, não bloqueia
- Código do cheque deve ser inserido no campo **Observação** do pedido no ZEN
- Cron job diário às 07:00 BRT processa expirados e envia avisos (30 e 15 dias antes)

**Why:** Regras da política comercial não estavam implementadas no portal. André aprovou todas.

**How to apply:** Qualquer alteração nas regras de cashback deve refletir em: `saldo.service.js` (backend), `cashback.js` (frontend), `app.js` (cron), e na documentação.

---

## Nunca cruzar Postgres × Supabase por nome/username — só por email (14/09/2026)

O Portal usa dois bancos sem FK real entre eles: Postgres `boxer-bmax` (`Users.username` = email desde 11/09/2026) e Supabase `boxer-sistemas` (`comercial_representantes_bmax.nome` = nome de exibição mutável). Cruzar por nome causou representantes duplicados na listagem `GET /users` (fix 14/09/2026: `canonRepsByEmail` + fallback por email).

**Why:** nome de exibição pode mudar; email é a única chave estável presente nos dois lados.

**How to apply:** qualquer novo código que precise correlacionar um registro do Postgres `boxer-bmax` com um registro do Supabase `boxer-sistemas` deve casar por email (ou outra chave estável explícita), nunca por nome/username assumido igual. Vale também para RD Station — lá existe `rd_alias` justamente pra reconciliar nome canônico com o nome vivo no picklist do RD, não é bug.

---

## PostgREST upsert exige `?on_conflict=`, `Prefer: merge-duplicates` não basta (14/09/2026, generalizado 21/09/2026)

Bug já visto no Portal BMax em pelo menos 5 lugares diferentes (`/comissao-config`, `/rep-bmax-list`, `saveSnapshot` do cron `sync-revenda-rep-rd`, criar representante novo em `PUT /representantes-bmax`, espelhamento pra chave legada do Motor): sem `?on_conflict=<coluna>` na URL do POST/PUT, o Supabase REST tenta INSERT puro mesmo com o header `Prefer: resolution=merge-duplicates`.

Duas manifestações distintas do mesmo problema raiz:
1. **Erro visível:** `23505` (chave duplicada) quando o padrão usado é POST puro.
2. **Falha silenciosa, pior e mais difícil de notar:** quando o padrão usado é `PATCH filtrado por chave, com .catch() fazendo fallback pra POST` — um PATCH que não acha nenhuma linha (registro genuinamente novo) devolve `200 OK` com array vazio, NÃO lança erro. O `.catch()` nunca dispara, o fallback POST nunca roda, e a tela mostra "sucesso" sem ter gravado nada. Achado 3x em 21/09/2026 (cron de aviso PCI12, criação de representante, espelhamento legado) — sempre o mesmo padrão de código.

**Why:** o header por si só não muda o tipo da operação — o `on_conflict` na querystring é o que ativa o upsert real no PostgREST. E `res.ok` do fetch é `true` pra um PATCH de zero linhas, então `.catch()` nunca é um jeito seguro de detectar "não existia ainda".

**How to apply:** todo upsert via Supabase REST deve ser um único POST com `Prefer: resolution=merge-duplicates,return=minimal` (ou `=representation`) E `?on_conflict=<coluna-chave>` na URL — nunca um PATCH-then-catch(POST). Se aparecer 500/23505, ou se um "criar X" disser sucesso mas o X não aparecer em lugar nenhum depois, checar esse padrão primeiro.

---

## Projeto sem migration tooling: mudar um model Sequelize NUNCA muda o schema real sozinho (21-22/09/2026)

Não existe `sequelize-cli`, nem pasta `migrations/`, neste projeto. Já mordeu duas vezes: (1) 21/09 — `RevendaFilial` model existia no código, mas a tabela `RevendaFiliais` nunca foi criada em produção, quebrando toda criação de revenda nova (500 puro); (2) 22/09 — `role: ENUM(..., "funcionario")` foi adicionado ao model `User`, mas o enum `user_role` real do Postgres nunca ganhou esse valor, quebrando toda criação de usuário funcionário (`invalid input value for enum`). Em ambos os casos o código deployado ficou correto, mas quebrado, porque o banco de produção não acompanhou.

**Why:** editar um model e dar deploy dá a falsa sensação de "já mudou o banco" — sem CLI de migration, isso nunca é automático, e o erro só aparece quando alguém tenta usar a feature nova pela primeira vez em produção.

**How to apply:** toda vez que um model Sequelize ganhar uma coluna nova, uma tabela nova, ou um valor novo de ENUM, aplicar o DDL correspondente direto em produção (via MCP Supabase `apply_migration`, ou SQL manual) **no mesmo momento do deploy do código**, não depois. Antes de declarar uma feature "pronta", testar o caminho real em produção (criar o registro de verdade), não só rodar os testes locais — os testes automatizados (Jest) não pegam esse tipo de drift porque não rodam contra o Postgres de produção.

---

## "Sem Revenda" é valor legítimo pra dado, mas nunca pra crédito/agregação de saldo (21/09/2026)

`"Sem Revenda"` (venda direta, sem parceira) é diferente de placeholders de dado ruim (`"?????"`, `"N/D"` etc — lista `REVENDA_INVALIDOS`). Em telas de gestão/validação de dado, "Sem Revenda" continua uma opção válida e não deve ser tratada como erro. Mas em qualquer lugar que credita comissão de revenda ou agrega saldo por revenda, "Sem Revenda" **não pode** ser tratado como se fosse uma revenda de verdade — não existe conta pra receber, e o resultado é um saldo fantasma que polui o painel de qualquer representante que também tenha lead sem revenda (achado real: R$587,48 de uma venda de um rep apareceram no "Saldo Revendas" de outro rep completamente sem relação).

**Why:** dois lugares (`recalcularComissoes`, `getRepRevendas`) só excluíam `"?????"`, nunca `"Sem Revenda"` — o placeholder de dado ruim e o valor de negócio legítimo receberam o mesmo tratamento por engano.

**How to apply:** nova constante `REVENDA_SEM_CREDITO` (`REVENDA_INVALIDOS` + `"Sem Revenda"`) em `constants.js`, usada SÓ nos pontos de crédito de comissão e agregação de saldo por revenda — nunca na validação/exibição de dado, onde `REVENDA_INVALIDOS` (sem "Sem Revenda") continua sendo o certo.

---

## RD picklist rejeita opções duplicadas de forma case/espaço-insensível — dedupe em JS precisa ser assim também (02/10/2026)

`PUT /custom_fields/:id` do RD valida duplicata nas `opts` de um jeito case/whitespace-insensitive (`"Total Soldas"` e `"TOTAL SOLDAS"` colidem pro RD), mas o dedupe em JS (`[...new Set([...existentes, ...novos])]`) é exato-match — então qualquer par de nomes que só diferia em maiúscula/espaço (achados 9 pares reais: Total Soldas, Luitex Sbo, Atual Equipamentos, Bismark, Coamassa, D. Soldas, Demil, Ivan Ferramentas, alphabras) fazia o RD rejeitar o PUT **inteiro** com 422, silenciosamente — `syncRevendasToRD`/`syncRepresentantesToRD` vinham falhando assim por tempo indeterminado, represando toda sincronização de nome novo no picklist (confirmado: um único fix desbloqueou 20 revendas represadas de uma vez).

**Why:** ninguém tinha comparado as opções JÁ existentes no RD contra as novas computadas localmente de forma case-insensitive antes — o sintoma (422 "opções não podem ter valores duplicados") parecia aleatório/intermitente até isolar exatamente quais pares colidiam.

**How to apply:** `dedupeCaseInsensitive()` em `rd.leads.service.js` substitui o `Set` simples em `syncRevendasToRD`/`syncRepresentantesToRD` — normaliza (trim+lowercase) como chave, mantendo o valor que já existe no RD quando há colisão. Qualquer novo código que monte a lista de opções pra escrever num campo picklist do RD precisa do mesmo cuidado.

---

## Varredura completa do funil do RD (rename/reatribuir em massa) trava com 504 se a revenda tiver muitos leads (02/10/2026)

`renomearRevendaNoRD`, `renomearRepresentanteNoRD` e `reatribuirRepresentanteDaRevendaNoRD` percorrem TODO o funil do RD (não só os leads da revenda/rep em questão, pois o RD não filtra por custom field no `/deals`) pra reescrever cada deal que bate. Caso real: editar o representante da revenda Aldesoldas (31 leads dela, mas a varredura passa pelo funil inteiro da empresa) estourou o limite de 60s da função serverless (`vercel.json`) e devolveu 504 — o problema cresce com o volume total de leads no RD, não só os da revenda.

**Why:** essas três funções sempre rodaram síncronas e completas dentro da mesma requisição HTTP — funcionava enquanto o funil era pequeno, mas não escala.

**How to apply:** as três agora compartilham `varrerEAtualizarDealsNoRD()`, que aceita `{ maxMs, cursor }` e, se o tempo acabar, devolve `{ done:false, cursor }` em vez de estourar o timeout do servidor. As rotas HTTP (`PATCH /revendas-bmax/:id`, `PUT /representantes-bmax`) reservam um orçamento de tempo e, se sobrar trabalho, devolvem `continuacoesPendentes` na resposta — o front (`admin.js`, `continuarVarredurasRD`) chama `POST /revendas-bmax/continuar-rd` em loop com o cursor até `done:true`. Scripts/chamadas fora de uma request HTTP continuam rodando tudo de uma vez (comportamento de sempre, `maxMs` default `Infinity`). Qualquer nova rotina que varra todo o funil do RD precisa do mesmo padrão, não só rodar `await` direto numa rota.

---

## Rotas admin-only devem usar a chave `service_role` do Supabase, não `anon` (02/10/2026)

`admin.routes.js` usava a chave anon pra ler/escrever `comercial_representantes_bmax`/`comercial_revendas_bmax`, mesmo todas as rotas já exigindo `authenticate`+`authorize(["adm"])` do próprio JWT do Portal. A permissão GRANT/RLS pra `anon` nessas tabelas estava instável — a mesma rota, chamada segundos depois, ora respondia 401 "permission denied" ora 200 — causando sintomas intermitentes e confusos (dropdown de representante vazio às vezes, "nome não confere com o RD" mesmo estando certo, porque a lista de opções do RD também dependia da mesma chave).

**Why:** usar `anon` numa rota que já está atrás de autenticação própria do Portal não dá segurança nenhuma a mais — só expõe a rota à instabilidade de GRANT/RLS do outro projeto Supabase.

**How to apply:** `admin.routes.js` importa `sbSistemasService` (chave service_role, que ignora RLS/GRANT de anon) com o alias `sbSistemas` agora — mesma chave que `users.controller.js` já usava pras mesmas tabelas. Qualquer rota nova em `admin.routes.js` que precise ler/escrever Supabase `boxer-sistemas` deve usar essa mesma importação, nunca `sbSistemasAnon`.

---

## Vários logins podem enxergar a mesma revenda — a trava nunca foi aí (02/10/2026)

Visibilidade de leads sempre dependeu só do nome gravado no login (`Revendas.name`, Postgres), comparado direto com `REVENDA/LOJA` no RD — nunca foi "1 login por revenda" de verdade, e nada impede dois logins com o mesmo `name`. O "gargalo" que parecia existir (criar um 2º usuário pra revenda já cadastrada obrigava redigitar tudo e arriscava duplicar o cadastro Supabase) era só na camada de bookkeeping (`comercial_revendas_bmax.user_id`, 1:1 por natureza — é só o dono do cadastro/contato), nunca na visibilidade.

**Why:** André queria um jeito mais simples de dar acesso a um segundo e-mail da mesma revenda sem recriar cadastro inteiro — a resposta certa não era mudar o modelo de dado (já suportava), era só expor a funcionalidade.

**How to apply:** criar um login escolhendo um nome que já tem cadastro ativo não toca mais em `comercial_revendas_bmax` (só nasce o login + `Revendas` row). Duas rotas novas fecham o ciclo: `PATCH /admin/users/:id/revenda` (troca/limpa o nome que um login enxerga, com a mesma trava de "precisa existir de verdade no picklist do RD") e `GET /admin/revendas-bmax/:id/usuarios-vinculados` (lista TODOS os logins com aquele nome, não só o dono do cadastro). UI: botão "Trocar Revenda" na aba Usuários; seção "Usuários com acesso aos leads desta revenda" no modal Editar Revenda.

## Escopo do Portal e cashback (regra do André, 08/10/2026)

- **Só se calcula cashback de card/lead VISÍVEL no Portal.** O filtro de escopo mora em `getLeads()` (fonte única de cards, export, recálculo, crédito retroativo) — nunca criar um segundo caminho de cálculo que olhe o RD sem passar por ele.
- Fora do Portal: "Máquina de interesse" com texto **"consum"** (decisão do André: texto, não o produto "COMPRA RECORRENTE", que também pega máquinas) e produtos fora da Tabela de Preços BMax (Supabase boxer-sistemas, tabela id=2 "Automação"; Migflex, Optiarc, Flama, Spectra, máscara, regulador, tocha mig, banco de carga). Listas em `src/services/escopoBmax.service.js`.
- Lead em Venda Efetivada/Vendido/Entrega Técnica/Perdido NUNCA mostra o seletor de caminho PCI12 (front + API). PCI "12" genérico em venda finalizada é lançamento manual do time no RD — o Portal não cria isso.
- "Repetidos" do mesmo CNPJ são em geral compras recorrentes lançadas como deal novo pelo time (Carlos Fernandes, em lote); não tratar como duplicata sem o André definir a regra.

## Prazos do PCI12 e do PCI12a (regra do André, 08/10/2026 — SUBSTITUI a regra antiga de 48h)

- **PCI12 pendente:** todo PCI12 vira responsável André; **48h sem escolha → o sistema aplica PCI 12b sozinho** (etapa Negociação, responsável = dono anterior ao André, senão planilha por região). Card segue visível sem seletor, com aviso discreto "Prazo de 48h expirou"; cashback segue o 12b. Antiga regra (só devolver o responsável) foi abolida. Todo PCI12 conta, inclusive os que já nascem com André como dono (tracking `owner_original_id=''`).
- **PCI12a (revenda assumiu):** 60 dias desde que a revenda assume; **continua no funil Indústria**; vencido sem venda/perda → funil **BMAX, etapa "Prazo Vencido"** (id `...603`, no código `RD_STAGE_PERDIDO`). Vendido/perdido antes nunca é arquivado. Em Prazo Vencido o lead some do painel e não bloqueia nova negociação do mesmo CNPJ. Crons `pci12-followup` e `pci12a-prazo`, ambos com `?dry=1`.
- Lead em Venda Efetivada/Vendido/Entrega Técnica/Perdido: nunca seletor de caminho; API recusa.

## Vínculo representante ↔ RD e carteira de comissão

- Login liga ao cadastro (`comercial_representantes_bmax`) pelo **e-mail**; deal.REPRESENTANTE (texto) deve ser = cadastro.nome OU cadastro.rd_alias. Painel do representante usa nome E alias. Gestão → Representantes → "Verificar vínculos" audita.
- Cashback do representante usa o texto do campo REPRESENTANTE do DEAL (não o rep cadastrado na revenda); a carteira (`bmax_saldo` tipo_agente representante) é por esse texto → dois nomes no RD = duas carteiras (caso Caio Tito x Caio P Mancini, pendente de unificar com aval do André). Reatribuir representante da revenda grava o nome do RD (alias), nunca o do cadastro.
- Revenda: `nome_rd` curto do cadastro renomeia deals e alinha o login (Romapar, Suprimig feitos em 08/10).

## Sessão por aba

- `token`/`session` ficavam no localStorage compartilhado: logar como outro perfil em outra aba causava 403 em tela de admin. Agora `public/js/session-isolation.js` (1º script) isola por aba via sessionStorage.

## Status final x etapa (regra do André, 09/10/2026)

- **Nenhum lead ganho/perdido no RD (`win` true/false) pode ficar em etapa de andamento (Negociação).** Causa dos 15 casos: revenda escolhia caminho 12a/12b num lead já ganho e o Portal o puxava de volta pra Negociação (tarefa "Revenda Autorizou"). Hoje: API recusa, card esconde seletor/Vendido/Perdido (`fechado`), cron `status-x-etapa` corrige todo dia. Mover etapa preserva win/fechamento/valor.
- Carteira do representante sempre pelo nome do RD (alias). Caio unificado: Caio Tito = R$ 6.317,84 (backup em scripts/backups, não versionado).

## Nomes de revenda (09/10/2026)

- Menu da Nova Negociação envia nome_rd (revenda) e alias (representante), nunca o nome longo do ZEN. Comparação de REVENDA/LOJA ignora espaço nas pontas. Visibilidade por grupo = tabela bmax_grupos (Postgres, UNIQUE revenda_rd), diferente da tag grupo do cadastro Supabase.
- Plano aplicado: Via Soldas/Technofer/AlugaASoldas/Luitex Sumaré/Eletro Solda renomeados no RD; grupo Diafer completo; D. Soldas sem cadastro/login (leads foram para Aldesoldas; carteira R$3.500,16 'D. Soldas' ficou órfã); 15 logins sem cadastro vinculado ainda pendentes (ver Documentação/Plano_correcao_nomes_revenda_09-10-2026.md).

## Revenda com várias lojas (13/10/2026 — modelo Casa do Soldador/Diafer)

- Cada loja = 1 cadastro em comercial_revendas_bmax (coordenada própria, é o que o Motor usa) com nome_rd único e a mesma tag grupo; só a matriz tem user_id/e-mail/CNPJ. Visibilidade do login = bmax_grupos (grupo + cada nome_rd) + Revenda.grupo no login; RevendaFiliais (Portal) é só cadastro de endereços. Depois de criar lojas: syncRevendasToRD pra opção existir no RD. Geocodificar por endereço (Nominatim com número), não só CEP (CEP devolve o centro da cidade).
- Casa do Soldador (PR): 6 lojas, Diamante, rep Hugo Carpanese. Revendas da região inicial reativadas 13/10: Oxigênio Jundiaí, Ferragista, Oxi-Rio, Ed Maq, Ivan Ferramentas; senha inicial = prefixo do e-mail (aba Senha inicial da planilha).

- 14/10/2026: grupos com filiais prontos (Casa do Soldador, Diafer, Luitex, Alphabras, Atual Equipamentos, Cascavel Soldas, Ivan Ferramentas): 56 revendas ativas, todas com CEP/coord/CNPJ/e-mail; CNPJ é por loja (nunca copiar o da matriz). Pendentes: WST tem 2 cadastros ativos de mesmo nome/CEP e CNPJs diferentes (confirmar se é loja ou duplicata); Casa dos Parafusos fica inativa por decisão do André; Ultra Máquinas só loja de Campinas; Eletro Solda sem filial. Fonte dos dados de loja = ZEN (Nº do documento) enviado pelo André em imagem.

## WhatsApp (14/10/2026)

- Canal SÓ de aviso (nada executado por lá; sempre link do Portal). Provedor Twilio (mesmo do PMA), número novo exclusivo do BMAX (não o do PMA nem o da SDR) — número ainda a obter. Sem novidade não envia; só revenda ativa com celular válido + aceite; texto sem nome de cliente nem % de comissão. Prévia pronta (aba WhatsApp em Gestão, GET /admin/whatsapp/previa); falta Twilio+modelos Meta+cron de envio com dedupe (bmax_whatsapp_envios) e preencher celulares (3 de 63 válidos).

## Prazos sem fim de semana + horários dos robôs (14/10/2026)
- Prazos 24h/48h do PCI12 pendente contam só seg-sex (Brasília) via src/services/prazoUtil.service.js; feriados NÃO descontados. O prazo de 60 dias do PCI12a continua em dias CORRIDOS (André decidiu em 14/10/2026: só 24h/48h ignoram fim de semana).
- Playbook da revenda (DOCX, 2 páginas A4) é gerado por `scripts/gerar-playbook-revenda.py` (python-docx, do zero); versão anterior em `Documentação/Antigos/`. Conferir visual: Word instalado + pywin32 (`win32com` ExportAsFixedFormat PDF) + PyMuPDF; não há LibreOffice.
- Playbook (14/10/2026): explica Nova Negociação + trava de CNPJ em linguagem da revenda; mostra % de comissão SÓ da revenda nos PCIs em que participa (6=1,5%, 9=2%, 12B=2%, 13/14/15 por classe 1–6, tabela comissao_tabela no Supabase); NUNCA comissão de representante/VI. O Portal tem endpoint de esqueci-senha (auth.routes) mas NÃO tem link na tela de login — o playbook manda falar com o representante.
- Anexo de orçamento no card do RD só existe na API v2 (OAuth, POST /crm/v2/deals/{id}/files; refresh token rotativo, 14 dias sem uso expira — por isso o Portal NÃO volta à v2); o Portal usa V1 (token), que só tem notas (POST /activities).
- Orçamento da Nova Negociação (14-15/10/2026, decisão do André): OBRIGATÓRIO (1 a 3 arquivos) para todos os perfis, validado no servidor (`createNegociacao`) e na tela. Nota do card usa `<a href>` HTML (RD não linka URL pura nem markdown). Teste ponta a ponta com EmpresaTeste3/4 OK; erro "não é possível abrir o arquivo" nos testes veio de PDFs falsos de 26 bytes (usar PDF válido, ex. PyMuPDF `fitz`, para testar). Até 3 arquivos no Storage do Supabase (bucket privado `bmax-orcamentos`, boxer-sistemas) + UMA nota no card com link fixo `/api/orcamento/<token>` (SEM login, nunca expira, revogável). NÃO criar campo novo no RD, só a nota. Falha da nota → cron sync-revenda-rep-rd reenvia. Código: `src/services/orcamento.service.js`; DDL+bucket: `scripts/create-orcamentos.js` (rodar uma vez em produção, com confirmação).
- Robôs sync-revenda-rep-rd (detecta PCI12, troca dono p/ André, e-mail) e pci12-followup (24h/48h) rodam 07h/10h/14h/17h Brasília (10/13/17/20 UTC).
- detectado_em/assumido_em são timestamp sem fuso gravados em UTC; Vercel lê certo, script local em UTC-3 lê +3h (não é bug; usar TZ=UTC em diagnóstico).
- Logs da Vercel (vercel logs) guardam só as últimas rodadas (~1h) — não dá para investigar histórico de dias; o nível "error" do CLI costuma ser ruído (aviso DEP0169 com status 200). Para saber se um robô rodou, olhar o efeito no banco (bmax_pci12_tracking etc.).

## Regras e lições de 27-28/10/2026 (Portal BMax)
- PCI do lead da REVENDA é sempre o da regra do projeto pelo produto: Máquinas=PCI 15, Laser=PCI 14, Robô=PCI 13 (`PCI_POR_SEGMENTO`); 12a/12b é SÓ para lead enviado PELA Boxer à revenda. Perguntas na Nova Negociação (revenda, representante e admin; o campo "Funil" foi removido): Produto + Caminho (BOX>REV revenda vende | BOX+REV>IND Boxer vende e paga comissão) + "Quem atende o cliente?" (revenda → card fica no funil BMAX com dono "Revenda" e NÃO vai p/ vendedor Boxer; Boxer → Negociação/Indústria com vendedor da região ou o Responsável escolhido). PCI 12/12a/12b não faz as perguntas (nasce em Indústria Interno, fluxo PCI12). O funil é decidido só no servidor.
- Trava na criação (todos os perfis): CNPJ com dígito verificador inválido é recusado; nome igual (sem espaço/pontuação) NA MESMA CIDADE em lead ativo é recusado; CNPJ repetido continua bloqueado (André quer manter). Unidade da mesma empresa (raiz de CNPJ) na mesma cidade NÃO bloqueia: nota ATENCAO no card + aviso (Portal e Motor).
- Nome da revenda no RD é a chave única (RD, Portal, Motor): POST/PATCH em Gestão recusam duplicado entre ativas. Lead cuja REVENDA/LOJA não tem login que o veja = invisível à revenda (caso Heitor/Suprimig): o robô de 48h NÃO conta prazo nesses cards e o admin recebe alerta/e-mail ("Revenda sem login").
- Cadastro de revenda cria o login junto (senha inicial = parte do e-mail antes do @, usuário = e-mail minúsculo, acesso ao Motor, sem e-mail de credenciais a menos que marcado). `Revendas.cnpj` é UNIQUE no Postgres = 1 login por CNPJ até o modelo de revenda com código único.
- REPRESENTANTE do card da revenda é preenchido pelo cadastro (alias do RD). No RD o Victor tem 2 nomes ("Victor Lantyer" e "Victor VLM") — consolidar.
- Cards em etapa perdido/excluído não aparecem no Portal. Fechar duplicado = mover de etapa (a API não marca a etiqueta "Perdida").
- RD v1: 422 se faltar campo obrigatório da etapa (ex.: ESTADO vazio impede qualquer edição); GET /deals/:id NÃO traz `contacts` (usar /deals/:id/contacts); não apaga deals.
- Auditoria: `AuditLogs` (quem/quando/ação/metadata) + `Negociacoes` (CNPJ como digitado) + tarefas/notas do RD explicam quem criou cada card; edição direta no RD não deixa rastro na API.
- Ferramental: o PowerShell deste ambiente quebra com comandos longos com aspas/crase/&/barra-mais (chegou a tentar "apagar" um caminho por engano) — criar scripts com a ferramenta Write em scripts/_x.js, rodar e apagar pelo caminho exato; Git Bash às vezes dá erro cygwin (usar PowerShell); dotenv com quiet:true não imprime a linha "injected env" (não usar Skip 1 às cegas); Supabase às vezes responde 521/522 (tentar de novo). `git push origin main` publica sozinho (Portal na Vercel, Motor no Cloudflare Pages via Actions); push recusado por não ser fast-forward: `git pull --rebase origin main` e enviar de novo.
