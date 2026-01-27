export class ClientDto {
  name: string;
  loginId: string;
  email: string;
  balance: number;
  timeSpent: string;
  createdAt: string;
  lastActivity: string;
  whatsapp: boolean;
  whatsappNumber?: string;
  activityPeriod?: string;
  userId: string;
  role: string;
}

export class ClientListResponseDto {
  clients: ClientDto[];
  total: number;
}

