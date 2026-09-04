---
name: feedback-bmax-supabase-keys
description: BMax uses two separate Supabase projects; use project-specific service keys to avoid API routing errors — comercial_revendas_bmax lives in boxer-sistemas
metadata:
  type: feedback
  originSessionId: current
  modified: 2026-09-04T00:00:00.000Z
---

**Supabase Project Routing for BMax (corrected 2026-09-04)**

BMax stores data in TWO separate Supabase projects. Always use the correct project-specific service/anon key.

**The rule (verified against live production behavior):**
- **boxer-sistemas** (`https://bmepxcnrsofofoswubuu.supabase.co`, `SUPABASE_SERVICE_KEY_SISTEMAS` / `SUPABASE_ANON_KEY_SISTEMAS`): representantes, admins, funcionários, **and `comercial_revendas_bmax` (revenda data)**.
- **boxer-bmax** (`https://zsvtxutoewypyitajjwz.supabase.co`, `SUPABASE_SERVICE_KEY_BMAX`): confirmed NOT to contain `comercial_revendas_bmax` — querying it returns PostgREST `PGRST205: Could not find the table 'public.comercial_revendas_bmax' in the schema cache`. No confirmed legitimate use for this project has been found in the codebase as of this writing — do not assume it holds revenda data.

**Implementation in code:**
- `src/config/supabaseSistemas.js` exports `sbSistemasAnon()` — used as `sbSistemas` in `admin.routes.js`/`users.controller.js`, and as `sbFetch` in `config.routes.js`. This is the ONLY client `comercial_revendas_bmax` should go through.
- `users.controller.js`'s revenda-creation insert uses columns `nome, email, telefone, rep, cnpj, cep, cidade, estado, ativo` — note the column is `rep` (a name string), not `representante_id`.

**History — how this went wrong twice:**
1. **2026-08-26**: a session concluded revenda data lives in boxer-bmax and documented that as "the rule" here, without verifying it against a live query. `users.controller.js` was already using `sbBmax` for the revenda-creation insert at that point — this insert was wrapped in try/catch and only logged a warning on failure, so it had likely been silently failing (table not found) ever since, meaning revendas created via "Usuários" were never actually persisted to `comercial_revendas_bmax` anywhere. This is why a revenda's negociação failed at RD Station with "Não está incluído na lista" (422) — the revenda's name was never in RD Station's REVENDA/LOJA picklist because it was never in the table `syncRevendasAfterChange()` reads from.
2. **2026-09-03**: trusting this memory's (wrong) rule at face value, `admin.routes.js` (Gestão de Revendas CRUD + `syncRevendasAfterChange`) and `config.routes.js` (`fetchRevendasBmax`, the negociação form's revenda dropdown) were switched from `sbSistemas` to a new `sbBmax` client — both had been working fine on `sbSistemas` for a long time. This broke the Gestão → Revendas screen entirely (500, surfaced the same PGRST205 "table not found" error, which is what finally proved the rule was wrong).
3. **2026-09-04**: reverted `admin.routes.js`/`config.routes.js` back to `sbSistemas`, fixed `users.controller.js`'s revenda insert to use `sbSistemas` too (and corrected the column name to `rep`), and deleted `src/config/supabaseBmax.js`.

**How to apply:** For `comercial_revendas_bmax`, always use `sbSistemas`/`sbSistemasAnon` (boxer-sistemas). Before trusting any claim in this memory about which project a table lives in, verify with a live query (a PGRST205 error is the tell) rather than assuming — this file has been wrong before. After creating/editing a revenda outside `admin.routes.js`'s own CRUD (e.g. via "Usuários"), remember RD Station's picklist only updates when `syncRevendasAfterChange()` runs — that function is not currently called from `users.controller.js`'s revenda-creation flow, so an admin still needs to click "Sincronizar Revendas RD" in Gestão afterward, or manage revendas through the Gestão screen instead (which does auto-sync).

**Environment setup:** `SUPABASE_SERVICE_KEY_BMAX` exists in Vercel production but has no confirmed legitimate use in the current codebase.
