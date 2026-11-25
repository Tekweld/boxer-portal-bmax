---
name: project-bmax-pci12-owner-switch
description: "PCI12: seletor de caminho liberado pra representante/admin + troca automática de responsável no RD (48h) enquanto pendente"
metadata:
  node_type: memory
  type: project
  modified: 2026-09-14T21:40:00.000Z
  originSessionId: 87fa48d5-0558-4034-9609-8fbcde3f3b32
---

> **HISTÓRICO (14–17/09/2026) — SUPERADO.** Regras vigentes: `DOCUMENTACAO_TECNICA.md` §6 e `project_bmax_estado_2026_11_25.md`. Hoje o prazo é de **48 horas úteis** (não corridas), existe lembrete às 24h úteis, o 12a tem prazo de 60 dias corridos com desfecho gravado no Portal, e o PCI X tem fluxo próprio. O que está abaixo descreve só o começo da funcionalidade.

## Seletor de caminho PCI12 liberado pra representante/admin (14/09/2026, commit `9205d9c`)

Antes só `role==="revenda"` podia escolher o caminho (BOX>REV / BOX+REV>IND) — checagem em 3 pontos: middleware `authorize(["revenda"])` na rota `POST /api/leads/pci` (`leads.routes.js`), checagem redundante no controller (`leads.controller.js`), e gate no front (`leads.js`, condição de exibição do seletor no card). Os 3 foram atualizados pra aceitar `["revenda", "representante", "adm"]`.

`aplicarCaminhoVenda()` (`caminhoVenda.service.js`) já era agnóstico de role — não precisou mudar. `AuditLog` já registra `req.user.role`, então dá pra saber depois quem selecionou em nome da revenda.

**Por que não tem risco de "travar":** todas as escritas do Portal no RD Station usam um único token de integração (`RD_CRM_TOKEN`, não OAuth por usuário) — o RD não distingue quem no Portal disparou a chamada. Isso já era assim pra toda ação do Portal, não é algo introduzido por essa mudança.

## Fix de normalização de PCI (defensivo)

`pci` em `rd.leads.service.js:mapDealToCard` agora sempre `.toUpperCase()` na origem (antes só removia espaço); front (`leads.js`) usa `normalizePci()` também no gate do seletor PCI12 (antes um dos dois pontos comparava string crua sem normalizar). **Não era a causa raiz** do caso investigado (lead Fabio Alessandro não mostrava o seletor) — a causa real era o usuário estar logado como **representante**, que na época não tinha permissão nenhuma de ver o seletor (ver seção acima). Mantido como melhoria defensiva.

## Troca automática de responsável durante PCI12 pendente — regra de 48h (14/09/2026, commit `ad423a0`)

Regra definida por André (14/09/2026): quando um lead vira PCI12 pendente, o responsável no RD Station passa a ser o André (`RD_OWNERS["Revenda"]` = `67efe9d367f94d002a8c4929`, já era usado assim desde 11/09/2026 por pedido dele) até a revenda escolher o caminho, **ou até 48h sem resposta** — nesse caso o responsável original (quem tinha o lead antes) é restaurado automaticamente.

### Implementação

- **Tabela nova** `bmax_pci12_tracking` (Postgres boxer-bmax): `deal_id` (PK), `owner_original_id`, `owner_original_nome`, `detectado_em`, `email_24h_enviado_em`, `revertido_em`, `resolvido_em`. Service: `src/services/pci12Tracking.service.js` (raw SQL via sequelize, mesmo padrão de `saldo.service.js` — não é um Model Sequelize).
- **Detecção**: dentro do cron diário já existente `sync-revenda-rep-rd` (`app.js`), no mesmo loop que já varria PCI12 pendentes pra mandar o e-mail imediato. Pra cada pendente: lê o owner atual do deal (`d.user._id`/`.name`), registra no tracking (`registrarTroca`, idempotente via `INSERT ... ON CONFLICT DO NOTHING RETURNING` — só troca o owner de verdade se o INSERT realmente aconteceu) e chama `updateLead(dealId, {data:{owner_id: RD_OWNERS["Revenda"]}})`.
- **Roda pra TODO pendente**, inclusive os que já estavam parados antes dessa feature existir — não depende mais do snapshot `pci12_leads_avisados` (que agora só controla se o e-mail imediato já foi mandado, não mais o tracking/troca de owner).
- **Cron novo** `/api/cron/pci12-followup`, 4x/dia (09/13/17/21h UTC — Vercel Hobby só permite 1x/dia por `schedule`, daí múltiplas entradas em `vercel.json`, mesmo padrão de `recalcular-comissoes`):
  - **≥24h sem resolver e sem e-mail 24h ainda:** manda lembrete pra revenda **e** representante (mesma lógica de busca de e-mail do aviso imediato), marca `email_24h_enviado_em`.
  - **PCI atual ≠ "PCI12"** (já resolveu, detectado via `getDealById` fresco): marca `resolvido_em`, não faz mais nada com esse deal (self-heal — cobre o caso de `aplicarCaminhoVenda` não ter marcado por algum motivo).
  - **≥48h sem resolver:** `updateLead(dealId, {data:{owner_id: owner_original_id}})`, marca `revertido_em`.
- `aplicarCaminhoVenda()` agora chama `marcarResolvido(dealId)` assim que o `updateLead` de resolução roda — não precisa reverter nada nesse ponto, porque esse mesmo `updateLead` já atribui o responsável certo via `lerPlanilhaResponsavel` (a função de resolução de responsável geográfico que já existia, usada pros dois caminhos 12A e 12B).

### Escopo — decisão confirmada por André (14/09/2026)

O tracking só pega leads que `getLeads("admin","adm")` retorna: pipeline Indústria Interno, criados a partir de 01/05/2026, excluindo Perdido/Excluído — **o mesmo recorte que já aparece pro Portal**. Ao disparar manualmente pela primeira vez (`vercel crons run`), só 3 leads entraram no tracking (Fabio Alessandro, Ezequiel/ESM, Huoli), bem menos que os ~20 PCI12 "esquecidos" achados numa investigação anterior via varredura direta da API RD (que não tinha esse filtro de pipeline/data). **André confirmou que está correto ficar assim** — não faz sentido trocar responsável de um lead que a revenda nem consegue ver/agir pelo Portal. Não é bug a corrigir; é o comportamento pretendido.

### Verificação ao vivo

- Funções de `pci12Tracking.service.js` testadas contra o Postgres de produção com deal_ids fictícios (inseridos e removidos depois) — insert idempotente, select, updates de marcação, tudo confirmado.
- Endpoint `/api/cron/pci12-followup` testado local contra deal inexistente (erro tratado, loop não quebra) e contra deal real (0h decorridas, sem disparo indevido).
- Disparo real via `vercel crons run /api/cron/sync-revenda-rep-rd` (14/09/2026, ~21:33 UTC) — confirmado direto no RD que os 3 leads pendentes tiveram `user` trocado pra André Coelho (`67efe9d367f94d002a8c4929`).

**Why:** vendedores Boxer classificam o lead como PCI12 e "somem" — sem ninguém de fato acompanhando enquanto a revenda não responde. Centralizar em André nesse meio-tempo garante acompanhamento ativo; devolver às 48h evita que o lead fique perdido em uma fila que ninguém revisita.

**How to apply:** qualquer mudança na regra de prazo (hoje 48h) ou na cadência de lembrete (hoje 24h, uma vez) mexe em `pci12-followup` (app.js) e possivelmente nos horários em `vercel.json`. Qualquer mudança em quem pode escolher o caminho do PCI12 mexe nos 3 pontos: `leads.routes.js`, `leads.controller.js`, `leads.js` (front).

## Regra de caminho corrigida: PCI12A NUNCA muda de funil (16-17/09/2026, commits `718ea1a`/`eecd26e`)

A implementação de 14/09 (acima) estava **errada** num ponto: fazia PCI12A (revenda assume) mover o deal pro pipeline "BMAX" via `RD_STAGE_ASSUMIDO`. André corrigiu: **nunca muda de funil**. Causa prática do bug: o dashboard (`getLeads`/`fetchAllDealsFromRD`) só busca deals do pipeline "INDÚSTRIA - INTERNO" — mover pra "BMAX" faz o card **desaparecer pra sempre** do painel da revenda, mesmo o RD estando "certo" por fora.

### Regra final (ambos os caminhos, mesmo pipeline)
- **BOX>REV (PCI12A):** fica em Indústria Interno, vai pra etapa **Negociação** (`RD_STAGE_NEGOCIACAO = "66151c1470449b000d54e917"`, adicionada nova em `constants.js` — antes só existia no mapa de labels `RD_STAGES`, não como constante exportada). Responsável continua André. Cria tarefa `createTask()` "Revenda Assumiu o Atendimento" documentando a decisão (API V1 do RD não tem endpoint de escrita **nem leitura** pra anotação real — `GET /annotations` também dá 404, confirmado testando várias variações de URL — tarefa é o mecanismo que de fato funciona).
- **BOX+REV>IND (PCI12B):** mesma etapa Negociação, responsável = `lerPlanilhaResponsavel(cidade,estado)` ou, se não achar, o dono original pré-troca (via `buscarOwnerOriginal()`, nova função em `pci12Tracking.service.js`) — nunca fica com André.
- `RD_STAGE_ASSUMIDO`/pipeline BMAX só entram em jogo no fechamento final (Vendido/Perdido via `updateLeadResultado`), que aí sim tira o lead do funil de propósito.

### Bugs reais achados e corrigidos no processo (não eram só do caso investigado — afetavam qualquer resolução futura)
1. **RD exige "Segmento de Produto" preenchido pra aceitar a etapa Negociação** (descoberto com erro 422 em "Fibertechnic LTDA"). PCI12 é sempre segmento "Máquinas" pela Política Comercial — `aplicarCaminhoVenda()` já manda isso automaticamente (`RD_CUSTOM_FIELDS.SEGMENTO_PRODUTO`, slug `seguimento-do-produto`).
2. **`getLeadNotes()` (anotações) 404 sem try/catch** dentro de `notificarNegociacaoAssumida` (caminho Boxer-vende) — travava a função INTEIRA antes de chegar no envio de e-mail. Histórico agora é enriquecimento opcional, protegido.
3. **`rdToUsername` devolve nome canônico, não username de login (e-mail)** — `getRepresentativeEmailByName` sempre falhava pra quem já migrou login pra e-mail (11/09/2026). Novo `rdToEmail` em `getAliasMaps()` (e-mail direto do Supabase), usado como fonte primária nos 3 lugares que notificam representante (`notificarRevendaAssumiu`, `notificarNegociacaoAssumida`, e os 2 blocos de e-mail em `app.js`).
4. **`getRevendaEmailByName()` só achava por nome exato** — grupos multi-loja no RD (Luitex Sumaré/Americana/etc, Alphabras filiais numeradas) só tinham 1 cadastro no Portal, então qualquer loja que não fosse a "principal" nunca achava e-mail. Fix: casa por `Revenda.grupo` ou substring de `Revenda.name` no nome do RD. **A Luitex sempre teve e-mail** (`marcio@luitex.com.br`) — era só esse bug de nome, não falta de cadastro.
5. **Faltava São Paulo capital em `ibge_responsaveis.json`** (10.740→10.741 linhas) — qualquer lead lá travaria "Responsável não encontrado" no caminho Boxer-vende. Adicionado: São Paulo/SP → Carlos.

### Auditoria e correção manual (17/09/2026)
Varredura de ~4.467 deals nas 2 pipelines achou 3 leads reais presos na regra antiga de 14/09 (funil errado): **Fabio Alessandro**, **Fibertechnic LTDA** (12A), **Danielle Silva-ECOPRIMOS** (12B) — todos corrigidos manualmente (funil/etapa/responsável/e-mail/tarefa) e emails reenviados incluindo revenda (após o fix #4). Achados sem ação: deals de teste (`TESTE_*_APAGAR`) e leads que já avançaram/foram perdidos por outro caminho (nunca ficaram "presos" de fato).

**Why:** mesmo motivo da troca de responsável (14/09) — mas a implementação original quebrou a visibilidade do card no Portal, o oposto do que se queria resolver.

**How to apply:** qualquer novo caminho/estágio que `aplicarCaminhoVenda()` passe a usar deve pertencer ao pipeline Indústria Interno (`66151c1470449b000d54e914`), nunca ao BMAX (`6a2bff35a294cf00226dd600`), a menos que seja fechamento final de verdade. Nunca usar `getLeadNotes()`/anotações do RD sem try/catch. Pra e-mail de representante, sempre preferir `rdToEmail` a `getRepresentativeEmailByName` com nome resolvido.
