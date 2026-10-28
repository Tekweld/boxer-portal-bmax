// Cria o login da Ultra Maquinas (cadastro ativo sem login). CEP informado pelo André: 13040-001. Senha inicial = prefixo do e-mail.
//   node scripts/criar-login-ultra-maquinas-28-10-2026.js [--aplicar]
require("dotenv").config({ quiet: true });
const fs = require("fs");
const { sbSistemasService: sv } = require("../src/config/supabaseSistemas");
const { geocodeCep } = require("../src/services/geocode.service");
const { validarNovoLogin, criarLoginDeRevenda } = require("../src/services/revendaLogin.service");
const { syncRevendasToRD } = require("../src/services/rd.leads.service");

const APLICAR = process.argv.includes("--aplicar");
const CADASTRO_ID = "82b6a6b6-fa0e-49db-85c5-9935ec007bc9";
const CEP = "13040001";

(async () => {
    const [cad] = await sv(`/comercial_revendas_bmax?id=eq.${CADASTRO_ID}&select=*`);
    if (!cad || cad.nome !== "Ultra Maquinas") throw new Error("cadastro não confere");
    const geo = await geocodeCep(CEP, { cidade: cad.cidade, estado: cad.estado });
    const dados = { nomeRd: "Ultra Maquinas", email: cad.email, telefone: cad.telefone, cnpj: cad.cnpj, cep: CEP, cidade: cad.cidade, estado: cad.estado, grupo: cad.grupo, cadastroId: cad.id };
    const v = await validarNovoLogin(dados);
    console.log("cadastro:", cad.nome, "|", cad.email, "| cnpj", cad.cnpj, "|", cad.cidade + "/" + cad.estado, "| classe", cad.classe, "| rep", cad.rep, "| coord", geo.lat, geo.lng);
    console.log("validação do login:", v.erro || "ok", "| usuário:", String(cad.email).toLowerCase(), "| senha inicial: parte antes do @");
    if (!APLICAR) { console.log("(simulação — use --aplicar)"); process.exit(0); }
    if (v.erro) throw new Error(v.erro);

    fs.writeFileSync(`scripts/backups/ultra-maquinas-${Date.now()}.json`, JSON.stringify(cad, null, 1));
    await sv(`/comercial_revendas_bmax?id=eq.${cad.id}`, "PATCH", { cep: CEP, nome_rd: "Ultra Maquinas", ...(geo.lat !== null ? { lat: geo.lat, lng: geo.lng } : {}), editado_em: new Date().toISOString(), editado_por: "script-ultra-28-10-2026" });
    const r = await criarLoginDeRevenda(dados);
    const ativas = await sv("/comercial_revendas_bmax?ativo=eq.true&select=nome,nome_rd");
    await syncRevendasToRD(ativas.map(x => (x.nome_rd && x.nome_rd.trim()) || x.nome));
    console.log("login criado:", r.username, "(id", r.userId + ") | senha inicial:", r.senhaInicial);
    process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
