// Consulta SOMENTE LEITURA de notas fiscais de saída no ZEN ERP, para mostrar no extrato de comissões qual NF
// originou o crédito de cada lead. Casa a nota pelo CNPJ do cliente (campo CNPJ do card no RD), pela data de
// fechamento e pelo valor do card (mesmo critério da auditoria de 03/11/2026).
// Precisa das variáveis ZEN_EMAIL e ZEN_SENHA no ambiente; sem elas, retorna null e o extrato mostra "—".
const { logger } = require("../logger");

const ZEN = "https://api.zenerp.app.br";
const TTL_MS = 15 * 60 * 1000;
let _token = null;
const _cacheCnpj = new Map(); // cnpj -> { ts, nfs }

const so = s => String(s || "").replace(/\D/g, "");
const mascara = d => d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const dia = s => String(s || "").slice(0, 10);
const dias = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

function configurado() {
    return !!(process.env.ZEN_EMAIL && process.env.ZEN_SENHA);
}

async function auth() {
    const r = await fetch(ZEN + "/system/security/tokenOpRequest", {
        method: "POST",
        headers: { tenant: "boxer", "Content-Type": "application/json" },
        body: JSON.stringify({ email: process.env.ZEN_EMAIL, password: process.env.ZEN_SENHA }),
        signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error("ZEN auth " + r.status);
    _token = (await r.text()).trim().replace(/^"|"$/g, "");
}

async function zget(path, q) {
    // 3 tentativas: o ZEN às vezes demora (páginas grandes de pedidos passam de 15 s). 401 renova o token; timeout e erro de rede tentam de novo.
    let ultimoErro;
    for (let i = 0; i < 3; i++) {
        try {
            if (!_token) await auth();
            const r = await fetch(ZEN + path + "?" + new URLSearchParams(q), {
                headers: { Authorization: "Bearer " + _token, tenant: "boxer" },
                signal: AbortSignal.timeout(40000)
            });
            if (r.status === 401) { _token = null; continue; }
            if (!r.ok) throw new Error("ZEN " + r.status);
            return await r.json();
        } catch (e) {
            ultimoErro = e;
            if (/^ZEN d{3}$/.test(String(e.message)) && !/^ZEN (429|5dd)$/.test(String(e.message))) throw e;   // erro definitivo do ZEN (4xx): não adianta repetir
            await new Promise(s => setTimeout(s, 800 * (i + 1)));
        }
    }
    throw ultimoErro || new Error("ZEN sem autorização");
}

// Fonte principal: notas de saída marcadas com a tag "bmax" no ZEN (case-insensitive). Uma consulta só traz
// número, data, valor e CNPJ do cliente de todas elas — sem precisar buscar cliente por cliente. Filtro da API:
// `tags==bmax` (casa por item da lista de tags; `=like=` não funciona em tags).
let _cacheTag = null; // { ts, porCnpj: Map<cnpj, nf[]> }
async function notasComTagBmax() {
    if (_cacheTag && Date.now() - _cacheTag.ts < TTL_MS) return _cacheTag.porCnpj;
    const porCnpj = new Map();
    let ultimo = null;
    for (let pag = 0; pag < 30; pag++) {
        const r = await zget("/fiscal/outgoingInvoice", { q: "tags==bmax" + (ultimo ? ";id<" + ultimo : ""), order: "-id", max: 100 });
        if (!Array.isArray(r) || !r.length) break;
        for (const n of r) {
            if (n.status === "CANCELED" || n.returned) continue;
            const c = so(n.person && n.person.documentNumber);
            if (!c) continue;
            if (!porCnpj.has(c)) porCnpj.set(c, []);
            porCnpj.get(c).push({ numero: n.number, data: dia(n.issueDate), total: Number(n.totalValue) || 0, tag: true });
        }
        ultimo = r[r.length - 1].id;
        if (r.length < 100) break;
    }
    _cacheTag = { ts: Date.now(), porCnpj };
    return porCnpj;
}

// Tira o "lixo" (empresa, nacionalidade, endereços aninhados) e guarda só o que descreve a nota. Nenhum cálculo: valores como vieram do ZEN.
const pessoaResumo = p => (p ? { id: p.id, nome: p.name || null, fantasia: p.fantasyName || null, tipo: p.type || null, documento: so(p.documentNumber) || null, email: p.email || null, telefone: p.phone || null, cep: p.zipcode || null, categoria1: (p.category1 && (p.category1.description || p.category1.name)) || null, tags: p.tags || null } : null);
function cabecalhoNf(n) {
    const pr = n.properties || {};
    return {
        id: n.id, numero: n.number, serie: n.invoiceSeries ? (n.invoiceSeries.code || null) : null, data_emissao: dia(n.issueDate), status: n.status || null, devolvida: !!n.returned,
        total: Number(n.totalValue) || 0, tags: n.tags || null, chave_acesso: pr.fiscal_br_chNFe || null, pedido_id: pr.saleId != null ? String(pr.saleId) : null, volumes: pr.volumes != null ? Number(pr.volumes) : null,
        comissao_vendedor_zen: pr.salesCommission != null ? Number(pr.salesCommission) : null, observacao: pr["#comments"] || pr.comments || null,
        tipo_frete: n.freightType || null, peso_bruto_kg: n.grossWeightKg != null ? Number(n.grossWeightKg) : null, peso_liquido_kg: n.netWeightKg != null ? Number(n.netWeightKg) : null, volume_m3: n.volumeM3 != null ? Number(n.volumeM3) : null,
        operacao_fiscal: n.fiscalProfileOperation ? (n.fiscalProfileOperation.description || n.fiscalProfileOperation.code || null) : null,
        cliente: pessoaResumo(n.person), vendedor: pessoaResumo(n.personSalesperson), transportadora: pessoaResumo(n.personShipping),
    };
}

async function notasDoCnpj(cnpj) {
    const c = so(cnpj);
    if (c.length !== 14) return [];
    const hit = _cacheCnpj.get(c);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.nfs;
    const pessoas = await zget("/catalog/person/person", { q: 'documentNumber=="' + mascara(c) + '"', max: 5 });
    const nfs = [];
    for (const p of pessoas) {
        const r = await zget("/fiscal/outgoingInvoice", { q: "person.id==" + p.id, order: "-id", max: 200 });
        for (const n of r) {
            if (n.status === "CANCELED" || n.returned) continue;
            nfs.push({ id: n.id, numero: n.number, data: dia(n.issueDate), total: Number(n.totalValue) || 0, cab: cabecalhoNf(n) });
        }
    }
    _cacheCnpj.set(c, { ts: Date.now(), nfs });
    return nfs;
}

// Para cada lead { id, cnpj, fechadoEm, valorCard } devolve { [id]: "NF 123 + NF 456" } com a melhor combinação
// (1 a 3 notas, emitidas de 45 dias antes a 90 dias depois do fechamento) que fecha o valor do card; se nenhuma
// fechar com folga de 1%, devolve a nota mais próxima marcada com "~". Sem nota na janela, o lead fica de fora.
async function notasPorLeads(leads) {
    const out = {};
    if (!configurado() || !leads.length) return out;
    const fila = leads.slice();
    let tagadas = new Map();
    try { tagadas = await notasComTagBmax(); } catch (e) { logger.warn({ message: "Falha ao listar NFs com tag bmax no ZEN", error: e.message }); }
    await Promise.all(Array.from({ length: 4 }, async () => {
        while (fila.length) {
            const lead = fila.shift();
            try {
                // 1º as notas com a tag bmax; sem nenhuma na janela, cai na busca por CNPJ (vendas antigas sem tag).
                const naJanela = lista => lista.filter(n => { const d = dias(n.data, dia(lead.fechadoEm)); return d >= -45 && d <= 90; });
                let todas = tagadas.get(so(lead.cnpj)) || [];
                let semTag = false;
                if (!naJanela(todas).length) { todas = await notasDoCnpj(lead.cnpj); semTag = true; }
                const fech = dia(lead.fechadoEm);
                const cand = todas.filter(n => { const d = dias(n.data, fech); return d >= -45 && d <= 90; }).slice(0, 14);
                if (!cand.length) continue;
                const alvo = Number(lead.valorCard) || 0;
                let melhor = null;
                const testa = idx => {
                    const t = idx.reduce((s, i) => s + cand[i].total, 0);
                    const e = alvo > 0 ? Math.abs(t - alvo) / alvo : 1;
                    if (!melhor || e < melhor.erro) melhor = { erro: e, notas: idx.map(i => cand[i]) };
                };
                const k = cand.length;
                for (let a = 0; a < k; a++) { testa([a]); for (let b = a + 1; b < k; b++) { testa([a, b]); for (let c = b + 1; c < k; c++) testa([a, b, c]); } }
                // "~" = não fecha com o valor do card; "†" = nota sem a tag bmax (achada pelo CNPJ).
                if (melhor) out[lead.id] = (melhor.erro <= 0.01 ? "" : "~") + melhor.notas.map(n => n.numero).join(" + ") + (semTag ? " †" : "");
            } catch (e) {
                logger.warn({ message: "Falha ao buscar NF no ZEN para o extrato", leadId: lead.id, error: e.message });
            }
        }
    }));
    return out;
}

// Notas de um CNPJ emitidas a partir de `desde` (AAAA-MM-DD), separadas em com tag bmax e sem tag.
// Usada pela simulação/automação de fechamento de venda por NF.
async function notasParaCard(cnpj, desde) {
    const c = so(cnpj);
    const ok = n => n.data >= desde;
    const comTag = ((await notasComTagBmax()).get(c) || []).filter(ok);
    const semTag = comTag.length ? [] : (await notasDoCnpj(c)).filter(ok);
    return { comTag, semTag };
}

// Itens de uma nota (só leitura), com todos os valores como o ZEN devolve. Cache por nota (nota emitida não muda).
const _cacheItens = new Map();
async function itensDaNota(idNota) {
    if (_cacheItens.has(idNota)) return _cacheItens.get(idNota);
    const it = await zget("/fiscal/outgoingInvoiceItem", { q: "invoice.id==" + idNota, max: 100 });
    const num = v => (v == null || v === "" ? null : Number(v));
    const lista = (Array.isArray(it) ? it : []).map(i => {
        const pp = i.productPacking || {}, p = pp.product || {}, props = i.properties || {};
        return {
            item_id: i.id, sequencia: props.sequence != null ? Number(props.sequence) : null, item_pedido: props.nItemPed != null ? String(props.nItemPed) : null,
            codigo: String(p.code || p.id || pp.code || "").trim(), descricao: String(p.description || ""), produto_id_zen: p.id != null ? p.id : null,
            perfil_produto: p.productProfile ? (p.productProfile.code || null) : null, perfil_produto_descricao: p.productProfile ? (p.productProfile.description || null) : null,
            unidade: i.unit ? (i.unit.code || null) : null, quantidade: num(i.quantity), quantidade_fisica: num(i.physicalQuantity), peso_liquido_kg: num(i.netWeightKg), peso_bruto_kg: num(i.grossWeightKg),
            valor_unitario: num(i.unitValue), valor_bruto_produto: num(i.grossProductValue), desconto: num(i.discountValue), valor_produto: num(i.productValue), outros_valores: i.otherValues || {},
            valor_operacao: num(i.operationValue), imposto_incluso: num(i.insideTaxValue), imposto_fora: num(i.outsideTaxValue), valor_total: num(i.totalValue), compensacao_imposto: num(i.taxCompensationValue), valor_efetivo: num(i.effectiveValue),
            tipo_contabil: i.accountingType || null, operacao_tributaria: i.taxationOperation ? (i.taxationOperation.description || i.taxationOperation.code || null) : null, descricao_calculada: props.descriptionCalc || null,
        };
    });
    _cacheItens.set(idNota, lista);
    return lista;
}

// Pedido de venda do ZEN (uma venda pode ter várias NFs): valores como vieram, sem cálculo.
function normalizarPedido(s) {
    const pr = s.properties || {};
    return {
        pedido_id: String(s.id), status: s.status || null, data: dia(s.date), total: s.totalValue != null ? Number(s.totalValue) : null, custo_total: s.costTotalValue != null ? Number(s.costTotalValue) : null,
        tipo_frete: s.freightType || null, tags: s.tags || null, comissao_vendedor_zen: pr.salesCommission != null ? Number(pr.salesCommission) : null, forma_pagamento: pr.paymentMethods != null ? String(pr.paymentMethods) : null,
        observacao: pr.comments != null ? String(pr.comments) : null,
        perfil: s.saleProfile ? (s.saleProfile.code || null) : null, perfil_descricao: s.saleProfile ? (s.saleProfile.description || null) : null,
        operacao_fiscal: s.fiscalProfileOperation ? (s.fiscalProfileOperation.description || s.fiscalProfileOperation.code || null) : null,
        nf_id: s.invoice && s.invoice.id != null ? s.invoice.id : null, nf_numero: s.invoice && s.invoice.number != null ? String(s.invoice.number) : null,
        vendedor: pessoaResumo(s.personSalesperson), cliente: pessoaResumo(s.person),
    };
}
const _cachePedido = new Map();
async function pedidoDeVenda(saleId) {
    const k = String(saleId);
    if (_cachePedido.has(k)) return _cachePedido.get(k);
    const r = await zget("/sale/sale", { q: "id==" + k, max: 1 });
    const s = Array.isArray(r) ? r[0] : r;
    const out = s ? normalizarPedido(s) : null;
    _cachePedido.set(k, out);
    return out;
}

// Pedidos do mais novo para o mais antigo, a partir de `startId` (exclusive; null = os mais novos). Para quando: chega em `minId` (varredura incremental), uma página
// INTEIRA é mais antiga que `desdeISO` (a data do pedido NÃO segue a ordem do id), acaba o orçamento de tempo `budgetMs` ou `maxPaginas`. O ZEN leva de 11 a 27 s por 100 pedidos,
// por isso a varredura é RETOMÁVEL: devolve `menorId` (onde parou) e `completo` = false quando o tempo acabou. Devolve { pedidos, maiorId, menorId, paginas, completo }.
async function pedidosRecentes({ startId = null, minId = null, desdeISO = null, budgetMs = 200000, maxPaginas = 60 } = {}) {
    const t0 = Date.now();
    const out = [];
    let ultimo = startId, maiorId = null, menorId = null, completo = false, paginas = 0;
    while (paginas < maxPaginas) {
        if (paginas > 0 && Date.now() - t0 > budgetMs) break;   // sem tempo: devolve de onde parou
        const r = await zget("/sale/sale", { q: ultimo ? "id<" + ultimo : "id>0", order: "-id", max: 50 });
        paginas++;
        if (!Array.isArray(r) || !r.length) { completo = true; break; }
        let recentes = 0, chegouNoMarco = false;
        for (const s of r) {
            if (maiorId == null || s.id > maiorId) maiorId = s.id;
            if (menorId == null || s.id < menorId) menorId = s.id;
            ultimo = s.id;
            if (minId != null && s.id <= minId) { chegouNoMarco = true; continue; }
            const p = normalizarPedido(s);
            if (!desdeISO || !p.data || p.data >= desdeISO) { out.push(p); recentes++; }
        }
        if (chegouNoMarco || r.length < 50 || (desdeISO && recentes === 0)) { completo = true; break; }
    }
    return { pedidos: out, maiorId, menorId, paginas, completo };
}

// Itens do pedido (antes de existir nota): produto, quantidade, preço, desconto, imposto, CUSTO do item e operação tributária, como o ZEN devolve.
async function itensDoPedido(saleId) {
    const it = await zget("/sale/saleItem", { q: "sale.id==" + saleId, max: 100 });
    const num = v => (v == null || v === "" ? null : Number(v));
    return (Array.isArray(it) ? it : []).map(i => {
        const pp = i.productPacking || {}, p = pp.product || {};
        return { item_id: i.id, codigo: String(p.code || p.id || "").trim(), descricao: String(p.description || ""), unidade: pp.unit ? (pp.unit.code || null) : (i.unit ? (i.unit.code || null) : null),
            quantidade: num(i.quantity), valor_unitario: num(i.unitValue), custo_unitario: num(i.costUnitValue), custo_total: num(i.costTotalValue), valor_bruto_produto: num(i.grossProductValue), desconto: num(i.discountValue), valor_produto: num(i.productValue),
            outros_valores: i.otherValues || {}, valor_operacao: num(i.operationValue), imposto_incluso: num(i.insideTaxValue), imposto_fora: num(i.outsideTaxValue), valor_total: num(i.totalValue), valor_efetivo: num(i.effectiveValue),
            operacao_tributaria: i.taxationOperation ? (i.taxationOperation.description || i.taxationOperation.code || null) : null };
    });
}

// Tabela de Preços BMax (boxer-sistemas, produtos tabela 2): código -> modelo. Cache de 1 hora.
let _tabela = null;
async function tabelaBmax() {
    if (_tabela && Date.now() - _tabela.ts < 3600000) return _tabela.mapa;
    const rows = await require("../config/supabaseSistemas").sbSistemasAnon("/produtos?tabela_id=eq.2&select=codigo,modelo&limit=1000");
    const mapa = new Map((Array.isArray(rows) ? rows : []).map(p => [String(p.codigo).trim(), p.modelo || ""]));
    _tabela = { ts: Date.now(), mapa };
    return mapa;
}

module.exports = { notasPorLeads, notasParaCard, notasDoCnpj, itensDaNota, pedidoDeVenda, pedidosRecentes, itensDoPedido, tabelaBmax, configurado, cabecalhoNf };
