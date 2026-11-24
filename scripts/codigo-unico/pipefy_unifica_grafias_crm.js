// Segunda passada: opções que só diferem por acento/caixa do nome único (ex.: "Metatronica" x "Metatrônica"). Fica só a grafia EXATA do cadastro.
// Uso: node scripts/codigo-unico/pipefy_unifica_grafias_crm.js [--aplicar]
const path = require("path"); const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const { sbSistemasService } = require(ROOT + "/src/config/supabaseSistemas"); const { norm } = require(ROOT + "/src/services/codigoUnico.service");
const T = process.env.PIPEFY_TOKEN_ADMIN, PIPE_ID = "307242360", CAMPO = "revenda_loja", APLICAR = process.argv.includes("--aplicar");
const gql = async (query, variables) => { const r = await fetch("https://api.pipefy.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + T }, body: JSON.stringify({ query, variables }) }); const j = await r.json(); if (j.errors) throw new Error(j.errors.map(e => e.message).join("; ")); return j.data; };
const cards = async v => { let c = null, t = []; for (;;) { const d = await gql(`query($p:ID!,$c:String!,$v:String!,$a:String){ findCards(pipeId:$p, search:{fieldId:$c, fieldValue:$v}, first:50, after:$a){ edges{ node{ id title } } pageInfo{ hasNextPage endCursor } } }`, { p: PIPE_ID, c: CAMPO, v, a: c }); t = t.concat(d.findCards.edges.map(e => e.node)); if (!d.findCards.pageInfo.hasNextPage) break; c = d.findCards.pageInfo.endCursor; } return t; };
(async () => {
  const campo = (await gql(`query($id:ID!){ pipe(id:$id){ start_form_fields{ id uuid label options } } }`, { id: PIPE_ID })).pipe.start_form_fields.find(f => f.id === CAMPO);
  const lojas = await sbSistemasService("/comercial_revendas_bmax?ativo=eq.true&select=nome,nome_rd");
  const exatas = new Set(lojas.map(l => String(l.nome_rd || l.nome).trim())); exatas.add("Sem revenda");
  const porNorm = {}; campo.options.forEach(o => (porNorm[norm(o)] = porNorm[norm(o)] || []).push(o));
  const sair = [];
  for (const grafias of Object.values(porNorm).filter(a => a.length > 1)) {
    const certa = grafias.find(g => exatas.has(g)); if (!certa) { console.log("sem grafia exata do cadastro, ignorado:", grafias); continue; }
    for (const errada of grafias.filter(g => g !== certa)) {
      const cs = await cards(errada); console.log(`"${errada}" -> "${certa}" (${cs.length} cards)`);
      if (APLICAR) { for (const c of cs) await gql(`mutation($c:ID!,$f:ID!,$v:[UndefinedInput]){ updateCardField(input:{card_id:$c, field_id:$f, new_value:$v}){ success } }`, { c: c.id, f: CAMPO, v: certa }); if (!(await cards(errada)).length) sair.push(errada); }
    }
  }
  if (APLICAR && sair.length) { await gql(`mutation($id:ID!,$uuid:ID!,$label:String!,$options:[String]){ updatePhaseField(input:{id:$id, uuid:$uuid, label:$label, options:$options}){ phase_field{ id } } }`, { id: CAMPO, uuid: campo.uuid, label: campo.label, options: campo.options.filter(o => !sair.includes(o)) }); console.log("removidas:", sair); }
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
