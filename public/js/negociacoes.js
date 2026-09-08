let negociacoes = [];

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

$("btnSalvarNegociacao").addEventListener("click", async () => {
  const novaNegociacao = {
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
    if (!$("negCaminho").value) return toast("Selecione o Caminho de Venda.", "warn");
    novaNegociacao.estado = $("negEstado").value.trim();
    novaNegociacao.caminho = $("negCaminho").value;
  } else {
    novaNegociacao.revenda = $("negRevenda").value;
  }

  if (session.role === "representante") {
    if (!$("negRepresentante").value) return toast("Selecione um Representante.", "warn");
    if (!$("negResponsavel").value) return toast("Selecione um Responsável.", "warn");
    if (!$("negPci").value) return toast("Selecione um PCI.", "warn");
    novaNegociacao.representante = $("negRepresentante").value;
    novaNegociacao.responsavel = $("negResponsavel").value;
    novaNegociacao.pci = $("negPci").value;
  } else {
    // Revenda/adm não escolhem representante/responsável/PCI (campos ficam ocultos) —
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
    if (res.status === 400) {
      const errData = await res.json().catch(() => null);
      toast(errData?.error || "Dados inválidos para a negociação", "error");
      return;
    }

    const errData = await res.json().catch(() => null);
    toast(errData?.error || "Erro ao salvar negociação", "error");
    return;
  }

  await res.json();
  loadNegociacoes();

  $("negCnpj").value = "";
  $("negCep").value = "";
  $("negNome").value = "";
  $("negCidade").value = "";
  $("negMaquina").value = "";
  $("negObs").value = "";
  $("negRepresentante").value = "";
  $("negResponsavel").value = "";
  $("negRevenda").value = "";
  $("negPci").value = "";
  $("negEstado").value = "";
  $("negCaminho").value = "";

  toast("Negociação Registrada!");
  } finally {
    btnLoading(btn, false);
  }
});
