export class ClientDto {
  name: string;
  loginId: string;
  email: string;
  balance: number;
  timeSpent: string;
  createdAt: string;
  lastActivity: string;
  whatsapp: boolean;
  userId: string;
}

export class ClientListResponseDto {
  clients: ClientDto[];
  total: number;
}

