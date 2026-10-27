// Interface: valida, envia ao webhook e mostra o resultado.
// Usa textContent (nunca innerHTML) para evitar XSS com texto da IA.
(function () {
  "use strict";

  const CONFIG = window.APP_CONFIG || {};
  const U = window.LeadUtils;

  const CAMPOS = ["nome", "email", "assunto", "mensagem"];
  const CLASSE_PRIORIDADE = { Baixa: "badge-baixa", "Média": "badge-media", Alta: "badge-alta" };

  const el = {
    form: document.getElementById("form-contato"),
    btnEnviar: document.getElementById("btn-enviar"),
    btnTexto: document.getElementById("btn-texto"),
    spinner: document.querySelector("#btn-enviar .spinner"),
    status: document.getElementById("status"),
    contador: document.getElementById("contador"),
    resultado: document.getElementById("resultado"),
    resCategoria: document.getElementById("res-categoria"),
    resPrioridade: document.getElementById("res-prioridade"),
    resResumo: document.getElementById("res-resumo"),
    resResposta: document.getElementById("res-resposta"),
    btnCopiar: document.getElementById("btn-copiar")
  };
  const entradas = {};
  const mensagensErro = {};
  CAMPOS.forEach(function (campo) {
    entradas[campo] = document.getElementById(campo);
    mensagensErro[campo] = document.getElementById("erro-" + campo);
  });

  let enviando = false;
  let respostaAtual = "";
  let temporizadorCopia = null;

  // Erro com mensagem pronta para o usuário.
  class ErroApp extends Error {
    constructor(codigo, mensagem) {
      super(mensagem);
      this.name = "ErroApp";
      this.codigo = codigo;
    }
  }

  /* Interface */

  function mostrarStatus(tipo, texto) {
    el.status.textContent = texto;
    el.status.className = "alert alert-" + tipo;
    el.status.hidden = false;
  }

  function esconderStatus() {
    el.status.hidden = true;
    el.status.textContent = "";
  }

  function limparErrosCampos() {
    CAMPOS.forEach(function (campo) {
      entradas[campo].removeAttribute("aria-invalid");
      mensagensErro[campo].hidden = true;
      mensagensErro[campo].textContent = "";
    });
  }

  function mostrarErrosCampos(erros) {
    CAMPOS.forEach(function (campo) {
      if (erros[campo]) {
        entradas[campo].setAttribute("aria-invalid", "true");
        mensagensErro[campo].textContent = erros[campo];
        mensagensErro[campo].hidden = false;
      }
    });
    const primeiro = CAMPOS.find(function (campo) {
      return erros[campo];
    });
    if (primeiro) entradas[primeiro].focus();
  }

  function definirCarregando(carregando) {
    enviando = carregando;
    el.btnEnviar.disabled = carregando;
    el.btnEnviar.setAttribute("aria-busy", carregando ? "true" : "false");
    el.spinner.hidden = !carregando;
    el.btnTexto.textContent = carregando ? "Analisando…" : "Analisar mensagem";
  }

  function atualizarContador() {
    const tamanho = entradas.mensagem.value.length;
    el.contador.textContent = tamanho + " / " + U.LIMITES.mensagemMax;
    el.contador.classList.toggle("is-over", tamanho > U.LIMITES.mensagemMax);
  }

  function esconderResultado() {
    el.resultado.hidden = true;
    respostaAtual = "";
  }

  function mostrarResultado(dados) {
    el.resCategoria.textContent = dados.categoria;

    el.resPrioridade.textContent = dados.prioridade;
    el.resPrioridade.className = "badge " + (CLASSE_PRIORIDADE[dados.prioridade] || "badge-categoria");

    el.resResumo.textContent = dados.resumo;
    el.resResposta.textContent = dados.resposta_sugerida;
    respostaAtual = dados.resposta_sugerida;

    restaurarBotaoCopiar();
    el.resultado.hidden = false;
    el.resultado.focus({ preventScroll: true });
    el.resultado.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* Comunicação com o n8n */

  async function enviarParaWebhook(payload) {
    const controlador = new AbortController();
    const temporizador = setTimeout(function () {
      controlador.abort();
    }, CONFIG.REQUEST_TIMEOUT_MS || 60000);

    try {
      let resposta;
      try {
        resposta = await fetch(CONFIG.WEBHOOK_URL.trim(), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
          signal: controlador.signal
        });
      } catch (erro) {
        if (erro && erro.name === "AbortError") {
          throw new ErroApp(
            "TIMEOUT",
            "A análise demorou mais do que o esperado e foi cancelada. Tente novamente."
          );
        }
        throw new ErroApp(
          "REDE",
          "Não foi possível conectar ao servidor de automação. Verifique se o n8n está em execução, " +
            "se o workflow está publicado (ativo), se a URL em js/config.js está correta e se o CORS permite esta origem."
        );
      }

      let textoCorpo = "";
      try {
        textoCorpo = await resposta.text();
      } catch (erro) {
        if (erro && erro.name === "AbortError") {
          throw new ErroApp("TIMEOUT", "A resposta demorou demais e foi cancelada. Tente novamente.");
        }
        throw new ErroApp("REDE", "A conexão foi interrompida antes de a resposta terminar.");
      }

      let corpo = null;
      try {
        corpo = JSON.parse(textoCorpo);
      } catch (erro) {
        corpo = null;
      }

      if (corpo === null) {
        if (!resposta.ok) throw new ErroApp("HTTP", U.mensagemPorStatus(resposta.status));
        throw new ErroApp("RESPOSTA_INVALIDA", U.MSG_RESPOSTA_INVALIDA);
      }

      const resultado = U.interpretarRespostaWebhook(corpo);
      if (!resultado.ok) {
        // JSON fora do formato do app (ex.: erro padrão do n8n): usa o status HTTP.
        const formatoDoApp = corpo && (corpo.sucesso === true || corpo.sucesso === false);
        if (!resposta.ok && !formatoDoApp) throw new ErroApp("HTTP", U.mensagemPorStatus(resposta.status));
        throw new ErroApp(resultado.codigo, resultado.erro);
      }
      if (!resposta.ok) throw new ErroApp("HTTP", U.mensagemPorStatus(resposta.status));
      return resultado.dados;
    } finally {
      clearTimeout(temporizador);
    }
  }

  /* Eventos */

  async function aoEnviar(evento) {
    evento.preventDefault();
    if (enviando) return;

    limparErrosCampos();
    esconderStatus();

    const validacao = U.validarFormulario({
      nome: entradas.nome.value,
      email: entradas.email.value,
      assunto: entradas.assunto.value,
      mensagem: entradas.mensagem.value
    });
    if (!validacao.valido) {
      mostrarErrosCampos(validacao.erros);
      mostrarStatus("erro", "Corrija os campos destacados e tente novamente.");
      return;
    }

    const configuracao = U.validarUrlWebhook(CONFIG.WEBHOOK_URL);
    if (!configuracao.valido) {
      mostrarStatus("erro", configuracao.erro);
      return;
    }

    esconderResultado();
    definirCarregando(true);
    try {
      const dados = await enviarParaWebhook(validacao.dadosLimpos);
      mostrarResultado(dados);
      mostrarStatus("sucesso", "Mensagem analisada com sucesso.");
    } catch (erro) {
      console.error(erro);
      mostrarStatus(
        "erro",
        erro instanceof ErroApp ? erro.message : "Ocorreu um erro inesperado. Tente novamente."
      );
    } finally {
      definirCarregando(false);
    }
  }

  async function copiarTexto(texto) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(texto);
      return;
    }
    // Fallback sem Clipboard API.
    const area = document.createElement("textarea");
    area.value = texto;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copiou = document.execCommand("copy");
    document.body.removeChild(area);
    if (!copiou) throw new Error("Falha ao copiar");
  }

  function restaurarBotaoCopiar() {
    clearTimeout(temporizadorCopia);
    el.btnCopiar.textContent = "Copiar resposta";
  }

  async function aoCopiar() {
    if (!respostaAtual) return;
    clearTimeout(temporizadorCopia);
    try {
      await copiarTexto(respostaAtual);
      el.btnCopiar.textContent = "Copiado!";
    } catch (erro) {
      console.error(erro);
      el.btnCopiar.textContent = "Não foi possível copiar";
    }
    temporizadorCopia = setTimeout(restaurarBotaoCopiar, 2500);
  }

  function aoDigitar(evento) {
    const campo = evento.target.id;
    if (CAMPOS.indexOf(campo) === -1) return;
    if (campo === "mensagem") atualizarContador();
    if (entradas[campo].getAttribute("aria-invalid") === "true") {
      entradas[campo].removeAttribute("aria-invalid");
      mensagensErro[campo].hidden = true;
      mensagensErro[campo].textContent = "";
    }
  }

  function iniciar() {
    const configuracao = U.validarUrlWebhook(CONFIG.WEBHOOK_URL);
    if (!configuracao.valido) mostrarStatus("erro", configuracao.erro);
    atualizarContador();
    el.form.addEventListener("submit", aoEnviar);
    el.form.addEventListener("input", aoDigitar);
    el.btnCopiar.addEventListener("click", aoCopiar);
  }

  iniciar();
})();
