// Reativa Brasolda (Diamante) e Trianorte (Ouro): o login já existia no Portal, mas o cadastro estava
// inativo/sem classe correta. Pedido do André em 27/10/2026. Senha inicial = prefixo do e-mail.
//   node scripts/ativar-brasolda-trianorte-27-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { sbSistemasService: sv } = require("../src/config/supabaseSistemas");
const { geocodeCep } = require("../src/services/geocode.service");
const { syncRevendasToRD } = require("../src/services/rd.leads.service");
const db = require("../src/database");

const APLICAR = process.argv.includes("--aplicar");
const ALVOS = [
    { email: "marcos@brasolda.com.br", userId: 40, cadastroId: "3dfe5226-a2b9-434d-8e3f-d7a49d64d6dd", classe: "Diamante", nomeRd: "Brasolda", rep: "Hugo Carpanese" },
    { email: "juniortrianorte1@gmail.com", userId: 42, cadastroId: "c0a5b8a5-9d70-4351-8779-e94d2ea60b69", classe: "Ouro", nomeRd: "Trianorte", rep: "Hugo Carpanese" }
];

(async () => {
    const plano = [];
    for (const a of ALVOS) {
        const user = await db.User.findOne({ where: { username: a.email } });
        const rev = await db.Revenda.findOne({ where: { user_id: a.userId } });
        const [cad] = await sv(`/comercial_revendas_bmax?id=eq.${a.cadastroId}&select=*`);
        if (!user || user.id !== a.userId || !rev || !cad) { console.log("PULADO (dado ausente):", a.email); continue; }
        const geo = await geocodeCep(rev.cep, { cidade: rev.cidade, estado: rev.estado });
        const campos = {
            ativo: true, user_id: user.id, nome_rd: a.nomeRd, email: a.email, classe: a.classe, rep: a.rep,
            cnpj: rev.cnpj, cep: rev.cep, cidade: rev.cidade, estado: rev.estado,
            ...(geo.lat !== null ? { lat: geo.lat, lng: geo.lng } : {}),
            editado_em: new Date().toISOString(), editado_por: "script-ativar-brasolda-trianorte-27-10-2026"
        };
        plano.push({ a, user, cad, campos });
        console.log(`${a.nomeRd} <${a.email}> | cadastro "${cad.nome}" | ativo ${cad.ativo} -> true | classe ${cad.classe} -> ${a.classe} | nome_rd ${cad.nome_rd || "-"} -> ${a.nomeRd} | cnpj ${cad.cnpj || "-"} -> ${rev.cnpj} | cep ${rev.cep} | coord ${geo.lat !== null ? geo.lat + "," + geo.lng : "(não achou)"}`);
    }
    console.log("\nsenha inicial (prefixo do e-mail) para:", plano.map(p => p.a.email).join(", "));
    if (!APLICAR) { console.log("(simulação — use --aplicar)"); process.exit(0); }

    fs.writeFileSync(`scripts/backups/ativar-brasolda-trianorte-${Date.now()}.json`, JSON.stringify(plano.map(p => ({ id: p.cad.id, antes: p.cad })), null, 1));
    for (const p of plano) await sv(`/comercial_revendas_bmax?id=eq.${p.cad.id}`, "PATCH", p.campos);
    for (const p of plano) await p.user.update({ password: await bcrypt.hash(p.a.email.split("@")[0], 10) });
    const ativas = await sv("/comercial_revendas_bmax?ativo=eq.true&select=nome,nome_rd");
    await syncRevendasToRD((ativas || []).map(r => (r.nome_rd && r.nome_rd.trim()) || r.nome));
    console.log("cadastros reativados, senhas redefinidas e lista do RD sincronizada:", plano.length);
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
