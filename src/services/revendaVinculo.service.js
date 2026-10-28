// Vínculo REVENDA/LOJA (RD) -> login do Portal. Caso Heitor/Suprimig (28/10/2026): o card entrou no RD com
// o nome do ZEN ("31023, Heitor Nogueira...") e não com "Suprimig"; o login não via o lead e o robô de 48h
// aplicou o 12b sem a revenda saber. Um nome de revenda só é "vinculado" se algum login do Portal o enxerga
// (Revendas.name) ou se pertence a um grupo (bmax_grupos) cujo nome é o de um login.
const { QueryTypes } = require("sequelize");
const db = require("../database");

const n = s => String(s || "").trim().toLowerCase();
const TTL_MS = 5 * 60 * 1000;
let _cache = { ts: 0, set: null };

async function nomesComLogin() {
    if (_cache.set && Date.now() - _cache.ts < TTL_MS) return _cache.set;
    const logins = await db.sequelize.query(
        `SELECT r.name, r.grupo FROM "Revendas" r JOIN "Users" u ON u.id = r.user_id WHERE u.role = 'revenda'`, { type: QueryTypes.SELECT });
    const grupos = await db.sequelize.query(`SELECT revenda_rd, grupo FROM bmax_grupos`, { type: QueryTypes.SELECT });
    const set = new Set(logins.map(x => n(x.name)).filter(Boolean));
    logins.filter(x => x.grupo).forEach(x => grupos.filter(g => g.grupo === x.grupo).forEach(g => set.add(n(g.revenda_rd))));
    _cache = { ts: Date.now(), set };
    return set;
}

// true se algum login do Portal enxerga leads com esse nome de revenda
async function revendaTemLogin(nome) {
    const k = n(nome);
    if (!k) return false;
    return (await nomesComLogin()).has(k);
}

const SEM_REVENDA = new Set(["", "?????", "?", "vazio", "n/d", "sem revenda"]);

// nome presente (não é "sem revenda") mas sem login que o veja
async function revendaSemLogin(nome) {
    if (SEM_REVENDA.has(n(nome))) return false;
    return !(await revendaTemLogin(nome));
}

module.exports = { nomesComLogin, revendaTemLogin, revendaSemLogin };
