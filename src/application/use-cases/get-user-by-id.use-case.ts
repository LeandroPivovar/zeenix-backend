import { Injectable, NotFoundException, Inject } from '@nestjs/common';
import type { UserRepository } from '../../domain/repositories/user.repository';
import { User } from '../../domain/entities/user.entity';
import { USER_REPOSITORY_TOKEN } from '../../constants/tokens';

@Injectable()
export class GetUserByIdUseCase {
  constructor(@Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository) {}

  async execute(id: string): Promise<User> {
    const user = await this.userRepository.findById(id);
    
    if (!user) {
      throw new NotFoundException('Usuário não encontrado');
    }

    return user;
  }
}
