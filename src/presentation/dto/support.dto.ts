import { IsString, IsNotEmpty, IsOptional, IsInt, Min } from 'class-validator';

export class CreateFaqDto {
  @IsString()
  @IsNotEmpty()
  question: string;

  @IsString()
  @IsNotEmpty()
  answer: string;

  @IsString()
  @IsOptional()
  category?: string | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  orderIndex?: number;
}

export class UpdateFaqDto {
  @IsString()
  @IsOptional()
  question?: string;

  @IsString()
  @IsOptional()
  answer?: string;

  @IsString()
  @IsOptional()
  category?: string | null;

  @IsInt()
  @Min(0)
  @IsOptional()
  orderIndex?: number;
}

export class CreateSupportItemDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsOptional()
  subtitle?: string | null;

  @IsString()
  @IsOptional()
  imagePath?: string | null;
}

export class UpdateSupportItemDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  subtitle?: string | null;

  @IsString()
  @IsOptional()
  imagePath?: string | null;
}

export class UpdateStudentGroupConfigDto {
  @IsString()
  @IsNotEmpty()
  buttonText: string;

  @IsString()
  @IsNotEmpty()
  buttonLink: string;

  @IsString()
  @IsOptional()
  iconPath?: string | null;
}

