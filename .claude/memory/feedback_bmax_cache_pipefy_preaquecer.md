---
name: feedback-bmax-cache-pipefy-preaquecer
description: Mudou a consulta ao Pipefy ou um filtro que depende de campo novo? Refazer o cache do Pipefy no banco LOCALMENTE antes, senão o painel fica com 0 leads (incidente 25/11/2026).
metadata:
  type: feedback
---

# Cache do Pipefy no banco: refazer localmente quando a consulta muda

**Incidente de 25/11/2026:** o deploy das 13:27 Brasília passou a pedir `labels { name }` na consulta (`CAMPOS_CARD_LISTAGEM` em `pipefy.service.js`) e a filtrar o painel por "RD: Indústria". O cache gravado em `bmax_pipefy_cache_cards` era anterior e não tinha etiquetas: 7.677 de 7.684 cards ficaram sem o campo, o filtro descartou todos e o painel mostrou 0 leads, sem erro visível, por mais de 3 horas. O cashback continuou aparecendo porque vem do razão. O auditor foi quem mostrou "0 cards".

**Por que não se resolve sozinho:** a leitura completa do pipe CRM BOXER SOLDAS (~7.700 cards, ~154 páginas) leva ~139 s e a Vercel mata a função em 60 s (`maxDuration`). A leitura completa diária dentro de uma requisição não termina, ou termina pela metade (5.293 de 7.684 linhas regravadas). Instância já no ar também ignora mudança feita no banco e continua com o cache velho em memória.

**Como foi corrigido (e como repetir):**
1. Ler o pipe inteiro localmente com o token de administrador do `.env` (`PIPEFY_TOKEN_ADMIN`, só leitura): `allCardsInPipe("307242360")` com `process.env.PIPEFY_TOKEN` apontando para esse token.
2. Gravar em `bmax_pipefy_cache_cards` (lotes de 100, `ON CONFLICT (pipe, card_id)`), apagar do cache o que não existe mais no Pipefy e atualizar `bmax_pipefy_cache_estado` (`maior_updated_at`, `ultima_leitura_completa` = agora). Conferir que todos os cards têm a chave `labels`.
3. Deploy sem mudança de código (commit vazio + push) para reiniciar as instâncias da Vercel; elas carregam o cache do banco e só fazem leituras incrementais.
O script `scripts/pre-aquecer-cache-pipefy.js` faz os passos 1 e 2, mas exige `PIPEFY_TOKEN` e o mapa (`PIPEFY_MAPA_JSON` ou `mapa_pipefy.json`), que não existem na máquina local hoje.

**Por que não blindar no código:** forçar leitura completa dentro da requisição quando faltarem etiquetas reproduziria o mesmo estouro de 60 s. Foi tentado e revertido sem deploy.

**Why:** painel vazio para todos os usuários, sem aviso.
**How to apply:** antes de publicar qualquer mudança que (a) acrescente campo à consulta do Pipefy ou (b) filtre por um campo que o cache antigo não tem, refazer o cache localmente e só então publicar. Testar o painel com a conta admin logo depois do deploy.
