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
    for (let i = 0; i < 2; i++) {
        if (!_token) await auth();
        const r = await fetch(ZEN + path + "?" + new URLSearchParams(q), {
            headers: { Authorization: "Bearer " + _token, tenant: "boxer" },
            signal: AbortSignal.timeout(15000)
        });
        if (r.status === 401) { _token = null; continue; }
        if (!r.ok) throw new Error("ZEN " + r.status);
        return r.json();
    }
    throw new Error("ZEN sem autorização");
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
            nfs.push({ numero: n.number, data: dia(n.issueDate), total: Number(n.totalValue) || 0 });
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

module.exports = { notasPorLeads, notasParaCard, configurado };
