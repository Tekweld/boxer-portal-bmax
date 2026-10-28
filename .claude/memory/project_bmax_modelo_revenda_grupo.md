---
name: project-bmax-modelo-revenda-grupo
description: "Arquitetura-alvo do Portal BMax (27-28/10/2026) — revenda com código único que agrupa lojas/CNPJs; logins e representantes ligados por código, não por nome; o que já foi feito e o que falta"
metadata:
  node_type: memory
  type: project
  originSessionId: 87fa48d5-0558-4034-9609-8fbcde3f3b32
  modified: 2026-10-28T21:01:29.418Z
---

André propôs (27/10/2026) trocar a ligação login↔revenda↔RD por **código único de revenda** (grupo), que pode **juntar vários cadastros** (CNPJs de filiais ou de outras empresas do mesmo grupo). Decisão de 28/10: **o RD mostra SÓ o nome da revenda (sem filial)** — nomes repetidos da mesma empresa pioram a usabilidade; o Portal e o Motor usam o mesmo nome.

**Modelo-alvo (ainda não implementado por completo):**
- Revenda/grupo = código único + nome no RD (único, obrigatório). Lojas/CNPJs apontam para o grupo; classe BPartner e representantes pertencem ao grupo. Leads visíveis = deals cujo REVENDA/LOJA é o nome da revenda.
- Todo login de revenda tem o campo "Revenda" (cadastro e edição de usuário); vários logins podem apontar para o mesmo grupo. CNPJ deixa de ser do login (hoje `Revendas.cnpj` é UNIQUE no Postgres e barra 2º login da mesma revenda).
- Representante com múltipla escolha de revendas pelo código; sincroniza REPRESENTANTE nos deals (`reatribuirRepresentanteDaRevendaNoRD`).
- Travas: nome único, nome novo no RD gera aviso (não cria duplicado), conferência diária.

**JÁ FEITO (28/10):** cadastro de revenda + login no mesmo passo (`revendaLogin.service.js`); nome no RD único e sempre preenchido (POST/PATCH recusam duplicado entre ativas); robô de 48h e alerta admin para lead cuja revenda não tem login (`revendaVinculo.service.js`); planilhas de proposta `Proposta_agrupamento_revendas.xlsx` e `_v2` (35 revendas ativas + 25 inativas com login/cards = 60 códigos REV-001…060; 97 lojas); 12 cards renomeados p/ o nome do login (D. SOLDAS→Aldesoldas, "25932…"→AlugaASoldas, "31023…"→Suprimig, Comercial Soldas Piracicaba→Comercial Soldas, "37662…"→Romapar, "31603…"→CS Ferramentas, Alphabras SJBV→alphabras).

**FALTA:** (1) André revisar a planilha v2 e devolver; (2) login por código (coluna + tela + filtro de leads) — destrava os 4 logins extras (AlugaASoldas/loja@alugaasolda.com.br, Casa do Soldador/fernando@casadosoldador.com.br, Cascavel Soldas/Joaocandiotto005@gmail.com, "A Bittencourt (Casa dos Parafusos)"/compras@casadosparafusos.com.br — classes Prata, Diamante, Diamante, Ouro); (3) representante multi-escolha; (4) retirar do RD os nomes antigos sem cards; (5) nome do representante único no RD (Victor Lantyer × Victor VLM).

**Why:** hoje 3 nomes por revenda (login/cadastro/RD) ligados por texto causam duplicidade, logins órfãos e leads invisíveis (caso Heitor/Suprimig).
**How to apply:** não criar logins extras com CNPJ improvisado nem apagar o índice único como paliativo sem OK; implementar por fases com simulação + backup + conferência de visibilidade login a login. Ver [[project-bmax-pendencias]] e [[feedback-portal-bmax-logica]].
