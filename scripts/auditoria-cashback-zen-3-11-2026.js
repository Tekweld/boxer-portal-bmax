// AUDITORIA SOMENTE LEITURA: cruza os cards do RD (vendidos e em aberto com revenda) com as notas fiscais de saída do
// ZEN pelo CNPJ do cliente. Não escreve nada no RD, no ZEN nem no banco.
// Uso: node scripts/auditoria-cashback-zen-3-11-2026.js <caminho do .env com ZEN_EMAIL/ZEN_SENHA> [saida.xlsx]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const { calcularComissoes } = require("../src/services/cashback.service");
const db = require("../src/database");
const { QueryTypes } = require("sequelize");

const envZen = {};
for (const linha of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) { const m = linha.match(/^(ZEN_[A-Z_]+)=(.*)$/); if (m) envZen[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const SAIDA = process.argv[3] || path.join(__dirname, "..", "..", "Documentação", "Auditoria_cashback_x_ZEN_03-11-2026.xlsx");
const ZEN = "https://api.zenerp.app.br";
let H = null;
async function auth() {
  const t = (await (await fetch(ZEN + "/system/security/tokenOpRequest", { method: "POST", headers: { tenant: "boxer", "Content-Type": "application/json" }, body: JSON.stringify({ email: envZen.ZEN_EMAIL, password: envZen.ZEN_SENHA }) })).text()).trim().replace(/^"|"$/g, "");
  H = { Authorization: "Bearer " + t, tenant: "boxer" };
}
async function zget(p, q, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(ZEN + p + "?" + new URLSearchParams(q), { headers: H, signal: AbortSignal.timeout(15000) });
      if (r.status === 401) { await auth(); continue; }
      if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 120));
      return await r.json();
    } catch (e) { if (i === tentativas - 1) throw e; await new Promise(s => setTimeout(s, 800 * (i + 1))); }
  }
}
const so = s => String(s || "").replace(/\D/g, "");
const mascara = d => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
const dia = s => String(s || "").slice(0, 10);

async function pool(itens, n, fn) {
  const out = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const k = i++; out[k] = await fn(itens[k], k); } }));
  return out;
}

(async () => {
  await auth();
  const deals = await l.getLeads("admin", "adm");
  const vendaStages = new Set([C.RD_STAGE_VENDIDO, C.RD_STAGE_VENDA_EFETIVADA, C.RD_STAGE_ENTREGA_TECNICA]);
  const abertoStages = new Set([C.RD_STAGE_ASSUMIDO, C.RD_STAGE_NEGOCIACAO, C.RD_STAGE_LEAD]);
  const linhas = [];
  for (const d of deals) {
    const stageId = d.deal_stage && d.deal_stage.id;
    const revenda = l.getCustomField(d, "REVENDA/LOJA") || "";
    const cnpj = so(l.getCustomField(d, "CNPJ"));
    const pci = (l.getCustomField(d, "PERFIL PCI") || "").trim();
    const pciN = pci.replace(/\s/g, "").toUpperCase();
    const vendido = vendaStages.has(stageId);
    const aberto = abertoStages.has(stageId) && /^PCI(12A|12B|13|14|15)$/.test(pciN);
    if (!(vendido || aberto) || !revenda || revenda === "Sem Revenda" || revenda === "?????") continue;
    linhas.push({ dealId: d.id || d._id, nome: d.name, cnpj, revenda, pci, classe: (l.getCustomField(d, "CLASSE DE PREÇO") || "").replace(/\D/g, ""), etapa: d.deal_stage && d.deal_stage.name, status: vendido ? "Vendido" : "Em aberto", valorCard: Number(d.amount_total || 0), criado: dia(d.created_at), dono: d.user && d.user.name, representante: l.getCustomField(d, "REPRESENTANTE") || "" });
  }
  console.log("cards a auditar:", linhas.length, "(vendidos:", linhas.filter(x => x.status === "Vendido").length + ")");

  // pessoa(s) por CNPJ -> notas
  const cnpjs = [...new Set(linhas.map(x => x.cnpj).filter(c => c.length === 14))];
  const porCnpj = {};
  await pool(cnpjs, 4, async c => {
    try {
      const pessoas = await zget("/catalog/person/person", { q: 'documentNumber=="' + mascara(c) + '"', max: 5 });
      const nfs = [];
      for (const p of pessoas) {
        const r = await zget("/fiscal/outgoingInvoice", { q: "person.id==" + p.id, order: "-id", max: 200 });
        for (const n of r) nfs.push({ id: n.id, numero: n.number, data: dia(n.issueDate), total: Number(n.totalValue) || 0, status: n.status, devolvida: !!n.returned, op: n.fiscalProfileOperation && n.fiscalProfileOperation.description, pessoa: p.name });
      }
      porCnpj[c] = { pessoas: pessoas.map(p => p.name), nfs };
    } catch (e) { porCnpj[c] = { erro: e.message.slice(0, 100), pessoas: [], nfs: [] }; }
  });

  const credRows = await db.sequelize.query(`SELECT lead_id, tipo_agente, SUM(CASE WHEN tipo='credito' THEN valor ELSE -valor END) AS total FROM bmax_transacoes WHERE lead_id IS NOT NULL GROUP BY lead_id, tipo_agente`, { type: QueryTypes.SELECT });
  const cred = {};
  for (const r of credRows) cred[r.lead_id] = (cred[r.lead_id] || 0) + Number(r.total);

  // itens das notas associadas (descrição dos produtos), só para cards com nota
  const resultado = [];
  await pool(linhas, 3, async x => {
    const info = porCnpj[x.cnpj] || { pessoas: [], nfs: [] };
    const validas = info.nfs.filter(n => n.status !== "CANCELED" && !n.devolvida && n.data >= x.criado);
    const total = Number(validas.reduce((s, n) => s + n.total, 0).toFixed(2));
    let itens = "";
    for (const n of validas.slice(0, 3)) {
      try {
        const it = await zget("/fiscal/outgoingInvoiceItem", { q: "invoice.id==" + n.id, max: 20 });
        itens += `NF ${n.numero}: ` + it.map(i => `${i.quantity}x ${(i.productPacking && i.productPacking.product && i.productPacking.product.description || "?").slice(0, 40)}`).join("; ") + " | ";
      } catch { /* itens são só informativos */ }
    }
    let cashCorreto = null, cashAtual = cred[x.dealId] || 0;
    if (x.status === "Vendido" && total > 0 && x.classe) {
      try { const c = await calcularComissoes({ valorTotal: total, pci: x.pci, classePreco: x.classe, representante: x.representante, responsavelRd: x.dono }); cashCorreto = c.faltando ? null : Number((((c.revenda && c.revenda.valor) || 0) + ((c.representante && c.representante.valor) || 0) + ((c.vendedorInterno && c.vendedorInterno.valor) || 0)).toFixed(2)); } catch { /* sem regra */ }
    }
    const dif = x.status === "Vendido" ? Number((x.valorCard - total).toFixed(2)) : null;
    let situacao;
    if (!x.cnpj || x.cnpj.length !== 14) situacao = "CNPJ do card inválido/vazio";
    else if (info.erro) situacao = "Erro ao consultar ZEN";
    else if (!info.pessoas.length) situacao = x.status === "Vendido" ? "Cliente NÃO encontrado no ZEN (venda sem nota?)" : "Cliente ainda não existe no ZEN";
    else if (!validas.length) situacao = x.status === "Vendido" ? "Cliente existe, SEM nota após a criação do card" : "Sem nota ainda (normal)";
    else if (x.status === "Em aberto") situacao = "TEM NOTA — candidato a fechar como vendido";
    else if (Math.abs(dif) <= Math.max(1, total * 0.005)) situacao = "OK — valor do card = notas";
    else situacao = dif > 0 ? "Card MAIOR que as notas" : "Card MENOR que as notas";
    resultado.push({ ...x, pessoas: info.pessoas.join(" / "), qtdNf: validas.length, totalNf: total, nfs: validas.map(n => `${n.numero} (${n.data}) R$ ${n.total}`).join("; "), itens: itens.slice(0, 300), dif, cashAtual: Number(cashAtual.toFixed(2)), cashCorreto, situacao });
  });

  const wb = new ExcelJS.Workbook();
  const cols = [["Situação", "situacao", 38], ["Cliente (RD)", "nome", 34], ["CNPJ", "cnpj", 17], ["Revenda", "revenda", 22], ["PCI", "pci", 9], ["Classe", "classe", 7], ["Etapa", "etapa", 18], ["Valor no card (R$)", "valorCard", 16], ["Notas ZEN (R$)", "totalNf", 15], ["Diferença card−notas", "dif", 16], ["Cashback creditado hoje (R$ total)", "cashAtual", 20], ["Cashback total pelas notas (R$)", "cashCorreto", 20], ["Qtd notas", "qtdNf", 9], ["Notas", "nfs", 50], ["Itens (amostra)", "itens", 60], ["Criado em", "criado", 11], ["Responsável RD", "dono", 18], ["Deal id", "dealId", 26]];
  const ordem = { "TEM NOTA — candidato a fechar como vendido": 0 };
  for (const [titulo, filtro] of [["Vendidos x notas", x => x.status === "Vendido"], ["Em aberto", x => x.status === "Em aberto"]]) {
    const ws = wb.addWorksheet(titulo); ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
    const rows = resultado.filter(filtro).sort((a, b) => (a.situacao.startsWith("OK") ? 1 : 0) - (b.situacao.startsWith("OK") ? 1 : 0) || (ordem[a.situacao] ?? 5) - (ordem[b.situacao] ?? 5));
    rows.forEach(r => ws.addRow(r));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D327B" } };
    ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: "A1", to: ws.getRow(1).getCell(cols.length).address };
    ["valorCard", "totalNf", "dif", "cashAtual", "cashCorreto"].forEach(k => { ws.getColumn(k).numFmt = "#,##0.00"; });
  }
  const cont = {}; resultado.forEach(r => { const k = r.status + " | " + r.situacao; cont[k] = (cont[k] || 0) + 1; });
  const rs = wb.addWorksheet("Resumo", { properties: { tabColor: { argb: "FF25BBEE" } } });
  rs.columns = [{ header: "Grupo | Situação", key: "k", width: 70 }, { header: "Qtd cards", key: "n", width: 12 }];
  Object.entries(cont).sort().forEach(([k, n]) => rs.addRow({ k, n }));
  rs.getRow(1).font = { bold: true };
  const somaV = resultado.filter(r => r.status === "Vendido");
  rs.addRow({}); rs.addRow({ k: "Total no card (vendidos)", n: Number(somaV.reduce((s, r) => s + r.valorCard, 0).toFixed(2)) });
  rs.addRow({ k: "Total em notas ZEN desses clientes (após criação do card)", n: Number(somaV.reduce((s, r) => s + r.totalNf, 0).toFixed(2)) });
  rs.addRow({ k: "Como ler: nota = NF de saída do ZEN, status ≠ cancelada, sem devolução, emitida a partir do dia da criação do card, somada por CNPJ do cliente (todas as notas, não só do produto BMax)." });
  wb.views = [{ activeTab: 2 }];
  await wb.xlsx.writeFile(SAIDA);
  console.log("RESUMO:", JSON.stringify(cont, null, 1));
  console.log("gravado:", SAIDA);
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack || e.message); process.exit(1); });
