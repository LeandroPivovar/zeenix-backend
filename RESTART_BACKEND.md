# 🚨 Backend com 502 Bad Gateway

## 🔴 Problema
```
❌ GET https://taxafacil.site/api/plans 502 (Bad Gateway)
```

O backend não está respondendo. Provavelmente não reiniciou corretamente após as mudanças.

---

## ✅ Solução Rápida

### **1️⃣ Parar o Backend**
```bash
cd /var/www/zeenix/backend
pm2 stop zeenix
```

### **2️⃣ Verificar Erros de Compilação**
```bash
npm run build
```

**Se houver erros, corrija antes de continuar!**

### **3️⃣ Reiniciar o Backend**
```bash
pm2 start zeenix
# OU
pm2 restart zeenix
```

### **4️⃣ Verificar Logs**
```bash
pm2 logs zeenix --lines 50
```

**Deve mostrar:**
```
✅ [NestApplication] Nest application successfully started
✅ Application is running on: http://localhost:3000
```

### **5️⃣ Testar API**
```bash
curl http://localhost:3000/plans
```

**Deve retornar os planos!**

---

## 🔍 Se o Backend Não Iniciar

### **Verificar Erros:**
```bash
pm2 logs zeenix --err --lines 100
```

### **Erros Comuns:**

#### **1. Erro de TypeScript**
```
src/plans/plans.service.ts:XX - error TSXXXX
```

**Solução:** Corrigir o código TypeScript

#### **2. Erro de Conexão MySQL**
```
Error: connect ECONNREFUSED
```

**Solução:** Verificar se MySQL está rodando:
```bash
systemctl status mysql
```

#### **3. Porta 3000 em Uso**
```
Error: listen EADDRINUSE: address already in use :::3000
```

**Solução:**
```bash
pm2 delete zeenix
pm2 start ecosystem.config.js
```

---

## 📋 **Sobre os Benefícios (Features)**

### ✅ **Os Inputs JÁ EXISTEM!**

No formulário de PlansManagement (linhas 66-85):

```vue
<div class="form-group" style="flex: 1 1 100%;">
    <label>Benefícios do Plano</label>
    <div class="benefits-list">
        <div v-for="(benefit, index) in planForm.benefits" :key="index" class="benefit-item">
            <input 
                type="text" 
                v-model="planForm.benefits[index]" 
                :placeholder="`Benefício ${index + 1}`"
                class="benefit-input"
            >
            <button type="button" @click="removeBenefit(index)" class="remove-benefit-btn">
                <i class="fas fa-times"></i>
            </button>
        </div>
        <button type="button" @click="addBenefit" class="add-benefit-btn">
            <i class="fas fa-plus"></i> Adicionar Benefício
        </button>
    </div>
</div>
```

### ✅ **Salvamento Funcional**

O código já salva corretamente (linha 388-390):
```javascript
const features = {
    benefits: benefits,  // Array de benefícios
};

const payload = {
    ...
    features: features,  // Salvo no banco como JSON
    ...
};
```

---

## 🎯 **Formato Salvo no Banco**

```json
{
  "features": {
    "benefits": [
      "IA Orion completa",
      "Copy Trading ilimitado",
      "Zenix Academy completa",
      "Suporte prioritário"
    ]
  }
}
```

---

## 🧪 **Como Testar Após Reiniciar Backend**

### **1️⃣ Acessar:**
```
https://taxafacil.site/PlansManagement
```

### **2️⃣ Clicar em:** 
```
+ Adicionar Novo Plano
```

### **3️⃣ Verificar se aparece:**
```
┌────────────────────────────────┐
│ Benefícios do Plano            │
│ ┌──────────────────────┐       │
│ │ Benefício 1          │ [x]   │
│ └──────────────────────┘       │
│ [+ Adicionar Benefício]        │
└────────────────────────────────┘
```

### **4️⃣ Adicionar benefícios:**
- "IA Orion completa"
- "Copy Trading ilimitado"
- "Academy completa"
- etc.

### **5️⃣ Salvar e verificar no banco:**
```bash
mysql -u root -p zeenix -e "SELECT id, name, features FROM plans ORDER BY id DESC LIMIT 1\G"
```

**Deve mostrar:**
```
features: {"benefits": ["IA Orion completa", "Copy Trading ilimitado", ...]}
```

---

## 🎉 Checklist

- [ ] ✅ Parar backend (`pm2 stop zeenix`)
- [ ] ✅ Compilar (`npm run build`)
- [ ] ✅ Iniciar backend (`pm2 start zeenix`)
- [ ] ✅ Verificar logs (sem erros)
- [ ] ✅ Testar API (`curl /plans`)
- [ ] ✅ Acessar PlansManagement
- [ ] ✅ Criar plano com benefícios
- [ ] ✅ Verificar no banco

---

## 💡 **Os inputs já existem! O problema é apenas o backend 502.**

Execute os comandos acima para reiniciar o backend! 🚀

