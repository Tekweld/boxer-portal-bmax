// Auditoria somente-leitura dos NOMES de revenda: login (Postgres Revendas.name) x cadastro
// (Supabase comercial_revendas_bmax) x opções do RD (REVENDA/LOJA) x leads reais.
//   node scripts/auditoria_nomes_revenda.js [--json]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const l = require("../src/services/rd.leads.service");
const { sbSistemasService: sv } = require("../src/config/supabaseSistemas");
const db = require("../src/database");
const { QueryTypes } = require("sequelize");

const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/^\s*\d+\s*,\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
const tokens = s => new Set(norm(s).split(" ").filter(t => t.length > 2 && !["ltda", "eireli", "epp", "comercio", "industria", "servicos", "para", "dos", "das", "com"].includes(t)));
const sim = (a, b) => { const A = tokens(a), B = tokens(b); if (!A.size || !B.size) return 0; let i = 0; A.forEach(t => { if (B.has(t)) i++; }); return i / Math.min(A.size, B.size); };

(async () => {
    const [cad, opcoes, deals, logins, grupos, saldos] = await Promise.all([
        sv("/comercial_revendas_bmax?select=id,nome,nome_rd,user_id,grupo,ativo&limit=1000"),
        l.getOpcoesRevendaRD(),
        l.getLeads("admin", "adm"),
        db.sequelize.query(`SELECT u.id, u.username, r.name, r.grupo FROM "Users" u LEFT JOIN "Revendas" r ON r.user_id = u.id WHERE u.role = 'revenda' ORDER BY u.username`, { type: QueryTypes.SELECT }),
        db.sequelize.query(`SELECT grupo, revenda_rd FROM bmax_grupos`, { type: QueryTypes.SELECT }),
        db.sequelize.query(`SELECT revenda, saldo FROM bmax_saldo WHERE tipo_agente = 'revenda'`, { type: QueryTypes.SELECT })
    ]);
    const optSet = new Set(opcoes.map(o => o.trim().toLowerCase()));
    const noPick = n => !!n && optSet.has(String(n).trim().toLowerCase());
    const dealsPorNome = {}; deals.forEach(d => { const k = l.getCustomField(d, "REVENDA/LOJA") || ""; dealsPorNome[k] = (dealsPorNome[k] || 0) + 1; });
    const saldoPor = Object.fromEntries(saldos.map(s => [s.revenda, Number(s.saldo)]));
    const gruposMap = {}; grupos.forEach(g => (gruposMap[g.grupo] = gruposMap[g.grupo] || []).push(g.revenda_rd));
    const cadPorUser = {}; cad.filter(c => c.user_id).forEach(c => (cadPorUser[c.user_id] = cadPorUser[c.user_id] || []).push(c));

    const linhas = [];
    for (const u of logins) {
        const nomesVistos = u.grupo && gruposMap[u.grupo] ? gruposMap[u.grupo] : (u.name ? [u.name] : []);
        const leads = nomesVistos.reduce((s, n) => s + (dealsPorNome[n] || 0), 0);
        const vinc = cadPorUser[u.id] || [];
        const cadRd = vinc.map(c => c.nome_rd || c.nome);
        let status = "OK", proposta = null;
        if (!u.name) status = "SEM_REVENDA_NO_LOGIN";
        else if (u.grupo && gruposMap[u.grupo]) status = nomesVistos.some(noPick) ? "OK_GRUPO" : "GRUPO_FORA_DO_RD";
        else if (!noPick(u.name)) status = "NOME_FORA_DO_RD";
        else if (vinc.length && !cadRd.some(n => n.trim().toLowerCase() === u.name.trim().toLowerCase())) status = "CADASTRO_DIVERGENTE";
        else if (!vinc.length) status = "SEM_CADASTRO_VINCULADO";
        if (status !== "OK" && status !== "OK_GRUPO") {
            // melhor sugestão: opção do RD mais parecida com o nome do login / do cadastro
            const base = [u.name, ...cadRd].filter(Boolean);
            const cand = opcoes.map(o => ({ o, s: Math.max(...base.map(b => sim(b, o))) })).filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s).slice(0, 3);
            proposta = cand.map(c => `${c.o} (${Math.round(c.s * 100)}%, ${dealsPorNome[c.o] || 0} leads)`);
        }
        linhas.push({ login: u.username, loginName: u.name, grupo: u.grupo, leadsVisiveis: leads, cadastros: vinc.map(c => c.nome + (c.nome_rd ? ` [nome_rd: ${c.nome_rd}]` : "") + (c.ativo === false ? " (inativo)" : "")), status, proposta, saldo: nomesVistos.reduce((s, n) => s + (saldoPor[n] || 0), 0) });
    }

    const cont = linhas.reduce((m, x) => (m[x.status] = (m[x.status] || 0) + 1, m), {});
    console.log("logins de revenda:", linhas.length, "|", JSON.stringify(cont));
    console.log("\n== PROBLEMAS ==");
    linhas.filter(x => !x.status.startsWith("OK")).forEach(x => console.log(`[${x.status}] ${x.login} | login="${x.loginName}"${x.grupo ? " grupo=" + x.grupo : ""} | leads:${x.leadsVisiveis} | cadastro: ${x.cadastros.join(" ; ") || "-"} | saldo R$${x.saldo.toFixed(2)}\n      sugestão: ${(x.proposta || []).join(" | ") || "(nenhuma parecida no RD)"}`));

    // valores do RD (com leads reais) que nenhum login enxerga
    const vistos = new Set(); linhas.forEach(x => { const g = x.grupo && gruposMap[x.grupo]; (g || (x.loginName ? [x.loginName] : [])).forEach(n => vistos.add(n)); });
    console.log("\n== NOMES NO RD COM LEADS QUE NENHUM LOGIN ENXERGA ==");
    Object.entries(dealsPorNome).filter(([n]) => n && !vistos.has(n) && n !== "Sem Revenda" && n !== "?????").sort((a, b) => b[1] - a[1]).forEach(([n, c]) => {
        const logSug = logins.map(u => ({ u, s: sim(n, u.name || "") })).filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s)[0];
        const cadSug = cad.filter(c2 => c2.ativo !== false).map(c2 => ({ c2, s: Math.max(sim(n, c2.nome), sim(n, c2.nome_rd || "")) })).filter(x => x.s >= 0.6).sort((a, b) => b.s - a.s)[0];
        console.log(`  ${String(c).padStart(3)} leads | "${n}" | login parecido: ${logSug ? logSug.u.username + ` ("${logSug.u.name}")` : "-"} | cadastro parecido: ${cadSug ? cadSug.c2.nome : "-"}`);
    });
    if (process.argv.includes("--json")) fs.writeFileSync("scripts/backups/auditoria-nomes-revenda.json", JSON.stringify(linhas, null, 1));
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
