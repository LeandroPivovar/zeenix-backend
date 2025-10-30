# API de Usuários - NestJS com Clean Architecture

Este projeto implementa uma API REST para gerenciamento de usuários usando NestJS, TypeORM, MySQL e seguindo os princípios da Clean Architecture.

## 🏗️ Estrutura do Projeto

```
src/
├── domain/                    # Camada de Domínio
│   ├── entities/             # Entidades de negócio
│   └── repositories/         # Interfaces dos repositórios
├── application/              # Camada de Aplicação
│   ├── use-cases/           # Casos de uso
│   └── dto/                 # DTOs da aplicação
├── infrastructure/          # Camada de Infraestrutura
│   └── database/
│       ├── entities/        # Entidades TypeORM
│       └── repositories/    # Implementações dos repositórios
└── presentation/            # Camada de Apresentação
    ├── controllers/         # Controllers REST
    └── dto/                 # DTOs de request/response
```

## 🚀 Configuração

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar banco de dados
Edite o arquivo `.env` com suas configurações do MySQL:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=root
DB_PASSWORD=sua_senha_aqui
DB_DATABASE=testes_db
PORT=3000
NODE_ENV=development
```

### 3. Criar o banco de dados
```sql
CREATE DATABASE testes_db;
```

### 4. Executar a aplicação
```bash
npm run start:dev
```

## 📚 Endpoints da API

### Usuários

#### Criar usuário
```http
POST /users
Content-Type: application/json

{
  "name": "João Silva",
  "email": "joao@email.com",
  "password": "123456"
}
```

#### Listar todos os usuários
```http
GET /users
```

#### Buscar usuário por ID
```http
GET /users/{id}
```

#### Atualizar usuário
```http
PUT /users/{id}
Content-Type: application/json

{
  "name": "João Santos",
  "email": "joao.santos@email.com"
}
```

#### Deletar usuário
```http
DELETE /users/{id}
```

## 🧪 Testando a API

Você pode usar o Postman, Insomnia ou curl para testar os endpoints:

```bash
# Criar usuário
curl -X POST http://localhost:3000/users \
  -H "Content-Type: application/json" \
  -d '{"name":"João Silva","email":"joao@email.com","password":"123456"}'

# Listar usuários
curl http://localhost:3000/users

# Buscar usuário por ID
curl http://localhost:3000/users/{id}

# Atualizar usuário
curl -X PUT http://localhost:3000/users/{id} \
  -H "Content-Type: application/json" \
  -d '{"name":"João Santos"}'

# Deletar usuário
curl -X DELETE http://localhost:3000/users/{id}
```

## 🏛️ Clean Architecture

Este projeto segue os princípios da Clean Architecture:

- **Domain**: Contém as regras de negócio puras
- **Application**: Contém os casos de uso e interfaces
- **Infrastructure**: Implementa as interfaces usando tecnologias específicas
- **Presentation**: Interface com o mundo externo (controllers, DTOs)

### Benefícios:
- ✅ Testabilidade
- ✅ Independência de frameworks
- ✅ Flexibilidade para mudanças
- ✅ Separação clara de responsabilidades
- ✅ Facilita manutenção e evolução

## 🔧 Scripts Disponíveis

```bash
npm run start          # Executar em produção
npm run start:dev      # Executar em desenvolvimento com hot reload
npm run start:debug    # Executar em modo debug
npm run build          # Compilar o projeto
npm run test           # Executar testes
npm run test:e2e       # Executar testes end-to-end
npm run lint           # Executar linter
npm run format         # Formatar código
```

## 📝 Próximos Passos

- [ ] Implementar hash de senhas com bcrypt
- [ ] Adicionar autenticação JWT
- [ ] Implementar testes unitários e de integração
- [ ] Adicionar validações mais robustas
- [ ] Implementar paginação na listagem de usuários
- [ ] Adicionar logs estruturados
- [ ] Implementar rate limiting