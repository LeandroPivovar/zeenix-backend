export class CreateUserDto {
  name: string;
  email: string;
  password: string;
  phone?: string | null;
}

export class UpdateUserDto {
  name?: string;
  email?: string;
}

export class ChangePasswordDto {
  currentPassword: string;
  newPassword: string;
}
