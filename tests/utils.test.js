// Testes de js/utils.js. Rode com: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const U = require("../js/utils.js");

const valido = {
  nome: "Maria Exemplo",
  email: "maria@exemplo.com",
  assunto: "Orçamento de site",
  mensagem: "Gostaria de receber um orçamento para um site institucional."
};

test("validarFormulario aceita dados corretos e devolve os dados limpos", () => {
  const r = U.validarFormulario({ ...valido, nome: "  Maria   Exemplo  ", mensagem: "  Olá, tudo bem?\r\nPreciso de ajuda.  " });
  assert.equal(r.valido, true);
  assert.deepEqual(r.erros, {});
  assert.equal(r.dadosLimpos.nome, "Maria Exemplo");
  assert.equal(r.dadosLimpos.mensagem, "Olá, tudo bem?\nPreciso de ajuda.");
});

test("validarFormulario rejeita campos vazios ou só com espaços", () => {
  const r = U.validarFormulario({ nome: "", email: "   ", assunto: "\n\t", mensagem: "" });
  assert.equal(r.valido, false);
  assert.deepEqual(Object.keys(r.erros).sort(), ["assunto", "email", "mensagem", "nome"]);
});

test("validarFormulario trata entradas que não são objeto ou texto", () => {
  assert.equal(U.validarFormulario(undefined).valido, false);
  assert.equal(U.validarFormulario(null).valido, false);
  const r = U.validarFormulario({ nome: 123, email: ["a@b.com"], assunto: {}, mensagem: null });
  assert.equal(r.valido, false);
  assert.equal(Object.keys(r.erros).length, 4);
});

test("validarFormulario respeita os limites de tamanho", () => {
  assert.equal(U.validarFormulario({ ...valido, nome: "a".repeat(U.LIMITES.nome) }).valido, true);
  assert.ok(U.validarFormulario({ ...valido, nome: "a".repeat(U.LIMITES.nome + 1) }).erros.nome);
  assert.ok(U.validarFormulario({ ...valido, assunto: "a".repeat(U.LIMITES.assunto + 1) }).erros.assunto);
  assert.ok(U.validarFormulario({ ...valido, mensagem: "a".repeat(U.LIMITES.mensagemMin - 1) }).erros.mensagem);
  assert.equal(U.validarFormulario({ ...valido, mensagem: "a".repeat(U.LIMITES.mensagemMin) }).valido, true);
  assert.equal(U.validarFormulario({ ...valido, mensagem: "a".repeat(U.LIMITES.mensagemMax) }).valido, true);
  assert.ok(U.validarFormulario({ ...valido, mensagem: "a".repeat(U.LIMITES.mensagemMax + 1) }).erros.mensagem);
});

test("emailValido aceita endereços comuns e rejeita formatos inválidos", () => {
  ["a@b.co", "maria.silva+vendas@exemplo.com.br", "x_y@sub.dominio.org"].forEach((e) =>
    assert.equal(U.emailValido(e), true, e)
  );
  ["", "maria", "maria@", "@exemplo.com", "maria@exemplo", "maria@exemplo.c", "maria@@exemplo.com",
    "ma ria@exemplo.com", "maria@exemplo..com", "maria@.com", "maria@exemplo.com.", "a@b.com ".trim() + "\n"].forEach((e) =>
    assert.equal(U.emailValido(e), false, JSON.stringify(e))
  );
  assert.equal(U.emailValido(null), false);
  assert.equal(U.emailValido("a".repeat(250) + "@b.com"), false);
});

test("validarUrlWebhook valida a configuração", () => {
  assert.equal(U.validarUrlWebhook("http://localhost:5678/webhook/ai-lead-assistant").valido, true);
  assert.equal(U.validarUrlWebhook("https://n8n.exemplo.com/webhook/x").valido, true);
  assert.equal(U.validarUrlWebhook("").valido, false);
  assert.equal(U.validarUrlWebhook(undefined).valido, false);
  assert.equal(U.validarUrlWebhook("não é url").valido, false);
  assert.equal(U.validarUrlWebhook("ftp://exemplo.com/x").valido, false);
});

const sucesso = {
  sucesso: true,
  dados: {
    categoria: "Orçamento",
    resumo: "O contato deseja um orçamento.",
    prioridade: "Média",
    resposta_sugerida: "Olá! Obrigado pelo contato."
  }
};

test("interpretarRespostaWebhook aceita o formato de sucesso", () => {
  const r = U.interpretarRespostaWebhook(sucesso);
  assert.equal(r.ok, true);
  assert.deepEqual(r.dados, sucesso.dados);
});

test("interpretarRespostaWebhook normaliza acentos e maiúsculas de categoria e prioridade", () => {
  const r = U.interpretarRespostaWebhook({ sucesso: true, dados: { ...sucesso.dados, categoria: "duvida", prioridade: "MEDIA" } });
  assert.equal(r.ok, true);
  assert.equal(r.dados.categoria, "Dúvida");
  assert.equal(r.dados.prioridade, "Média");
});

test("interpretarRespostaWebhook repassa a mensagem de erro enviada pelo servidor", () => {
  const r = U.interpretarRespostaWebhook({ sucesso: false, codigo: "LIMITE_EXCEDIDO", erro: "Muitas solicitações." });
  assert.equal(r.ok, false);
  assert.equal(r.codigo, "LIMITE_EXCEDIDO");
  assert.equal(r.erro, "Muitas solicitações.");
});

test("interpretarRespostaWebhook usa mensagem padrão quando o erro vem sem texto", () => {
  const r = U.interpretarRespostaWebhook({ sucesso: false });
  assert.equal(r.ok, false);
  assert.ok(r.erro.length > 0);
});

test("interpretarRespostaWebhook rejeita respostas fora do formato esperado", () => {
  const invalidas = [
    null, undefined, "texto", 42, [], {},
    { sucesso: true },
    { sucesso: true, dados: null },
    { sucesso: "true", dados: sucesso.dados },
    { sucesso: true, dados: { ...sucesso.dados, categoria: "Reclamação" } },
    { sucesso: true, dados: { ...sucesso.dados, prioridade: "Urgentíssima" } },
    { sucesso: true, dados: { ...sucesso.dados, resumo: "   " } },
    { sucesso: true, dados: { ...sucesso.dados, resposta_sugerida: 123 } },
    { code: 404, message: "The requested webhook is not registered." }
  ];
  invalidas.forEach((corpo) => {
    const r = U.interpretarRespostaWebhook(corpo);
    assert.equal(r.ok, false, JSON.stringify(corpo));
    assert.equal(r.erro, U.MSG_RESPOSTA_INVALIDA);
  });
});

test("mensagemPorStatus devolve texto útil para os principais códigos HTTP", () => {
  assert.match(U.mensagemPorStatus(404), /Webhook não encontrado/);
  assert.match(U.mensagemPorStatus(429), /Aguarde/);
  assert.match(U.mensagemPorStatus(500), /HTTP 500/);
  assert.match(U.mensagemPorStatus(418), /HTTP 418/);
});
