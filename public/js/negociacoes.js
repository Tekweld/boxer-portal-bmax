let negociacoes = [];

function showNegFormError(msg) {
  const el = $("negFormError");
  if (!el) return;
  el.innerHTML = `<span class="alert-icon">✕</span><span>${esc(msg)}</span>`;
  el.classList.remove("hidden");
  el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideNegFormError() {
  const el = $("negFormError");
  if (el) el.classList.add("hidden");
}

async function loadNegociacoes() {
  try {
    const token = localStorage.getItem("token");

    const res = await fetch(`${API_URL}/negociacoes`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) throw new Error("Erro ao carregar negociações");

    negociacoes = await res.json();
    renderNegociacoes();
  } catch (err) {
    console.error(err);
  }
}

function renderNegociacoes() {
  const grid = $("gridNegociacoes");
  grid.innerHTML = "";

  negociacoes.forEach(n => {
    const el = document.createElement("div");
    el.className = "lead";

    el.innerHTML = `
      <div class="lead-top">
        <div class="lead-title">
          <h4>${esc(n.nome)}</h4>
          <div class="subline">${esc(n.cnpj)}</div>
        </div>
      </div>

      <div class="meta">
        <div class="pair"><b>Cidade</b><span>${esc(n.cidade)}</span></div>
        <div class="pair"><b>Máquina</b><span>${esc(n.maquina)}</span></div>
        <div class="pair"><b>Revenda</b><span>${esc(n.revenda)}</span></div>
        <div class="pair"><b>Representante</b><span>${esc(n.representante || "Não informado")}</span></div>
      </div>
    `;

    grid.appendChild(el);
  });
}

// ── Orçamento (até 3 arquivos): sobe direto pro Storage assim que escolhido; o id vai junto no salvar ──
const NEG_MAX_ARQUIVOS = 3;
const NEG_MAX_BYTES = 10 * 1024 * 1024;
const NEG_EXT = ["pdf", "png", "jpg", "jpeg", "xlsx", "xls", "docx", "doc"];
let negArquivos = []; // { nome, tamanho, id, uploading, erro }

function renderNegArquivos() {
  const el = $("negArquivosLista");
  if (!el) return;
  el.innerHTML = negArquivos.map((a, i) => {
    const estado = a.erro ? `<span style="color:#e30613">${esc(a.erro)}</span>`
      : a.uploading ? `<span style="color:var(--muted)">enviando...</span>`
      : `<span style="color:#16a34a">pronto</span>`;
    return `<div style="display:flex;gap:8px;align-items:center;margin:2px 0;">
      <span>&#128206; ${esc(a.nome)} (${(a.tamanho / 1048576).toFixed(1)} MB)</span> ${estado}
      <a href="#" onclick="removerNegArquivo(${i});return false;" style="color:var(--muted)">remover</a></div>`;
  }).join("");
}

function removerNegArquivo(i) {
  negArquivos.splice(i, 1);
  renderNegArquivos();
}

async function enviarNegArquivo(item, file) {
  try {
    const token = localStorage.getItem("token");
    const r = await fetch("/api/negociacoes/orcamento-upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ nome: file.name, tamanho: file.size, tipo: file.type })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Falha ao preparar o envio");
    const fd = new FormData();
    fd.append("cacheControl", "3600");
    fd.append("", file);
    const up = await fetch(d.uploadUrl, { method: "PUT", body: fd });
    if (!up.ok) throw new Error("Falha ao enviar o arquivo");
    item.id = d.id;
  } catch (e) {
    item.erro = e.message || "Falha no envio";
  } finally {
    item.uploading = false;
    renderNegArquivos();
  }
}

$("negArquivos")?.addEventListener("change", (ev) => {
  const files = Array.from(ev.target.files || []);
  ev.target.value = "";
  for (const f of files) {
    const ext = (f.name.split(".").pop() || "").toLowerCase();
    if (negArquivos.length >= NEG_MAX_ARQUIVOS) { toast(`Anexe no máximo ${NEG_MAX_ARQUIVOS} arquivos.`, "warn"); break; }
    if (!NEG_EXT.includes(ext)) { toast(`"${f.name}": use PDF, imagem, Word ou Excel.`, "warn"); continue; }
    if (f.size > NEG_MAX_BYTES) { toast(`"${f.name}" passa de 10 MB.`, "warn"); continue; }
    const item = { nome: f.name, tamanho: f.size, id: null, uploading: true, erro: null };
    negArquivos.push(item);
    enviarNegArquivo(item, f);
  }
  renderNegArquivos();
});

// "Quem atende o cliente?" só aparece quando a Boxer vende (a revenda que vende já atende sozinha)
$("negCaminho").addEventListener("change", () => {
  const boxerVende = $("negCaminho").value === "BOX+REV>IND";
  $("campoAtendimento").classList.toggle("hidden", !boxerVende);
  if (!boxerVende) $("negAtendimento").value = "";
});

$("btnSalvarNegociacao").addEventListener("click", async () => {
  hideNegFormError();
  if (negArquivos.some(a => a.uploading)) return toast("Aguarde o envio dos arquivos terminar.", "warn");
  if (negArquivos.some(a => a.erro)) return toast("Remova ou reenvie o arquivo com erro antes de salvar.", "warn");
  if (!negArquivos.length) return toast("Anexe pelo menos 1 orçamento.", "warn");
  const novaNegociacao = {
    orcamentos: negArquivos.map(a => a.id).filter(Boolean),
    cnpj: $("negCnpj").value,
    cep: $("negCep").value,
    nome: $("negNome").value,
    cidade: $("negCidade").value,
    maquinainteresse: $("negMaquina").value,
    observacoes: $("negObs").value,
    usuario: session.username
  };

  if (!novaNegociacao.nome.trim()) return toast("Informe o Nome do Cliente.", "warn");
  if (!novaNegociacao.cnpj.trim()) return toast("Informe o CNPJ.", "warn");
  if (!novaNegociacao.cidade.trim()) return toast("Informe a Cidade.", "warn");

  if (session.role === "revenda") {
    novaNegociacao.revenda = session.name;

    if (!$("negEstado").value.trim()) return toast("Informe o Estado.", "warn");
    if (!$("negSegmento").value) return toast("Selecione o produto do lead (Máquinas, Laser ou Robô).", "warn");
    if (!$("negCaminho").value) return toast("Selecione o Caminho de Venda.", "warn");
    // "Quem atende o cliente?" só vale quando a Boxer vende; se a revenda vende, ela mesma atende
    if ($("negCaminho").value === "BOX+REV>IND" && !$("negAtendimento").value) return toast("Informe quem atende o cliente.", "warn");
    novaNegociacao.estado = $("negEstado").value.trim();
    novaNegociacao.segmento = $("negSegmento").value;
    novaNegociacao.caminho = $("negCaminho").value;
    novaNegociacao.atendimento = $("negCaminho").value === "BOX>REV" ? "revenda" : $("negAtendimento").value;
  } else {
    novaNegociacao.revenda = $("negRevenda").value;
  }

  if (session.role === "representante" || session.role === "adm") {
    if (!$("negRepresentante").value) return toast("Selecione um Representante.", "warn");
    if (!$("negResponsavel").value) return toast("Selecione um Responsável.", "warn");
    if (!$("negPci").value) return toast("Selecione um PCI.", "warn");
    novaNegociacao.representante = $("negRepresentante").value;
    novaNegociacao.responsavel = $("negResponsavel").value;
    novaNegociacao.pci = $("negPci").value;
    // Funil: representante e admin escolhem (revenda sempre vai pro BMAX, sem
    // escolha — o backend também impõe isso server-side, não confia só nisso aqui).
    novaNegociacao.funil = $("negFunil")?.value || "bmax";
  } else {
    // Revenda não escolhe representante/responsável/PCI (campos ficam ocultos) —
    // sem isso, RD_OWNERS[undefined] deixava o deal sem owner e o RD Station rejeitava a criação.
    novaNegociacao.responsavel = "Revenda";
  }

  const btn = $("btnSalvarNegociacao");
  btnLoading(btn, true);

  const token = localStorage.getItem("token");

  try {
  const res = await fetch("/api/negociacoes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(novaNegociacao)
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => null);
    const msg = errData?.error || (res.status === 400 ? "Dados inválidos para a negociação" : "Erro ao salvar negociação");
    // Banner fixo em vez de só toast — o toast some em 3s e o cadastro que
    // NÃO foi salvo passa fácil batido se a pessoa já desviou o olhar.
    showNegFormError(`Cadastro NÃO foi salvo: ${msg}`);
    return;
  }

  await res.json();
  hideNegFormError();
  loadNegociacoes();

  $("negCnpj").value = "";
  $("negCep").value = "";
  $("negNome").value = "";
  $("negCidade").value = "";
  $("negMaquina").value = "";
  $("negObs").value = "";
  negArquivos = []; renderNegArquivos();
  $("negRepresentante").value = "";
  $("negResponsavel").value = "";
  $("negRevenda").value = "";
  $("negPci").value = "";
  $("negEstado").value = "";
  $("negCaminho").value = "";
  $("negSegmento").value = "";
  $("negAtendimento").value = "";
  $("campoAtendimento").classList.add("hidden");
  if ($("negFunil")) $("negFunil").value = "bmax";

  toast("Negociação Registrada!");
  } finally {
    btnLoading(btn, false);
  }
});
