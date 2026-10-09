const express = require("express");
const { REPRESENTANTES, RESPONSAVEIS, PCI_POR_CAMINHO } = require("../config/constants");

const router = express.Router();

const { sbSistemasAnon } = require("../config/supabaseSistemas");
const { getRdUsuariosAtivos } = require("../services/rd.leads.service");

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
        const rows = await sbFetch('/comercial_revendas_bmax?ativo=eq.true&select=id,nome,nome_rd,cidade,estado,classe&order=nome');
        // O valor enviado ao RD (REVENDA/LOJA) tem que ser o NOME NO RD (nome_rd), que é o
        // que o login da revenda enxerga — não o nome longo importado do ZEN. Achado
        // 09/10/2026: lead criado pelo menu da Nova Negociação nascia com o nome longo e
        // ficava invisível pra própria revenda.
        _revendasCache = { data: (rows || []).map(r => ({ ...r, nome: (r.nome_rd && r.nome_rd.trim()) || r.nome })), ts: Date.now() };
        return _revendasCache.data;
    } catch { return []; }
}

async function fetchRepresentantesBmax() {
    if (_repsCache.data && Date.now() - _repsCache.ts < CACHE_TTL) return _repsCache.data;
    try {
        const rows = await sbFetch('/comercial_representantes_bmax?ativo=eq.true&select=nome,rd_alias&order=nome');
        // Mesmo princípio: o menu manda ao RD o nome que o RD usa (alias), senão o deal nasce
        // com uma 2ª grafia do mesmo representante (caso Caio).
        const nomes = (rows || []).map(r => (r.rd_alias && r.rd_alias.trim()) || r.nome);
        _repsCache = { data: nomes, ts: Date.now() };
        return nomes;
    } catch { return REPRESENTANTES; }
}

function invalidateConfigCache() {
    _revendasCache = { data: null, ts: 0 };
    _repsCache = { data: null, ts: 0 };
}

// "Responsável" precisa sempre bater com quem existe de verdade no RD hoje
// (achado 2026-09-11: a lista fixa em constants.js não tinha nem Billy nem
// André, que já eram usuários ativos do RD há tempo). "Revenda"/"Representante"
// continuam no fim da lista — são pseudo-responsáveis de auto-atribuição,
// não usuários reais (ver RD_OWNERS/resolverResponsavelId).
async function fetchResponsaveis() {
    try {
        const usuarios = await getRdUsuariosAtivos();
        return [...usuarios.map(u => u.nome), "Revenda", "Representante"];
    } catch {
        return RESPONSAVEIS;
    }
}

router.get("/", async (req, res) => {
    const [revendas, repsBmax, responsaveis] = await Promise.all([
        fetchRevendasBmax(),
        fetchRepresentantesBmax(),
        fetchResponsaveis()
    ]);
    res.json({
        representantes: repsBmax,
        responsaveis,
        pcis: PCIS,
        caminhos: CAMINHOS,
        revendas
    });
});

module.exports = router;
module.exports.invalidateConfigCache = invalidateConfigCache;
