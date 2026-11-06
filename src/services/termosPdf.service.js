// Comprovante em PDF do Termo de Adesão BPartner: texto aceito, lojas, quem aprovou/quando/de onde e o hash do texto.
const PDFDocument = require("pdfkit");

const NIVEL = { bpartner_prata: "Prata", bpartner_ouro: "Ouro", bpartner_diamante: "Diamante" };
const AZUL = "#1d327b";
const ETAPA = { revenda: "Revenda (signatário)", testemunha_representante: "Representante (testemunha)", boxer: "Boxer Soldas (aprovação final)" };

function dataHora(v) {
    try { return new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }); } catch { return String(v || ""); }
}

function gerarComprovante({ termo, lojas, aprovacoes, fmt }) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 48, info: { Title: `Comprovante — Termo BPartner ${NIVEL[termo.programa] || ""} — ${termo.grupo}`, Author: "Boxer Soldas — Portal BMax" } });
        const parts = [];
        doc.on("data", c => parts.push(c));
        doc.on("end", () => resolve(Buffer.concat(parts)));
        doc.on("error", reject);

        doc.fillColor(AZUL).fontSize(18).text("Comprovante de Formalização Digital", { align: "left" });
        doc.moveDown(0.2).fontSize(12).fillColor("#333").text(`Programa BPartner ${NIVEL[termo.programa] || termo.programa} — Grupo ${termo.grupo}`);
        doc.moveDown(0.6).fontSize(9).fillColor("#555")
            .text(`Código do termo: ${termo.id}`)
            .text(`Situação: ${termo.status}${termo.compra_prazo_ate ? ` — compra das máquinas até ${termo.compra_prazo_ate}` : ""}`)
            .text(`Hash SHA-256 do texto aceito: ${termo.hash_sha256}`);

        doc.moveDown(0.8).fillColor(AZUL).fontSize(12).text("Aprovações");
        doc.moveDown(0.2).fontSize(9).fillColor("#222");
        for (const a of aprovacoes) {
            doc.text(`${ETAPA[a.etapa] || a.etapa}: ${a.nome_aprovador}${a.cargo ? " — " + a.cargo : ""}${a.cpf ? " — CPF " + fmt.fmtCpfMascarado(a.cpf) : ""}`);
            doc.fillColor("#666").text(`   em ${dataHora(a.aprovado_em)}${a.ip_address ? " — IP " + a.ip_address : ""}${a.usuario_email ? " — " + a.usuario_email : ""}`).fillColor("#222");
        }

        doc.moveDown(0.8).fillColor(AZUL).fontSize(12).text("Lojas do grupo (dados informados pela revenda)");
        doc.moveDown(0.2).fontSize(9).fillColor("#222");
        lojas.forEach((l, i) => {
            const inf = !!l.inf_cnpj;
            const end = inf ? fmt.enderecoComposto({ logradouro: l.inf_logradouro, numero: l.inf_numero, bairro: l.inf_bairro, complemento: l.inf_complemento }) : (l.cad_endereco || "");
            doc.text(`${i + 1}) ${inf ? l.inf_razao_social : l.cad_nome} — CNPJ ${fmt.fmtCnpj(inf ? l.inf_cnpj : l.cad_cnpj)}`);
            doc.fillColor("#444").text(`    ${end} — CEP ${fmt.fmtCep(inf ? l.inf_cep : l.cad_cep)} — ${(inf ? l.inf_cidade : l.cad_cidade) || ""}/${(inf ? l.inf_estado : l.cad_estado) || ""}`).fillColor("#222");
        });

        doc.addPage().fillColor(AZUL).fontSize(12).text("Texto do termo aceito");
        doc.moveDown(0.4).fontSize(9.5).fillColor("#222").text(termo.texto_renderizado || "", { align: "left", lineGap: 2 });

        doc.moveDown(1).fontSize(8).fillColor("#777").text("Documento gerado eletronicamente pelo Portal BMax. A integridade do texto pode ser conferida pelo hash SHA-256 acima.");
        doc.end();
    });
}

module.exports = { gerarComprovante };
