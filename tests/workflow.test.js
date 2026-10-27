// Testes do workflow: estrutura, segredos, consistência com o frontend e nós de código.
// Rode com: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const U = require("../js/utils.js");

const RAIZ = path.join(__dirname, "..");
const workflow = JSON.parse(
  fs.readFileSync(path.join(RAIZ, "n8n", "ai-lead-assistant-workflow.json"), "utf8")
);
const no = (nome) => {
  const encontrado = workflow.nodes.find((n) => n.name === nome);
  assert.ok(encontrado, `nó "${nome}" não existe no workflow`);
  return encontrado;
};

// Executa o código de um nó Code com um ambiente mínimo do n8n.
function executar(nomeDoNo, entrada, estado = {}) {
  const funcao = new Function("$input", "$getWorkflowStaticData", no(nomeDoNo).parameters.jsCode);
  const saida = funcao({ first: () => ({ json: entrada }) }, () => estado);
  assert.equal(saida.length, 1);
  return saida[0].json;
}

const webhook = (corpo, ip) => ({ body: corpo, headers: ip ? { "x-forwarded-for": ip } : {} });
const gemini = (texto) => ({ candidates: [{ content: { parts: [{ text: texto }] }, finishReason: "STOP" }] });

const contatoValido = {
  nome: "Maria Exemplo",
  email: "maria@exemplo.com",
  assunto: "Orçamento",
  mensagem: "Gostaria de receber um orçamento para um site institucional."
};
const respostaIa = {
  categoria: "Orçamento",
  resumo: "O contato deseja um orçamento.",
  prioridade: "Média",
  resposta_sugerida: "Olá! Obrigado pelo contato."
};

/* Estrutura */

test("o workflow tem os nós esperados e todas as conexões apontam para nós existentes", () => {
  const nomes = workflow.nodes.map((n) => n.name);
  [
    "Webhook", "Validar e Limitar Uso", "Dados válidos?", "Preparar Prompt", "Chamar Gemini",
    "Interpretar Resposta da IA", "Resposta da IA válida?", "Responder Sucesso",
    "Responder Erro da IA", "Responder Erro de Entrada"
  ].forEach((n) => assert.ok(nomes.includes(n), `falta o nó ${n}`));
  assert.equal(new Set(nomes).size, nomes.length, "nomes de nós duplicados");

  for (const [origem, saidas] of Object.entries(workflow.connections)) {
    assert.ok(nomes.includes(origem), `conexão parte de nó inexistente: ${origem}`);
    for (const grupo of saidas.main) {
      for (const destino of grupo) assert.ok(nomes.includes(destino.node), `conexão para nó inexistente: ${destino.node}`);
    }
  }
});

test("o webhook aceita POST e responde por um nó Respond to Webhook", () => {
  const w = no("Webhook").parameters;
  assert.equal(w.httpMethod, "POST");
  assert.equal(w.responseMode, "responseNode");
});

test("a URL do frontend aponta para o path do webhook do workflow", () => {
  const contexto = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(RAIZ, "js", "config.js"), "utf8"), contexto);
  const url = new URL(contexto.window.APP_CONFIG.WEBHOOK_URL);
  assert.ok(url.pathname.endsWith(`/webhook/${no("Webhook").parameters.path}`), url.pathname);
});

test("os arquivos referenciados no index.html existem", () => {
  const html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
  const caminhos = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map((m) => m[1]).filter((c) => !/^https?:/.test(c));
  assert.ok(caminhos.length >= 4);
  caminhos.forEach((c) => assert.ok(fs.existsSync(path.join(RAIZ, c)), `arquivo ausente: ${c}`));
});

/* Segredos */

test("nenhuma chave de API está escrita no workflow nem no código do projeto", () => {
  const arquivos = [];
  (function listar(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) listar(p);
      else if (/\.(js|json|html|css|md|example|txt)$/.test(e.name) || e.name === ".env.example") arquivos.push(p);
    }
  })(RAIZ);
  assert.ok(arquivos.length > 5);
  arquivos.forEach((arquivo) => {
    const conteudo = fs.readFileSync(arquivo, "utf8");
    assert.doesNotMatch(conteudo, /AIza[0-9A-Za-z_-]{30,}/, `possível chave do Google em ${arquivo}`);
    assert.doesNotMatch(conteudo, /sk-[A-Za-z0-9]{20,}/, `possível chave de API em ${arquivo}`);
  });
});

test("a chamada ao Gemini usa credencial do n8n (Header Auth) e não leva a chave na URL", () => {
  const http = no("Chamar Gemini");
  assert.equal(http.parameters.authentication, "genericCredentialType");
  assert.equal(http.parameters.genericAuthType, "httpHeaderAuth");
  assert.ok(http.credentials.httpHeaderAuth);
  assert.doesNotMatch(http.parameters.url, /[?&]key=/);
  assert.equal(http.parameters.sendHeaders, undefined, "cabeçalhos manuais poderiam expor a chave");
});

/* Validação: n8n × frontend */

const casos = [
  ["válido", contatoValido],
  ["campos vazios", { nome: "", email: "", assunto: "", mensagem: "" }],
  ["corpo vazio", {}],
  ["e-mail sem domínio", { ...contatoValido, email: "maria@" }],
  ["e-mail com ponto duplo", { ...contatoValido, email: "maria@exemplo..com" }],
  ["e-mail com espaço", { ...contatoValido, email: "ma ria@exemplo.com" }],
  ["e-mail válido com subdomínio", { ...contatoValido, email: "a.b+c@sub.exemplo.com.br" }],
  ["nome não é texto", { ...contatoValido, nome: 123 }],
  ["mensagem é lista", { ...contatoValido, mensagem: ["a", "b"] }],
  ["mensagem curta", { ...contatoValido, mensagem: "oi" }],
  ["mensagem no limite", { ...contatoValido, mensagem: "a".repeat(U.LIMITES.mensagemMax) }],
  ["mensagem acima do limite", { ...contatoValido, mensagem: "a".repeat(U.LIMITES.mensagemMax + 1) }],
  ["nome acima do limite", { ...contatoValido, nome: "a".repeat(U.LIMITES.nome + 1) }],
  ["assunto acima do limite", { ...contatoValido, assunto: "a".repeat(U.LIMITES.assunto + 1) }],
  ["só espaços", { nome: "  ", email: " ", assunto: "\n", mensagem: "\t\t" }]
];

for (const [descricao, corpo] of casos) {
  test(`frontend e n8n concordam sobre a validade: ${descricao}`, () => {
    const front = U.validarFormulario(corpo);
    const back = executar("Validar e Limitar Uso", webhook(corpo, "192.0.2.1"));
    assert.equal(back.valido, front.valido);
    if (back.valido) assert.deepEqual(back.contato, front.dadosLimpos);
    else {
      assert.equal(back.status, 400);
      assert.equal(back.resposta.codigo, "VALIDACAO");
      assert.equal(back.resposta.sucesso, false);
    }
  });
}

test("o n8n não quebra quando o corpo do webhook não existe ou não é objeto", () => {
  [{}, { body: null }, { body: "texto" }, { body: [] }, { headers: {} }].forEach((entrada) => {
    const r = executar("Validar e Limitar Uso", entrada);
    assert.equal(r.valido, false);
    assert.equal(r.status, 400);
  });
});

test("os limites e valores permitidos do n8n são iguais aos do frontend", () => {
  const validar = no("Validar e Limitar Uso").parameters.jsCode;
  const limites = new Function("return " + validar.match(/const LIMITES = (\{[^}]*\});/)[1])();
  assert.deepEqual(limites, { ...U.LIMITES });

  const interpretar = no("Interpretar Resposta da IA").parameters.jsCode;
  const categorias = new Function("return " + interpretar.match(/const CATEGORIAS = (\[[^\]]*\]);/)[1])();
  const prioridades = new Function("return " + interpretar.match(/const PRIORIDADES = (\[[^\]]*\]);/)[1])();
  assert.deepEqual(categorias, [...U.CATEGORIAS]);
  assert.deepEqual(prioridades, [...U.PRIORIDADES]);

  const schema = no("Chamar Gemini").parameters.jsonBody;
  categorias.forEach((c) => assert.ok(schema.includes(`'${c}'`), `schema do Gemini sem a categoria ${c}`));
  prioridades.forEach((p) => assert.ok(schema.includes(`'${p}'`), `schema do Gemini sem a prioridade ${p}`));
});

/* Limite de uso */

test("limite de uso: bloqueia o 11º pedido válido do mesmo IP e não afeta outros IPs", () => {
  const estado = {};
  const ip = "198.51.100.5";
  for (let i = 0; i < 10; i += 1) assert.equal(executar("Validar e Limitar Uso", webhook(contatoValido, ip), estado).valido, true);
  const bloqueado = executar("Validar e Limitar Uso", webhook(contatoValido, ip), estado);
  assert.equal(bloqueado.valido, false);
  assert.equal(bloqueado.status, 429);
  assert.equal(bloqueado.resposta.codigo, "LIMITE_EXCEDIDO");
  assert.equal(executar("Validar e Limitar Uso", webhook(contatoValido, "198.51.100.6"), estado).valido, true);
});

test("limite de uso: pedidos inválidos não consomem o limite", () => {
  const estado = {};
  for (let i = 0; i < 30; i += 1) executar("Validar e Limitar Uso", webhook({}, "198.51.100.7"), estado);
  assert.equal(executar("Validar e Limitar Uso", webhook(contatoValido, "198.51.100.7"), estado).valido, true);
});

test("limite de uso: o teto global por hora vale mesmo com IPs diferentes", () => {
  const estado = {};
  let bloqueadoEm = null;
  for (let i = 0; i < 400; i += 1) {
    const r = executar("Validar e Limitar Uso", webhook(contatoValido, `10.0.${Math.floor(i / 250)}.${i % 250}`), estado);
    if (!r.valido) { bloqueadoEm = i; break; }
  }
  assert.equal(bloqueadoEm, 300);
});

test("limite de uso: a janela de 1 minuto expira", () => {
  const estado = {};
  const realNow = Date.now;
  try {
    let agora = realNow();
    Date.now = () => agora;
    for (let i = 0; i < 10; i += 1) executar("Validar e Limitar Uso", webhook(contatoValido, "198.51.100.8"), estado);
    assert.equal(executar("Validar e Limitar Uso", webhook(contatoValido, "198.51.100.8"), estado).status, 429);
    agora += 61 * 1000;
    assert.equal(executar("Validar e Limitar Uso", webhook(contatoValido, "198.51.100.8"), estado).valido, true);
  } finally {
    Date.now = realNow;
  }
});

/* Interpretação da resposta da IA */

test("resposta válida da IA vira JSON de sucesso que o frontend aceita", () => {
  const r = executar("Interpretar Resposta da IA", gemini(JSON.stringify(respostaIa)));
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.resposta, { sucesso: true, dados: respostaIa });
  assert.deepEqual(U.interpretarRespostaWebhook(r.resposta), { ok: true, dados: respostaIa });
});

test("JSON dentro de cerca de código ou com texto ao redor é tolerado", () => {
  const cerca = executar("Interpretar Resposta da IA", gemini("```json\n" + JSON.stringify(respostaIa) + "\n```"));
  assert.equal(cerca.ok, true);
  const ao_redor = executar("Interpretar Resposta da IA", gemini("Aqui está: " + JSON.stringify(respostaIa) + " Espero ter ajudado."));
  assert.equal(ao_redor.ok, true);
});

test("categoria e prioridade são normalizadas para os valores permitidos", () => {
  const r = executar("Interpretar Resposta da IA", gemini(JSON.stringify({ ...respostaIa, categoria: "duvida", prioridade: "alta" })));
  assert.equal(r.ok, true);
  assert.equal(r.resposta.dados.categoria, "Dúvida");
  assert.equal(r.resposta.dados.prioridade, "Alta");
});

test("partes de raciocínio (thought) do modelo são ignoradas", () => {
  const entrada = { candidates: [{ content: { parts: [{ thought: true, text: "pensando..." }, { text: JSON.stringify(respostaIa) }] } }] };
  assert.equal(executar("Interpretar Resposta da IA", entrada).ok, true);
});

test("textos muito longos da IA são cortados", () => {
  const r = executar("Interpretar Resposta da IA", gemini(JSON.stringify({ ...respostaIa, resumo: "x".repeat(900), resposta_sugerida: "y".repeat(5000) })));
  assert.equal(r.ok, true);
  assert.ok(r.resposta.dados.resumo.length <= 400);
  assert.ok(r.resposta.dados.resposta_sugerida.length <= 1200);
});

const invalidas = [
  ["texto livre em vez de JSON", gemini("Desculpe, não posso ajudar com isso.")],
  ["JSON truncado", gemini('{"categoria": "Suporte", "resumo": "O contato relata')],
  ["JSON que é lista", gemini("[1, 2, 3]")],
  ["categoria fora da lista", gemini(JSON.stringify({ ...respostaIa, categoria: "Reclamação" }))],
  ["prioridade fora da lista", gemini(JSON.stringify({ ...respostaIa, prioridade: "Crítica" }))],
  ["resumo ausente", gemini(JSON.stringify({ ...respostaIa, resumo: undefined }))],
  ["resposta sugerida vazia", gemini(JSON.stringify({ ...respostaIa, resposta_sugerida: "  " }))],
  ["campos com tipo errado", gemini(JSON.stringify({ ...respostaIa, resumo: 42 }))],
  ["sem candidatos", { candidates: [] }],
  ["sem corpo útil", {}],
  ["candidato sem partes", { candidates: [{ content: {} }] }]
];

for (const [descricao, entrada] of invalidas) {
  test(`resposta inválida da IA vira erro 502 compreensível: ${descricao}`, () => {
    const r = executar("Interpretar Resposta da IA", entrada);
    assert.equal(r.ok, false);
    assert.equal(r.status, 502);
    assert.equal(r.resposta.sucesso, false);
    assert.equal(r.resposta.codigo, "IA_RESPOSTA_INVALIDA");
    assert.ok(r.resposta.erro.length > 10);
    assert.equal(U.interpretarRespostaWebhook(r.resposta).ok, false);
  });
}

test("falha na chamada HTTP à IA vira erro 502 sem vazar detalhes técnicos", () => {
  const r = executar("Interpretar Resposta da IA", { error: { message: "API key not valid: AIza-SEGREDO", httpCode: "400" } });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.equal(r.resposta.codigo, "IA_INDISPONIVEL");
  assert.doesNotMatch(JSON.stringify(r.resposta), /AIza|API key/);
});

test("prompt bloqueado pelo modelo vira erro 422", () => {
  const r1 = executar("Interpretar Resposta da IA", { promptFeedback: { blockReason: "SAFETY" } });
  assert.equal(r1.status, 422);
  assert.equal(r1.resposta.codigo, "IA_BLOQUEADA");
  const r2 = executar("Interpretar Resposta da IA", { candidates: [{ finishReason: "SAFETY" }] });
  assert.equal(r2.status, 422);
});

/* Prompt */

test("o prompt trata o contato como dado não confiável e envia o contato como JSON", () => {
  const campos = Object.fromEntries(no("Preparar Prompt").parameters.assignments.assignments.map((a) => [a.name, a.value]));
  assert.match(campos.instrucaoSistema, /NÃO CONFIÁVEL/);
  assert.match(campos.instrucaoSistema, /SOMENTE com um objeto JSON/);
  assert.match(campos.conteudoUsuario, /JSON\.stringify\(\$json\.contato/);
  assert.match(campos.modelo, /^gemini-/);
});
