// Termo de Formalização Digital BPartner (Prata/Ouro/Diamante) — Fase 1.
// Fluxo: revenda (grupo) confirma e informa TODAS as lojas (CNPJ, endereço, CEP) -> representante testemunha ->
// Boxer (admin) aprova. Na aprovação o cadastro (comercial_revendas_bmax) é atualizado sozinho (CNPJ/CEP só com dígitos,
// endereço, cidade/UF e lat/lng) e o Motor passa a enxergar os dados certos, pois lê esse mesmo cadastro.
// Diamante: só vira Diamante depois que o admin confirma a compra das duas máquinas (prazo de 30 dias); sem compra, segue Ouro.
// Tabelas: ver scripts/sql/termos-fase1.sql (boxer-sistemas). Recurso protegido pelo interruptor `termos_ativo`.
const crypto = require("crypto");
const { sbSistemasService, SB_SISTEMAS_URL } = require("../config/supabaseSistemas");
const { logger } = require("../logger");

const PORTAL_URL = process.env.PORTAL_URL || "https://bmax.boxersoldas.com.br";
const BUCKET = "bmax-termos";
const PRAZO_COMPRA_DIAS = 30;
const STATUS_ABERTOS = ["aguardando_revenda", "aguardando_representante", "aguardando_boxer", "aguardando_compra"];
const NIVEL = { bpartner_prata: "Prata", bpartner_ouro: "Ouro", bpartner_diamante: "Diamante" };
const UFS = new Set("AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO".split(" "));

// ─── Validações / formatação (puras) ─────────────────────────
const soDigitos = s => String(s == null ? "" : s).replace(/\D/g, "");

function cnpjValido(v) {
    const c = soDigitos(v);
    if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
    const dv = (base) => {
        let soma = 0, peso = base.length - 7;
        for (const d of base) { soma += Number(d) * peso--; if (peso < 2) peso = 9; }
        const r = soma % 11;
        return r < 2 ? 0 : 11 - r;
    };
    return dv(c.slice(0, 12)) === Number(c[12]) && dv(c.slice(0, 13)) === Number(c[13]);
}

function cpfValido(v) {
    const c = soDigitos(v);
    if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
    const dv = (n) => {
        let soma = 0;
        for (let i = 0; i < n; i++) soma += Number(c[i]) * (n + 1 - i);
        const r = (soma * 10) % 11;
        return r === 10 ? 0 : r;
    };
    return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

const cepValido = v => { const c = soDigitos(v); return c.length === 8 && c !== "00000000"; };
const fmtCnpj = v => soDigitos(v).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
const fmtCep = v => soDigitos(v).replace(/^(\d{5})(\d{3})$/, "$1-$2");
const fmtCpfMascarado = v => { const c = soDigitos(v); return c.length === 11 ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : "***"; };
const limpa = s => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

function enderecoComposto({ logradouro, numero, bairro, complemento }) {
    const rua = [limpa(logradouro), limpa(numero)].filter(Boolean).join(", ");
    const comp = limpa(complemento) ? `, ${limpa(complemento)}` : "";
    return `${rua}${comp}${limpa(bairro) ? " - " + limpa(bairro) : ""}`;
}

// Valida os dados de UMA loja informados pela revenda. Tudo obrigatório (exceto complemento), CEP em destaque.
function validarLoja(l, rotulo) {
    const erros = [];
    const d = {
        razao_social: limpa(l.razao_social), cnpj: soDigitos(l.cnpj), logradouro: limpa(l.logradouro), numero: limpa(l.numero),
        bairro: limpa(l.bairro), complemento: limpa(l.complemento), cep: soDigitos(l.cep), cidade: limpa(l.cidade), estado: limpa(l.estado).toUpperCase()
    };
    if (d.razao_social.length < 3) erros.push(`${rotulo}: informe a razão social.`);
    if (!cnpjValido(d.cnpj)) erros.push(`${rotulo}: CNPJ inválido.`);
    if (!cepValido(d.cep)) erros.push(`${rotulo}: CEP inválido (use o formato 00000-000).`);
    if (!d.logradouro) erros.push(`${rotulo}: informe o logradouro.`);
    if (!d.numero) erros.push(`${rotulo}: informe o número (use S/N se não houver).`);
    if (!d.bairro) erros.push(`${rotulo}: informe o bairro.`);
    if (!d.cidade) erros.push(`${rotulo}: informe a cidade.`);
    if (!UFS.has(d.estado)) erros.push(`${rotulo}: UF inválida.`);
    return { dados: d, erros };
}

const sha256 = txt => crypto.createHash("sha256").update(txt, "utf8").digest("hex");

// ─── Texto do termo ──────────────────────────────────────────
function lojaParaTexto(l) {
    const inf = l.inf_cnpj;
    const razao = inf ? l.inf_razao_social : l.cad_nome;
    const cnpj = inf ? l.inf_cnpj : l.cad_cnpj;
    const end = inf ? enderecoComposto({ logradouro: l.inf_logradouro, numero: l.inf_numero, bairro: l.inf_bairro, complemento: l.inf_complemento }) : (l.cad_endereco || "(endereço não informado)");
    const cep = inf ? l.inf_cep : l.cad_cep;
    const cidade = inf ? l.inf_cidade : l.cad_cidade;
    const uf = inf ? l.inf_estado : l.cad_estado;
    return `${razao} — CNPJ ${fmtCnpj(cnpj)} — ${end} — CEP ${fmtCep(cep)} — ${cidade || "?"}/${uf || "?"}`;
}

function renderTexto(corpo, { grupo, programa, lojas }) {
    const lojasTxt = "\n" + lojas.map((l, i) => `   ${i + 1}) ${lojaParaTexto(l)}`).join("\n");
    const sub = t => String(t).replace(/\{\{grupo\}\}/g, grupo).replace(/\{\{nivel\}\}/g, NIVEL[programa] || programa).replace(/\{\{lojas\}\}/g, lojasTxt);
    const partes = [String(corpo.titulo || "Termo de Adesão"), ""];
    (corpo.clausulas || []).forEach((c, i) => { partes.push(`${i + 1}. ${c.titulo}`, sub(c.texto), ""); });
    return partes.join("\n").trim();
}

// ─── Elegibilidade (pura) ────────────────────────────────────
// Qualquer grupo pode receber qualquer programa (decisão do André, 06/11/2026): não há restrição de estado nem de classe de
// origem. O programa do termo define a classe final das lojas incluídas; diferenças viram aviso para o admin conferir.
function avaliarElegibilidade({ programa, lojas }) {
    const erros = [], avisos = [];
    const nivel = NIVEL[programa];
    if (!nivel) return { ok: false, erros: ["Programa inválido."], avisos, classeAtual: null };
    if (!lojas.length) return { ok: false, erros: ["O grupo não tem lojas ativas selecionadas."], avisos, classeAtual: null };
    const classes = [...new Set(lojas.map(l => l.classe || "sem classe"))];
    const classeAtual = classes.length === 1 ? classes[0] : "misto";
    const mudam = lojas.filter(l => l.classe !== nivel);
    if (mudam.length) {
        avisos.push(`Classe atual: ${classes.join(", ")}. Ao concluir, ${mudam.length} loja(s) passam a ${nivel}${programa === "bpartner_diamante" ? " (só depois da compra das duas máquinas)" : ""}.`);
    }
    return { ok: true, erros, avisos, classeAtual };
}

// ─── Camada de acesso (injetável nos testes) ─────────────────
const enc = encodeURIComponent;
const realDeps = {
    get: p => sbSistemasService(p, "GET"),
    post: (p, b) => sbSistemasService(p, "POST", b),
    patch: (p, b) => sbSistemasService(p, "PATCH", b),
    now: () => new Date(),
    geocode: (...a) => require("./geocode.service").geocodeCep(...a),
    consultarCep: consultarCepReal,
    resolverRepresentante: resolverRepresentanteReal,
    notificar: notificarReal,
    gerarComprovante: (...a) => require("./termosPdf.service").gerarComprovante(...a),
    guardarComprovante: guardarComprovanteReal,
    sincronizarLogin: sincronizarLoginReal,
    invalidarCache: () => { try { require("../routes/config.routes").invalidateConfigCache(); } catch { /* opcional */ } }
};
let D = realDeps;
function __setDeps(over) { D = over ? { ...realDeps, ...over } : realDeps; }

const rows = r => (Array.isArray(r) ? r : []);
const hoje = () => D.now().toISOString().slice(0, 10);

async function flagAtiva() {
    const r = rows(await D.get(`/comercial_bmax_config?chave=eq.termos_ativo&select=valor`));
    return r[0] && String(r[0].valor).toLowerCase() === "true";
}
async function configBool(chave) {
    const r = rows(await D.get(`/comercial_bmax_config?chave=eq.${enc(chave)}&select=valor`));
    return !!(r[0] && String(r[0].valor).toLowerCase() === "true");
}
async function setFlag(valor) {
    const existe = rows(await D.get(`/comercial_bmax_config?chave=eq.termos_ativo&select=id`));
    if (existe.length) await D.patch(`/comercial_bmax_config?chave=eq.termos_ativo`, { valor: String(!!valor), atualizado_em: D.now().toISOString() });
    else await D.post(`/comercial_bmax_config`, { chave: "termos_ativo", valor: String(!!valor), descricao: "Termo de Formalização Digital BPartner" });
    return !!valor;
}

async function auditar(termoId, evento, ator, detalhes, ip) {
    await D.post(`/comercial_bmax_termo_auditoria`, {
        termo_id: termoId, evento, ator_email: ator && ator.email || null, ator_tipo: ator && ator.tipo || "sistema",
        detalhes: detalhes || null, ip_address: ip || null
    });
}

async function carregar(termoId) {
    const t = rows(await D.get(`/comercial_bmax_termos?id=eq.${enc(termoId)}&select=*`))[0];
    if (!t) throw erro(404, "Termo não encontrado.");
    const lojas = rows(await D.get(`/comercial_bmax_termo_lojas?termo_id=eq.${enc(termoId)}&select=*&order=criado_em.asc`));
    return { termo: t, lojas };
}
const erro = (status, msg) => Object.assign(new Error(msg), { status });

// ─── Acesso por papel ────────────────────────────────────────
async function papelDoUsuario(user, termo) {
    if (user.role === "adm") return "admin";
    if (user.role === "representante" && termo.representante_user_id === user.id) return "representante";
    if (user.role === "revenda") {
        const meus = rows(await D.get(`/comercial_revendas_bmax?user_id=eq.${Number(user.id)}&select=id,grupo`));
        if (meus.some(m => m.grupo && m.grupo === termo.grupo)) return "revenda";
        const lojas = rows(await D.get(`/comercial_bmax_termo_lojas?termo_id=eq.${enc(termo.id)}&select=revenda_id`));
        const ids = new Set(lojas.map(l => l.revenda_id));
        if (meus.some(m => ids.has(m.id))) return "revenda";
    }
    return null;
}

// ─── Emissão (admin) ─────────────────────────────────────────
async function lojasDoGrupo(grupo) {
    return rows(await D.get(`/comercial_revendas_bmax?grupo=eq.${enc(grupo)}&ativo=eq.true&select=*&order=nome.asc`));
}

async function listarGrupos() {
    const todas = rows(await D.get(`/comercial_revendas_bmax?ativo=eq.true&grupo=not.is.null&select=grupo,classe,estado,user_id`));
    const m = new Map();
    for (const r of todas) {
        const g = m.get(r.grupo) || { grupo: r.grupo, lojas: 0, classes: new Set(), temLogin: false };
        g.lojas++; g.classes.add(r.classe || "-"); if (r.user_id) g.temLogin = true;
        m.set(r.grupo, g);
    }
    return [...m.values()].map(g => ({ grupo: g.grupo, lojas: g.lojas, classes: [...g.classes], temLogin: g.temLogin })).sort((a, b) => a.grupo.localeCompare(b.grupo));
}

async function previaEmissao(grupo, programa, lojaIds) {
    let lojas = await lojasDoGrupo(grupo);
    if (Array.isArray(lojaIds) && lojaIds.length) lojas = lojas.filter(l => lojaIds.includes(l.id));
    const el = avaliarElegibilidade({ programa, lojas });
    const reps = [...new Set(lojas.map(l => limpa(l.rep)).filter(Boolean))];
    return { lojas, elegibilidade: el, representantes: reps };
}

async function emitir({ grupo, programa, lojaIds, representante }, admin) {
    if (!(await flagAtiva())) throw erro(409, "O recurso de termos está desligado (interruptor termos_ativo).");
    if (!NIVEL[programa]) throw erro(400, "Programa inválido.");
    const { lojas, elegibilidade, representantes } = await previaEmissao(grupo, programa, lojaIds);
    if (!elegibilidade.ok) throw erro(400, elegibilidade.erros.join(" "));

    const abertos = rows(await D.get(`/comercial_bmax_termos?grupo=eq.${enc(grupo)}&programa=eq.${enc(programa)}&status=in.(${STATUS_ABERTOS.join(",")})&select=id`));
    if (abertos.length) throw erro(409, "Já existe um termo em andamento para este grupo e programa.");

    const repNome = limpa(representante) || (representantes.length === 1 ? representantes[0] : "");
    if (!repNome) throw erro(400, representantes.length > 1 ? `O grupo tem mais de um representante (${representantes.join(", ")}). Informe quem será a testemunha.` : "O grupo não tem representante no cadastro; informe a testemunha.");
    const rep = await D.resolverRepresentante(repNome);
    if (!rep) throw erro(400, `Representante "${repNome}" não tem login ativo no Portal — a testemunha precisa de acesso.`);

    const conteudo = rows(await D.get(`/comercial_bmax_conteudos_programa?programa=eq.${enc(programa)}&tema=eq.termo_adesao&ativo=eq.true&select=*&order=versao.desc&limit=1`))[0];
    if (!conteudo) throw erro(500, "Texto do termo não encontrado para este programa.");

    const lojasTermo = lojas.map(l => ({
        revenda_id: l.id, cad_nome: l.nome, cad_cnpj: soDigitos(l.cnpj), cad_endereco: l.endereco, cad_cep: soDigitos(l.cep),
        cad_cidade: l.cidade, cad_estado: l.estado, classe_antes: l.classe
    }));
    const texto = renderTexto(conteudo.corpo, { grupo, programa, lojas: lojasTermo });
    const criado = rows(await D.post(`/comercial_bmax_termos`, {
        grupo, programa, classe_antes: elegibilidade.classeAtual, conteudo_id: conteudo.id, texto_renderizado: texto, hash_sha256: sha256(texto),
        status: "aguardando_revenda", representante_nome: repNome, representante_user_id: rep.userId, emitido_por: admin.email
    }))[0];
    await D.post(`/comercial_bmax_termo_lojas`, lojasTermo.map(l => ({ ...l, termo_id: criado.id })));
    await auditar(criado.id, "criado", { email: admin.email, tipo: "admin" }, { programa, grupo, lojas: lojasTermo.length, conteudo_versao: conteudo.versao });
    await D.notificar("emitido", criado, lojasTermo);
    return criado;
}

// ─── Etapa 1: revenda ────────────────────────────────────────
async function revendaConfirmar(termoId, user, body, ctx = {}) {
    if (!(await flagAtiva())) throw erro(409, "Recurso desligado.");
    const { termo, lojas } = await carregar(termoId);
    if ((await papelDoUsuario(user, termo)) !== "revenda") throw erro(403, "Acesso negado.");
    if (termo.status !== "aguardando_revenda") throw erro(409, "Este termo não está aguardando a revenda.");

    const erros = [];
    const nome = limpa(body.nome), cargo = limpa(body.cargo), cpf = soDigitos(body.cpf);
    if (nome.split(" ").length < 2) erros.push("Informe o nome completo do signatário.");
    if (cargo.length < 2) erros.push("Informe o cargo do signatário.");
    if (!cpfValido(cpf)) erros.push("CPF do signatário inválido.");
    if (body.aceite !== true) erros.push("É preciso marcar o aceite do termo.");

    const enviados = Array.isArray(body.lojas) ? body.lojas : [];
    const porId = new Map(enviados.map(e => [e.id, e]));
    const validadas = [];
    for (const l of lojas.filter(x => !x.nova_loja)) {
        const e = porId.get(l.id);
        if (!e) { erros.push(`Faltam os dados da loja ${l.cad_nome}.`); continue; }
        const v = validarLoja(e, l.cad_nome || "Loja");
        erros.push(...v.erros); validadas.push({ id: l.id, nova: false, dados: v.dados });
    }
    (Array.isArray(body.novas) ? body.novas : []).forEach((n, i) => {
        const v = validarLoja(n, `Loja adicional ${i + 1}`);
        erros.push(...v.erros); validadas.push({ id: null, nova: true, dados: v.dados });
    });
    const cnpjs = validadas.map(v => v.dados.cnpj);
    if (new Set(cnpjs).size !== cnpjs.length) erros.push("Há CNPJ repetido entre as lojas informadas.");

    // CNPJ já cadastrado em OUTRA loja (de qualquer grupo) = duplicidade: bloqueia antes de gravar qualquer coisa
    for (const v of validadas) {
        const proprio = v.id ? (lojas.find(l => l.id === v.id) || {}).revenda_id : null;
        const dono = await cnpjEmOutraLoja(v.dados.cnpj, proprio);
        if (dono) erros.push(`O CNPJ ${fmtCnpj(v.dados.cnpj)} já está cadastrado na loja "${dono.nome}". Se for a mesma loja, não a repita; se for engano, corrija o CNPJ.`);
    }

    // CEP precisa existir e bater com a UF (consulta externa; indisponibilidade não bloqueia)
    for (const v of validadas) {
        if (v.dados.cep.length !== 8) continue;
        const c = await D.consultarCep(v.dados.cep).catch(() => null);
        if (c && c.estado && c.estado.toUpperCase() !== v.dados.estado) erros.push(`CEP ${fmtCep(v.dados.cep)} pertence a ${c.estado}, mas a UF informada é ${v.dados.estado}.`);
        if (c && c.naoEncontrado) erros.push(`CEP ${fmtCep(v.dados.cep)} não encontrado.`);
    }
    if (erros.length) throw Object.assign(erro(400, erros[0]), { erros });

    const agora = D.now().toISOString();
    for (const v of validadas) {
        const inf = {
            inf_razao_social: v.dados.razao_social, inf_cnpj: v.dados.cnpj, inf_logradouro: v.dados.logradouro, inf_numero: v.dados.numero,
            inf_bairro: v.dados.bairro, inf_complemento: v.dados.complemento || null, inf_cep: v.dados.cep, inf_cidade: v.dados.cidade,
            inf_estado: v.dados.estado, informado_em: agora
        };
        if (v.nova) await D.post(`/comercial_bmax_termo_lojas`, { termo_id: termo.id, nova_loja: true, ...inf });
        else await D.patch(`/comercial_bmax_termo_lojas?id=eq.${enc(v.id)}`, inf);
    }
    const { lojas: finais } = await carregar(termoId);
    const conteudo = rows(await D.get(`/comercial_bmax_conteudos_programa?id=eq.${enc(termo.conteudo_id)}&select=corpo`))[0];
    const texto = renderTexto(conteudo.corpo, { grupo: termo.grupo, programa: termo.programa, lojas: finais });
    const hash = sha256(texto);
    await D.post(`/comercial_bmax_termo_aprovacoes`, {
        termo_id: termo.id, etapa: "revenda", usuario_id: user.id, usuario_email: user.username || null, nome_aprovador: nome, cargo, cpf,
        declaracao: `Declaro representar o grupo ${termo.grupo} e todas as lojas relacionadas e aceito este termo (hash ${hash.slice(0, 16)}…).`,
        detalhes: { observacao: limpa(body.observacao) || null, lojas: validadas.length }, ip_address: ctx.ip || null, user_agent: ctx.userAgent || null
    });
    await D.patch(`/comercial_bmax_termos?id=eq.${enc(termo.id)}`, { texto_renderizado: texto, hash_sha256: hash, status: "aguardando_representante", atualizado_em: agora });
    await auditar(termo.id, "etapa_concluida", { email: user.username, tipo: "revenda" }, { etapa: "revenda", hash }, ctx.ip);
    await D.notificar("revenda_confirmou", { ...termo, hash_sha256: hash }, finais);
    return { status: "aguardando_representante", hash };
}

// ─── Etapa 2: representante (testemunha) ─────────────────────
async function testemunhar(termoId, user, body, ctx = {}) {
    if (!(await flagAtiva())) throw erro(409, "Recurso desligado.");
    const { termo } = await carregar(termoId);
    if ((await papelDoUsuario(user, termo)) !== "representante") throw erro(403, "Somente o representante deste grupo pode testemunhar.");
    if (termo.status !== "aguardando_representante") throw erro(409, "Este termo não está aguardando a testemunha.");
    if (body.aceite !== true) throw erro(400, "É preciso confirmar a declaração de testemunha.");
    const nome = limpa(body.nome) || termo.representante_nome;
    if (nome.length < 3) throw erro(400, "Informe o nome do representante.");
    await D.post(`/comercial_bmax_termo_aprovacoes`, {
        termo_id: termo.id, etapa: "testemunha_representante", usuario_id: user.id, usuario_email: user.username || null, nome_aprovador: nome,
        declaracao: "Declaro ter acompanhado esta adesão e conferido os dados das lojas relacionadas.", ip_address: ctx.ip || null, user_agent: ctx.userAgent || null
    });
    await D.patch(`/comercial_bmax_termos?id=eq.${enc(termo.id)}`, { status: "aguardando_boxer", atualizado_em: D.now().toISOString() });
    await auditar(termo.id, "etapa_concluida", { email: user.username, tipo: "representante" }, { etapa: "testemunha_representante" }, ctx.ip);
    await D.notificar("testemunhou", termo, []);
    return { status: "aguardando_boxer" };
}

// ─── Atualização automática do cadastro ──────────────────────
// Existe OUTRA loja no cadastro (ativa ou não) com esse CNPJ? `proprio` = id da loja que está sendo editada (ignorada).
async function cnpjEmOutraLoja(cnpj, proprio) {
    const d = soDigitos(cnpj);
    const achados = [
        ...rows(await D.get(`/comercial_revendas_bmax?cnpj=eq.${enc(d)}&select=id,nome`)),
        ...rows(await D.get(`/comercial_revendas_bmax?cnpj=eq.${enc(fmtCnpj(d))}&select=id,nome`))
    ];
    return achados.find(a => a.id !== proprio) || null;
}

// PLANEJA (só lê): o que seria gravado no cadastro, o que é divergência (precisa de confirmação) e o que bloqueia.
//  - Nunca renomeia (nome/nome_rd ligam RD, Portal e Motor) e nunca cria loja nova (lojas adicionais ficam listadas).
//  - Troca de CNPJ de loja existente só com confirmação explícita do admin (pode ser erro de digitação da revenda).
//  - CNPJ que já existe em outra loja bloqueia (evita duplicidade).
//  - Se a loja tem login no Portal, o espelho (Revendas/RevendaFilial) recebe cep/cidade/estado (e CNPJ confirmado).
async function planejarCadastro(termo, lojas, nivel) {
    const plano = { atualizadas: [], divergencias: [], bloqueios: [], pendentesCadastro: [], avisos: [] };
    for (const l of lojas) {
        if (l.nova_loja) { plano.pendentesCadastro.push({ razao_social: l.inf_razao_social, cnpj: l.inf_cnpj, cep: l.inf_cep, cidade: l.inf_cidade, estado: l.inf_estado }); continue; }
        if (!l.revenda_id || !l.inf_cnpj) continue;
        const atual = rows(await D.get(`/comercial_revendas_bmax?id=eq.${enc(l.revenda_id)}&select=*`))[0];
        if (!atual) { plano.avisos.push(`Loja ${l.cad_nome} não existe mais no cadastro.`); continue; }
        const cnpjMudou = soDigitos(atual.cnpj) !== l.inf_cnpj;
        if (cnpjMudou) {
            const dono = await cnpjEmOutraLoja(l.inf_cnpj, l.revenda_id);
            if (dono) plano.bloqueios.push(`${l.cad_nome}: o CNPJ ${fmtCnpj(l.inf_cnpj)} já pertence à loja "${dono.nome}".`);
            else plano.divergencias.push({ loja: l.cad_nome, campo: "cnpj", de: fmtCnpj(atual.cnpj), para: fmtCnpj(l.inf_cnpj) });
        }
        const patch = {
            cep: l.inf_cep, endereco: enderecoComposto({ logradouro: l.inf_logradouro, numero: l.inf_numero, bairro: l.inf_bairro, complemento: l.inf_complemento }),
            cidade: l.inf_cidade, estado: l.inf_estado
        };
        if (cnpjMudou || atual.cnpj !== l.inf_cnpj) patch.cnpj = l.inf_cnpj; // padroniza só dígitos
        if (nivel && nivel !== "Diamante" && atual.classe !== nivel) patch.classe = nivel; // Diamante só após a compra
        const geo = await D.geocode(l.inf_cep, { cidade: l.inf_cidade, estado: l.inf_estado }).catch(() => ({ lat: null, lng: null }));
        if (geo && geo.lat != null && geo.lng != null) { patch.lat = geo.lat; patch.lng = geo.lng; }
        else plano.avisos.push(`Sem coordenadas para o CEP ${fmtCep(l.inf_cep)} (${l.cad_nome}); a distância no Motor usa a posição anterior.`);
        const antes = {}; for (const k of Object.keys(patch)) antes[k] = atual[k] == null ? null : atual[k];
        plano.atualizadas.push({ loja: l.cad_nome, id: l.revenda_id, userId: atual.user_id || null, cnpjMudou, antes, depois: patch, loja_termo_id: l.id });
    }
    return plano;
}

// EXECUTA o plano. Idempotente. `confirmarCnpj` libera a troca de CNPJ de lojas existentes.
async function aplicarCadastro(termo, lojas, { dry = false, ator = "termo", confirmarCnpj = false, nivel = null } = {}) {
    const plano = await planejarCadastro(termo, lojas, nivel);
    plano.avisosLogin = [];
    if (dry) return plano;
    if (plano.bloqueios.length) throw erro(409, "Duplicidade de CNPJ: " + plano.bloqueios.join(" "));
    if (plano.divergencias.length && !confirmarCnpj) throw Object.assign(erro(409, "Há troca de CNPJ de loja existente: confira e confirme. " + plano.divergencias.map(d => `${d.loja}: ${d.de} → ${d.para}`).join("; ")), { divergencias: plano.divergencias });
    const agora = D.now().toISOString();
    for (const a of plano.atualizadas) {
        await D.patch(`/comercial_revendas_bmax?id=eq.${enc(a.id)}`, { ...a.depois, editado_em: agora, editado_por: `${ator}:${termo.id}` });
        await D.patch(`/comercial_bmax_termo_lojas?id=eq.${enc(a.loja_termo_id)}`, { cadastro_atualizado_em: agora, classe_depois: a.depois.classe || null });
        if (a.userId) {
            try { await D.sincronizarLogin(a.userId, { cep: a.depois.cep, cidade: a.depois.cidade, estado: a.depois.estado, ...(a.cnpjMudou ? { cnpj: a.depois.cnpj } : {}) }); }
            catch (e) { plano.avisosLogin.push(`Login da loja ${a.loja} não sincronizado: ${e.message}`); }
        }
    }
    if (plano.atualizadas.length) D.invalidarCache();
    return plano;
}

// ─── Etapa 3: Boxer (admin) ──────────────────────────────────
async function boxerAprovar(termoId, admin, body = {}, ctx = {}) {
    if (!(await flagAtiva())) throw erro(409, "Recurso desligado.");
    const { termo, lojas } = await carregar(termoId);
    if (termo.status !== "aguardando_boxer") throw erro(409, "Este termo não está aguardando a Boxer.");
    if ((await configBool("termos_aprovador_diferente")) && termo.emitido_por && termo.emitido_por === admin.email) throw erro(403, "Quem emitiu o termo não pode aprová-lo.");
    const chk = body.checklist || {};
    const nivel = NIVEL[termo.programa];
    const jaDiamante = lojas.length > 0 && lojas.every(l => l.classe_antes === "Diamante");
    if (termo.programa === "bpartner_diamante") {
        if (!chk.capacitacao || !chk.funcionario_dedicado) throw erro(400, "Confirme a capacitação do demonstrador e o funcionário dedicado.");
        if (jaDiamante && !chk.compra_realizada) throw erro(400, "Confirme que a compra das duas máquinas já foi realizada.");
    }
    // 1) cadastro (idempotente) — duplicidade ou troca de CNPJ não confirmada interrompem; o termo continua aguardando
    const cadastro = await aplicarCadastro(termo, lojas, { dry: body.simular === true, confirmarCnpj: body.confirmarCnpj === true, nivel });
    if (body.simular === true) return { simulacao: true, cadastro };

    const agora = D.now();
    const upgrade = termo.programa === "bpartner_diamante" && !jaDiamante;
    const prazo = upgrade ? new Date(agora.getTime() + PRAZO_COMPRA_DIAS * 86400000).toISOString().slice(0, 10) : null;
    await D.post(`/comercial_bmax_termo_aprovacoes`, {
        termo_id: termo.id, etapa: "boxer", usuario_id: admin.id || null, usuario_email: admin.email, nome_aprovador: admin.nome || admin.email,
        declaracao: "Aprovação final da Boxer Soldas.", detalhes: { checklist: chk, confirmouCnpj: body.confirmarCnpj === true, cadastro: { atualizadas: cadastro.atualizadas.length, pendentes: cadastro.pendentesCadastro.length } },
        ip_address: ctx.ip || null, user_agent: ctx.userAgent || null
    });
    const novoStatus = upgrade ? "aguardando_compra" : "aprovado";
    await D.patch(`/comercial_bmax_termos?id=eq.${enc(termo.id)}`, {
        status: novoStatus, compra_prazo_ate: prazo, aprovado_em: upgrade ? null : agora.toISOString(), atualizado_em: agora.toISOString()
    });
    await auditar(termo.id, "etapa_concluida", { email: admin.email, tipo: "admin" }, { etapa: "boxer", status: novoStatus, checklist: chk }, ctx.ip);
    await auditar(termo.id, "cadastro_atualizado", { email: admin.email, tipo: "admin" }, { atualizadas: cadastro.atualizadas, pendentesCadastro: cadastro.pendentesCadastro, avisos: [...cadastro.avisos, ...cadastro.avisosLogin] }, ctx.ip);

    let comprovantePath = null;
    try {
        const atual = await carregar(termoId);
        const aprov = rows(await D.get(`/comercial_bmax_termo_aprovacoes?termo_id=eq.${enc(termoId)}&select=*&order=aprovado_em.asc`));
        const pdf = await D.gerarComprovante({ termo: atual.termo, lojas: atual.lojas, aprovacoes: aprov, fmt: { fmtCnpj, fmtCep, fmtCpfMascarado, enderecoComposto } });
        comprovantePath = await D.guardarComprovante(termoId, pdf);
        await D.patch(`/comercial_bmax_termos?id=eq.${enc(termoId)}`, { comprovante_path: comprovantePath });
        await auditar(termoId, "comprovante_gerado", { tipo: "sistema" }, { path: comprovantePath });
        await D.notificar(novoStatus === "aprovado" ? "aprovado" : "aprovado_aguarda_compra", { ...atual.termo, status: novoStatus, compra_prazo_ate: prazo }, atual.lojas, pdf);
    } catch (e) {
        logger.error({ message: "Falha ao gerar/enviar comprovante do termo", termoId, error: e.message });
    }
    return { status: novoStatus, compra_prazo_ate: prazo, cadastro, comprovante: !!comprovantePath };
}

// ─── Diamante: confirmação da compra das duas máquinas ───────
async function confirmarCompra(termoId, admin, body = {}, ctx = {}) {
    const { termo, lojas } = await carregar(termoId);
    if (termo.status !== "aguardando_compra") throw erro(409, "Este termo não está aguardando a compra das máquinas.");
    const notas = limpa(body.notas);
    if (notas.length < 3) throw erro(400, "Informe os números das NFs da compra das duas máquinas.");
    const agora = D.now().toISOString();
    for (const l of lojas.filter(x => x.revenda_id)) {
        await D.patch(`/comercial_revendas_bmax?id=eq.${enc(l.revenda_id)}`, { classe: "Diamante", editado_em: agora, editado_por: `termo:${termo.id}` });
        await D.patch(`/comercial_bmax_termo_lojas?id=eq.${enc(l.id)}`, { classe_depois: "Diamante" });
    }
    D.invalidarCache();
    await D.patch(`/comercial_bmax_termos?id=eq.${enc(termo.id)}`, {
        status: "aprovado", aprovado_em: agora, compra_confirmada_em: agora, compra_confirmada_por: admin.email, compra_notas: notas, atualizado_em: agora
    });
    await auditar(termo.id, "compra_confirmada", { email: admin.email, tipo: "admin" }, { notas }, ctx.ip);
    await auditar(termo.id, "classe_atualizada", { email: admin.email, tipo: "admin" }, { de: "Ouro", para: "Diamante", lojas: lojas.filter(x => x.revenda_id).length }, ctx.ip);
    await D.notificar("diamante_confirmado", { ...termo, status: "aprovado" }, lojas);
    return { status: "aprovado" };
}

async function cancelar(termoId, admin, motivo, ctx = {}) {
    const { termo } = await carregar(termoId);
    if (!STATUS_ABERTOS.includes(termo.status)) throw erro(409, "Este termo já foi concluído ou cancelado.");
    await D.patch(`/comercial_bmax_termos?id=eq.${enc(termo.id)}`, { status: "cancelado", atualizado_em: D.now().toISOString() });
    await auditar(termo.id, "cancelado", { email: admin.email, tipo: "admin" }, { motivo: limpa(motivo) || null }, ctx.ip);
    return { status: "cancelado" };
}

// ─── Rotina diária: prazo da compra (30 dias) ────────────────
async function processarPrazos() {
    const hojeStr = hoje();
    const venceram = rows(await D.get(`/comercial_bmax_termos?status=eq.aguardando_compra&compra_prazo_ate=lt.${hojeStr}&select=*`));
    for (const t of venceram) {
        await D.patch(`/comercial_bmax_termos?id=eq.${enc(t.id)}`, { status: "encerrado_sem_compra", atualizado_em: D.now().toISOString() });
        await auditar(t.id, "encerrado_sem_compra", { tipo: "sistema" }, { prazo: t.compra_prazo_ate });
        await D.notificar("encerrado_sem_compra", t, []);
    }
    const limite = new Date(D.now().getTime() + 5 * 86400000).toISOString().slice(0, 10);
    const perto = rows(await D.get(`/comercial_bmax_termos?status=eq.aguardando_compra&compra_prazo_ate=gte.${hojeStr}&compra_prazo_ate=lte.${limite}&select=*`));
    let lembretes = 0;
    for (const t of perto) {
        const ja = rows(await D.get(`/comercial_bmax_termo_auditoria?termo_id=eq.${enc(t.id)}&evento=eq.lembrete_compra&select=id&limit=1`));
        if (ja.length) continue;
        await auditar(t.id, "lembrete_compra", { tipo: "sistema" }, { prazo: t.compra_prazo_ate });
        await D.notificar("lembrete_compra", t, []);
        lembretes++;
    }
    return { encerrados: venceram.length, lembretes };
}

// ─── Consultas ───────────────────────────────────────────────
async function listar() {
    return rows(await D.get(`/comercial_bmax_termos?select=id,grupo,programa,classe_antes,status,representante_nome,emitido_por,compra_prazo_ate,aprovado_em,criado_em,atualizado_em&order=criado_em.desc&limit=200`));
}

async function obter(termoId, user) {
    const { termo, lojas } = await carregar(termoId);
    const papel = await papelDoUsuario(user, termo);
    if (!papel) throw erro(403, "Acesso negado.");
    const aprovacoes = rows(await D.get(`/comercial_bmax_termo_aprovacoes?termo_id=eq.${enc(termoId)}&select=etapa,nome_aprovador,cargo,usuario_email,aprovado_em,declaracao&order=aprovado_em.asc`));
    const out = { papel, termo, lojas, aprovacoes };
    if (papel === "admin") out.auditoria = rows(await D.get(`/comercial_bmax_termo_auditoria?termo_id=eq.${enc(termoId)}&select=evento,ator_email,ator_tipo,detalhes,criado_em&order=criado_em.asc`));
    return out;
}

// Pendências do usuário logado (revenda: aguardando a revenda; representante: aguardando a testemunha)
async function minhas(user) {
    if (!(await flagAtiva())) return [];
    if (user.role === "representante") {
        return rows(await D.get(`/comercial_bmax_termos?representante_user_id=eq.${Number(user.id)}&status=eq.aguardando_representante&select=id,grupo,programa,status,criado_em`));
    }
    if (user.role === "revenda") {
        const meus = rows(await D.get(`/comercial_revendas_bmax?user_id=eq.${Number(user.id)}&select=grupo`));
        const grupos = [...new Set(meus.map(m => m.grupo).filter(Boolean))];
        if (!grupos.length) return [];
        const lista = grupos.map(g => `"${String(g).replace(/"/g, '\\"')}"`).join(",");
        return rows(await D.get(`/comercial_bmax_termos?grupo=in.(${enc(lista)})&status=eq.aguardando_revenda&select=id,grupo,programa,status,criado_em`));
    }
    return [];
}

async function urlComprovante(termoId, user) {
    const { termo } = await carregar(termoId);
    if (!(await papelDoUsuario(user, termo))) throw erro(403, "Acesso negado.");
    if (!termo.comprovante_path) throw erro(404, "Comprovante ainda não gerado.");
    const key = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
    const r = await fetch(`${SB_SISTEMAS_URL}/storage/v1/object/sign/${BUCKET}/${termo.comprovante_path}`, {
        method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 300 })
    });
    if (!r.ok) throw erro(502, "Não foi possível abrir o comprovante.");
    const j = await r.json();
    return `${SB_SISTEMAS_URL}/storage/v1${j.signedURL}`;
}

// ─── Integrações reais (substituídas nos testes) ─────────────
// Espelho do cadastro no login do Portal: só cep/cidade/estado (e CNPJ confirmado), sem criar nem apagar nada.
async function sincronizarLoginReal(userId, patch) {
    const { Revenda, RevendaFilial } = require("../database");
    const rev = await Revenda.findOne({ where: { user_id: userId } });
    if (!rev) return;
    const upd = { cep: patch.cep, cidade: patch.cidade, estado: patch.estado };
    if (patch.cnpj && patch.cnpj !== rev.cnpj) {
        const outro = await Revenda.findOne({ where: { cnpj: patch.cnpj } });
        if (outro && outro.user_id !== userId) throw new Error("CNPJ já usado por outro login");
        upd.cnpj = patch.cnpj;
    }
    await Revenda.update(upd, { where: { user_id: userId } });
    await RevendaFilial.update({ cep: patch.cep, cidade: patch.cidade, estado: patch.estado }, { where: { user_id: userId, principal: true } });
}

async function consultarCepReal(cep) {
    const r = await fetch(`https://brasilapi.com.br/api/cep/v2/${soDigitos(cep)}`, { signal: AbortSignal.timeout(6000) });
    if (r.status === 404) return { naoEncontrado: true };
    if (!r.ok) return null;
    const d = await r.json();
    return { estado: d.state, cidade: d.city, bairro: d.neighborhood, logradouro: d.street };
}

async function resolverRepresentanteReal(nomeRd) {
    const { getAliasMaps } = require("./rd.leads.service");
    const { User } = require("../database");
    const maps = await getAliasMaps();
    const username = maps.rdToUsername && maps.rdToUsername[nomeRd];
    if (!username) return null;
    const u = await User.findOne({ where: { username, role: "representante" } });
    return u ? { userId: u.id, username, email: (maps.rdToEmail && maps.rdToEmail[nomeRd]) || (String(username).includes("@") ? username : null) } : null;
}

async function guardarComprovanteReal(termoId, pdfBuffer) {
    const path = `${new Date().getFullYear()}/${termoId}/comprovante.pdf`;
    const key = process.env.SUPABASE_SERVICE_KEY_SISTEMAS;
    const r = await fetch(`${SB_SISTEMAS_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST", headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/pdf", "x-upsert": "true" }, body: pdfBuffer
    });
    if (!r.ok) throw new Error(`Storage ${r.status}: ${(await r.text()).slice(0, 120)}`);
    return path;
}

async function emailsDosAdmins() {
    try {
        const r = rows(await sbSistemasService(`/comercial_bmax_admins?ativo=eq.true&select=email`));
        const lista = r.map(a => a.email).filter(e => e && e.includes("@"));
        if (lista.length) return lista;
    } catch { /* cai no fallback */ }
    const { User } = require("../database");
    return (await User.findAll({ where: { role: "adm" } })).map(u => u.username).filter(e => e && e.includes("@"));
}

async function emailsDaRevenda(lojas) {
    const ids = [...new Set(lojas.map(l => l.revenda_id).filter(Boolean))];
    if (!ids.length) return [];
    const cad = rows(await sbSistemasService(`/comercial_revendas_bmax?id=in.(${ids.join(",")})&select=email,user_id`));
    const out = new Set(cad.map(c => c.email).filter(e => e && e.includes("@")));
    const userIds = cad.map(c => c.user_id).filter(Boolean);
    if (userIds.length) {
        const { User } = require("../database");
        (await User.findAll({ where: { id: userIds } })).forEach(u => { if (u.username && u.username.includes("@")) out.add(u.username); });
    }
    return [...out];
}

async function enviarEmail(para, assunto, html, anexo) {
    const apiKey = process.env.RESEND_API_KEY;
    const to = [...new Set((Array.isArray(para) ? para : [para]).filter(Boolean))];
    if (!apiKey || !to.length) return false;
    const corpo = { from: "Portal BMax <noreply@boxersoldas.com.br>", to, subject: assunto, html };
    if (anexo) corpo.attachments = [{ filename: "comprovante-termo-bpartner.pdf", content: Buffer.from(anexo).toString("base64") }];
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
    if (!r.ok) logger.error({ message: "Resend (termo) falhou", status: r.status, to });
    return r.ok;
}

const caixa = (titulo, corpo) => `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px"><h2 style="color:#1d327b">${titulo}</h2>${corpo}<p style="margin-top:20px"><a href="${PORTAL_URL}/#dash" style="background:#1d327b;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Abrir o Portal BMax</a></p></div>`;

async function notificarReal(evento, termo, lojas, anexo) {
    try {
        const nivel = NIVEL[termo.programa] || termo.programa;
        const base = `<p>Grupo: <b>${termo.grupo}</b> — Programa BPartner ${nivel}</p>`;
        if (evento === "emitido") await enviarEmail(await emailsDaRevenda(lojas), `Termo de adesão BPartner ${nivel} aguardando sua confirmação`, caixa("Termo de adesão aguardando você", base + "<p>Entre no Portal BMax e confirme o termo, informando os dados de todas as lojas do grupo (CNPJ, endereço e CEP).</p>"));
        else if (evento === "revenda_confirmou") { const rep = await resolverRepresentanteReal(termo.representante_nome).catch(() => null); await enviarEmail(rep && rep.email, `Termo BPartner ${nivel}: sua testemunha é necessária`, caixa("Você foi indicado como testemunha", base + "<p>A revenda confirmou o termo. Entre no Portal BMax para conferir os dados e testemunhar.</p>")); }
        else if (evento === "testemunhou") await enviarEmail(await emailsDosAdmins(), `Termo BPartner ${nivel} aguardando aprovação da Boxer`, caixa("Termo aguardando a Boxer", base + "<p>Revenda e representante concluíram suas etapas. Aprove na tela Gestão › Termos.</p>"));
        else if (evento === "aprovado" || evento === "aprovado_aguarda_compra") {
            const msg = evento === "aprovado" ? "<p>O termo foi aprovado. O comprovante segue em anexo.</p>" : `<p>O termo foi aprovado. A classificação Diamante será ativada após a compra das duas máquinas, até <b>${termo.compra_prazo_ate}</b>; sem a compra, o grupo permanece Ouro. Comprovante em anexo.</p>`;
            const rep = await resolverRepresentanteReal(termo.representante_nome).catch(() => null);
            await enviarEmail([...(await emailsDaRevenda(lojas)), ...(await emailsDosAdmins()), ...(rep && rep.email ? [rep.email] : [])], `Termo BPartner ${nivel} aprovado`, caixa("Termo aprovado", base + msg), anexo);
        } else if (evento === "diamante_confirmado") await enviarEmail([...(await emailsDaRevenda(lojas)), ...(await emailsDosAdmins())], "Classificação Diamante ativada", caixa("Classificação Diamante ativada", base + "<p>A compra das duas máquinas foi confirmada e o grupo agora é Diamante.</p>"));
        else if (evento === "encerrado_sem_compra") await enviarEmail(await emailsDosAdmins(), `Termo BPartner Diamante encerrado sem compra — ${termo.grupo}`, caixa("Prazo de compra vencido", base + "<p>Passaram 30 dias sem a compra das duas máquinas. O grupo permanece Ouro.</p>"));
        else if (evento === "lembrete_compra") await enviarEmail(await emailsDosAdmins(), `Prazo de compra Diamante vence em breve — ${termo.grupo}`, caixa("Prazo de compra perto de vencer", base + `<p>O prazo para a compra das duas máquinas vence em <b>${termo.compra_prazo_ate}</b>.</p>`));
    } catch (e) {
        logger.error({ message: "Falha ao notificar evento do termo", evento, termoId: termo && termo.id, error: e.message });
    }
}

module.exports = {
    // puras (testáveis)
    soDigitos, cnpjValido, cpfValido, cepValido, fmtCnpj, fmtCep, enderecoComposto, validarLoja, sha256, renderTexto, avaliarElegibilidade,
    // fluxo
    flagAtiva, setFlag, listarGrupos, previaEmissao, emitir, revendaConfirmar, testemunhar, boxerAprovar, confirmarCompra, cancelar,
    planejarCadastro, aplicarCadastro, cnpjEmOutraLoja, processarPrazos, listar, obter, minhas, urlComprovante, papelDoUsuario, consultarCepReal,
    __setDeps
};
