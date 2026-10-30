// Teste (30/10/2026) da criação de contato no card de teste "testeSC": roda o mesmo código novo do Portal
// (validarContatoLead + criarContatoDoLead) e confere a leitura. Uso: node scripts/teste-contato-lead-30-10-2026.js [dealId]
require("dotenv").config({ quiet: true });
const l = require("../src/services/rd.leads.service");
// leitura simples (rdFetch do serviço não é exportado)
l.rdFetch = async p => (await fetch(`https://crm.rdstation.com/api/v1${p}${p.includes("?") ? "&" : "?"}token=${process.env.RD_CRM_TOKEN}`)).json();

(async () => {
  let dealId = process.argv[2];
  if (!dealId) {
    const r = await l.rdFetch(`/deals?q=${encodeURIComponent("testeSC")}&limit=10`);
    const achados = (r.deals || []).filter(d => String(d.name).toLowerCase() === "testesc");
    console.log("cards testeSC:", achados.map(d => d._id || d.id));
    if (achados.length !== 1) return console.log("Passe o dealId explicitamente.");
    dealId = achados[0]._id || achados[0].id;
  }
  const antes = await l.rdFetch(`/deals/${dealId}/contacts`);
  console.log("contatos antes:", (antes.contacts || []).length);
  const contato = l.validarContatoLead({ contato_nome: "Contato Teste Portal", contato_telefone: "(19) 99999-0000", contato_email: "teste.portal@exemplo.com.br" });
  const id = await l.criarContatoDoLead(dealId, contato);
  console.log("contato criado:", id);
  const depois = await l.rdFetch(`/deals/${dealId}/contacts`);
  console.log("contatos depois:", JSON.stringify((depois.contacts || []).map(c => ({ nome: c.name, tel: c.phones, email: c.emails })), null, 1));
  console.log("leitura do Portal:", JSON.stringify(await l.getContatoPrincipal(null, dealId, { contacts: null })));
})().catch(e => { console.error("ERRO:", e.message); process.exit(1); });
