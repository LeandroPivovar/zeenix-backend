# Sistema de Experts - Guia de Instalação e Uso

## 📋 Estrutura do Sistema

O sistema de Experts permite gerenciar especialistas/traders na plataforma com as seguintes funcionalidades:
- Cadastro de experts com informações completas
- Sistema de avaliação e verificação
- Controle de ativo/inativo
- Estatísticas e métricas
- Integração completa backend + frontend

## 🗄️ Banco de Dados

### 1. Criar a Tabela de Experts

Execute o arquivo SQL para criar a tabela:

```bash
# No MySQL/MariaDB
mysql -u seu_usuario -p seu_banco < backend/db/create_experts_table.sql
```

Ou execute diretamente no seu cliente MySQL:

```sql
source backend/db/create_experts_table.sql;
```

### 2. Estrutura da Tabela

A tabela `experts` contém:
- **Identificação**: id, name, email
- **Especialização**: specialty, bio, experience_years
- **Métricas**: rating, total_reviews, total_followers, total_signals, win_rate
- **Status**: is_verified, is_active
- **Extras**: avatar_url, social_links (JSON)
- **Timestamps**: created_at, updated_at

### 3. Dados de Exemplo

O script já insere 5 experts de exemplo para testes:
- Carlos Silva (Forex)
- Ana Rodrigues (Crypto)
- João Martins (Stocks)
- Maria Santos (Options)
- Pedro Costa (Commodities)

## 🔌 API Endpoints

### Listar Todos os Experts
```
GET /experts
```
Resposta:
```json
[
  {
    "id": "uuid",
    "name": "Carlos Silva",
    "email": "carlos.silva@example.com",
    "specialty": "Forex",
    "bio": "Especialista em mercado Forex...",
    "experienceYears": 15,
    "rating": 4.8,
    "totalReviews": 234,
    "totalFollowers": 1520,
    "totalSignals": 450,
    "winRate": 78.50,
    "isVerified": true,
    "isActive": true
  }
]
```

### Buscar Expert por ID
```
GET /experts/:id
```

### Criar Novo Expert (requer autenticação)
```
POST /experts
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "João Silva",
  "email": "joao@example.com",
  "specialty": "Forex",
  "bio": "Especialista em trading...",
  "experienceYears": 10
}
```

### Atualizar Expert (requer autenticação)
```
PUT /experts/:id
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "João Silva Updated",
  "specialty": "Crypto",
  "bio": "Nova descrição...",
  "experienceYears": 12
}
```

### Deletar Expert (requer autenticação)
```
DELETE /experts/:id
Authorization: Bearer {token}
```

### Alternar Status Ativo/Inativo (requer autenticação)
```
PUT /experts/:id/toggle-status
Authorization: Bearer {token}
```

### Alternar Verificação (requer autenticação)
```
PUT /experts/:id/toggle-verified
Authorization: Bearer {token}
```

## 🖥️ Frontend

### Rota
```
http://localhost:8080/Experts
```

### Funcionalidades

1. **Dashboard com Cards**:
   - Experts Ativos
   - Total de Experts
   - Experts Verificados
   - Avaliação Média

2. **Tabela de Experts**:
   - Nome (com badge de verificação)
   - Especialidade
   - Avaliação (com total de reviews)
   - Anos de Experiência
   - Taxa de Acerto (Win Rate)
   - Status (Ativo/Inativo)
   - Ações (Ativar/Desativar, Verificar, Editar, Deletar)

3. **Formulário de Cadastro/Edição**:
   - Nome completo
   - Email
   - Especialidade (dropdown)
   - Anos de experiência
   - Biografia

### Componentes Vue

- **View**: `frontend/ExpertsView.vue`
- **Funcionalidades**:
  - Carregamento automático de dados
  - CRUD completo
  - Loading states
  - Responsivo
  - Integração com backend via API

## 🚀 Como Usar

### 1. Backend

```bash
cd backend

# Instalar dependências (se ainda não instalou)
npm install

# Executar a migration do banco de dados
mysql -u seu_usuario -p seu_banco < db/create_experts_table.sql

# Iniciar o servidor
npm run start:dev
```

### 2. Frontend

```bash
cd frontend

# Instalar dependências (se ainda não instalou)
npm install

# Iniciar o servidor de desenvolvimento
npm run serve
```

### 3. Acessar

- Frontend: http://localhost:8080/Experts
- API: http://localhost:3000/experts

## 🔐 Autenticação

Os endpoints de criação, edição e exclusão requerem autenticação JWT.
O token deve ser enviado no header:

```
Authorization: Bearer {seu_token_jwt}
```

O frontend automaticamente obtém o token do localStorage.

## 📊 Dados de Teste

Após executar o script SQL, você terá 5 experts cadastrados para teste.
Você pode:
- Editar qualquer expert
- Adicionar novos experts
- Alternar status (ativo/inativo)
- Alternar verificação
- Deletar experts

## 🎨 Personalização

### Especialidades

Para adicionar novas especialidades, edite:
1. Frontend: `ExpertsView.vue` (linha ~36-43)
2. Adicione novas opções no select

### Campos Adicionais

Para adicionar campos à tabela:
1. Backend: Altere `expert.entity.ts`
2. Adicione migrations SQL
3. Frontend: Atualize `ExpertsView.vue`

## 🐛 Troubleshooting

### Erro 404 na API
- Verifique se o backend está rodando
- Confirme se ExpertsModule está importado no app.module.ts

### Tabela não existe
- Execute o script SQL de criação da tabela

### Erro de autenticação
- Verifique se você está logado
- Confirme se o token JWT está válido

## 📝 Notas

- A tabela usa UUIDs para IDs
- Todos os timestamps são automáticos
- Emails devem ser únicos
- Rating está entre 0-5
- Win rate está em porcentagem (0-100)

