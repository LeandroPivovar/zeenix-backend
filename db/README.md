# Scripts de Banco de Dados - Zenix

Este diretório contém os scripts SQL para configuração do banco de dados do projeto Zenix.

## 🚀 Setup Rápido

### Opção 1: Script Unificado (Recomendado)
Para criar todo o banco de dados do zero, execute o arquivo unificado:

```bash
mysql -u seu_usuario -p < setup_database.sql
```

Ou usando o MySQL Workbench/phpMyAdmin, importe o arquivo `setup_database.sql`.

**Nota importante:** Se você executar o script em um banco que já possui a tabela `users`, pode aparecer erros sobre colunas já existentes (`plan_id`, `plan_activated_at`). Esses erros podem ser ignorados com segurança, pois significa que as colunas já foram adicionadas anteriormente.

### Opção 2: Scripts Individuais
Se preferir executar scripts separados, siga esta ordem:

1. `create_database.sql` - Cria o banco e tabela de usuários
2. `plans_tables.sql` - Cria tabelas de planos
3. `settings_tables.sql` - Cria tabelas de configurações
4. `reset_and_populate_courses.sql` - Cria e popula tabelas de cursos
5. `support_tables.sql` - Cria tabelas de suporte (FAQs e status)

## 📋 Estrutura do Banco de Dados

### Tabelas Principais

#### `users`
- Armazena informações dos usuários
- Campos: id, name, email, password, plan_id, deriv_* (conexão Deriv)

#### `plans`
- Planos de assinatura disponíveis
- Starter (gratuito), Pro (R$ 67/mês), Zenix Black (R$ 147/mês)

#### `user_settings`
- Configurações pessoais do usuário
- Idioma, fuso horário, notificações, 2FA

#### `user_activity_logs`
- Histórico de ações do usuário
- Logs de alterações e atividades

#### `user_sessions`
- Sessões ativas do usuário
- Controle de login e segurança

#### `courses`, `modules`, `lessons`
- Estrutura da Zenix Academy
- Cursos, módulos e aulas

#### `user_lesson_progress`
- Progresso do usuário nas aulas
- Controle de conclusão

#### `faqs`
- Perguntas frequentes
- Sistema de suporte

#### `system_status`
- Status dos serviços da plataforma
- Monitoramento de operações

## 🔧 Configuração

### Variáveis de Ambiente

Certifique-se de configurar o arquivo `.env` no backend:

```env
DB_TYPE=mysql
DB_HOST=localhost
DB_PORT=3306
DB_USERNAME=seu_usuario
DB_PASSWORD=sua_senha
DB_DATABASE=zeenix
```

### Permissões

O usuário do MySQL precisa ter permissões para:
- CREATE DATABASE
- CREATE TABLE
- INSERT, UPDATE, DELETE, SELECT
- FOREIGN KEY constraints

## 📝 Notas

- Todos os scripts usam `utf8mb4_unicode_ci` para suporte completo a Unicode
- IDs são UUIDs (char(36))
- Timestamps usam `datetime(6)` para precisão de microsegundos
- Foreign keys têm `ON DELETE CASCADE` ou `ON DELETE SET NULL` conforme apropriado
- Usa `INSERT IGNORE` para evitar erros em re-execução

## 🐛 Troubleshooting

### Erro: "Table already exists"
Se você já executou o script antes, pode usar `DROP TABLE IF EXISTS` antes de criar, ou simplesmente ignorar (os `CREATE TABLE IF NOT EXISTS` já fazem isso).

### Erro: "Foreign key constraint fails"
Certifique-se de executar os scripts na ordem correta. O script unificado já faz isso automaticamente.

### Erro: "Unknown column 'plan_id'"
Se você executou `create_database.sql` antes e depois `plans_tables.sql`, o campo já deve existir. Se não, execute novamente o `setup_database.sql` completo.

## 📚 Referências

- [TypeORM Documentation](https://typeorm.io/)
- [MySQL Documentation](https://dev.mysql.com/doc/)

