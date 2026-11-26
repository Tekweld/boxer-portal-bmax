// ─── IDs RD Station CRM ──────────────────────────────────────
// Pipeline principal (Indústria Interno)
const RD_PIPELINE_INDUSTRIA = "66151c1470449b000d54e914";
// Pipeline BMax Interno
const RD_PIPELINE_BMAX_INTERNO = "6a2bff35a294cf00226dd600";
// Pipeline Revendas
const RD_PIPELINE_REVENDAS = "68b19e2883a5f700170072d3";

// Stages
const RD_STAGES = {
    "678f7e08dc0b4800142783ac": "Lead",
    "66151c1470449b000d54e916": "Em Contato",
    "66151c1470449b000d54e917": "Negociação",
    "66153bd8ebb08a0014e92453": "Demonstração",
    "66151c1470449b000d54e919": "Venda Efetivada",
    "66151c4859f00e001209d066": "Perdidos | Sem Perfil",
    "6a2bff35a294cf00226dd602": "Assumido",
    "6a2bff35a294cf00226dd603": "Perdido",
    "6afb723153734400239f4226": "Perdido",
    "6a5a200c4d3424002786a346": "Vendido",
    // Estágio novo (Indústria Interno, criado ~09/2026), pós-venda — descoberto
    // 22/09/2026 quando um card ficou com tag "??????" no painel. Sempre que uma
    // negociação chega aqui ela JÁ passou por Venda Efetivada, então conta como
    // vendida pra todo efeito de cashback/comissão (ver RD_STAGE_ENTREGA_TECNICA
    // abaixo, incluído nos mesmos "vendaStages" que Venda Efetivada/Vendido).
    "6aa05557a4f8c10025433f09": "Entrega Técnica"
};

const RD_STAGE_EXCLUIDO = "66151c4859f00e001209d066";
const RD_STAGE_ASSUMIDO = "6a2bff35a294cf00226dd602";
const RD_STAGE_NEGOCIACAO = "66151c1470449b000d54e917";
const RD_STAGE_LEAD = "678f7e08dc0b4800142783ac";
const RD_STAGE_VENDIDO = "6a5a200c4d3424002786a346";
// Etapa "Prazo Vencido" do funil BMAX (nome histórico no código: PERDIDO). Desde 16/11/2026 recebe SÓ o arquivamento automático de 60 dias do PCI12a.
const RD_STAGE_PERDIDO = "6a2bff35a294cf00226dd603";
// Etapa "Perdido pela Revenda" (funil BMAX, criada pelo André em 16/11/2026): destino do botão "Perdido" da revenda no Portal.
const RD_STAGE_PERDIDO_REVENDA = "6afb723153734400239f4226";
const RD_STAGE_VENDA_EFETIVADA = "66151c1470449b000d54e919";
const RD_STAGE_ENTREGA_TECNICA = "6aa05557a4f8c10025433f09";
// Só usadas pela tabela fase->etapa do Pipefy pro pipe INDÚSTRIA - INTERNO
// (pipefyConstants.js, migração RD->Pipefy) — já existiam em RD_STAGES, sem
// constante própria, até a Fase 3 do plano da migração (19/10/2026).
const RD_STAGE_EM_CONTATO = "66151c1470449b000d54e916";
const RD_STAGE_DEMONSTRACAO = "66153bd8ebb08a0014e92453";

// Stages excluídos por pipeline (para busca de leads duplicados)
const RD_STAGES_EXCLUIDOS_REVENDAS = ["68b19eeab3e5a3001b7c83b6", "68b19ef1fd3c29001b0a118a"];

// Custom field IDs
const RD_CUSTOM_FIELDS = {
    CNPJ: "66549f56bc9996000f00486d",
    ESTADO: "67407ad5f612fe001acf4874",
    CIDADE: "69de7c5ff84e9d00198ba86d",
    REPRESENTANTE: "687562da830acf00229b542f",
    REVENDA_LOJA: "69a19ce32db3db00162b7f77",
    MAQUINA: "69a1eaa65a4db30013c0bd1b",
    PERFIL_PCI: "6a3ae56694471c001e755ff8",
    NOTAS: "661405c2d6161a0014264a6b",
    SEGMENTO_PRODUTO: "6aa346e64ea34c002966dda8"
};

// Mapeamento slug → custom field ID (usado em updateLead)
const RD_CF_SLUG_MAP = {
    "perfil-pci": RD_CUSTOM_FIELDS.PERFIL_PCI,
    "cnpj": RD_CUSTOM_FIELDS.CNPJ,
    "cidade": RD_CUSTOM_FIELDS.CIDADE,
    "estado": RD_CUSTOM_FIELDS.ESTADO,
    "revenda-loja": RD_CUSTOM_FIELDS.REVENDA_LOJA,
    "representante": RD_CUSTOM_FIELDS.REPRESENTANTE,
    "maquina-de-interesse-1": RD_CUSTOM_FIELDS.MAQUINA,
    "notas": RD_CUSTOM_FIELDS.NOTAS,
    "classe-de-preco": null,
    "seguimento-do-produto": RD_CUSTOM_FIELDS.SEGMENTO_PRODUTO
};

// ─── Owners / Responsáveis ───────────────────────────────────
const RD_OWNERS = {
    "Carlos": "66152391467aac000da67451",
    "Lucas Ferreira": "69c5314a81439100135437c7",
    "Max": "6a2007b8b9704500268c5624",
    // Pedido do André 2026-09-11: negociações com Responsável = "Revenda"
    // (revenda/adm criando via Portal) passam a ter André Coelho como dono
    // no RD, não mais o Billy.
    "Revenda": "67efe9d367f94d002a8c4929",
    "Representante": "661572a5823cb7000e85e146"
};

// Dono do RD (chave de RD_OWNERS) -> e-mail do membro correspondente no Pipefy. O robô de PCI12 (troca para o André ao detectar, devolve ao dono
// anterior no 12b automático de 48h) e o caminho 12a/12b trabalham com o ID do dono do RD; no Pipefy o responsável é um membro. Sem este mapa só o
// "Carlos" achava o membro (rdToEmail do cadastro só tinha ele) e as trocas de responsável eram ignoradas em silêncio (achado 26/11/2026).
const PIPEFY_EMAIL_POR_DONO_RD = {
    "Carlos": "vendas.2@boxersoldas.com.br",
    "Lucas Ferreira": "lucas.ferreira@boxersoldas.com.br",
    "Max": "max.santos@boxersoldas.com.br",
    "Revenda": "andre.coelho@boxersoldas.com.br"   // "Revenda" = André Coelho (ver comentário de RD_OWNERS)
};
const EMAIL_ANDRE = PIPEFY_EMAIL_POR_DONO_RD["Revenda"];
// ID do dono no RD a partir do e-mail do responsável no Pipefy (null quando o responsável não é um dono mapeado)
function donoRdPorEmail(email) {
    const e = String(email || "").trim().toLowerCase();
    const chave = Object.entries(PIPEFY_EMAIL_POR_DONO_RD).find(([, mail]) => mail === e)?.[0];
    return chave ? RD_OWNERS[chave] : null;
}

// Owner padrão para tarefas automáticas
const RD_OWNER_DEFAULT = "6a312b777a6c170023b6427d";
// Owner usado para leads criados via portal
const RD_OWNER_PORTAL = "6a312b777a6c170023b6427d";

// ─── Aliases de nomes e lista de representantes ──────────────
// Fonte real: tabela comercial_representantes_bmax (nome, rd_alias) no Supabase
// boxer-sistemas — ver rd.leads.service.js:getAliasMaps(). REPRESENTANTES abaixo
// é usada apenas como fallback estático se a consulta ao banco falhar.
const REPRESENTANTES = [
    "Lucas do Vale",
    "Victor Lantyer",
    "Fernando Augusto",
    "Caio Tito",
    "Hugo Carpanese",
    "Fernando Marques",
    "Carlos Alberto",
    "Cristina Perez",
    "Joyce Florencio",
    "Patrick Ferreira",
    "Weberson Rodrigues",
    "Daniela Gelsleichter",
    "Kleber Vasconcelos",
    "Francisco Garra",
    "José Maria",
    "N/D",
    "Lorena Leite",
    "Sergio Serlam",
    "Célio Almeida",
    "Silvio Valente",
    "Paulo Machado",
    "Manoel Messias",
    "Ronaldo/Marcus Macieira",
    "Francisco Campopiano"
];

// ─── Responsáveis internos ───────────────────────────────────
const RESPONSAVEIS = ["Carlos", "Lucas Ferreira", "Max", "Revenda", "Representante"];

// ─── Validação de revenda ────────────────────────────────────
const REVENDA_INVALIDOS = ["", "?????", "?", "Vazio", "N/D"];

// "Sem Revenda" é um valor legítimo (venda direta, sem revenda parceira) —
// não entra em REVENDA_INVALIDOS porque não é erro de dado, e continua
// aparecendo normal nas telas de gestão. Mas nenhum crédito de comissão de
// revenda deve ir pra uma conta chamada "Sem Revenda" (ninguém pode sacar
// isso), e nenhuma agregação de saldo por revenda deve somar esse valor
// como se fosse revenda de verdade de alguém. Usar esta lista só nesses
// dois cenários (crédito e agregação de saldo), nunca pra validação de dado.
const REVENDA_SEM_CREDITO = [...REVENDA_INVALIDOS, "Sem Revenda"];

// ─── PCI por caminho de venda ────────────────────────────────
// PCI 12a = BOX>REV (revenda atende) — NUNCA inverter
// PCI 12b = BOX+REV>IND (Boxer vende) — NUNCA inverter
// Lead TRAZIDO PELA REVENDA (Nova Negociação): o PCI é o da regra do projeto, pelo produto — Máquina=15, Laser=14,
// Robô=13 (André, 28/10/2026). Os caminhos/atendimento só mudam PARA ONDE o card vai, nunca o PCI.
const PCI_POR_SEGMENTO = {
    "Máquinas": "PCI 15",
    "Laser": "PCI 14",
    "Robo": "PCI 13"
};

const PCI_POR_CAMINHO = {
    "BOX>REV": "PCI 12a",
    "BOX+REV>IND": "PCI 12b"
};

// ─── Email fallback ──────────────────────────────────────────
const EMAIL_FALLBACK = process.env.EMAIL_FALLBACK;

// ─── Estados brasileiros ─────────────────────────────────────
const ESTADOS = {
    "Acre":"AC","Alagoas":"AL","Amapá":"AP","Amazonas":"AM","Bahia":"BA",
    "Ceará":"CE","Distrito Federal":"DF","Espírito Santo":"ES","Goiás":"GO",
    "Maranhão":"MA","Mato Grosso":"MT","Mato Grosso do Sul":"MS","Minas Gerais":"MG",
    "Pará":"PA","Paraíba":"PB","Paraná":"PR","Pernambuco":"PE","Piauí":"PI",
    "Rio de Janeiro":"RJ","Rio Grande do Norte":"RN","Rio Grande do Sul":"RS",
    "Rondônia":"RO","Roraima":"RR","Santa Catarina":"SC","São Paulo":"SP",
    "Sergipe":"SE","Tocantins":"TO"
};

module.exports = {
    RD_PIPELINE_INDUSTRIA,
    RD_PIPELINE_BMAX_INTERNO,
    RD_PIPELINE_REVENDAS,
    RD_STAGES,
    RD_STAGE_EXCLUIDO,
    RD_STAGE_ASSUMIDO,
    RD_STAGE_NEGOCIACAO,
    RD_STAGE_LEAD,
    RD_STAGE_VENDIDO,
    RD_STAGE_PERDIDO,
    RD_STAGE_PERDIDO_REVENDA,
    RD_STAGE_VENDA_EFETIVADA,
    RD_STAGE_ENTREGA_TECNICA,
    RD_STAGE_EM_CONTATO,
    RD_STAGE_DEMONSTRACAO,
    RD_STAGES_EXCLUIDOS_REVENDAS,
    RD_CUSTOM_FIELDS,
    RD_CF_SLUG_MAP,
    RD_OWNERS,
    PIPEFY_EMAIL_POR_DONO_RD,
    EMAIL_ANDRE,
    donoRdPorEmail,
    RD_OWNER_DEFAULT,
    RD_OWNER_PORTAL,
    REPRESENTANTES,
    RESPONSAVEIS,
    REVENDA_INVALIDOS,
    REVENDA_SEM_CREDITO,
    PCI_POR_CAMINHO,
    PCI_POR_SEGMENTO,
    EMAIL_FALLBACK,
    ESTADOS
};
