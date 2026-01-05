# Como Pausar o Agente Autônomo Temporariamente

Este documento explica como pausar temporariamente a execução do agente autônomo.

## 📋 Método: Flag no Código (Mais Simples)

A forma mais simples de pausar o processamento do agente autônomo é alterando uma flag diretamente no código.

### Passos:

1. **Abra o arquivo `backend/src/autonomous-agent/autonomous-agent.scheduler.ts`**

2. **Localize a linha com `IS_PAUSED` (linha ~13):**
   ```typescript
   private readonly IS_PAUSED = false; // ⬅️ MUDE PARA 'true' PARA PAUSAR
   ```

3. **Altere para `true`:**
   ```typescript
   private readonly IS_PAUSED = true; // ⬅️ AGENTE PAUSADO
   ```

4. **Reinicie o servidor backend:**
   ```bash
   npm run start:dev
   # ou
   npm run build && npm run start:prod
   ```

5. **Verifique os logs:**
   Você verá uma mensagem de aviso nos logs indicando que o processamento está pausado:
   ```
   [AutonomousAgentScheduler] ⚠️ PROCESSAMENTO PAUSADO - Agente autônomo está temporariamente desabilitado
   ```

### Para Reativar:

1. **Altere de volta para `false` no mesmo arquivo:**
   ```typescript
   private readonly IS_PAUSED = false; // ⬅️ AGENTE ATIVO
   ```

2. **Reinicie o servidor backend**

## ⚠️ Importante

- **Agentes já ativos continuarão no banco de dados** - apenas o processamento será pausado
- **Usuários ainda poderão ativar/desativar agentes via interface** - mas eles não serão processados
- **A pausa é apenas no scheduler** - não afeta outras funcionalidades do sistema
- **Reinicie o servidor após alterar a flag** para que a mudança tenha efeito

## 🔍 Verificação

Para verificar se o agente está pausado, verifique os logs do backend. Quando pausado, você verá:
```
[AutonomousAgentScheduler] ⏸️ Processamento pausado (IS_PAUSED=true)
```

Quando ativo, você verá:
```
[AutonomousAgentScheduler] Executando processamento de agentes autônomos
```

## 📝 Notas Técnicas

- A flag é verificada a cada execução do scheduler (a cada 1 minuto)
- O scheduler continua rodando, mas não processa agentes quando pausado
- Esta é uma pausa temporária - ideal para manutenção ou debug
- Para desabilitar permanentemente, considere remover o scheduler ou comentar o método `handleProcessAgents()`
- **Localização da flag:** `backend/src/autonomous-agent/autonomous-agent.scheduler.ts` (linha ~13)

