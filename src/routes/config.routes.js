const express = require("express");
const { REPRESENTANTES, RESPONSAVEIS, PCI_POR_CAMINHO } = require("../config/constants");

const router = express.Router();

const { sbSistemasAnon } = require("../config/supabaseSistemas");

const PCIS = [
    "PCI 1", "PCI 2", "PCI 3", "PCI 4", "PCI 5",
    "PCI 6", "PCI 7", "PCI 8", "PCI 9", "PCI 10",
    "PCI 11", "PCI 12", "PCI 13", "PCI 14", "PCI 15"
];

const CAMINHOS = Object.keys(PCI_POR_CAMINHO);

let _revendasCache = { data: null, ts: 0 };
let _repsCache = { data: null, ts: 0 };
const CACHE_TTL = 30 * 60 * 1000;

async function sbFetch(path) {
    try {
        return await sbSistemasAnon(path);
    } catch {
        return null;
    }
}

async function fetchRevendasBmax() {
    if (_revendasCache.data && Date.now() - _revendasCache.ts < CACHE_TTL) return _revendasCache.data;
    try {
        const rows = await sbFetch('/comercial_revendas_bmax?ativo=eq.true&select=id,nome,cidade,estado,classe&order=nome');
        _revendasCache = { data: rows || [], ts: Date.now() };
        return _revendasCache.data;
    } catch { return []; }
}

async function fetchRepresentantesBmax() {
    if (_repsCache.data && Date.now() - _repsCache.ts < CACHE_TTL) return _repsCache.data;
    try {
        const rows = await sbFetch('/comercial_representantes_bmax?ativo=eq.true&select=nome&order=nome');
        const nomes = (rows || []).map(r => r.nome);
        _repsCache = { data: nomes, ts: Date.now() };
        return nomes;
    } catch { return REPRESENTANTES; }
}

function invalidateConfigCache() {
    _revendasCache = { data: null, ts: 0 };
    _repsCache = { data: null, ts: 0 };
}

router.get("/", async (req, res) => {
    const [revendas, repsBmax] = await Promise.all([fetchRevendasBmax(), fetchRepresentantesBmax()]);
    res.json({
        representantes: repsBmax,
        responsaveis: RESPONSAVEIS,
        pcis: PCIS,
        caminhos: CAMINHOS,
        revendas
    });
});

module.exports = router;
module.exports.invalidateConfigCache = invalidateConfigCache;
