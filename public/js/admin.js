let ADMIN_REVENDAS = [];
let ADMIN_ALERTAS = [];
let ADMIN_USERS = [];
let ADMIN_REV_BMAX = [];
let ADMIN_REPS_BMAX = [];
let ADMIN_VENDEDORES = [];
let ADMIN_REP_BMAX_LIST = [];
let ADMIN_COMISSAO = {};
let ADMIN_COMISSAO_LOADED = false;

// Masks e formatação
function maskCNPJ(v) { return v.replace(/\D/g, '').replace(/(\d{2})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1/$2').replace(/(\d{4})(\d)/, '$1-$2').substring(0, 18); }
function maskTelefone(v) { const c = v.replace(/\D/g, ''); return c.length <= 10 ? c.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2') : c.replace(/(\d{2})(\d{5})(\d)/, '($1) $2-$3').substring(0, 15); }
function maskCEP(v) { return v.replace(/\D/g, '').replace(/(\d{5})(\d)/, '$1-$2').substring(0, 9); }
function unmaskNumber(v) { return v.replace(/\D/g, ''); }

async function loadAdminRevendas() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/revendas-rd`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar revendas");
        const data = await res.json();
        ADMIN_REVENDAS = data.revendas || [];
        ADMIN_ALERTAS = data.alertas || [];
    } catch (e) { console.error(e); toast("Erro ao carregar revendas RD", "error"); }
}

async function loadAdminUsers() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar usuarios");
        ADMIN_USERS = await res.json();
    } catch (e) { console.error(e); toast("Erro ao carregar usuarios", "error"); }
}

function renderAdminRevendas() {
    const wrap = $("adminRevendasBody");
    if (!wrap) return;

    const filterVal = ($("adminRevendaFilter")?.value || "").toLowerCase();
    const grupoFilter = $("adminGrupoFilter")?.value || "all";

    let filtered = ADMIN_REVENDAS;
    if (filterVal) filtered = filtered.filter(r => r.nome.toLowerCase().includes(filterVal));
    if (grupoFilter === "sem-grupo") filtered = filtered.filter(r => !r.grupo);
    else if (grupoFilter === "com-grupo") filtered = filtered.filter(r => !!r.grupo);
    else if (grupoFilter !== "all") filtered = filtered.filter(r => r.grupo === grupoFilter);

    const gruposDistintos = [...new Set(ADMIN_REVENDAS.filter(r => r.grupo).map(r => r.grupo))].sort();

    const grupoSelect = $("adminGrupoFilter");
    if (grupoSelect && grupoSelect.options.length <= 3) {
        gruposDistintos.forEach(g => {
            const opt = document.createElement("option");
            opt.value = g; opt.textContent = g;
            grupoSelect.appendChild(opt);
        });
    }

    if (!filtered.length) {
        wrap.innerHTML = '<div class="empty-state">Nenhuma revenda encontrada.</div>';
        return;
    }

    let alertaHtml = "";
    if (ADMIN_ALERTAS.length) {
        alertaHtml = `<div class="admin-alerta"><span class="alert-icon" style="color:#e30613">⚠</span> <strong>${ADMIN_ALERTAS.length}</strong> lead(s) com revenda que nao existe na lista do RD: <strong>${ADMIN_ALERTAS.map(a => esc(a.nome)).join(", ")}</strong></div>`;
    }

    let html = `<table class="extrato-table">
        <thead><tr>
            <th>Revenda (RD Station)</th>
            <th>Leads</th>
            <th>Grupo</th>
            <th>Email Responsavel</th>
            <th>Acoes</th>
        </tr></thead><tbody>`;

    for (const r of filtered) {
        html += `<tr>
            <td><strong>${esc(r.nome)}</strong></td>
            <td>${r.leads ? '<span style="color:#16a34a">sim</span>' : '<span style="color:var(--muted)">—</span>'}</td>
            <td>${r.grupo ? `<span class="tipo-badge credito">${esc(r.grupo)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
            <td>${r.email_responsavel ? esc(r.email_responsavel) : '<span style="color:var(--muted)">—</span>'}</td>
            <td><button class="btn btn-sm" onclick="openGrupoModal('${esc(r.nome)}','${esc(r.grupo || "")}','${esc(r.email_responsavel || "")}')">Editar</button></td>
        </tr>`;
    }
    html += "</tbody></table>";

    const comLeads = ADMIN_REVENDAS.filter(r => r.leads).length;
    const stats = `<div class="admin-stats">
        <span><strong>${ADMIN_REVENDAS.length}</strong> revendas no RD</span>
        <span><strong>${comLeads}</strong> com leads</span>
        <span><strong>${ADMIN_REVENDAS.filter(r => r.grupo).length}</strong> com grupo</span>
        <span><strong>${gruposDistintos.length}</strong> grupos</span>
    </div>`;

    wrap.innerHTML = alertaHtml + stats + html;
}

function openGrupoModal(revenda, grupo, email) {
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>Configurar Grupo</h3>
        <div class="form-row">
            <label>Revenda (RD)</label>
            <input type="text" id="modalRevenda" value="${esc(revenda)}" readonly style="background:var(--bg-alt);color:var(--muted)">
        </div>
        <div class="form-row">
            <label>Grupo Comercial</label>
            <input type="text" id="modalGrupo" value="${esc(grupo)}" placeholder="Ex: Luitex, Ferrox..." list="gruposSugestao">
            <datalist id="gruposSugestao">${[...new Set(ADMIN_REVENDAS.filter(r=>r.grupo).map(r=>r.grupo))].map(g=>`<option value="${esc(g)}">`).join("")}</datalist>
        </div>
        <div class="form-row">
            <label>Email Responsavel</label>
            <input type="email" id="modalEmail" value="${esc(email)}" placeholder="usuario@empresa.com.br" list="emailsSugestao">
            <datalist id="emailsSugestao">${ADMIN_USERS.filter(u=>u.role==="revenda").map(u=>`<option value="${esc(u.username)}">`).join("")}</datalist>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="salvarGrupo()">Salvar</button>
        </div>`;
    modal.classList.add("show");
}

async function salvarGrupo() {
    const revenda_rd = $("modalRevenda").value;
    const grupo = $("modalGrupo").value.trim();
    const email_responsavel = $("modalEmail").value.trim();

    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/grupos`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ revenda_rd, grupo, email_responsavel })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }

        const idx = ADMIN_REVENDAS.findIndex(r => r.nome === revenda_rd);
        if (idx >= 0) {
            ADMIN_REVENDAS[idx].grupo = grupo || null;
            ADMIN_REVENDAS[idx].email_responsavel = email_responsavel || null;
        }

        closeAdminModal();
        renderAdminRevendas();
        await loadAdminUsers();
        renderAdminUsers();
        toast("Grupo salvo com sucesso!");
    } catch (e) {
        toast(e.message || "Erro ao salvar", "error");
    }
}

function renderAdminUsers() {
    const wrap = $("adminUsersBody");
    if (!wrap) return;

    const filterVal = ($("adminUserFilter")?.value || "").toLowerCase();
    const roleFilter = $("adminRoleFilter")?.value || "all";

    let filtered = ADMIN_USERS;
    if (filterVal) filtered = filtered.filter(u => u.username.toLowerCase().includes(filterVal) || (u.revenda || "").toLowerCase().includes(filterVal) || (u.email || "").toLowerCase().includes(filterVal));
    if (roleFilter !== "all") filtered = filtered.filter(u => u.role === roleFilter);

    const counts = { adm: 0, representante: 0, revenda: 0 };
    ADMIN_USERS.forEach(u => counts[u.role]++);

    let html = `<div class="admin-stats">
        <span><strong>${ADMIN_USERS.length}</strong> usuarios</span>
        <span><strong>${counts.adm}</strong> admins</span>
        <span><strong>${counts.representante}</strong> representantes</span>
        <span><strong>${counts.revenda}</strong> revendas</span>
    </div>`;

    html += `<table class="extrato-table">
        <thead><tr>
            <th>ID</th>
            <th>Login</th>
            <th>Tipo</th>
            <th>Detalhes</th>
            <th>Grupo</th>
            <th>Acoes</th>
        </tr></thead><tbody>`;

    for (const u of filtered) {
        let detalhes = "";
        if (u.role === "revenda") detalhes = `${esc(u.revenda || "?")} — ${esc(u.cidade || "")}/${esc(u.estado || "")} — CNPJ: ${esc(u.cnpj || "")}`;
        else if (u.role === "representante") {
            const partes = [esc(u.email || "sem e-mail")];
            if (u.telefone) partes.push(esc(u.telefone));
            partes.push(u.id ? "Portal: ✓" : "Portal: —");
            partes.push(u.temLoginMotor ? "Motor: ✓" : "Motor: —");
            if (u.ativo === false) partes.push('<span style="color:#d9534f">inativo</span>');
            detalhes = partes.join(" · ");
        }
        else detalhes = "—";

        const roleBadge = { adm: "status-aprovado", representante: "status-pendente", revenda: "status-utilizado" }[u.role] || "";

        let acoes = "";
        if (u.role === "representante") {
            acoes = `<button class="btn btn-sm" onclick="editarRepresentanteDeUsuarios('${esc(u.username)}')">Editar</button>`;
            if (u.id) acoes += ` <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${esc(u.username)}')">Excluir login</button>`;
            else acoes += ` <button class="btn btn-sm btn-danger" onclick="excluirRepresentanteCanonico('${esc(u.username)}')">Excluir</button>`;
        } else if (u.role === "revenda") {
            acoes = `<button class="btn btn-sm" onclick="openFiliaisModal(${u.id},'${esc(u.revenda || u.username)}')">Filiais</button>
                <button class="btn btn-sm" onclick="openResetSenhaModal(${u.id},'${esc(u.username)}')">Senha</button>
                <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${esc(u.username)}')">Excluir</button>`;
        } else {
            acoes = `<button class="btn btn-sm" onclick="openResetSenhaModal(${u.id},'${esc(u.username)}')">Senha</button>
                <button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id},'${esc(u.username)}')">Excluir</button>`;
        }

        html += `<tr>
            <td>${u.id ?? "—"}</td>
            <td><strong>${esc(u.username)}</strong></td>
            <td><span class="status-badge ${roleBadge}">${u.role}</span></td>
            <td style="font-size:12px">${detalhes}</td>
            <td>${u.grupo ? `<span class="tipo-badge credito">${esc(u.grupo)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
            <td style="white-space:nowrap">${acoes}</td>
        </tr>`;
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;
}

async function excluirRepresentanteCanonico(nome) {
    if (!confirm(`Excluir o representante "${nome}"? Ele não tem login — a exclusão é definitiva.`)) return;
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/representantes-bmax/${encodeURIComponent(nome)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        ADMIN_REPS_BMAX = ADMIN_REPS_BMAX.filter(r => r.nome !== nome);
        await loadAdminUsers();
        renderAdminUsers();
        toast("Representante excluído");
    } catch (e) { toast(e.message || "Erro ao excluir representante", "error"); }
}

// Abre o modal de representante (mesmo modal da antiga aba "Representantes") a
// partir da aba Usuários, que agora é a fonte única de gestão de representantes.
function editarRepresentanteDeUsuarios(nome) {
    const idx = ADMIN_REPS_BMAX.findIndex(r => r.nome === nome);
    openRepBmaxModal(idx >= 0 ? idx : undefined);
    if (idx < 0) {
        setTimeout(() => { const el = $("modalRepNome"); if (el) el.value = nome; }, 0);
    }
}

function openResetSenhaModal(id, username) {
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>Resetar Senha</h3>
        <p style="margin-bottom:12px;color:var(--muted)">Usuario: <strong>${esc(username)}</strong></p>
        <div class="form-row">
            <label>Nova Senha</label>
            <input type="text" id="modalNovaSenha" placeholder="Minimo 6 caracteres">
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="resetSenha(${id})">Salvar</button>
        </div>`;
    modal.classList.add("show");
}

async function resetSenha(id) {
    const password = $("modalNovaSenha").value;
    if (!password || password.length < 6) { toast("Senha deve ter no minimo 6 caracteres", "error"); return; }

    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/users/${id}/reset-password`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ password })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        closeAdminModal();
        toast("Senha atualizada!");
    } catch (e) {
        toast(e.message || "Erro ao resetar senha", "error");
    }
}

async function deleteUser(id, username) {
    if (!confirm(`Excluir usuario "${username}"? Esta acao nao pode ser desfeita.`)) return;

    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/users/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }

        ADMIN_USERS = ADMIN_USERS.filter(u => u.id !== id);
        renderAdminUsers();
        toast("Usuario excluido!");
    } catch (e) {
        toast(e.message || "Erro ao excluir", "error");
    }
}

function openCriarUsuarioModal() {
    const modal = $("adminModal");
    const content = $("adminModalContent");

    const repsOptions = ADMIN_USERS.filter(u => u.role === "representante").map(u => `<option value="${esc(u.username)}">${esc(u.username)}</option>`).join("");

    content.innerHTML = `
        <h3>Novo Usuario</h3>
        <div class="form-row">
            <label>Tipo</label>
            <select id="modalNovoTipo" onchange="toggleModalCampos()">
                <option value="representante">Representante</option>
                <option value="revenda">Revenda</option>
                <option value="funcionario">Funcionário Boxer</option>
                <option value="adm">ADM</option>
            </select>
        </div>
        <div class="form-row">
            <label>Nome / Username</label>
            <input type="text" id="modalNovoNome" placeholder="Nome">
        </div>
        <div class="form-row">
            <label>Email</label>
            <input type="email" id="modalNovoEmail" placeholder="usuario@empresa.com.br">
        </div>
        <div class="form-row">
            <label>Telefone</label>
            <input type="tel" id="modalNovoTelefone" placeholder="(11) 99999-9999" maxlength="20">
        </div>
        <p style="font-size:12px;color:#666;margin:8px 0">Uma senha segura será gerada automaticamente e enviada por email com as credenciais de acesso.</p>

        <div id="modalCamposRevenda" style="display:none">
            <div class="form-row">
                <label>Representante</label>
                <select id="modalNovoRepresentante">
                    <option value="">Selecione um representante</option>
                    ${repsOptions}
                </select>
            </div>
            <div class="form-row">
                <label>CNPJ</label>
                <input type="text" id="modalNovoCnpj" placeholder="00000000000000">
            </div>
            <div class="form-row" style="display:grid;grid-template-columns:2fr 1fr;gap:8px">
                <div><label>Cidade</label><input type="text" id="modalNovoCidade" placeholder="Cidade"></div>
                <div><label>Estado</label><input type="text" id="modalNovoEstado" placeholder="SP" maxlength="2"></div>
            </div>
            <div class="form-row">
                <label>CEP</label>
                <input type="text" id="modalNovoCep" placeholder="00000000">
            </div>

            <div style="border-top:1px solid var(--border);margin:16px 0;padding-top:16px">
                <h4 style="margin:0 0 12px 0">Filiais Adicionais</h4>
                <p style="font-size:12px;color:#666;margin:0 0 12px 0">A primeira filial é a sede. Você pode adicionar outras filiais após criar a revenda.</p>
                <button type="button" class="btn btn-sm" onclick="addFilialField()" style="width:100%">+ Adicionar Filial</button>
                <div id="modalFiliaisContainer" style="margin-top:12px"></div>
            </div>
        </div>

        <div id="modalCamposAdmin" style="display:none">
            <div class="form-row">
                <label>Classe de Preço (Admin só pode definir)</label>
                <select id="modalNovoClasse">
                    <option value="">Nenhuma</option>
                    <option value="standard">Standard</option>
                    <option value="premium">Premium</option>
                </select>
            </div>
        </div>

        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="criarUsuario()">Criar</button>
        </div>`;
    modal.classList.add("show");

    // Add masks after rendering
    const telInput = $("modalNovoTelefone");
    const cnpjInput = $("modalNovoCnpj");
    const cepInput = $("modalNovoCep");

    if (telInput) telInput.addEventListener("input", e => e.target.value = maskTelefone(e.target.value));
    if (cnpjInput) cnpjInput.addEventListener("input", e => e.target.value = maskCNPJ(e.target.value));
    if (cepInput) cepInput.addEventListener("input", e => e.target.value = maskCEP(e.target.value));
}

function toggleModalCampos() {
    const tipo = $("modalNovoTipo").value;
    const revFields = $("modalCamposRevenda");
    const adminFields = $("modalCamposAdmin");
    if (revFields) revFields.style.display = tipo === "revenda" ? "block" : "none";
    if (adminFields) adminFields.style.display = tipo === "adm" ? "block" : "none";
}

async function criarUsuario() {
    const role = $("modalNovoTipo").value;
    const name = $("modalNovoNome").value.trim();
    const email = $("modalNovoEmail")?.value?.trim() || "";
    const telefone = unmaskNumber($("modalNovoTelefone")?.value || "");

    if (!name) { toast("Nome é obrigatório", "error"); return; }
    if (!email) { toast("Email é obrigatório", "error"); return; }
    if (!telefone) { toast("Telefone é obrigatório", "error"); return; }

    const payload = { role, name, email, telefone };

    if (role === "revenda") {
        payload.representante = $("modalNovoRepresentante")?.value || "";
        payload.cnpj = unmaskNumber($("modalNovoCnpj")?.value || "");
        payload.cep = unmaskNumber($("modalNovoCep")?.value || "");
        payload.cidade = $("modalNovoCidade")?.value?.trim() || "";
        payload.estado = ($("modalNovoEstado")?.value?.trim() || "").toUpperCase();
        payload.filiais = getFiliais();
        if (!payload.cnpj || payload.cnpj.length !== 14) {
            toast("CNPJ deve ter 14 dígitos", "error"); return;
        }
        if (!payload.cep || payload.cep.length !== 8) {
            toast("CEP deve ter 8 dígitos", "error"); return;
        }
        if (!payload.cidade || !payload.estado) {
            toast("Preencha cidade e estado", "error"); return;
        }
    }

    if (role === "adm") {
        payload.classe = $("modalNovoClasse")?.value || "";
    }


    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/users`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(payload)
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const created = await res.json();

        const grupo = $("modalNovoGrupo")?.value;
        if (role === "revenda" && grupo) {
            await fetch(`${API_URL}/admin/users/${created.id}/grupo`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                body: JSON.stringify({ grupo })
            });
        }

        closeAdminModal();
        await loadAdminUsers();
        renderAdminUsers();
        toast("Usuario criado!");
    } catch (e) {
        toast(e.message || "Erro ao criar usuario", "error");
    }
}

function addFilialField() {
    const container = $("modalFiliaisContainer");
    if (!container) return;

    const filialId = `filial-${Date.now()}`;
    const html = `
        <div class="filial-card" id="${filialId}" style="background:#f5f5f5;padding:12px;border-radius:6px;margin-bottom:12px;border:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <label style="font-weight:600;font-size:13px">Filial</label>
                <button type="button" class="btn btn-sm" onclick="removeFilialField('${filialId}')" style="background:#f0f0f0;color:#666">Remover</button>
            </div>
            <div class="form-row">
                <label>Nome da Filial</label>
                <input type="text" class="filial-nome" placeholder="Nome da filial">
            </div>
            <div class="form-row">
                <label>Telefone</label>
                <input type="tel" class="filial-telefone" placeholder="(11) 99999-9999" maxlength="20">
            </div>
            <div class="form-row">
                <label>Email</label>
                <input type="email" class="filial-email" placeholder="email@filial.com">
            </div>
            <div class="form-row" style="display:grid;grid-template-columns:2fr 1fr;gap:8px">
                <div><label>Cidade</label><input type="text" class="filial-cidade" placeholder="Cidade"></div>
                <div><label>Estado</label><input type="text" class="filial-estado" placeholder="SP" maxlength="2"></div>
            </div>
            <div class="form-row">
                <label>CEP</label>
                <input type="text" class="filial-cep" placeholder="00000000">
            </div>
            <div class="form-row">
                <label>Endereço</label>
                <input type="text" class="filial-endereco" placeholder="Rua/Av">
            </div>
            <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <div><label>Número</label><input type="text" class="filial-numero" placeholder="Nº"></div>
                <div><label>Complemento</label><input type="text" class="filial-complemento" placeholder="Apto/Sala"></div>
            </div>
        </div>`;

    container.insertAdjacentHTML("beforeend", html);

    // Apply masks
    const card = $(filialId);
    const telInput = card.querySelector(".filial-telefone");
    const cepInput = card.querySelector(".filial-cep");

    if (telInput) telInput.addEventListener("input", e => e.target.value = maskTelefone(e.target.value));
    if (cepInput) cepInput.addEventListener("input", e => e.target.value = maskCEP(e.target.value));
}

function removeFilialField(filialId) {
    const card = $(filialId);
    if (card) card.remove();
}

function getFiliais() {
    const container = $("modalFiliaisContainer");
    if (!container) return [];

    const filials = [];
    const cards = container.querySelectorAll(".filial-card");
    for (const card of cards) {
        const nome = card.querySelector(".filial-nome").value.trim();
        const telefone = card.querySelector(".filial-telefone").value.trim();
        const email = card.querySelector(".filial-email").value.trim();
        const cep = unmaskNumber(card.querySelector(".filial-cep").value);
        const cidade = card.querySelector(".filial-cidade").value.trim();
        const estado = card.querySelector(".filial-estado").value.trim().toUpperCase();
        const endereco = card.querySelector(".filial-endereco").value.trim();
        const numero = card.querySelector(".filial-numero").value.trim();
        const complemento = card.querySelector(".filial-complemento").value.trim();

        if (nome && cep && cidade && estado) {
            filials.push({ nome, telefone, email, cep, cidade, estado, endereco, numero, complemento });
        }
    }
    return filials;
}

async function openFiliaisModal(userId, revendaNome) {
    const modal = $("adminModal");
    const content = $("adminModalContent");

    content.innerHTML = `
        <h3>Filiais: ${esc(revendaNome)}</h3>
        <div id="filiaisContent" style="margin:16px 0">Carregando...</div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Fechar</button>
            <button class="btn primary" onclick="addNewFilialForm()">+ Nova Filial</button>
        </div>`;
    modal.classList.add("show");

    // Load filiais
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/users/${userId}/filiais`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Erro ao carregar filiais");
        const filiais = await res.json();

        let html = "";
        if (filiais.length === 0) {
            html = '<div class="empty-state">Nenhuma filial adicional registrada. Esta revenda possui apenas a sede.</div>';
        } else {
            html = '<div style="display:flex;flex-direction:column;gap:12px">';
            for (const filial of filiais) {
                html += `
                    <div class="filial-card" style="background:#f5f5f5;padding:12px;border-radius:6px;border:1px solid var(--border)">
                        <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
                            <h4 style="margin:0">${esc(filial.nome)}${filial.principal ? ' <span style="font-size:11px;background:#4CAF50;color:white;padding:2px 6px;border-radius:3px;margin-left:6px">PRINCIPAL</span>' : ''}</h4>
                            ${filial.principal ? '' : `<button class="btn btn-sm btn-danger" onclick="deleteFilialRequest(${userId},${filial.id})">Deletar</button>`}
                        </div>
                        <p style="margin:4px 0;font-size:13px">
                            ${filial.endereco ? esc(filial.endereco) + (filial.numero ? ', ' + esc(filial.numero) : '') : '—'}
                            ${filial.complemento ? ' ' + esc(filial.complemento) : ''}
                        </p>
                        <p style="margin:4px 0;font-size:13px;color:#666">
                            ${esc(filial.cidade)}, ${esc(filial.estado)} — CEP: ${maskCEP(filial.cep)}
                        </p>
                        ${filial.telefone ? `<p style="margin:4px 0;font-size:13px">📞 ${esc(filial.telefone)}</p>` : ''}
                        ${filial.email ? `<p style="margin:4px 0;font-size:13px">✉️ ${esc(filial.email)}</p>` : ''}
                    </div>`;
            }
            html += '</div>';
        }

        $("filiaisContent").innerHTML = html;
    } catch (e) {
        console.error(e);
        $("filiaisContent").innerHTML = `<div style="color:#d9534f">Erro ao carregar filiais: ${esc(e.message)}</div>`;
    }
}

async function deleteFilialRequest(userId, filialId) {
    if (!confirm("Deseja deletar esta filial?")) return;
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/users/${userId}/filiais/${filialId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) throw new Error("Erro ao deletar");
        toast("Filial deletada");
        await openFiliaisModal(userId, "Filiais");
    } catch (e) {
        toast(e.message || "Erro ao deletar filial", "error");
    }
}

function addNewFilialForm() {
    toast("Nova filial será adicionada quando você criar uma revenda ou via API", "info");
}

function closeAdminModal() {
    $("adminModal").classList.remove("show");
}

function showAdminTab(tab, el) {
    document.querySelectorAll(".admin-tab-content").forEach(p => p.classList.add("hidden"));
    document.querySelectorAll(".admin-tab").forEach(t => t.classList.remove("active"));
    document.getElementById("admin-" + tab).classList.remove("hidden");
    el.classList.add("active");
    if (tab === "logs") initAuditLogs();
    if (tab === "cobertura" && !COB_DATA.length) { loadCobertura().then(() => renderCobertura()); }
    if (tab === "vendedores" && !ADMIN_VENDEDORES.length) { loadVendedoresBmax().then(() => renderVendedoresBmax()); }
    if (tab === "repbmax" && !ADMIN_REP_BMAX_LIST.length) { loadRepBmaxList().then(() => renderRepBmaxList()); }
    if (tab === "comissao" && !ADMIN_COMISSAO_LOADED) { loadComissaoConfig().then(() => renderComissaoConfig()); }
}

// ─── Revendas BMax (Supabase) ────────────────────────────────

async function loadRevendasBmax() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/revendas-bmax`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar revendas BMax");
        ADMIN_REV_BMAX = await res.json();
    } catch (e) { console.error(e); toast("Erro ao carregar revendas BMax", "error"); }
}

function renderRevendasBmax() {
    const wrap = $("adminRevBmaxBody");
    if (!wrap) return;
    const filter = ($("adminRevBmaxFilter")?.value || "").toLowerCase();
    const statusFilter = $("adminRevBmaxStatusFilter")?.value || "ativas";
    let list = ADMIN_REV_BMAX;
    if (statusFilter === "ativas") list = list.filter(r => r.ativo);
    else if (statusFilter === "inativas") list = list.filter(r => !r.ativo);
    if (filter) list = list.filter(r => (r.nome || "").toLowerCase().includes(filter) || (r.cidade || "").toLowerCase().includes(filter));
    const grupoFilter = $("adminRevBmaxGrupoFilter")?.value || "all";
    if (grupoFilter === "sem-grupo") list = list.filter(r => !r.grupo);
    else if (grupoFilter === "com-grupo") list = list.filter(r => !!r.grupo);
    else if (grupoFilter !== "all") list = list.filter(r => r.grupo === grupoFilter);

    const gruposDistintos = [...new Set(ADMIN_REV_BMAX.filter(r => r.grupo).map(r => r.grupo))].sort();
    const grupoSelect = $("adminRevBmaxGrupoFilter");
    if (grupoSelect && grupoSelect.options.length <= 3) {
        gruposDistintos.forEach(g => {
            const opt = document.createElement("option");
            opt.value = g; opt.textContent = g;
            grupoSelect.appendChild(opt);
        });
    }

    const ativas = ADMIN_REV_BMAX.filter(r => r.ativo).length;
    const comGrupo = ADMIN_REV_BMAX.filter(r => r.grupo).length;
    let html = `<div class="admin-stats">
        <span><strong>${ativas}</strong> ativas</span>
        <span><strong>${comGrupo}</strong> com grupo</span>
        <span><strong>${gruposDistintos.length}</strong> grupos</span>
        <span><strong>${ADMIN_REV_BMAX.length}</strong> total</span>
    </div>`;

    html += `<table class="extrato-table"><thead><tr>
        <th>Nome</th><th>Cidade</th><th>Estado</th><th>Classe</th><th>Grupo</th><th>Rep BMax</th><th>Status</th><th>Acoes</th>
    </tr></thead><tbody>`;
    for (const r of list) {
        const badge = r.ativo ? '<span class="status-badge status-aprovado">Ativa</span>' : '<span class="status-badge status-rejeitado">Inativa</span>';
        html += `<tr>
            <td><strong>${esc(r.nome || "")}</strong></td>
            <td>${esc(r.cidade || "—")}</td>
            <td>${esc(r.estado || "—")}</td>
            <td>${esc(r.classe || "—")}</td>
            <td>${r.grupo ? `<span class="tipo-badge credito">${esc(r.grupo)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
            <td>${esc(r.rep || "—")}</td>
            <td>${badge}</td>
            <td style="white-space:nowrap">
                <button class="btn btn-sm" onclick='openRevBmaxModal(${JSON.stringify(r)})'>Editar</button>
                <button class="btn btn-sm ${r.ativo ? "btn-danger" : "primary"}" onclick="toggleRevBmax('${r.id}',${!r.ativo})">${r.ativo ? "Desativar" : "Ativar"}</button>
            </td>
        </tr>`;
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;
}

function openRevBmaxModal(rev) {
    const isEdit = !!rev;
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>${isEdit ? "Editar" : "Nova"} Revenda BMax</h3>
        <div class="form-row"><label>Nome</label><input type="text" id="modalRevNome" value="${esc(rev?.nome || "")}"></div>
        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><label>Email</label><input type="email" id="modalRevEmail" value="${esc(rev?.email || "")}" placeholder="email@empresa.com"></div>
            <div><label>Telefone</label><input type="text" id="modalRevTelefone" value="${esc(rev?.telefone || "")}" placeholder="(00) 00000-0000"></div>
        </div>
        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><label>CNPJ</label><input type="text" id="modalRevCnpj" value="${esc(rev?.cnpj || "")}" placeholder="00.000.000/0000-00"></div>
            <div><label>CEP</label><input type="text" id="modalRevCep" value="${esc(rev?.cep || "")}" placeholder="00000-000"></div>
        </div>
        <div class="form-row" style="display:grid;grid-template-columns:2fr 1fr;gap:8px">
            <div><label>Cidade</label><input type="text" id="modalRevCidade" value="${esc(rev?.cidade || "")}"></div>
            <div><label>Estado</label><input type="text" id="modalRevEstado" value="${esc(rev?.estado || "")}" maxlength="2"></div>
        </div>
        <div class="form-row"><label>Classe</label>
            <select id="modalRevClasse">
                <option value="">—</option>
                ${["Diamante","Ouro","Prata"].map(c => `<option value="${c}" ${rev?.classe === c ? "selected" : ""}>${c}</option>`).join("")}
            </select>
        </div>
        <div class="form-row"><label>Grupo</label>
            <input type="text" id="modalRevGrupo" value="${esc(rev?.grupo || "")}" placeholder="Ex: Luitex, Ferrox..." list="gruposSugestaoRev">
            <datalist id="gruposSugestaoRev">${[...new Set(ADMIN_REV_BMAX.filter(r=>r.grupo).map(r=>r.grupo))].sort().map(g=>`<option value="${esc(g)}">`).join("")}</datalist>
        </div>
        <div class="form-row"><label>Rep BMax</label>
            <select id="modalRevRep">
                <option value="">—</option>
                ${ADMIN_REPS_BMAX.filter(r => r.ativo).map(r => {
                    const selected = rev?.rep && rev.rep.trim().toLowerCase() === r.nome.trim().toLowerCase();
                    return `<option value="${esc(r.nome)}" ${selected ? "selected" : ""}>${esc(r.nome)}</option>`;
                }).join("")}
            </select>
            ${rev?.rep && !ADMIN_REPS_BMAX.some(r => r.nome.trim().toLowerCase() === rev.rep.trim().toLowerCase())
                ? `<p style="color:#d9534f;font-size:12px">Valor atual "${esc(rev.rep)}" não corresponde a nenhum representante cadastrado — selecione o correto.</p>`
                : ""}
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="salvarRevBmax('${rev?.id || ""}')">${isEdit ? "Salvar" : "Criar"}</button>
        </div>`;
    modal.classList.add("show");
}

async function salvarRevBmax(id) {
    const nome = $("modalRevNome").value.trim();
    if (!nome) { toast("Nome é obrigatório", "error"); return; }
    const body = {
        nome,
        email: $("modalRevEmail").value.trim() || null,
        telefone: $("modalRevTelefone").value.trim() || null,
        cnpj: $("modalRevCnpj").value.trim() || null,
        cep: $("modalRevCep").value.trim() || null,
        cidade: $("modalRevCidade").value.trim() || null,
        estado: ($("modalRevEstado").value.trim() || "").toUpperCase() || null,
        classe: $("modalRevClasse").value || null,
        grupo: $("modalRevGrupo").value.trim() || null,
        rep: $("modalRevRep").value.trim() || null
    };
    try {
        const token = localStorage.getItem("token");
        const method = id ? "PATCH" : "POST";
        const url = id ? `${API_URL}/admin/revendas-bmax/${id}` : `${API_URL}/admin/revendas-bmax`;
        const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const data = await res.json();
        closeAdminModal();
        await loadRevendasBmax();
        renderRevendasBmax();
        const syncMsg = data.sync?.synced ? ` (${data.sync.synced} opções sincronizadas no RD)` : "";
        toast((id ? "Revenda atualizada" : "Revenda criada") + syncMsg);
    } catch (e) { toast(e.message || "Erro ao salvar", "error"); }
}

async function toggleRevBmax(id, ativo) {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/revendas-bmax/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ativo })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const data = await res.json();
        await loadRevendasBmax();
        renderRevendasBmax();
        const syncMsg = data.sync?.synced ? ` (RD atualizado: ${data.sync.synced} opções)` : "";
        toast((ativo ? "Revenda ativada" : "Revenda desativada") + syncMsg);
    } catch (e) { toast(e.message || "Erro", "error"); }
}

async function syncRevendasRD() {
    const btn = $("btnSyncRD");
    if (btn) { btn.disabled = true; btn.textContent = "Sincronizando..."; }
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/sync-revendas-rd`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const data = await res.json();
        toast(`RD sincronizado: ${data.synced} opções de revenda`);
    } catch (e) { toast(e.message || "Erro ao sincronizar", "error"); }
    finally { if (btn) { btn.disabled = false; btn.textContent = "Sincronizar RD"; } }
}

// ─── Representantes BMax ─────────────────────────────────────

async function loadRepsBmax() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/representantes-bmax`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar representantes");
        ADMIN_REPS_BMAX = await res.json();
    } catch (e) { console.error(e); toast("Erro ao carregar representantes", "error"); }
}

function openRepBmaxModal(idx) {
    const isEdit = idx !== undefined && idx !== null;
    const rep = isEdit ? ADMIN_REPS_BMAX[idx] : null;
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>${isEdit ? "Editar" : "Novo"} Representante BMax</h3>
        <div class="form-row"><label>Nome</label><input type="text" id="modalRepNome" value="${esc(rep?.nome || "")}"></div>
        <div class="form-row"><label>Email</label><input type="email" id="modalRepEmail" value="${esc(rep?.email || "")}" placeholder="nome@email.com"></div>
        <div class="form-row"><label>Telefone</label><input type="tel" id="modalRepTelefone" value="${esc(rep?.telefone || "")}" placeholder="(11) 99999-9999" maxlength="20"></div>
        <div class="form-row"><label>${isEdit ? "Nova senha de acesso ao Portal (deixe vazio para manter)" : "Senha de acesso ao Portal (deixe vazio para não criar login agora)"}</label><input type="password" id="modalRepSenha" value="" placeholder="Mínimo 6 caracteres"></div>
        <div class="form-row"><label><input type="checkbox" id="modalRepConvidarMotor" ${isEdit ? (rep?.tem_login_motor ? 'checked' : '') : 'checked'}> Convidar por e-mail para acessar o Motor PCI</label></div>
        <div class="form-row"><label><input type="checkbox" id="modalRepAtivo" ${(!isEdit || rep?.ativo !== false) ? "checked" : ""}> Ativo</label></div>
        ${rep?.tem_login ? '<p style="opacity:.7;font-size:12px">Já tem login no Portal.</p>' : ''}
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="salvarRepBmax(${isEdit ? idx : -1})">${isEdit ? "Salvar" : "Criar"}</button>
        </div>`;
    modal.classList.add("show");
}

async function salvarRepBmax(idx) {
    const nome = $("modalRepNome").value.trim();
    const email = $("modalRepEmail").value.trim();
    const telefone = $("modalRepTelefone").value.trim();
    const senha = $("modalRepSenha").value;
    const convidarMotor = $("modalRepConvidarMotor").checked;
    const ativo = $("modalRepAtivo").checked;
    if (!nome) { toast("Nome é obrigatório", "error"); return; }
    if (senha && senha.length < 6) { toast("Senha deve ter no mínimo 6 caracteres", "error"); return; }
    if (convidarMotor && !email) { toast("Informe o email para convidar ao Motor", "error"); return; }
    let nomeAntigo = null;
    if (idx >= 0) {
        nomeAntigo = ADMIN_REPS_BMAX[idx].nome;
        Object.assign(ADMIN_REPS_BMAX[idx], { nome, email, telefone, ativo });
    } else {
        if (ADMIN_REPS_BMAX.find(r => r.nome.toLowerCase() === nome.toLowerCase())) {
            toast("Já existe um representante com este nome", "error"); return;
        }
        ADMIN_REPS_BMAX.push({ nome, email, telefone, ativo });
    }
    await saveRepsBmax({ alvoNome: nome, alvoNomeAntigo: nomeAntigo !== nome ? nomeAntigo : undefined, senha: senha || undefined, convidarMotor });
    closeAdminModal();
    await loadAdminUsers();
    renderAdminUsers();
    toast(idx >= 0 ? "Representante atualizado" : "Representante criado");
}

async function saveRepsBmax(opts) {
    opts = opts || {};
    try {
        const token = localStorage.getItem("token");
        const body = { representantes: ADMIN_REPS_BMAX, alvoNome: opts.alvoNome, alvoNomeAntigo: opts.alvoNomeAntigo, senha: opts.senha, convidarMotor: !!opts.convidarMotor };
        const res = await fetch(`${API_URL}/admin/representantes-bmax`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        const data = await res.json();
        const syncMsg = data.sync?.error ? ` (RD falhou: ${data.sync.error})` : data.sync ? ` | RD sincronizado (${data.sync.synced} opções)` : '';
        const acessoMsg = data.acesso?.motor ? ` | Motor: ${data.acesso.motor}` : '';
        const renomeMsg = data.renomeRD?.error ? ` | Falha ao renomear no RD: ${data.renomeRD.error}`
            : data.renomeRD ? ` | ${data.renomeRD.updated}/${data.renomeRD.total} negociações renomeadas no RD` : '';
        toast('Representantes salvos' + syncMsg + acessoMsg + renomeMsg);
    } catch (e) { toast(e.message || "Erro ao salvar representantes", "error"); }
}

async function syncRepsRD(btn) {
    btn.disabled = true; btn.textContent = "⏳ Sincronizando...";
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/sync-reps-rd`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        toast(`RD sincronizado: ${data.synced} representantes`);
    } catch (e) { toast(e.message || "Erro ao sincronizar RD", "error"); }
    btn.disabled = false; btn.textContent = "🔄 Sincronizar RD";
}

// ─── Cobertura Geográfica ────────────────────────────────────

let COB_DATA = [];
let COB_RESUMO = [];

async function loadCobertura() {
    try {
        const token = localStorage.getItem("token");
        const [cobRes, resRes] = await Promise.all([
            fetch(`${API_URL}/admin/cobertura`, { headers: { Authorization: `Bearer ${token}` } }),
            fetch(`${API_URL}/admin/cobertura/resumo`, { headers: { Authorization: `Bearer ${token}` } })
        ]);
        if (cobRes.ok) COB_DATA = await cobRes.json();
        if (resRes.ok) COB_RESUMO = await resRes.json();
    } catch (e) { console.error(e); toast("Erro ao carregar cobertura", "error"); }
}

function renderCobertura() {
    const wrap = $("cobTabelaBody");
    const resumoWrap = $("cobResumoBody");
    if (!wrap) return;

    const filter = ($("cobFilter")?.value || "").toLowerCase();
    const ufFilter = $("cobEstadoFilter")?.value || "all";
    const repFilter = $("cobRepFilter")?.value || "all";

    // populate UF filter
    const ufSelect = $("cobEstadoFilter");
    if (ufSelect && ufSelect.options.length <= 1) {
        const ufs = [...new Set(COB_DATA.map(r => r.estado))].sort();
        ufs.forEach(uf => {
            const opt = document.createElement("option");
            opt.value = uf; opt.textContent = uf;
            ufSelect.appendChild(opt);
        });
    }
    // populate rep filter
    const repSelect = $("cobRepFilter");
    if (repSelect && repSelect.options.length <= 2) {
        const reps = [...new Set(COB_DATA.filter(r => r.rep_bmax).map(r => r.rep_bmax))].sort();
        reps.forEach(r => {
            const opt = document.createElement("option");
            opt.value = r; opt.textContent = r;
            repSelect.appendChild(opt);
        });
    }

    let list = COB_DATA;
    if (ufFilter !== "all") list = list.filter(r => r.estado === ufFilter);
    if (repFilter === "sem-rep") list = list.filter(r => !r.rep_bmax);
    else if (repFilter !== "all") list = list.filter(r => r.rep_bmax === repFilter);
    if (filter) list = list.filter(r => (r.cidade || "").toLowerCase().includes(filter) || (r.ibge_codigo || "").includes(filter));

    // Resumo
    if (resumoWrap) {
        let rhtml = '<div class="admin-stats">';
        rhtml += `<span><strong>${COB_DATA.length}</strong> cidades</span>`;
        rhtml += `<span><strong>${COB_DATA.filter(r => r.rep_bmax).length}</strong> com rep</span>`;
        rhtml += `<span><strong>${COB_DATA.filter(r => !r.rep_bmax).length}</strong> sem rep</span>`;
        rhtml += '</div>';
        rhtml += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">';
        for (const r of COB_RESUMO) {
            rhtml += `<span class="tipo-badge ${r.rep === '(Sem rep)' ? '' : 'credito'}" style="font-size:12px">${esc(r.rep)}: ${r.total}</span>`;
        }
        rhtml += '</div>';
        resumoWrap.innerHTML = rhtml;
    }

    // Rep options for inline select
    const repOpts = [...new Set(ADMIN_REPS_BMAX.filter(r => r.ativo).map(r => r.nome))].sort();

    const MAX = 200;
    const showing = list.slice(0, MAX);
    let html = `<table class="extrato-table"><thead><tr>
        <th>IBGE</th><th>Cidade</th><th>UF</th><th>DDD</th><th>Mesorregiao</th><th>Representante</th>
    </tr></thead><tbody>`;
    for (const r of showing) {
        html += `<tr>
            <td style="font-size:11px">${esc(r.ibge_codigo || "")}</td>
            <td><strong>${esc(r.cidade || "")}</strong></td>
            <td>${esc(r.estado || "")}</td>
            <td>${r.ddd || "—"}</td>
            <td style="font-size:11px">${esc(r.mesorregiao || "—")}</td>
            <td><select onchange="updateCobRep('${esc(r.ibge_codigo)}',this.value)" style="font-size:12px;padding:4px 6px;min-width:140px">
                <option value="">— Sem rep —</option>
                ${repOpts.map(n => `<option value="${esc(n)}" ${r.rep_bmax === n ? "selected" : ""}>${esc(n)}</option>`).join("")}
            </select></td>
        </tr>`;
    }
    html += "</tbody></table>";
    if (list.length > MAX) html += `<p style="color:var(--muted);font-size:12px;margin-top:8px">Mostrando ${MAX} de ${list.length}. Use os filtros para refinar.</p>`;
    wrap.innerHTML = html;
}

async function updateCobRep(ibge, rep) {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/cobertura/${ibge}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ rep_bmax: rep || null })
        });
        if (!res.ok) throw new Error("Erro ao atualizar");
        const item = COB_DATA.find(r => r.ibge_codigo === ibge);
        if (item) item.rep_bmax = rep || null;
        toast("Rep atualizado");
    } catch (e) { toast(e.message, "error"); }
}

function openCoberturaModal() {
    const repOpts = [...new Set(ADMIN_REPS_BMAX.filter(r => r.ativo).map(r => r.nome))].sort();
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>Nova Cidade</h3>
        <div class="form-row"><label>Codigo IBGE</label><input type="text" id="modalCobIbge" placeholder="3550308"></div>
        <div class="form-row"><label>Cidade</label><input type="text" id="modalCobCidade" placeholder="Sao Paulo"></div>
        <div class="form-row" style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><label>UF</label><input type="text" id="modalCobUF" maxlength="2" placeholder="SP"></div>
            <div><label>DDD</label><input type="number" id="modalCobDDD" placeholder="11"></div>
        </div>
        <div class="form-row"><label>Mesorregiao</label><input type="text" id="modalCobMeso" placeholder="Metropolitana de Sao Paulo"></div>
        <div class="form-row"><label>Representante</label>
            <select id="modalCobRep">
                <option value="">— Sem rep —</option>
                ${repOpts.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}
            </select>
        </div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="salvarCobCidade()">Criar</button>
        </div>`;
    modal.classList.add("show");
}

async function salvarCobCidade() {
    const ibge = $("modalCobIbge").value.trim();
    const cidade = $("modalCobCidade").value.trim();
    const estado = $("modalCobUF").value.trim().toUpperCase();
    if (!ibge || !cidade || !estado) { toast("IBGE, cidade e UF sao obrigatorios", "error"); return; }
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/cobertura`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
                ibge_codigo: ibge, cidade, estado,
                ddd: $("modalCobDDD").value || null,
                mesorregiao: $("modalCobMeso").value.trim() || null,
                rep_bmax: $("modalCobRep").value || null
            })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        closeAdminModal();
        await loadCobertura();
        renderCobertura();
        toast("Cidade adicionada");
    } catch (e) { toast(e.message || "Erro", "error"); }
}

async function uploadCobertura(input) {
    const file = input.files[0];
    if (!file) return;
    input.value = "";
    const formData = new FormData();
    formData.append("file", file);
    try {
        const token = localStorage.getItem("token");
        toast("Enviando planilha...");
        const res = await fetch(`${API_URL}/admin/cobertura/upload`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        await loadCobertura();
        renderCobertura();
        toast(`Upload concluido: ${data.upserted} cidades${data.skipped ? ` (${data.skipped} ignoradas)` : ""}`);
    } catch (e) { toast(e.message || "Erro no upload", "error"); }
}

async function downloadCobertura() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/cobertura/download`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao baixar");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "cobertura_bmax.xlsx"; a.click();
        URL.revokeObjectURL(url);
    } catch (e) { toast(e.message, "error"); }
}

// ─── Vendedores BMax (área de atuação = ddds) ────────────────

async function loadVendedoresBmax() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/vendedores-bmax`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar vendedores");
        ADMIN_VENDEDORES = await res.json();
    } catch (e) { console.error(e); toast("Erro ao carregar vendedores", "error"); }
}

function renderVendedoresBmax() {
    const wrap = $("adminVendedoresBody");
    if (!wrap) return;
    if (!ADMIN_VENDEDORES.length) { wrap.innerHTML = '<div class="empty-state">Nenhum vendedor cadastrado.</div>'; return; }

    let html = `<table class="extrato-table"><thead><tr>
        <th>Nome</th><th>Tipo</th><th>Cor</th><th>Área de atuação (DDDs)</th><th>Fallback</th><th>Status</th><th>Ações</th>
    </tr></thead><tbody>`;
    for (const v of ADMIN_VENDEDORES) {
        const badge = v.ativo ? '<span class="status-badge status-aprovado">Ativo</span>' : '<span class="status-badge status-rejeitado">Inativo</span>';
        html += `<tr>
            <td><strong>${esc(v.nome)}</strong></td>
            <td>${esc(v.tipo)}</td>
            <td><span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${esc(v.cor || '#60a5fa')};vertical-align:middle"></span></td>
            <td>${(v.ddds || []).length ? esc((v.ddds || []).join(", ")) : '<span style="color:var(--muted)">—</span>'}</td>
            <td>${v.fallback ? "Sim" : "—"}</td>
            <td>${badge}</td>
            <td style="white-space:nowrap">
                <button class="btn btn-sm" onclick='openVendedorModal(${JSON.stringify(v)})'>Editar</button>
                <button class="btn btn-sm ${v.ativo ? "btn-danger" : "primary"}" onclick="toggleVendedorBmax(${v.id},${!v.ativo})">${v.ativo ? "Desativar" : "Ativar"}</button>
            </td>
        </tr>`;
    }
    html += "</tbody></table>";
    wrap.innerHTML = html;
}

function openVendedorModal(v) {
    const isEdit = !!v;
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>${isEdit ? "Editar" : "Novo"} Vendedor</h3>
        <div class="form-row"><label>Nome</label><input type="text" id="modalVendNome" value="${esc(v?.nome || "")}"></div>
        <div class="form-row"><label>Tipo</label>
            <select id="modalVendTipo">
                ${["VI", "VT1", "VT2"].map(t => `<option value="${t}" ${v?.tipo === t ? "selected" : ""}>${t}</option>`).join("")}
            </select>
        </div>
        <div class="form-row"><label>Cor</label><input type="color" id="modalVendCor" value="${esc(v?.cor || '#60a5fa')}"></div>
        <div class="form-row"><label>DDDs (área de atuação, separados por vírgula)</label>
            <input type="text" id="modalVendDdds" value="${esc((v?.ddds || []).join(", "))}" placeholder="Ex: 11, 12, 13">
        </div>
        <div class="form-row"><label><input type="checkbox" id="modalVendFallback" ${v?.fallback ? "checked" : ""}> Fallback — atende DDDs não mapeados</label></div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="salvarVendedorBmax(${v?.id ?? "null"})">${isEdit ? "Salvar" : "Criar"}</button>
        </div>`;
    modal.classList.add("show");
}

async function salvarVendedorBmax(id) {
    const nome = $("modalVendNome").value.trim();
    if (!nome) { toast("Nome é obrigatório", "error"); return; }
    const ddds = $("modalVendDdds").value.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    const body = {
        nome,
        tipo: $("modalVendTipo").value,
        cor: $("modalVendCor").value,
        ddds: ddds.length ? ddds : null,
        fallback: $("modalVendFallback").checked
    };
    try {
        const token = localStorage.getItem("token");
        const method = id ? "PATCH" : "POST";
        const url = id ? `${API_URL}/admin/vendedores-bmax/${id}` : `${API_URL}/admin/vendedores-bmax`;
        const res = await fetch(url, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        closeAdminModal();
        await loadVendedoresBmax();
        renderVendedoresBmax();
        toast(id ? "Vendedor atualizado" : "Vendedor criado");
    } catch (e) { toast(e.message || "Erro ao salvar", "error"); }
}

async function toggleVendedorBmax(id, ativo) {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/vendedores-bmax/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ ativo })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        await loadVendedoresBmax();
        renderVendedoresBmax();
        toast(ativo ? "Vendedor ativado" : "Vendedor desativado");
    } catch (e) { toast(e.message || "Erro", "error"); }
}

// ─── Lista mestre "Representantes BMax" (dropdown de Cobertura) ─

async function loadRepBmaxList() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/rep-bmax-list`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar lista");
        ADMIN_REP_BMAX_LIST = await res.json();
    } catch (e) { console.error(e); toast("Erro ao carregar lista de representantes BMax", "error"); }
}

function renderRepBmaxList() {
    const wrap = $("adminRepBmaxListBody");
    if (!wrap) return;
    if (!ADMIN_REP_BMAX_LIST.length) { wrap.innerHTML = '<div class="empty-state">Nenhum representante nesta lista.</div>'; return; }

    let html = `<table class="extrato-table"><thead><tr><th>Nome</th><th>Status</th><th>Ações</th></tr></thead><tbody>`;
    ADMIN_REP_BMAX_LIST.forEach((r, i) => {
        html += `<tr>
            <td><strong>${esc(r.nome)}</strong></td>
            <td>${r.ativo ? '<span class="status-badge status-aprovado">Ativo</span>' : '<span class="status-badge status-rejeitado">Inativo</span>'}</td>
            <td style="white-space:nowrap">
                <button class="btn btn-sm" onclick="toggleRepBmaxListItem(${i})">${r.ativo ? "Desativar" : "Ativar"}</button>
                <button class="btn btn-sm btn-danger" onclick="removeRepBmaxListItem(${i})">Excluir</button>
            </td>
        </tr>`;
    });
    html += "</tbody></table>";
    wrap.innerHTML = html;
}

function openRepBmaxListModal() {
    const modal = $("adminModal");
    const content = $("adminModalContent");
    content.innerHTML = `
        <h3>Adicionar Representante BMax</h3>
        <div class="form-row"><label>Nome</label><input type="text" id="modalRepBmaxListNome"></div>
        <div class="form-actions">
            <button class="btn" onclick="closeAdminModal()">Cancelar</button>
            <button class="btn primary" onclick="addRepBmaxListItem()">Adicionar</button>
        </div>`;
    modal.classList.add("show");
}

async function addRepBmaxListItem() {
    const nome = $("modalRepBmaxListNome").value.trim();
    if (!nome) { toast("Nome é obrigatório", "error"); return; }
    if (ADMIN_REP_BMAX_LIST.some(r => r.nome.toLowerCase() === nome.toLowerCase())) {
        toast("Já existe um representante com este nome na lista", "error"); return;
    }
    ADMIN_REP_BMAX_LIST.push({ nome, ativo: true });
    await saveRepBmaxList();
    closeAdminModal();
    renderRepBmaxList();
    toast("Adicionado");
}

async function toggleRepBmaxListItem(i) {
    ADMIN_REP_BMAX_LIST[i].ativo = !ADMIN_REP_BMAX_LIST[i].ativo;
    await saveRepBmaxList();
    renderRepBmaxList();
}

async function removeRepBmaxListItem(i) {
    const nome = ADMIN_REP_BMAX_LIST[i].nome;
    if (!confirm(`Excluir "${nome}" da lista? Cidades com este representante ficam sem representante atribuído.`)) return;
    ADMIN_REP_BMAX_LIST.splice(i, 1);
    await saveRepBmaxList();
    renderRepBmaxList();
    toast("Removido");
}

async function saveRepBmaxList() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/rep-bmax-list`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ lista: ADMIN_REP_BMAX_LIST })
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    } catch (e) { toast(e.message || "Erro ao salvar lista", "error"); }
}

// ─── Matriz de Comissão / Parâmetros de Classificação PCI ────

const COMISSAO_FIELDS = [
    { key: "raio_km", label: "Raio máximo revenda (km)", type: "number" },
    { key: "nf_threshold", label: "Faturamento de corte para NF (R$)", type: "number" },
    { key: "vinculo_dias", label: "Dias de vínculo", type: "number" },
    { key: "rep_pct_r1", label: "Comissão rep — faixa 1 (%)", type: "number" },
    { key: "rep_pct_r3a", label: "Comissão rep — faixa 3a (%)", type: "number" },
    { key: "rep_pct_r3b", label: "Comissão rep — faixa 3b (%)", type: "number" },
    { key: "rep_pct_r5", label: "Comissão rep — faixa 5 (%)", type: "number" },
    { key: "vi_pct", label: "Comissão VI (%)", type: "number" }
];

async function loadComissaoConfig() {
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/comissao-config`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error("Erro ao carregar configuração de comissão");
        ADMIN_COMISSAO = await res.json();
        ADMIN_COMISSAO_LOADED = true;
    } catch (e) { console.error(e); toast("Erro ao carregar comissão/classificação", "error"); }
}

function renderComissaoConfig() {
    const wrap = $("adminComissaoBody");
    if (!wrap) return;
    let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:700px">';
    for (const f of COMISSAO_FIELDS) {
        html += `<div class="form-row"><label>${f.label}</label>
            <input type="${f.type}" step="any" id="modalCom_${f.key}" value="${esc(ADMIN_COMISSAO[f.key] ?? "")}"></div>`;
    }
    html += '</div>';
    html += `<p style="color:var(--muted);font-size:12px;margin-top:12px">A matriz de comissão por PCI/classe (tabela completa) continua sendo editada apenas via suporte técnico nesta primeira versão — os parâmetros acima já cobrem o ajuste do dia a dia.</p>`;
    wrap.innerHTML = html;
}

async function salvarComissaoConfig() {
    const body = {};
    for (const f of COMISSAO_FIELDS) {
        const val = $(`modalCom_${f.key}`)?.value;
        if (val !== undefined && val !== "") body[f.key] = val;
    }
    try {
        const token = localStorage.getItem("token");
        const res = await fetch(`${API_URL}/admin/comissao-config`, {
            method: "PUT",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify(body)
        });
        if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
        await loadComissaoConfig();
        renderComissaoConfig();
        toast("Parâmetros salvos — refletem no Motor na próxima consulta");
    } catch (e) { toast(e.message || "Erro ao salvar", "error"); }
}

// ─── Init ────────────────────────────────────────────────────

async function initGestao() {
    await Promise.all([loadAdminUsers(), loadRevendasBmax(), loadRepsBmax()]);
    renderRevendasBmax();
    renderAdminUsers();
}
