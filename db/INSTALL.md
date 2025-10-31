# Guia de Instalação do Banco de Dados - Zenix

## 📋 Pré-requisitos

- MySQL 5.7+ ou MariaDB 10.3+
- Acesso de administrador ao servidor MySQL
- Credenciais de acesso ao banco de dados

## 🚀 Instalação Rápida (Recomendado)

### Passo 1: Executar o Script Unificado

```bash
mysql -u root -p < backend/db/setup_database.sql
```

O script irá:
- ✅ Criar o banco de dados `zeenix`
- ✅ Criar todas as tabelas necessárias
- ✅ Adicionar colunas de plano aos usuários
- ✅ Popular dados iniciais (planos, cursos, FAQs, etc.)

### Passo 2: Verificar Instalação

```bash
mysql -u root -p -e "USE zeenix; SHOW TABLES;"
```

Você deve ver as seguintes tabelas:
- `users`
- `plans`
- `user_settings`
- `user_activity_logs`
- `user_sessions`
- `courses`
- `modules`
- `lessons`
- `user_lesson_progress`
- `faqs`
- `system_status`

## 🔄 Reinstalação (Reset Completo)

Se você precisar resetar o banco de dados completamente:

```bash
mysql -u root -p -e "DROP DATABASE IF EXISTS zeenix;"
mysql -u root -p < backend/db/setup_database.sql
```

## ⚠️ Solução de Problemas

### Erro: "Column 'plan_id' already exists"
**Causa:** Você já executou o script anteriormente ou a coluna já existe.

**Solução:** Pode ignorar este erro com segurança. As colunas já estão criadas.

### Erro: "Table 'plans' already exists"
**Causa:** As tabelas já foram criadas anteriormente.

**Solução:** 
1. Use `INSERT IGNORE` que já está no script (seguro)
2. Ou execute: `DROP DATABASE zeenix;` e execute o script novamente

### Erro: "Access denied"
**Causa:** Usuário sem permissões suficientes.

**Solução:** 
```sql
GRANT ALL PRIVILEGES ON zeenix.* TO 'seu_usuario'@'localhost';
FLUSH PRIVILEGES;
```

## 📊 Estrutura de Dados Iniciais

Após a instalação, o banco conterá:

### Planos
- **Starter** (Gratuito)
- **Pro** (R$ 67/mês) - Mais Popular
- **Zenix Black** (R$ 147/mês) - Recomendado

### Cursos
- Fundamentos do Copy Trading
- IA Zenix e Automação de Operações
- Estratégias Avançadas de Mercado
- Psicologia do Trader

### FAQs
- 8 perguntas frequentes pré-configuradas

### Status do Sistema
- 4 serviços monitorados (Sistema Principal, API Deriv, IA Zenix, Copy Trading)

## 🔐 Configuração do Backend

Após instalar o banco, configure o arquivo `.env` no backend:

```env
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=seu_usuario
DB_PASSWORD=sua_senha
DB_DATABASE=zeenix

JWT_SECRET=seu_jwt_secret_aqui
JWT_EXPIRES_IN=1d
```

## ✅ Verificação Final

Teste a conexão:

```bash
# No diretório do backend
npm run start:dev
```

Se tudo estiver correto, você verá:
```
[Nest] Application successfully started
```

## 📚 Próximos Passos

1. ✅ Banco de dados instalado
2. ⏭️ Configure o `.env` do backend
3. ⏭️ Inicie o servidor backend
4. ⏭️ Inicie o servidor frontend
5. ⏭️ Crie seu primeiro usuário via registro

---

**Dúvidas?** Consulte o arquivo `README.md` neste diretório para mais informações.

