// Teste (05/11/2026) do "botão de venda" (win) do RD CRM v1 no card de teste testeSC. NÃO muda etapa nem valor.
// Uso: node scripts/teste-win-testesc-5-11-2026.js
require("dotenv").config({ quiet: true });
const T = process.env.RD_CRM_TOKEN;
const rd = async (p, m = "GET", body) => { const r = await fetch(`https://crm.rdstation.com/api/v1${p}${p.includes("?") ? "&" : "?"}token=${T}`, { method: m, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { s: r.status, j }; };
const resumo = d => ({ nome: d.name, etapa: d.deal_stage && d.deal_stage.name, win: d.win, closed_at: d.closed_at, amount_unique: d.amount_unique, amount_total: d.amount_total });
(async () => {
  const r = await rd(`/deals?name=${encodeURIComponent("testeSC")}&limit=10`);
  const achados = (r.j.deals || []).filter(d => String(d.name).toLowerCase() === "testesc");
  if (achados.length !== 1) return console.log("achados:", achados.length, "— abortando");
  const id = achados[0]._id || achados[0].id;
  console.log("antes:", JSON.stringify(resumo((await rd(`/deals/${id}`)).j)));
  for (const [rotulo, body] of [["deal.win=true", { deal: { win: true } }], ["win=true (raiz)", { win: true }]]) {
    const p = await rd(`/deals/${id}`, "PUT", body);
    const d = (await rd(`/deals/${id}`)).j;
    console.log(rotulo, "-> HTTP", p.s, JSON.stringify(resumo(d)));
    if (d.win === true) { console.log("FUNCIONOU com:", rotulo); break; }
  }
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
