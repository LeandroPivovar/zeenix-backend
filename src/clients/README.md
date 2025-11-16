# Módulo de Clientes - API

Este módulo fornece endpoints para gerenciar e visualizar informações dos clientes da plataforma Zeenix.

## Endpoints

### 1. GET /clients/metrics
Retorna métricas agregadas dos clientes.

**Autenticação:** Requerida (JWT)

**Resposta:**
```json
{
  "total": 453,
  "realAccountUsed": 367,
  "newToday": 12,
  "newThisWeek": 45,
  "newThisMonth": 112,
  "activeThisWeek": 210,
  "activeThisMonth": 350,
  "balanceLess100": 89,
  "balanceMore500": 156,
  "balanceMore1000": 78,
  "balanceMore5000": 23
}
```

**Métricas:**
- `total`: Total de usuários cadastrados
- `realAccountUsed`: Usuários com conta Deriv conectada
- `newToday`: Novos usuários cadastrados hoje
- `newThisWeek`: Novos usuários cadastrados nesta semana
- `newThisMonth`: Novos usuários cadastrados neste mês
- `activeThisWeek`: Usuários ativos nesta semana (com sessão ativa)
- `activeThisMonth`: Usuários ativos neste mês
- `balanceLess100`: Usuários com saldo < $100
- `balanceMore500`: Usuários com saldo > $500
- `balanceMore1000`: Usuários com saldo > $1000
- `balanceMore5000`: Usuários com saldo > $5000

### 2. GET /clients/list
Retorna lista de clientes com filtros opcionais.

**Autenticação:** Requerida (JWT)

**Query Parameters:**
- `search` (opcional): Busca por nome, email ou ID de login
- `balanceFilter` (opcional): Filtra por faixa de saldo
  - `less100`: Saldo < $100
  - `more500`: Saldo > $500
  - `more1000`: Saldo > $1000
  - `more5000`: Saldo > $5000

**Exemplo de requisição:**
```
GET /clients/list?search=john&balanceFilter=more1000
```

**Resposta:**
```json
{
  "clients": [
    {
      "userId": "uuid",
      "name": "João Silva",
      "loginId": "CR123456",
      "email": "joao.silva@example.com",
      "balance": 1250.75,
      "timeSpent": "12h 45m",
      "createdAt": "2025-09-15",
      "lastActivity": "2025-10-18",
      "whatsapp": false
    }
  ],
  "total": 1
}
```

### 3. GET /clients/export
Exporta lista completa de clientes em formato JSON.

**Autenticação:** Requerida (JWT)

**Resposta:** Array de objetos ClientDto

## Estrutura do Código

### DTOs
- `ClientMetricsDto`: Métricas agregadas dos clientes
- `ClientDto`: Informações detalhadas de um cliente
- `ClientListResponseDto`: Resposta da listagem de clientes

### Service (ClientsService)
Contém a lógica de negócio:
- `getMetrics()`: Calcula métricas agregadas
- `getClients()`: Busca e filtra clientes
- `exportClients()`: Exporta lista completa

### Controller (ClientsController)
Define os endpoints da API e faz a integração com o service.

## Integração Frontend

O frontend faz chamadas aos endpoints usando `fetch`:

```javascript
// Buscar métricas
const response = await fetch(`${apiBaseUrl}/clients/metrics`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// Buscar clientes
const response = await fetch(`${apiBaseUrl}/clients/list?search=term`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// Exportar clientes
const response = await fetch(`${apiBaseUrl}/clients/export`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

## Dependências

- TypeORM: ORM para acesso ao banco de dados
- NestJS: Framework backend
- JWT: Autenticação

## Entidades Relacionadas

- `UserEntity`: Informações dos usuários
- `UserSessionEntity`: Sessões dos usuários para calcular tempo gasto e última atividade

