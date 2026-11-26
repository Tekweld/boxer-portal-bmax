// FASE 1 (SOMENTE LEITURA) da auditoria "a venda do CRM existe no ZEN". Desenho: Documentação/Desenho_Auditoria_Vendas_CRM_x_ZEN_26-11-2026.md
// Não escreve nada no CRM, no ZEN nem no banco. Só gera uma planilha.
// Uso: node scripts/auditoria-vendas-zen-fase1-26-11-2026.js <caminho do .env com ZEN_EMAIL/ZEN_SENHA> [saida.xlsx]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const l = require("../src/services/rd.leads.service");
const C = require("../src/config/constants");
const { compactar } = require("../src/services/escopoBmax.service");

const envZen = {};
for (const linha of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) { const m = linha.match(/^(ZEN_[A-Z_]+)=(.*)$/); if (m) envZen[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const SAIDA = process.argv[3] || path.join(__dirname, "..", "..", "Documentação", "Simulacao_Vendas_CRM_x_ZEN_26-11-2026.xlsx");
const ZEN = "https://api.zenerp.app.br";
let H = null;
async function auth() {
  const t = (await (await fetch(ZEN + "/system/security/tokenOpRequest", { method: "POST", headers: { tenant: "boxer", "Content-Type": "application/json" }, body: JSON.stringify({ email: envZen.ZEN_EMAIL, password: envZen.ZEN_SENHA }) })).text()).trim().replace(/^"|"$/g, "");
  H = { Authorization: "Bearer " + t, tenant: "boxer" };
}
async function zget(p, q, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      if (!H) await auth();
      const r = await fetch(ZEN + p + "?" + new URLSearchParams(q), { headers: H, signal: AbortSignal.timeout(20000) });
      if (r.status === 401) { H = null; continue; }
      if (!r.ok) throw new Error(r.status + " " + (await r.text()).slice(0, 100));
      return await r.json();
    } catch (e) { if (i === tentativas - 1) throw e; await new Promise(s => setTimeout(s, 700 * (i + 1))); }
  }
}
async function pool(itens, n, fn) {
  const out = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const k = i++; out[k] = await fn(itens[k], k); } }));
  return out;
}
const so = s => String(s || "").replace(/\D/g, "");
const mascara = d => d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : d;
const dia = s => String(s || "").slice(0, 10);
const difDias = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);
const nomeDe = x => (x && typeof x === "object" ? (x.name || x.description || x.code || "") : String(x || ""));
const tokens = s => new Set(String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3));
const interseccao = (a, b) => [...a].some(t => b.has(t));
const CORTE = "2026-05-01";
const VENDA = new Set([C.RD_STAGE_VENDIDO, C.RD_STAGE_VENDA_EFETIVADA, C.RD_STAGE_ENTREGA_TECNICA]);

(async () => {
  // 1) vendas do CRM (as que o Portal enxerga)
  const deals = await l.getLeads("admin", "adm");
  const cards = [];
  for (const d of deals) {
    if (!VENDA.has(d.deal_stage && d.deal_stage.id)) continue;
    const valor = Number(d.amount_total || 0);
    const fechado = dia(d.closed_at || d.updated_at);
    if (!(valor > 0) || fechado < CORTE) continue;
    const pci = String(l.getCustomField(d, "PERFIL PCI") || "").trim();
    cards.push({
      id: String(d.id || d._id), rdId: d.rd_deal_id || "", nome: d.name, cnpj: so(l.getCustomField(d, "CNPJ")), valor, criado: dia(d.created_at), fechado,
      pci, revenda: String(l.getCustomField(d, "REVENDA/LOJA") || "").trim(), rep: String(l.getCustomField(d, "REPRESENTANTE") || "").trim(), resp: d.user && d.user.name ? String(d.user.name).trim() : "",
      maquina: String(l.getCustomField(d, "MÁQUINA DE INTERESSE") || "").trim(), segmento: String(l.getCustomField(d, "SEGMENTO DE PRODUTO") || "").trim(),
    });
  }
  // cards de teste não entram em nada (André, 26/11/2026)
  const ehTeste = c => /teste/i.test(c.nome || "");
  const nTeste = cards.filter(ehTeste).length;
  for (let i = cards.length - 1; i >= 0; i--) if (ehTeste(cards[i])) cards.splice(i, 1);
  console.log("vendas do CRM no escopo (desde 01/05):", cards.length, "| cards de teste ignorados:", nTeste);

  // Tabela de Preços BMax (boxer-sistemas, produtos tabela_id=2): código -> modelo, para classificar os itens das notas
  const SBK = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
  const tabelaPorCodigo = new Map();
  if (SBK) {
    const r = await fetch("https://bmepxcnrsofofoswubuu.supabase.co/rest/v1/produtos?tabela_id=eq.2&select=codigo,modelo&limit=1000", { headers: { apikey: SBK, Authorization: "Bearer " + SBK } });
    if (r.ok) for (const p of await r.json()) tabelaPorCodigo.set(String(p.codigo).trim(), p.modelo || "");
  }
  console.log("produtos da Tabela de Preços BMax lidos:", tabelaPorCodigo.size);
  // famílias canônicas (texto livre do card x descrição/modelo da nota)
  const FAM = [["laser", /laser|lq\d/], ["hardmig", /hardmig|hard\d/], ["duramax", /duramax|dura\d/], ["tigon", /tigon/], ["alutig", /alutig/], ["alumig", /alumig|alu\d|m500/], ["q25", /q25/], ["hardcut", /hardcut/], ["robo", /robo|robot|rm\d|b500|posicionador|troly|cabecote|chiller|rtb/], ["migflex", /migflex/], ["optiarc", /optiarc/], ["flama", /flama/]];
  const familias = txt => { const t = compactar(txt); return new Set(FAM.filter(([, re]) => re.test(t)).map(([f]) => f)); };
  const addDias = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);

  // 2) notas do ZEN com a tag bmax (filtro principal)
  const nfs = []; let ultimo = null;
  for (let pag = 0; pag < 40; pag++) {
    const r = await zget("/fiscal/outgoingInvoice", { q: "tags==bmax" + (ultimo ? ";id<" + ultimo : ""), order: "-id", max: 100 });
    if (!Array.isArray(r) || !r.length) break;
    for (const n of r) {
      ultimo = n.id;
      nfs.push({ id: n.id, numero: n.number, data: dia(n.issueDate), total: Number(n.totalValue) || 0, status: n.status, cancelada: n.status === "CANCELED" || !!n.returned, saleId: n.properties && n.properties.saleId ? String(n.properties.saleId) : "",
        cnpj: so(n.person && n.person.documentNumber), cliente: nomeDe(n.person), canal: (n.personSalesperson && n.personSalesperson.category1 && (n.personSalesperson.category1.description || n.personSalesperson.category1.name)) || "", vendedor: nomeDe(n.personSalesperson), comissao: n.properties && n.properties.salesCommission, tag: true });
    }
    if (r.length < 100) break;
  }
  const nfsDesde = nfs.filter(n => n.data >= CORTE);
  console.log("notas bmax no ZEN (desde 01/05):", nfsDesde.length, "| total lido:", nfs.length);

  // 3) plano B: cards sem nota com tag -> procurar por CNPJ (nota sem a tag)
  const porCnpjTag = new Map(); nfs.forEach(n => { if (!porCnpjTag.has(n.cnpj)) porCnpjTag.set(n.cnpj, []); porCnpjTag.get(n.cnpj).push(n); });
  const semTag = cards.filter(c => c.cnpj.length === 14 && !(porCnpjTag.get(c.cnpj) || []).some(n => !n.cancelada));
  const extra = new Map();
  await pool([...new Set(semTag.map(c => c.cnpj))], 4, async cnpj => {
    try {
      const pessoas = await zget("/catalog/person/person", { q: 'documentNumber=="' + mascara(cnpj) + '"', max: 5 });
      const lista = [];
      for (const p of pessoas) {
        const r = await zget("/fiscal/outgoingInvoice", { q: "person.id==" + p.id, order: "-id", max: 100 });
        for (const n of r) lista.push({ id: n.id, numero: n.number, data: dia(n.issueDate), total: Number(n.totalValue) || 0, status: n.status, cancelada: n.status === "CANCELED" || !!n.returned, saleId: n.properties && n.properties.saleId ? String(n.properties.saleId) : "", cnpj, cliente: p.name, canal: (n.personSalesperson && n.personSalesperson.category1 && (n.personSalesperson.category1.description || n.personSalesperson.category1.name)) || "", vendedor: nomeDe(n.personSalesperson), tag: /bmax/i.test(n.tags || "") });
      }
      extra.set(cnpj, { achou: pessoas.length > 0, nfs: lista });
    } catch (e) { extra.set(cnpj, { erro: e.message.slice(0, 80), nfs: [] }); }
  });

  // 4) candidatas por card e pontuação
  const nfsDoCnpj = cnpj => { const m = new Map(); for (const n of (porCnpjTag.get(cnpj) || [])) m.set(n.id, n); for (const n of ((extra.get(cnpj) || {}).nfs || [])) if (!m.has(n.id)) m.set(n.id, n); return [...m.values()].filter(n => !n.cancelada); };
  const pontuar = (c, n) => {
    const dif = Math.abs(n.total - c.valor), rel = c.valor ? dif / c.valor : 1;
    let p = 0; const ev = [];
    if (dif <= 0.05 || rel <= 0.001) { p += 5; ev.push("valor igual"); } else if (rel <= 0.01) { p += 2; ev.push("valor ~1%"); }
    const dd = difDias(n.data, c.fechado);
    if (n.data < c.criado) ev.push("nota ANTES da criação do card"); else if (dd >= -5 && dd <= 60) { p += 2; ev.push("data perto do fechamento"); } else if (dd >= -45 && dd <= 90) { p += 1; ev.push("data na janela larga"); } else ev.push("data fora da janela");
    if (n.vendedor && (interseccao(tokens(n.vendedor), tokens(c.resp)) || interseccao(tokens(n.vendedor), tokens(c.rep)))) { p += 1; ev.push("vendedor bate"); }
    if (n.tag) { p += 1; ev.push("tag bmax"); }
    if (/ind[uú]stria/i.test(n.canal || "")) { p += 1; ev.push("canal Indústria"); } else if (n.canal) ev.push("canal " + n.canal);
    return { p, ev, dif, rel, dd };
  };
  const linhas = cards.map(c => {
    const cand = c.cnpj.length === 14 ? nfsDoCnpj(c.cnpj) : [];
    const ranked = cand.map(n => ({ n, ...pontuar(c, n) })).sort((a, b) => b.p - a.p || a.dif - b.dif);
    return { c, cand, ranked };
  });
  // 1 nota para 1 card: do maior escore para o menor, cada nota fica com um card só
  const usadas = new Map();
  [...linhas].sort((a, b) => ((b.ranked[0] || {}).p || -1) - ((a.ranked[0] || {}).p || -1)).forEach(x => {
    const melhor = x.ranked.find(r => !usadas.has(r.n.id) && r.p >= 5);
    if (melhor) { usadas.set(melhor.n.id, x.c.id); x.escolhida = melhor; }
  });

  // 4b) SOMA DE NOTAS: o card sem nota de valor igual pode ser um pedido faturado em várias notas.
  // Procura um conjunto de notas do cliente (ainda livres, na janela do card) cuja soma bate com o valor; prefere notas do mesmo pedido (saleId).
  linhas.filter(x => !x.escolhida && x.cand.length > 1).forEach(x => {
    const livres = x.cand.filter(n => !usadas.has(n.id) && n.data >= addDias(x.c.criado, -60) && n.data <= addDias(x.c.fechado, 90)).slice(0, 14);
    const tol = Math.max(0.05, x.c.valor * 0.001);
    let melhor = null;
    for (let m = 1; m < (1 << livres.length); m++) {
      const sub = livres.filter((_, i) => m & (1 << i));
      if (sub.length < 2 || sub.length > 6) continue;
      const soma = sub.reduce((s, n) => s + n.total, 0);
      if (Math.abs(soma - x.c.valor) > tol) continue;
      const mesmoPedido = sub[0].saleId && sub.every(n => n.saleId === sub[0].saleId);
      const nota = (mesmoPedido ? 0 : 10) + sub.length;
      if (!melhor || nota < melhor.nota) melhor = { sub, soma, mesmoPedido, nota };
    }
    if (!melhor) return;
    melhor.sub.forEach(n => usadas.set(n.id, x.c.id));
    const u = melhor.sub[melhor.sub.length - 1];
    x.escolhida = { n: { ...u, numero: melhor.sub.map(n => n.numero).join(" + "), data: melhor.sub.map(n => n.data).sort().pop(), total: melhor.soma, tag: melhor.sub.some(n => n.tag), canal: u.canal }, p: 7, dif: 0, rel: 0, ev: ["SOMA de " + melhor.sub.length + " notas" + (melhor.mesmoPedido ? " do mesmo pedido" : "")], ids: melhor.sub.map(n => n.id), soma: melhor.sub.length };
  });

  // 5) itens da(s) nota(s) escolhida(s): produto conferido pela família (texto livre do card x descrição + modelo da Tabela BMax)
  await pool(linhas.filter(x => x.escolhida), 4, async x => {
    try {
      const it = [];
      for (const id of (x.escolhida.ids || [x.escolhida.n.id])) it.push(...await zget("/fiscal/outgoingInvoiceItem", { q: "invoice.id==" + id, max: 30 }));
      const prod = i => (i.productPacking && i.productPacking.product) || {};
      const codigoDe = i => String(prod(i).code || prod(i).id || (i.productPacking && i.productPacking.code) || "").trim();
      x.itens = it.map(i => `${i.quantity}x ${(prod(i).description || "?").slice(0, 45)}`).join("; ");
      const daTabela = it.filter(i => tabelaPorCodigo.has(codigoDe(i)));
      x.naTabela = it.length ? daTabela.length + "/" + it.length : "";
      const textoItens = it.map(i => (prod(i).description || "") + " " + (tabelaPorCodigo.get(codigoDe(i)) || "")).join(" ");
      const fc = familias(x.c.maquina), fn = familias(textoItens);
      if (!x.c.maquina) x.produto = "card sem máquina";
      else if (fc.size) x.produto = [...fc].some(f => fn.has(f)) ? "compatível" : "NÃO bate";
      else { const tc = tokens(x.c.maquina + " " + x.c.segmento), ti = tokens(textoItens); x.produto = interseccao(tc, ti) || compactar(textoItens).includes(compactar(x.c.maquina).slice(0, 6)) ? "compatível" : "NÃO bate"; }
    } catch { x.itens = ""; x.produto = "sem itens"; }
  });

  // 6) estado de cada venda
  const revendaVende = c => /^PCI12A$/.test(c.pci.replace(/\s/g, "").toUpperCase());
  const dados = linhas.map(x => {
    const { c, cand, ranked, escolhida } = x;
    let estado, obs = "";
    if (escolhida) {
      const e = escolhida;
      const valorOk = e.p >= 5 && (e.rel <= 0.001 || e.dif <= 0.05);
      estado = valorOk && x.produto !== "NÃO bate" && e.n.data >= c.criado ? "Confirmada" : "Provável (revisar: " + [x.produto === "NÃO bate" ? "produto" : "", !valorOk ? "valor" : "", e.n.data < c.criado ? "data" : ""].filter(Boolean).join(", ") + ")";
      if (cand.length > 1) obs = "cliente tem outras notas (" + (cand.length - 1) + ")";
    } else if (c.cnpj.length !== 14) estado = "CNPJ do card inválido ou vazio";
    else if (!cand.length) estado = revendaVende(c) ? "Sem nota esperada (revenda vende, PCI12a)" : "SEM NOTA no ZEN";
    else if (ranked.length && ranked[0].p >= 5) estado = "Ambígua (a nota já foi usada por outro card)";
    else estado = "Valor diverge (há notas do cliente, nenhuma com o valor)";
    // dica: nota com o mesmo valor em outro CNPJ (ex.: revenda compra e revende)
    let outroCnpj = "";
    if (!escolhida) {
      const igual = nfsDesde.find(n => !n.cancelada && !usadas.has(n.id) && n.cnpj !== c.cnpj && Math.abs(n.total - c.valor) <= 0.05 && Math.abs(difDias(n.data, c.fechado)) <= 90);
      if (igual) outroCnpj = `NF ${igual.numero} R$ ${igual.total} em outro CNPJ (${igual.cliente}), ${igual.data}`;
    }
    return { estado, ...c, nfNumero: escolhida ? escolhida.n.numero : "", nfData: escolhida ? escolhida.n.data : "", nfTotal: escolhida ? escolhida.n.total : "", nfVendedor: escolhida ? escolhida.n.vendedor : "", nfCanal: escolhida ? (escolhida.n.canal || "(vazio)") : "", nfTag: escolhida ? (escolhida.n.tag ? "sim" : "não") : "",
      pontos: escolhida ? escolhida.p : "", evidencias: escolhida ? escolhida.ev.join(", ") : "", produto: x.produto || "", itens: x.itens || "", naTabela: x.naTabela || "", soma: escolhida && escolhida.soma ? escolhida.soma + " notas" : "", outrasNotas: obs, outroCnpj, melhorSemUso: !escolhida && ranked[0] ? `NF ${ranked[0].n.numero} R$ ${ranked[0].n.total} (${ranked[0].n.data}): ${ranked[0].ev.join(", ")}` : "" };
  });

  // 7) notas com tag bmax sem card
  const semCard = nfsDesde.filter(n => !n.cancelada && !usadas.has(n.id)).map(n => ({ numero: n.numero, data: n.data, total: n.total, cliente: n.cliente, cnpj: n.cnpj, vendedor: n.vendedor, canal: n.canal, comissao: n.comissao }));

  const ordem = e => e.startsWith("SEM NOTA") ? 0 : e.startsWith("Valor") ? 1 : e.startsWith("Ambígua") ? 2 : e.startsWith("Provável") ? 3 : e.startsWith("CNPJ") ? 4 : e.startsWith("Sem nota esperada") ? 6 : 7;
  dados.sort((a, b) => ordem(a.estado) - ordem(b.estado));
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Vendas do CRM x NF");
  const cols = [["Estado", "estado", 34], ["Cliente (CRM)", "nome", 34], ["CNPJ", "cnpj", 17], ["Valor no card", "valor", 14], ["Fechado em", "fechado", 11], ["Criado em", "criado", 11], ["PCI", "pci", 9], ["Revenda", "revenda", 18], ["Representante", "rep", 16], ["Responsável", "resp", 18], ["Máquina de interesse", "maquina", 26], ["NF", "nfNumero", 9], ["Data NF", "nfData", 11], ["Total NF", "nfTotal", 14], ["Vendedor no ZEN", "nfVendedor", 22], ["Canal do vendedor (categoria 1)", "nfCanal", 18], ["Tag bmax", "nfTag", 8], ["Pontos", "pontos", 7], ["O que bateu", "evidencias", 40], ["Produto", "produto", 14], ["Itens da NF", "itens", 50], ["Itens na Tabela BMax", "naTabela", 12], ["Soma de notas", "soma", 10], ["Obs", "outrasNotas", 24], ["NF de mesmo valor em outro CNPJ", "outroCnpj", 50], ["Melhor nota (não usada)", "melhorSemUso", 50], ["Card (Pipefy)", "id", 12]];
  ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
  dados.forEach(r => ws.addRow(r));
  ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } }; ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D327B" } };
  ws.views = [{ state: "frozen", ySplit: 1 }]; ws.autoFilter = { from: "A1", to: ws.getRow(1).getCell(cols.length).address };
  ["valor", "nfTotal"].forEach(k => { ws.getColumn(k).numFmt = "#,##0.00"; });
  const w2 = wb.addWorksheet("NF bmax sem card");
  w2.columns = [["NF", "numero", 9], ["Data", "data", 11], ["Total", "total", 14], ["Cliente", "cliente", 40], ["CNPJ", "cnpj", 17], ["Vendedor", "vendedor", 24], ["Canal", "canal", 14], ["Comissão %", "comissao", 11]].map(([header, key, width]) => ({ header, key, width }));
  semCard.forEach(r => w2.addRow(r)); w2.getRow(1).font = { bold: true }; w2.getColumn("total").numFmt = "#,##0.00";
  const cont = {}; dados.forEach(r => { const k = r.estado.replace(/ \(.*/, ""); cont[k] = (cont[k] || 0) + 1; });
  const w3 = wb.addWorksheet("Resumo");
  w3.columns = [{ header: "Estado", key: "k", width: 60 }, { header: "Qtd", key: "n", width: 8 }];
  Object.entries(cont).forEach(([k, n]) => w3.addRow({ k, n })); w3.addRow({ k: "Notas bmax sem card (desde 01/05)", n: semCard.length }); w3.getRow(1).font = { bold: true };
  await wb.xlsx.writeFile(SAIDA);
  console.log(JSON.stringify(cont), "| NF sem card:", semCard.length);
  console.log("planilha:", SAIDA);
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack.split("\n").slice(0, 4).join(" | ")); process.exit(1); });
