#!/bin/bash

# ============================================
# Script para executar migração de UUID
# ============================================

echo "=========================================="
echo "Migração Copy Trading - UUID Support"
echo "=========================================="
echo ""

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Diretório do script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MIGRATION_FILE="$SCRIPT_DIR/migrate_copy_trading_uuid.sql"

# Verificar se o arquivo de migração existe
if [ ! -f "$MIGRATION_FILE" ]; then
    echo -e "${RED}❌ Erro: Arquivo de migração não encontrado!${NC}"
    echo "   Esperado: $MIGRATION_FILE"
    exit 1
fi

echo -e "${YELLOW}⚠️  ATENÇÃO: Esta migração irá alterar a estrutura das tabelas:${NC}"
echo "   - copy_trading_config"
echo "   - copy_trading_sessions"
echo "   - copy_trading_operations"
echo ""
echo "   Campo 'user_id' será alterado de INT para VARCHAR(36)"
echo ""

# Pedir confirmação
read -p "Deseja continuar? (s/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    echo -e "${YELLOW}Migração cancelada.${NC}"
    exit 0
fi

# Pedir credenciais do MySQL
echo ""
echo -e "${YELLOW}Informe as credenciais do MySQL:${NC}"
read -p "Usuário [root]: " DB_USER
DB_USER=${DB_USER:-root}

read -p "Nome do banco [zeenix]: " DB_NAME
DB_NAME=${DB_NAME:-zeenix}

echo ""
echo -e "${GREEN}🔄 Executando migração...${NC}"
echo ""

# Executar migração
mysql -u "$DB_USER" -p "$DB_NAME" < "$MIGRATION_FILE"

# Verificar resultado
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Migração executada com sucesso!${NC}"
    echo ""
    echo -e "${YELLOW}📋 Próximos passos:${NC}"
    echo "   1. Reiniciar o backend: pm2 restart zeenix"
    echo "   2. Verificar logs: pm2 logs zeenix --lines 50"
    echo "   3. Testar funcionalidade de Copy Trading"
    echo ""
else
    echo ""
    echo -e "${RED}❌ Erro ao executar migração!${NC}"
    echo "   Verifique os logs acima para mais detalhes."
    echo ""
    exit 1
fi







