// Relatório (SOMENTE LEITURA): para cada opção do campo Representante do CRM BOXER SOLDAS, quantos cards estão ABERTOS, VENDIDOS e PERDIDOS/encerrados.
const path = require("path"); const fs = require("fs"); const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const T = process.env.PIPEFY_TOKEN_ADMIN, PIPE_ID = "307242360", CAMPO = "representante";
const gql = async (query, variables) => { const r = await fetch("https://api.pipefy.com/graphql", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + T }, body: JSON.stringify({ query, variables }) }); const j = await r.json(); if (j.errors) throw new Error(j.errors.map(e => e.message).join("; ")); return j.data; };
const VENDA = /venda efetiva|entrega tecnica/i, PERDA = /perdid|timming/i;
const cards = async v => { let c = null, t = []; for (;;) { const d = await gql(`query($p:ID!,$c:String!,$v:String!,$a:String){ findCards(pipeId:$p, search:{fieldId:$c, fieldValue:$v}, first:50, after:$a){ edges{ node{ id title created_at current_phase{ name } } } pageInfo{ hasNextPage endCursor } } }`, { p: PIPE_ID, c: CAMPO, v, a: c }); t = t.concat(d.findCards.edges.map(e => e.node)); if (!d.findCards.pageInfo.hasNextPage) break; c = d.findCards.pageInfo.endCursor; } return t; };
(async () => {
  const opcoes = (await gql(`query($id:ID!){ pipe(id:$id){ start_form_fields{ id options } } }`, { id: PIPE_ID })).pipe.start_form_fields.find(f => f.id === CAMPO).options;
  const linhas = [];
  for (const o of opcoes) {
    const cs = await cards(o); const f = { opcao: o, total: cs.length, abertos: 0, vendidos: 0, perdidos: 0, fases: {}, ultimo: null };
    for (const c of cs) { const fase = (c.current_phase && c.current_phase.name || "?").trim(); f.fases[fase] = (f.fases[fase] || 0) + 1; if (VENDA.test(fase)) f.vendidos++; else if (PERDA.test(fase)) f.perdidos++; else f.abertos++; if (!f.ultimo || c.created_at > f.ultimo) f.ultimo = c.created_at; }
    linhas.push(f);
  }
  linhas.sort((a, b) => b.total - a.total);
  fs.writeFileSync(path.resolve(ROOT, "../Documentação/Backups_Banco/pipefy_representantes_cards_24-11-2026.json"), JSON.stringify(linhas, null, 1));
  console.log(linhas.map(l => `${l.opcao.padEnd(26)} total ${String(l.total).padStart(4)} | abertos ${String(l.abertos).padStart(4)} | vendidos ${String(l.vendidos).padStart(3)} | perdidos ${String(l.perdidos).padStart(4)} | último card ${l.ultimo ? l.ultimo.slice(0, 10) : "-"}`).join("\n"));
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
