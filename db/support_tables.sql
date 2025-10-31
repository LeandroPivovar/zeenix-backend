-- Script para criar tabelas de Suporte
-- FAQs (Perguntas Frequentes) e System Status

-- Criar tabela de FAQs
CREATE TABLE IF NOT EXISTS `faqs` (
  `id` char(36) NOT NULL,
  `question` varchar(500) NOT NULL,
  `answer` text NOT NULL,
  `category` varchar(100) DEFAULT NULL,
  `order_index` int NOT NULL DEFAULT 0,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `idx_category` (`category`),
  KEY `idx_order` (`order_index`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Criar tabela de System Status
CREATE TABLE IF NOT EXISTS `system_status` (
  `id` char(36) NOT NULL,
  `service_name` varchar(255) NOT NULL,
  `status` enum('operational', 'degraded', 'outage', 'maintenance') NOT NULL DEFAULT 'operational',
  `message` text DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_service_name` (`service_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inserir FAQs iniciais
INSERT INTO `faqs` (`id`, `question`, `answer`, `category`, `order_index`) VALUES
('00000000-0000-0000-0000-000000000101', 'Como conecto minha conta da corretora?', 'Para conectar sua conta, vá para o Dashboard, clique em "Conectar Corretora" e insira suas credenciais da Deriv. O processo é seguro e leva menos de um minuto.', 'conexao', 1),
('00000000-0000-0000-0000-000000000102', 'Posso testar as IAs de investimento sem usar dinheiro real?', 'Sim, oferecemos uma conta demo onde você pode testar todas as funcionalidades das IAs de investimento sem usar dinheiro real. Acesse as configurações e selecione "Modo Demo".', 'ias', 2),
('00000000-0000-0000-0000-000000000103', 'O que é Copy Trading?', 'Copy Trading é uma funcionalidade que permite copiar automaticamente as operações de traders experientes. Você escolhe um trader e nossa plataforma replica suas operações em sua conta.', 'copy-trading', 3),
('00000000-0000-0000-0000-000000000104', 'Onde posso ver meu histórico de operações?', 'Você pode ver seu histórico completo de operações na seção "Relatórios" do Dashboard. Lá você encontrará todas as transações, resultados e estatísticas detalhadas.', 'operacoes', 4),
('00000000-0000-0000-0000-000000000105', 'Como funciona a IA Zenix?', 'A IA Zenix analisa o mercado em tempo real e executa operações automaticamente baseada em algoritmos avançados. Você pode configurar seus parâmetros de risco e a IA cuidará do resto.', 'ias', 5),
('00000000-0000-0000-0000-000000000106', 'Quais são os custos da plataforma?', 'A Zenix Black oferece planos flexíveis. Consulte a seção de Planos em Configurações para ver todas as opções disponíveis e seus respectivos custos.', 'planos', 6),
('00000000-0000-0000-0000-000000000107', 'Como retiro meus lucros?', 'Você pode retirar seus lucros diretamente através da sua conta Deriv conectada. As retiradas são processadas conforme as políticas da corretora.', 'retiradas', 7),
('00000000-0000-0000-0000-000000000108', 'A plataforma é segura?', 'Sim, utilizamos criptografia de ponta a ponta e não armazenamos senhas. Todas as conexões são feitas via API oficial da Deriv, garantindo máxima segurança.', 'seguranca', 8);

-- Inserir status inicial do sistema
INSERT INTO `system_status` (`id`, `service_name`, `status`, `message`) VALUES
('00000000-0000-0000-0000-000000000201', 'Sistema Principal', 'operational', 'Todos os sistemas operacionais.'),
('00000000-0000-0000-0000-000000000202', 'API Deriv', 'operational', 'Conexão com Deriv estável.'),
('00000000-0000-0000-0000-000000000203', 'IA Zenix', 'operational', 'Serviços de IA funcionando normalmente.'),
('00000000-0000-0000-0000-000000000204', 'Copy Trading', 'operational', 'Serviço de Copy Trading ativo.');

