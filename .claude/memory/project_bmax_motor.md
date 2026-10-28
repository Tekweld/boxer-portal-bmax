---
name: project-bmax-motor
description: "BMax Motor PCI — classificador de leads industriais, estado atual, stack, tabelas Supabase, pendências"
metadata: 
  node_type: memory
  type: project
  atualizado: 08/09/2026
  originSessionId: 87fa48d5-0558-4034-9609-8fbcde3f3b32
  modified: 2026-10-28T21:02:14.240Z
---

## CORREÇÃO IMPORTANTE (21/09/2026) — Motor virou somente-leitura em cadastro

Boa parte do que está descrito abaixo (edição de revendas/cobertura/vendedores pelo próprio Motor, "Admin pode editar DDDs na aba Equipe Comercial sem mexer no código") **ficou desatualizado em 11/09/2026**, migration `07_lockdown_rls_portal_only.sql`: `comercial_revendas_bmax`, `comercial_bmax_config`, `comercial_bmax_cobertura` e `comercial_bmax_vendedores` passaram a aceitar escrita **só via `service_role`** — que só o Portal BMax usa. O código de escrita do Motor (`saveRev`, `saveCfg`, CRUD de `equipe.html`/`representantes.html`) continua no repo mas é **código morto** — a UI do menu admin do Motor virou um resumo com links pro Portal (`{PORTAL_URL}/#gestao`). `equipe.html`/`representantes.html` ficaram órfãs (sem link, login funciona, save falha por RLS).

Documento técnico completo (com citação de linha/commit pra cada achado, e tudo que ainda não foi 100% verificado): [`bmax-motor/DOCUMENTACAO_TECNICA.md`](https://github.com/Tekweld/bmax-motor/blob/main/DOCUMENTACAO_TECNICA.md), escrito 21/09/2026. Ler esse arquivo antes de assumir qualquer coisa sobre "onde editar X" no ecossistema BMax — a resposta hoje é quase sempre "no Portal, não no Motor".

Diamante confirmado por leitura de código (`checkDiamante()`): só entra pós-classificação, só Laser fora de SP, nunca muda PCI/comissão — só sugere revenda Diamante pra apoio de demonstração (e dá bônus de 30km na busca de "revenda no raio"). Confirma o que já estava registrado abaixo.

Hospedagem real: **Cloudflare Pages** (`bmax-motor.pages.dev`, via Wrangler nos GitHub Actions) — não Netlify (README do repo está desatualizado nesse ponto).

## BMax Motor PCI — Estado (02/08/2026)

### Localização do projeto
```
C:\Users\andre.coelho.BXSD\BOXER\Dados - Documentos\Comercial\Geral\Estrategia\2026\Projeto BMax\bmax-motor\
```
Sincronizada com SharePoint via OneDrive — trabalhar sempre neste caminho.

### URLs
- **Portal:** `https://bmax-motor.pages.dev` (Cloudflare Pages, branch main)
- **CF Access:** removido em 24/06/2026 — acesso direto requer login Supabase Auth
- **GitHub:** `Tekweld/bmax-motor`

### Stack
- Frontend: `index.html` (single-file HTML/JS, dark theme Syne+DM Sans)
- Auth: Supabase Auth (email @boxersoldas.com.br)
- Banco: Supabase `boxer-sistemas` — schema `comercial_`
  - URL: `https://bmepxcnrsofofoswubuu.supabase.co`
  - Anon key embutida no index.html (seguro — só leitura pública)
- Deploy: **auto-deploy on push** via `.github/workflows/deploy_on_push.yml` (adicionado 02/08/2026). Workflow `atualizar_bmax.yml` também deploya diariamente às 08:00 BRT.
  - `deploy_on_push.yml`: trigger `push` em `main` (paths: `index.html`, `*.css`, `*.js`) → wrangler pages deploy
  - Wrangler manual via `%LOCALAPPDATA%\bav-node\wrangler.cmd` ainda funciona como fallback

### Tabelas Supabase (criadas e em uso)
| Tabela | Descrição |
|---|---|
| `comercial_revendas_bmax` | 80 ativas / 25 inativas. Colunas auditoria: `editado_em`, `editado_por` |
| `comercial_bmax_log_revendas` | Log de ações com usuário/valores anterior+novo |
| `comercial_bmax_cobertura` | 5570 municípios BR com rep_bmax atribuído |
| `comercial_bmax_config` | Thresholds (raio, NF) + lista de reps |
| `comercial_bmax_classificacoes` | Log de classificações feitas |

### PCIs V2 — estrutura atual (16 PCIs)

**Lead Boxer (PCI1–12):**
- PCI1–3: Robô
- PCI4–6: Laser (multiplicador ×2)
- PCI7–9: Laser (multiplicador ×1)
- PCI10–12: Máquina (≥R$25k e <R$25k)

**Lead Revenda (PCI13–16):**
- PCI13–16: leads originados por revenda parceira

**PCI12 é sintético** — dual-path 12A/12B: gerado pela Boxer para máquina ≤R$25k com revenda no raio. O resultado mostra os dois caminhos possíveis lado a lado. Atendimento definitivo (12A vs 12B) definido apenas após a revenda confirmar como quer atender o lead.

### Revenda Diamante (implementado 02/08/2026, commit `2d6b891`)

Diamante é **operacional** (quem faz a demonstração), não classificatório — os 16 PCIs não mudam.

- **Elegibilidade:** produto Laser + lead fora de SP
- **Matching:** por mesorregião IBGE (137 mesorregiões, 5570 municípios populados no Supabase)
- **Banner:** aparece pós-classificação com revenda Diamante, demonstrador, e instruções (contatar Gerente Industrial, R$550 premium)
- **Campos na revenda:** `mesorregiao_ibge`, `demonstrador_nome` (condicionais — aparecem só quando classe=Diamante)
- **Chip:** `chip-d` (cyan, `rgba(37,187,238,.14)`)
- **Distância:** `BONUS_KM = { Diamante: 30, Ouro: 15, Prata: 0 }`
- **Log:** `diamante_disponivel` e `diamante_revenda_id` em `comercial_bmax_classificacoes`
- **Cobertura:** tabela `comercial_bmax_cobertura` tem coluna `mesorregiao` (populada via IBGE API)
- Função `checkDiamante(pci)` → busca revenda Diamante por mesorregião → fallback por estado

### Regra de prioridade de revendas (ordenação)

1. **≤5km do lead** → prioridade absoluta por proximidade real, independente de classe
2. **>5km** → Diamante +30km, Ouro +15km, Prata +0km na distância efetiva
3. Dentro de cada faixa, ordena por distância crescente

Constantes: `PROXIMIDADE_MAX = 5`, `BONUS_KM = { Diamante: 30, Ouro: 15, Prata: 0 }`. Função: `revendasDentro()`.

### Fluxo V2 — sequência de steps
Wizard dinâmico com `calcSteps()` que recalcula total de passos conforme seleções:
- CEP → Produto
  - Máquina (sem revenda indicante): → NF → Origem → [Condutor se revenda]
  - Máquina (com revenda indicante): → Condutor direto
  - Robô/Laser (sem revenda indicante): → Origem → [Condutor se revenda]
- NF threshold: **R$25.000** (migração V2: corrigido de R$50k para R$25k em `loadConfig()`)

### Regras de comissão — migrado para dinâmico (29/07/2026, commit `07bbcfb`)
Arrays hardcoded (`VI_STD`, `VI_LR`, `REV_CLASSES`, `EXC_CLASSES`) renomeadas com `_` prefix como fallback.
- **COM_TABELA**: JSON com `{classes:[], linhas:[{pci,agente,valores:[]}]}` — 3 linhas por PCI (VI/VT, Rep, Revenda) × 6 classes
- **COM_COMPLEMENTOS**: JSON com `[{pci,agente,condicao,valores:[]}]` — "informações complementares" (ex: rep conduz sozinho)
- Armazenamento: `comercial_bmax_config` chaves `comissao_tabela` e `comissao_complementos`
- UI: duas tabelas editáveis no painel Configurações — add/remove classes, linhas e complementos
- `buildDefaultComTabela()` / `buildDefaultComComplementos()` constroem defaults dos arrays legados na primeira carga
- Helpers: `comGetLinha(pciId, agente)`, `comGetComplementos(pciId)`

### Fixes S37 — 25/07/2026
- **Labels comissão rep:** ≥50k → ≥25k e <50k → <25k (alinhado com threshold NF real)
- **Vínculo default:** 120 → 60 dias (regra definida: 60 dias para PCIs 13-16, 30 dias para PCI 12A)
- **PCI resultado redesign:** "PCI" em fonte 32px (metade), número em 64px, gap 6px. Cards 12A/12B: "PCI" 18px, número 36px
- **EXC_CLASSES.PCI12B:** `[3.1×6]` → `[2.2,2.5,2.7,2.9,3.0,3.1]` (progressivo por classe)
- **Deploy realizado** — commit `548687d`, push main, CF Pages auto-deploy

### Alinhamento Motor × Excel × Doc V1 (verificado S36)
Todos os 16 PCIs conferidos — modelos comerciais, comissões, representante. Sem divergências restantes.
- PCI 3: BOX>IND (correto — Robô complexo demais para revenda)
- PCI 13/14/15: BOX+REV>IND (correto no Motor — Lead Revenda, Boxer vende para indústria)
- PCI 16: BOX>REV, rep:true (cenário teórico — revenda compra e revende, nunca passa pelo Motor na prática)

### Fixes S35 — 22/07/2026
- **Geocode Cobertura BMax:** `_geocodeCity()` agora converte sigla UF → nome completo via `_UF_NOMES` antes de chamar Nominatim. Sigla "SP" não é reconhecida pelo Nominatim; sem o fix, todas as buscas por cidade falhavam.
- Deploy realizado com fix aplicado.

### Fixes S34 (anteriores, desta série)
- `calcSteps()` — step counter dinâmico (não mais hardcoded no HTML)
- `goStep2Next()` — máquinas vão para NF antes de Origem
- PCI12 dual-path result com cards VI/Rep/Revenda
- Badge contextual (Lead Revenda / Rev. como compradora / Rev. no raio / Sem rev. no raio)
- `resetWiz()` — null-check em `rep-auto-msg` (TypeError que bloqueava "Nova Classificação")
- `cobRenderRevendas()` — sem fallback para lista completa do estado quando geocode falha

### Credenciais e acesso
- **Supabase Auth** (boxer-sistemas): `andre.coelho@boxersoldas.com.br` — senha não armazenada aqui por segurança
- **`.env` local** em `bmax-motor/` tem `SB_USER_PASS` — pode estar desatualizado, confirmar com André

### Revendas — estado atual
- **80 revendas ativas**, 25 inativas (mantidas como rascunho)
- `ativo` gerenciado EXCLUSIVAMENTE pelo portal — CI nunca altera
- CI (`sincronizar_excel_bmax.py`): insere novas e atualiza rep/classe/cidade/estado; NUNCA toca `ativo`

### Dropdowns revenda/representante no Passo 1 (24/08/2026, commit `996a1f3`)
- **Revenda indicante:** botão dropdown (click-only, sem digitação) lista todas revendas BMax ativas + opção "Não é Revenda BMax" que abre campo texto livre
- **Representante indicante:** mesmo padrão, lista `_repBmaxList` de `comercial_bmax_config` (chave `representantes_bmax`) + "Não é Representante BMax"
- **Override de rep:** quando representante é indicado manualmente, `repIndicante` faz override na atribuição geográfica (`leadGeo.repBmax`), badge "OVERRIDE" no resultado
- **`loadRepBmaxList()`:** carrega reps do Supabase no `initApp()` (Promise.all)
- **Click-outside:** fecha ambos dropdowns
- **`resetWiz()`:** agora chama `clearRepInd()` além de `clearRevInd()`
- Substituiu a pendência #8 (Flag Revenda Não-BMax)

### Vendedores Boxer — distribuição de áreas (atualizado 08/09/2026, commit `80fc4fe`)
| Vendedor | Tipo | DDDs | Região |
|---|---|---|---|
| Carlos | VI | 11, 12 | SP capital + Vale do Paraíba |
| Max | VT1 | 13, 14, 15, 19 | SP interior leste (Campinas, Sorocaba, Santos) |
| Lucas | VT2 | 16, 17, 18, 35 | SP interior oeste + sul MG |
| Billy | VE | fallback | Fora de SP (todo DDD não mapeado) |

- Tabela Supabase: `comercial_bmax_vendedores` (constraint tipo inclui `VE`)
- Fallback hardcoded em `index.html` sincronizado com Supabase
- Admin pode editar DDDs na aba "Equipe Comercial" sem mexer no código

### Pendências abertas
| # | Descrição |
|---|---|
| 5 | Job 3 (enriquecer_zen): bsis.db 404 no SharePoint — André disse NÃO corrigir por enquanto |
| 6 | Redirect URL — verificar que `https://bmax-motor.pages.dev` está em Supabase Auth → Redirect URLs |
| 7 | **Primeiro acesso:** adicionar texto "Primeiro acesso?" no TOPO da tela de login (acima do form) instruindo contato com Time BMax ou ADM de Vendas. "Esqueceu a senha?" permanece abaixo do botão Entrar |
| 8 | **Flag Revenda Não-BMax:** checkbox no Motor para indicar revenda não-BMax como origem. PCI classifica normalmente (BOX+REV>IND). Definido na sessão de gap analysis da Política V5 (07/08/2026) |

### Concluídas (sessão 29/07/2026)
- ~~CF Access~~ — removido: login Supabase já é restrição suficiente, externos precisam acessar
- ~~Redesign comissões~~ — tabela dinâmica + complementos (commit `07bbcfb`), deploy CF Pages
- ~~GitHub Secrets~~ — todos 7 configurados via API (SUPABASE_URL_BMAX, SUPABASE_SERVICE_KEY_BMAX, ZEN_EMAIL, ZEN_SENHA, CF_ACCOUNT_ID, CF_API_TOKEN, MSAL_TOKEN_CACHE)
- ~~MSAL token~~ — renovado 29/07/2026 para bmax-motor E bav-boxer (expira ~26/09/2026)
- ~~ZEN sync workflow~~ — fix msal dependency (commit `4ed2624`). Jobs 1,2,4,5,6 OK. Job 3 falha (ver pendência #5)
- ~~Auth~~ — reset senha e criação de usuário já implementados no código (não era pendência real)

## Consulta de Lead — avisos de CNPJ e filiais (28/10/2026)
A consulta por CNPJ (`GET /api/motor/consulta-lead` no Portal) passou a devolver `cnpjInvalido`, `unidades` (outros leads ATIVOS da mesma empresa = mesma raiz de CNPJ, CNPJ diferente, com cidade/funil/etapa/responsável e `mesmaCidade`) e `cidadeConsultada` (BrasilAPI, 3 s, pode vir nula). O Motor (`index.html`, `consultaAvisosCnpjHtml()`) mostra aviso de CNPJ inválido e destaca unidade na mesma cidade ("alinhe o atendimento"); filial em outra cidade é só informação. A Nova Negociação do Portal aplica as mesmas regras. Deploy do Motor = push em main (Actions "Deploy on Push" → Cloudflare Pages). Outra pessoa (AyrtonBoxerSoldas) também mexe na Consulta de Lead — fazer `git pull --rebase` antes de enviar. PENDENTE: workflow "Atualizar BMax (diário)" falhou em 28/10 17:02Z (run 40731844205, etapa "Sincronizar Excel → Supabase").
