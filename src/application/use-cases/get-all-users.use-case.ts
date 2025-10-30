import { Injectable, Inject } from '@nestjs/common';
import type { UserRepository } from '../../domain/repositories/user.repository';
import { User } from '../../domain/entities/user.entity';
import { USER_REPOSITORY_TOKEN } from '../../constants/tokens';

@Injectable()
export class GetAllUsersUseCase {
  constructor(@Inject(USER_REPOSITORY_TOKEN) private readonly userRepository: UserRepository) {}

  async execute(): Promise<User[]> {
    return await this.userRepository.findAll();
  }
}
