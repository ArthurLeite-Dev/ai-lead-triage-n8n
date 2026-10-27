// Validação e interpretação da resposta. Sem DOM, para testar com node --test.
(function (raiz, fabrica) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = fabrica();
  } else {
    raiz.LeadUtils = fabrica();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Devem ser iguais aos do workflow do n8n.
  const LIMITES = Object.freeze({
    nome: 100,
    email: 254,
    assunto: 150,
    mensagemMin: 10,
    mensagemMax: 2000
  });
  const CATEGORIAS = Object.freeze(["Dúvida", "Orçamento", "Suporte", "Outro"]);
  const PRIORIDADES = Object.freeze(["Baixa", "Média", "Alta"]);

  const REGEX_EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

  const MSG_RESPOSTA_INVALIDA =
    "O servidor devolveu uma resposta em formato inesperado. Tente novamente.";

  // Remove caracteres de controle e espaços extras.
  function limparTexto(valor, multilinha) {
    if (typeof valor !== "string") return null;
    let texto = valor
      .replace(/\r\n?/g, "\n")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
    if (!multilinha) texto = texto.replace(/\s+/g, " ");
    return texto.trim();
  }

  function emailValido(email) {
    return (
      typeof email === "string" &&
      email.length <= LIMITES.email &&
      REGEX_EMAIL.test(email)
    );
  }

  // Retorna { valido, erros, dadosLimpos }.
  function validarFormulario(dados) {
    const origem = dados && typeof dados === "object" ? dados : {};
    const nome = limparTexto(origem.nome, false) || "";
    const email = limparTexto(origem.email, false) || "";
    const assunto = limparTexto(origem.assunto, false) || "";
    const mensagem = limparTexto(origem.mensagem, true) || "";
    const erros = {};

    if (!nome) erros.nome = "Informe o nome do contato.";
    else if (nome.length > LIMITES.nome)
      erros.nome = "O nome deve ter no máximo " + LIMITES.nome + " caracteres.";

    if (!email) erros.email = "Informe o e-mail.";
    else if (!emailValido(email))
      erros.email = "Informe um e-mail válido, como nome@exemplo.com.";

    if (!assunto) erros.assunto = "Informe o assunto.";
    else if (assunto.length > LIMITES.assunto)
      erros.assunto = "O assunto deve ter no máximo " + LIMITES.assunto + " caracteres.";

    if (!mensagem) erros.mensagem = "Escreva a mensagem.";
    else if (mensagem.length < LIMITES.mensagemMin)
      erros.mensagem = "A mensagem deve ter pelo menos " + LIMITES.mensagemMin + " caracteres.";
    else if (mensagem.length > LIMITES.mensagemMax)
      erros.mensagem = "A mensagem deve ter no máximo " + LIMITES.mensagemMax + " caracteres.";

    return {
      valido: Object.keys(erros).length === 0,
      erros: erros,
      dadosLimpos: { nome: nome, email: email, assunto: assunto, mensagem: mensagem }
    };
  }

  // Confere a URL definida em config.js.
  function validarUrlWebhook(url) {
    if (typeof url !== "string" || !url.trim()) {
      return { valido: false, erro: "A URL do webhook não está configurada. Edite js/config.js." };
    }
    try {
      const analisada = new URL(url.trim());
      if (analisada.protocol !== "http:" && analisada.protocol !== "https:") {
        throw new Error("protocolo não suportado");
      }
      return { valido: true, erro: "" };
    } catch (e) {
      return { valido: false, erro: "A URL do webhook em js/config.js é inválida." };
    }
  }

  function normalizarChave(texto) {
    return String(texto == null ? "" : texto)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .toLowerCase();
  }

  function normalizarPeloConjunto(valor, permitidos) {
    const chave = normalizarChave(valor);
    for (let i = 0; i < permitidos.length; i += 1) {
      if (normalizarChave(permitidos[i]) === chave) return permitidos[i];
    }
    return null;
  }

  function normalizarCategoria(valor) {
    return normalizarPeloConjunto(valor, CATEGORIAS);
  }

  function normalizarPrioridade(valor) {
    return normalizarPeloConjunto(valor, PRIORIDADES);
  }

  function textoNaoVazio(valor) {
    return typeof valor === "string" && valor.trim() ? valor.trim() : null;
  }

  // Interpreta o JSON do webhook. Retorna { ok: true, dados } ou { ok: false, codigo, erro }.
  function interpretarRespostaWebhook(corpo) {
    const invalida = { ok: false, codigo: "RESPOSTA_INVALIDA", erro: MSG_RESPOSTA_INVALIDA };

    if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return invalida;

    if (corpo.sucesso === false) {
      return {
        ok: false,
        codigo: typeof corpo.codigo === "string" ? corpo.codigo : "ERRO",
        erro:
          textoNaoVazio(corpo.erro) !== null
            ? textoNaoVazio(corpo.erro).slice(0, 300)
            : "O servidor não conseguiu processar a mensagem."
      };
    }

    if (corpo.sucesso !== true || !corpo.dados || typeof corpo.dados !== "object") {
      return invalida;
    }

    const categoria = normalizarCategoria(corpo.dados.categoria);
    const prioridade = normalizarPrioridade(corpo.dados.prioridade);
    const resumo = textoNaoVazio(corpo.dados.resumo);
    const resposta = textoNaoVazio(corpo.dados.resposta_sugerida);

    if (!categoria || !prioridade || !resumo || !resposta) return invalida;

    return {
      ok: true,
      dados: { categoria: categoria, resumo: resumo, prioridade: prioridade, resposta_sugerida: resposta }
    };
  }

  // Mensagem para erros HTTP sem corpo JSON utilizável.
  function mensagemPorStatus(status) {
    if (status === 400) return "O servidor recusou os dados enviados. Revise os campos e tente novamente.";
    if (status === 404)
      return "Webhook não encontrado. Confirme que o workflow está ativo (ou aguardando o evento de teste) e que a URL em js/config.js está correta.";
    if (status === 413) return "A mensagem é grande demais para ser enviada.";
    if (status === 429) return "Muitas solicitações em pouco tempo. Aguarde um minuto e tente novamente.";
    if (status >= 500)
      return "O servidor de automação encontrou um erro (HTTP " + status + "). Tente novamente em instantes.";
    return "O servidor respondeu com um erro inesperado (HTTP " + status + ").";
  }

  return {
    LIMITES: LIMITES,
    CATEGORIAS: CATEGORIAS,
    PRIORIDADES: PRIORIDADES,
    MSG_RESPOSTA_INVALIDA: MSG_RESPOSTA_INVALIDA,
    limparTexto: limparTexto,
    emailValido: emailValido,
    validarFormulario: validarFormulario,
    validarUrlWebhook: validarUrlWebhook,
    normalizarCategoria: normalizarCategoria,
    normalizarPrioridade: normalizarPrioridade,
    interpretarRespostaWebhook: interpretarRespostaWebhook,
    mensagemPorStatus: mensagemPorStatus
  };
});
