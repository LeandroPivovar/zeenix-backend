import { User } from '../entities/user.entity';

export interface UserRepository {
  create(user: User): Promise<User>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByPhone(phone: string): Promise<User | null>;
  findAll(): Promise<User[]>;
  update(user: User): Promise<User>;
  delete(id: string): Promise<void>;
  updateDerivInfo(userId: string, info: { loginId: string; currency?: string; balance?: number; raw?: any }): Promise<void>;
  getDerivInfo(userId: string): Promise<{ loginId: string | null; currency: string | null; balance: string | null; raw: any } | null>;
  clearDerivInfo(userId: string): Promise<void>;
}
