import { IsString, IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class CreateUserRequestDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @IsString()
  phone?: string;
}

export class UpdateUserRequestDto {
  @IsString()
  name?: string;

  @IsEmail()
  email?: string;
}

export class UserResponseDto {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}
