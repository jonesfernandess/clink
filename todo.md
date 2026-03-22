# Clink — Ideias de Melhoria

## Comandos Telegram

- [ ] `/model` — Trocar modelo ativo (sonnet, opus, haiku, gpt-5.4, etc.) direto pelo Telegram com menu inline de botões
- [ ] `/provider` — Alternar entre Claude e Codex sem editar config
- [ ] `/config` — Exibir/editar configurações do bot (systemPrompt, workingDir, skipPermissions) via Telegram
- [ ] `/usage` — Mostrar estatísticas de uso (mensagens enviadas, tokens consumidos, modelo mais usado)
- [ ] `/lang` — Trocar idioma do bot via Telegram (en/pt/es)

## Bugs / Melhorias

- [x] Sessões fantasma do classificador — O classificador de intenção (`claude -p`) criava arquivos .jsonl no diretório de sessões, poluindo `/sessions` e `claude --resume` com entradas "Classify this message...". **Fix**: adicionado `--no-session-persistence` ao spawn do classificador.
- [ ] `/sessions` — Melhorar preview das sessões no menu inline para exibir informações mais ricas (timestamp relativo, contagem de turnos, preview melhor do contexto).

## Funcionalidades

- [ ] Rotação automática de contas ao atingir rate limit (account rotation — já documentado em DOC-account-rotation.md)
- [ ] Suporte a mensagens de voz — transcrição via Whisper e envio como texto ao modelo
- [ ] Suporte a imagens — enviar fotos pelo Telegram e ter o modelo analisando via vision
- [ ] Fila de mensagens — enfileirar requests quando o modelo estiver ocupado em vez de rejeitar
- [ ] Histórico de conversas persistente — salvar sessões em SQLite para recall entre reinícios

## DevEx

- [ ] Testes de integração end-to-end com Telegram Bot API mockado
- [ ] Dashboard web simples para monitorar status do bot, sessões ativas e logs
- [ ] Docker Compose para deploy com um comando
- [ ] CI/CD com GitHub Actions (lint, test, build, deploy)
- [ ] Hot reload em produção — reiniciar gracefully ao detectar mudanças

## Qualidade

- [ ] Rate limiting por usuário para evitar abuso
- [ ] Logging estruturado (JSON) com níveis configuráveis
- [ ] Métricas Prometheus/OpenTelemetry para observabilidade
- [ ] Retry com exponential backoff em falhas de API
- [ ] Sanitização de input para prevenir prompt injection
