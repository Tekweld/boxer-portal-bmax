---
name: project-bmax-estado-2026-11-25
description: "ESTADO REAL do Portal/Motor BMax em 25/11/2026 (fonte de verdade): Pipefy em produção, funil por etiqueta, cashback = só o que está no razão, PCI manda na comissão, PCI12 e PCI X, pendências. Em conflito com qualquer memória de set/out, esta ganha."
metadata:
  node_type: memory
  type: project
  modified: 2026-11-25T18:00:00.000Z
---

**Regra de uso:** este arquivo descreve o projeto em 25/11/2026. Memórias de set/out (inclusive a "14/09" de comissões e PCI12) estão superadas onde divergirem. Antes de afirmar algo sobre comportamento, confira no código (`grep`), não confie em memória.

Detalhe completo (não copiar para cá, ler lá): `DOCUMENTACAO_TECNICA.md` (§6 PCI12, §6d Pipefy, §7 cashback, §9 crons, última seção 23–25/11), `PIPEFY_PENDENCIAS.md`, e na pasta do projeto `Documentação/Registro_Mudancas_Portal_BMax_23-25-11-2026.md` (contexto + **pendências atuais, §6**) e `Vendas_sem_dados_para_comissao_25-11-2026.md`.

## CRM e ids
- `CRM_PROVIDER=pipefy` em produção desde 23/11. Só o pipe **CRM BOXER SOLDAS** (id 307242360) é usado; etiquetas "RD: Indústria / BMAX / Revenda / SDR" marcam o tipo.
- Id do card: antes hex do RD, agora numérico do Pipefy; o id do RD fica em `deal.rd_deal_id`. **Toda tabela/cálculo que usa id de card precisa casar pelos DOIS ids** (`bmax_transacoes.lead_id`, `bmax_pci12_tracking`, `bmax_pci12a_prazo`, AuditLogs ainda guardam o id do RD).
- O Portal só considera cards com etiqueta **"RD: Indústria"** (painel, robô de comissões, exportação, WhatsApp). "RD: BMAX" = revenda vende sozinha: fora do painel e da comissão, só Performance. Nova Negociação cria sempre no CRM BOXER SOLDAS, fase Lead, com etiqueta e Responsável obrigatório. Risco aberto: leads novos do SDR-IA ("Qualificado") não aparecem até receberem a etiqueta.

## Cashback e comissão (regra final 25/11)
- **Nunca mostrar estimativa.** Comissão é só o que já foi creditado no razão (`bmax_saldo`/`bmax_transacoes`). Card de venda não creditada mostra "a creditar" (`cashbackPendente`); falta PCI/Classe = `cashbackFaltando`. Mesmo número em todas as abas e perfis; fonte única = razão. (O card antigo, que somava estimativa ao vivo, foi removido.)
- **O PCI manda:** só PCI 6, 9, 12b, 13, 14, 15 geram cashback para a revenda. Sem comissão: PCI12A, PCI16, PCI X (`PCI_SEM_COMISSAO` em `cashback.service.js`).
- 4 tipos de agente na tabela `comissao_tabela`: `Revenda`, `Rep`, `RepExcecao`, `VI/VT`. Exceção = representante preenchido e responsável do card = "André Coelho". Carteiras separadas por `tipo_agente`.
- **Cashback por GRUPO:** carteira única com o nome do grupo (`codigoUnico.nomeUnico`); saque confere pela soma do grupo.
- Robô `recalcular-comissoes` (4x/dia) é idempotente por lead+agente somando créditos sob os dois ids, tem `{ dryRun: true }`, e `roboMonitor.verificarCreditosAnormais` avisa os admins (>40 créditos ou >R$ 25 mil em 24 h). Incidente 24/11: virada para o Pipefy trocou o `lead_id`, o robô creditou 213 vezes de novo (R$ 114.616,97), reparado com backup. **Lição: mudou o id do card, o robô duplica crédito se não somar os dois ids.**
- Visibilidade por PCI (`visibilidadePci.service.js`, planilha mestre): revenda não vê lead sem PCI; PCI 3 aparece só como transparência, sem cashback; representante vê também 2, 5, 8, 11.

## PCI12 e PCI X (já construídos; não refazer)
- PCI12 pendente → responsável vira André; seletor "Como deseja atender este lead?" no card; **48 horas ÚTEIS** (sáb/dom não contam) sem escolha → robô aplica 12b (`pci12-followup`); lembrete às 24h úteis. 12a = revenda assume (prazo de 60 dias corridos, `pci12a-prazo`, desfecho gravado no Portal). 12a = BOX>REV, 12b = BOX+REV>IND, **nunca inverter**; não muda de funil. Vendedor do 12b vem da planilha por município (`responsavel.service.js`), não de DDD.
- PCI X (produto não BMax): sem aceite, sem comissão, prazo de 30 dias com alertas 15/25/30 e semanal (`pcix-prazo`). Andamento (7 status) e motivo de perda obrigatório em "Perdido".

## Verificado no código em 25/11 (trabalho de 14/09 que continua válido)
- CSP: `scriptSrcAttr: ["'self'","'unsafe-inline'"]` em `src/app.js` (sem isso o helmet injeta `script-src-attr 'none'` e **todo onclick inline do site trava**).
- Motor `index.html`: `applyConfig()` com guarda de null (sem ela o `initApp` abortava e "Revendas Ativas" ficava em "carregando..."); `supabase-js` servido local em `vendor/supabase.min.js`.
- `updateLead` grava o valor da venda em `amount_unique` (`amount_total` é calculado/somente leitura no RD).
- Login: `username` nasce como e-mail para todos os papéis (`users.controller.js`); `getAliasMaps()` indexa por nome E e-mail.
- Admin: Extrato de Comissões (export Excel por agente), editor visual da matriz de comissão, reatribuição de representante em lote em Revendas BMax.
- Lição de teste: regressão de CSP/UI é invisível a curl/API. Teste feature de tela clicando de verdade no navegador.

## Pendências atuais (Registro 23–25/11 §6; lá estão completas)
Agente auditor diário (2x/dia, corrige o seguro, alerta só o André) é o próximo trabalho; conferir Performance em produção (caso Rosman/Aldesoldas); juntar cards duplicados no Pipefy; ligar "Motivo de perda" ao campo do Pipefy; decidir representantes Joyce/Cristina/SANTOS; Ayrton virar admin do pipe ou trocar `PIPEFY_TOKEN`; etapa 6 do código único (aposentar `bmax_grupos`); rodar auditoria de PCI/classe das comissões.

## Documentação
`DOCUMENTACAO_TECNICA.md` §7 foi reconferida contra o código em 25/11 e corrigida (card sem estimativa, dedup no robô pelos dois ids, expiração só da revenda, PCIs que geram comissão, etapas consideradas venda). Regra para não defasar de novo: ao mudar uma regra já descrita, corrija a seção original; a seção "Atualização" no fim só registra o histórico.
