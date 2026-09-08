---
name: feedback-bmax-supabase-keys
description: BMax uses two separate Supabase projects; use project-specific service keys to avoid API routing errors
metadata:
  type: feedback
  originSessionId: current
  modified: 2026-09-03T00:00:00.000Z
---

**Supabase Project Routing for BMax (2026-08-26)**

BMax stores data in TWO separate Supabase projects. Always use the correct project-specific service key.

**Why:** Mixing projects causes "Could not find column X in schema cache" errors. Revenda data lives in boxer-bmax; other entities in boxer-sistemas.

**The rule:**
- boxer-sistemas (https://bmepxcnrsofofoswubuu.supabase.co): representantes, admins, funcionários → use SUPABASE_SERVICE_KEY_SISTEMAS
- boxer-bmax (https://zsvtxutoewypyitajjwz.supabase.co): comercial_revendas_bmax → use SUPABASE_SERVICE_KEY_BMAX

**Implementation in code:**
- src/config/supabaseBmax.js exports sbBmax() (boxer-bmax project) — shared by users.controller.js, admin.routes.js, config.routes.js
- src/config/supabaseSistemas.js exports sbSistemasAnon() (boxer-sistemas project) — used as sbSistemas in admin.routes.js/users.controller.js, sbFetch in config.routes.js
- sbBmax() tries SUPABASE_SERVICE_KEY_BMAX first, falls back to SUPABASE_SERVICE_KEY
- 2026-09-03: found admin.routes.js (Gestão de Revendas CRUD + syncRevendasAfterChange, the function that pushes revenda names into RD Station's REVENDA/LOJA picklist) and config.routes.js (fetchRevendasBmax, the negociação form's revenda dropdown) were both querying comercial_revendas_bmax on boxer-sistemas instead of boxer-bmax — the rule below was documented but not applied everywhere. Symptom: a revenda created via "Usuários" (correctly written to boxer-bmax) never appeared in RD Station's picklist, so its negociações failed RD's deal_custom_fields validation with "Não está incluído na lista" (422). Fixed by moving all comercial_revendas_bmax reads/writes to sbBmax(); everyone querying that table must go through it.

**How to apply:** When adding new Supabase calls for revenda data (comercial_revendas_bmax), use sbBmax() from src/config/supabaseBmax.js — never sbSistemas/sbFetch. For other roles (representantes, admins, funcionários), use sbSistemas(). If adding a new table, verify which Supabase project it lives in first. After creating/editing a revenda outside admin.routes.js's own CRUD, remember RD Station's picklist only updates when syncRevendasAfterChange() runs — call it, or have an admin click "Sincronizar Revendas RD" in Gestão.

**Environment setup:** SUPABASE_SERVICE_KEY_BMAX is now in Vercel production (confirmed 2026-08-26).
