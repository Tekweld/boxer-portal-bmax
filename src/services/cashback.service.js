const { sbSistemasAnon } = require("../config/supabaseSistemas");
const { logger } = require("../logger");

let _comCache = { data: null, ts: 0 };
const COM_CACHE_TTL = 10 * 60 * 1000;

async function fetchComTabela() {
    if (_comCache.data && Date.now() - _comCache.ts < COM_CACHE_TTL) return _comCache.data;

    let rows;
    try {
        rows = await sbSistemasAnon('/comercial_bmax_config?chave=eq.comissao_tabela&select=valor');
    } catch (err) {
        logger.error({ message: "Erro ao buscar comissao_tabela do boxer-sistemas", error: err.message });
        return null;
    }
    if (!rows.length) return null;

    const parsed = typeof rows[0].valor === 'string' ? JSON.parse(rows[0].valor) : rows[0].valor;
    _comCache = { data: parsed, ts: Date.now() };
    return parsed;
}

async function lerPlanilhaCashback(pci, role, classepreco) {
    const pciKey = (pci || '').toUpperCase().replace(/\s/g, '');
    const agente = role === 'revenda' ? 'Revenda' : 'Rep';

    const tabela = await fetchComTabela();
    if (!tabela || !tabela.linhas) return 0;

    const linha = tabela.linhas.find(l => l.pci === pciKey && l.agente === agente);
    if (!linha) return 0;

    const idx = classepreco ? parseInt(classepreco, 10) - 1 : 0;
    const val = linha.valores[idx >= 0 && idx < linha.valores.length ? idx : 0];
    if (!val || val <= 0) return 0;

    return val / 100;
}

module.exports = {
    lerPlanilhaCashback
};
