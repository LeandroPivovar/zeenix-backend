# Instruções para Corrigir o Problema das Colunas Deriv

## Problema
O TypeORM está tentando buscar colunas em snake_case (`deriv_login_id`) mas o banco de dados tem as colunas em camelCase (`derivLoginId`).

## Solução

### 1. Verificar se o código fonte está atualizado
Certifique-se de que o arquivo `src/infrastructure/database/entities/user.entity.ts` tem as seguintes linhas com `name` especificado:

```typescript
@Column({ type: 'varchar', length: 50, nullable: true, name: 'derivLoginId' })
derivLoginId?: string | null;

@Column({ type: 'varchar', length: 10, nullable: true, name: 'derivCurrency' })
derivCurrency?: string | null;

@Column({ type: 'decimal', precision: 36, scale: 18, nullable: true, name: 'derivBalance' })
derivBalance?: string | null;

@Column({ type: 'json', nullable: true, name: 'derivRaw' })
derivRaw?: any | null;

@CreateDateColumn({ name: 'createdAt' })
createdAt: Date;

@UpdateDateColumn({ name: 'updatedAt' })
updatedAt: Date;
```

### 2. Limpar o build anterior e recompilar
```bash
cd /var/www/zeenix/backend
rm -rf dist
npm run build
```

### 3. Verificar o arquivo compilado
Verifique se o arquivo `dist/infrastructure/database/entities/user.entity.js` tem `name: 'derivLoginId'` (e não apenas `nullable: true`):

```bash
grep -A 2 "derivLoginId" dist/infrastructure/database/entities/user.entity.js
```

Deve mostrar algo como:
```javascript
(0, typeorm_1.Column)({ type: 'varchar', length: 50, nullable: true, name: 'derivLoginId' }),
```

### 4. Reiniciar o serviço
```bash
# Se estiver usando PM2:
pm2 restart zeenix-backend

# Se estiver usando systemd:
sudo systemctl restart zeenix-backend

# Ou simplesmente reinicie o processo Node.js
```

### 5. Verificar se funcionou
Após reiniciar, tente fazer login novamente. O erro não deve mais aparecer.

## Verificação do Banco de Dados

Se ainda houver problemas, verifique se as colunas no banco estão realmente em camelCase:

```sql
USE zeenix;
SHOW COLUMNS FROM users LIKE 'deriv%';
```

As colunas devem aparecer como:
- `derivLoginId`
- `derivCurrency`
- `derivBalance`
- `derivRaw`
- `createdAt`
- `updatedAt`

Se aparecerem em snake_case (`deriv_login_id`, etc.), você precisa renomeá-las ou ajustar a entidade para usar os nomes em snake_case.




