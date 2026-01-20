# Configuração Nginx para Upload de Vídeos Grandes

## Problema

Erro 413 "Content Too Large" ao fazer upload de vídeos. Isso geralmente ocorre porque o Nginx tem um limite padrão de `client_max_body_size` de apenas 1MB.

## Solução

Você precisa aumentar o limite de tamanho do corpo da requisição no Nginx. Adicione ou modifique a seguinte diretiva no arquivo de configuração do Nginx:

### Opção 1: Configuração Global (recomendado)

No arquivo `/etc/nginx/nginx.conf`, dentro do bloco `http { ... }`:

```nginx
http {
    # ... outras configurações ...
    
    # Aumentar limite para uploads de vídeo (2GB)
    client_max_body_size 2048M;
    
    # Tempo limite para uploads grandes (opcional)
    client_body_timeout 300s;
    proxy_read_timeout 300s;
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;
    
    # ... resto das configurações ...
}
```

### Opção 2: Configuração por Site

No arquivo de configuração do seu site (geralmente em `/etc/nginx/sites-available/iazenix.com` ou similar):

```nginx
server {
    listen 80;
    listen [::]:80;
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    
    server_name iazenix.com;
    
    # Limite para uploads de vídeo (2GB)
    client_max_body_size 2048M;
    
    # Timeouts para uploads grandes
    client_body_timeout 300s;
    proxy_read_timeout 300s;
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;
    
    # Servir arquivos de upload diretamente (ANTES do proxy /api)
    # Isso é mais eficiente e evita 404 para imagens/vídeos
    location /api/uploads {
        alias /var/www/zeenix/backend/uploads;
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
        
        # Permitir acesso a arquivos estáticos
        try_files $uri =404;
    }
    
    # Proxy para aplicação NestJS
    location /api {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeouts específicos para o proxy
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
        proxy_send_timeout 300s;
    }
    
    # ... outras configurações ...
}
```

### Opção 3: Apenas para Rota de Upload

Se você quiser aplicar apenas para a rota de upload de vídeo:

```nginx
location /api/courses/lessons/upload/video {
    client_max_body_size 2048M;
    client_body_timeout 300s;
    
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    proxy_read_timeout 300s;
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;
}
```

## Após Configurar

1. **Teste a configuração do Nginx:**
   ```bash
   sudo nginx -t
   ```

2. **Recarregue o Nginx:**
   ```bash
   sudo systemctl reload nginx
   # ou
   sudo service nginx reload
   ```

3. **Verifique se a aplicação NestJS também está configurada:**
   - O arquivo `main.ts` já foi atualizado para suportar uploads até 2GB
   - O Multer já está configurado para aceitar até 1GB por arquivo em `courses.controller.ts`

## Notas Importantes

- **Segurança:** Permitir uploads de 2GB pode ser um risco de segurança. Considere:
  - Implementar autenticação/autorização forte
  - Validar tipos de arquivo no backend
  - Limitar tamanho por tipo de conteúdo
  - Monitorar uso de disco

- **Performance:** Uploads grandes podem:
  - Consumir muita memória/CPU
  - Bloquear workers do Nginx
  - Consumir banda larga

- **Alternativas:** Para vídeos muito grandes, considere:
  - Upload direto para S3/Cloud Storage
  - Usar chunked upload
  - Processar vídeos de forma assíncrona

## Verificação

Após configurar, teste o upload com um arquivo de vídeo. O erro 413 não deve mais aparecer.

## Servir Arquivos de Upload Estáticos

Para evitar erros 404 ao acessar imagens e vídeos enviados, configure o Nginx para servir os arquivos de upload diretamente ANTES do proxy `/api`:

```nginx
# Servir arquivos de upload diretamente (ANTES do proxy /api)
# Isso é mais eficiente e evita 404 para imagens/vídeos
location /api/uploads {
    alias /var/www/zeenix/backend/uploads;
    expires 30d;
    add_header Cache-Control "public, immutable";
    access_log off;
    
    # Permitir acesso a arquivos estáticos
    try_files $uri =404;
}
```

**Importante:** 
- Ajuste o caminho `alias /var/www/zeenix/backend/uploads;` para o caminho correto onde os uploads estão armazenados no servidor
- Esta configuração deve vir ANTES do `location /api` no nginx
- O caminho no alias deve apontar para o diretório `uploads` do backend

## Limites Configurados

- **Nginx:** 2GB (2048M) - precisa ser configurado manualmente
- **NestJS body parser:** 2GB - já configurado em `main.ts`
- **Multer (upload de vídeo):** 1GB - já configurado em `courses.controller.ts`

