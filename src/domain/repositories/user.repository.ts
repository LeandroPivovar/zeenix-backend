import { User } from '../entities/user.entity';

export interface UserRepository {
  create(user: User): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByPhone(phone: string): Promise<User | null>;
  findAll(): Promise<User[]>;
  update(user: User): Promise<User>;
  delete(id: string): Promise<void>;
  updateDerivInfo(userId: string, info: { loginId?: string; currency?: string; balance?: number; raw?: any; tokenDemo?: string; tokenReal?: string; tokenRealCurrency?: string; tokenDemoCurrency?: string; realAmount?: number; demoAmount?: number; idRealAccount?: string; idDemoAccount?: string }): Promise<void>;
  getDerivInfo(userId: string): Promise<{ loginId: string | null; currency: string | null; balance: string | null; raw: any; realAmount: number; demoAmount: number; tokenRealCurrency: string | null; tokenDemoCurrency: string | null; idRealAccount: string | null; idDemoAccount: string | null } | null>;
  clearDerivInfo(userId: string): Promise<void>;
}
