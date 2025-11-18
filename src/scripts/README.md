# Monitor de Volatilidade 100 - Deriv API

Sistema de monitoramento em tempo real do Volatility 100 Index da Deriv, com exibição no terminal e integração com a interface web.

## 🚀 Como Usar

### 1. Executar o Monitor no Terminal

Para rodar o script de monitoramento standalone no terminal:

```bash
cd backend
npm run monitor:volatility
```

O monitor irá:
- Conectar-se à API da Deriv via WebSocket
- Exibir os últimos 10 preços em tempo real
- Mostrar o preço atual destacado
- Calcular e exibir estatísticas (mínimo, máximo, média, variação)
- Atualizar automaticamente a cada novo tick

### 2. Usar via Interface Web

Para usar o monitoramento integrado na interface web:

1. **Iniciar o backend** (se ainda não estiver rodando):
   ```bash
   cd backend
   npm run start:dev
   ```

2. **Acessar a página de Estatísticas das IAs**:
   - Navegue até `https://taxafacil.site/stats-ias`

3. **Ativar o Monitor**:
   - Clique no botão **"▶ Ativar IA"** na seção "Monitor de Volatilidade 100"
   - O sistema irá se conectar à API e começar a exibir os dados

4. **Visualizar os Dados**:
   - **Preço Atual**: Preço mais recente em destaque
   - **Últimos 10 Preços**: Lista com histórico e variações
   - **Estatísticas**: Mín, Máx, Média e Variação percentual

5. **Desativar**:
   - Clique em **"⏸ Desativar IA"** para parar o monitoramento

## 📡 API Endpoints

### POST /api/ai/start
Inicia o monitoramento do Volatility 100

**Resposta:**
```json
{
  "success": true,
  "message": "Monitoramento iniciado com sucesso",
  "status": {
    "isConnected": true,
    "ticksCount": 0,
    "symbol": "R_100"
  }
}
```

### POST /api/ai/stop
Para o monitoramento

**Resposta:**
```json
{
  "success": true,
  "message": "Monitoramento parado com sucesso"
}
```

### GET /api/ai/ticks
Busca os dados atuais (últimos 10 preços, preço atual e estatísticas)

**Resposta:**
```json
{
  "success": true,
  "data": {
    "ticks": [
      {
        "value": 875.54,
        "epoch": 1763134124,
        "timestamp": "12:28:44"
      }
    ],
    "currentPrice": 875.54,
    "statistics": {
      "min": 868.77,
      "max": 878.24,
      "avg": 873.45,
      "current": 875.54,
      "change": 0.78
    },
    "status": {
      "isConnected": true,
      "ticksCount": 10,
      "symbol": "R_100"
    }
  }
}
```

### GET /api/ai/status
Verifica o status da conexão

**Resposta:**
```json
{
  "success": true,
  "data": {
    "isConnected": true,
    "ticksCount": 10,
    "symbol": "R_100",
    "subscriptionId": "fb47ab0a-c455-70e5-4f3c-53c0c348e600"
  }
}
```

### GET /api/ai/current-price
Busca apenas o preço atual

**Resposta:**
```json
{
  "success": true,
  "data": {
    "currentPrice": 875.54,
    "timestamp": "2025-11-14T12:28:44.123Z"
  }
}
```

## 🔧 Configuração

### Variáveis de Ambiente

Adicione ao arquivo `.env` no backend:

```env
DERIV_APP_ID=111346
DERIV_TOKEN=seu_token_aqui  # Opcional, funciona sem autenticação
```

## 📊 Funcionalidades

### Monitor no Terminal
- ✅ Conexão WebSocket em tempo real
- ✅ Exibição dos últimos 10 preços
- ✅ Preço atual destacado
- ✅ Variação entre preços (setas 📈📉)
- ✅ Estatísticas calculadas automaticamente
- ✅ Reconexão automática em caso de queda
- ✅ Interface limpa com atualização em tempo real

### Interface Web
- ✅ Botão de ativar/desativar IA
- ✅ Card com preço atual em destaque
- ✅ Lista dos últimos 10 preços com variações
- ✅ Card de estatísticas (mín, máx, média, variação %)
- ✅ Atualização automática a cada 2 segundos
- ✅ Design moderno e responsivo

## 🛠️ Tecnologias Utilizadas

- **Backend**: Node.js, NestJS, WebSocket (ws)
- **Frontend**: Vue.js 3
- **API**: Deriv WebSocket API v3

## 📝 Notas

- O monitor funciona sem autenticação para leitura de preços públicos
- Se fornecer um token, terá acesso a mais funcionalidades
- O Volatility 100 (R_100) atualiza aproximadamente a cada 2 segundos
- A conexão é mantida ativa enquanto o monitor estiver rodando

## 🐛 Troubleshooting

### "Erro ao conectar com Deriv API"
- Verifique sua conexão com a internet
- Confirme que a porta 443 não está bloqueada

### "Timeout ao conectar"
- A API da Deriv pode estar temporariamente indisponível
- O script tentará reconectar automaticamente

### "Máximo de tentativas de reconexão atingido"
- Reinicie o monitor manualmente
- Verifique se há problemas com o serviço da Deriv

## 📄 Licença

Este projeto é parte do sistema Zeenix.











