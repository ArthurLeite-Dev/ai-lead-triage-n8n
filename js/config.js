// Arquivo público: nunca coloque chaves ou tokens aqui.
window.APP_CONFIG = Object.freeze({
  // URL do webhook do n8n (use /webhook-test/... só no modo de teste do editor)
  WEBHOOK_URL: "http://localhost:5678/webhook/ai-lead-assistant",

  // Tempo máximo de espera, em ms
  REQUEST_TIMEOUT_MS: 60000
});
