# Fix: Sessões fantasma do classificador poluindo /sessions e claude --resume

## Problema

O bot clink usa um classificador de intenção (`classifyIntent` em `src/bot.ts`) que roda `claude -p` antes de cada mensagem real do usuario. Embora `-p` (print mode) seja stateless, o Claude CLI **ainda cria arquivos .jsonl** no diretorio de sessoes do projeto (`~/.claude/projects/<path>/`).

Isso gera sessoes fantasma com titulo "Classify this message. Reply with a single word: CHAT, ACTION,..." que aparecem tanto no `/sessions` do Telegram quanto no `claude --resume` interativo, tornando a lista ilegivel e confusa.

### Evidencia

- 5 de 9 sessoes no projeto clink continham texto do classificador
- 61 de 387 sessoes no projeto observer-sessions
- 23 de 85 sessoes no diretorio home

## Causa raiz

O Claude CLI, mesmo em modo `-p` (print), persiste a sessao em disco como `.jsonl`. O classificador nao usava nenhuma flag para desabilitar essa persistencia.

## Solucao

Adicionar `--no-session-persistence` ao spawn do classificador Claude em `src/bot.ts`:

```typescript
proc = spawn("claude", [
  "-p", "--model", "haiku",
  "--dangerously-skip-permissions",
  "--no-session-persistence",  // <-- impede criacao de .jsonl fantasma
  classifyPrompt,
], { ... });
```

A flag `--no-session-persistence` e suportada pelo Claude CLI e funciona com `--print`, impedindo que sessoes sejam salvas em disco.

## Arquivos modificados

- `src/bot.ts` — adicionado `--no-session-persistence` ao classificador (dentro de `classifyIntent`)
- `todo.md` — atualizado item de `/sessions` para refletir a correcao

## Verificacao

1. `npm run build` — compila sem erros
2. Iniciar o gateway e enviar mensagem pelo Telegram
3. Verificar que nao e criado novo .jsonl com "Classify" apos processamento
4. `/sessions` e `claude --resume` mostram apenas sessoes reais
5. (Opcional) Limpar sessoes fantasma existentes manualmente
